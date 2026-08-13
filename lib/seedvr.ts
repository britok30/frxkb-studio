import { createFalClient, type FalClient } from "@fal-ai/client";
import { currentOperator } from "@/lib/operators";
import { collectQueued, submitQueued, type FalQueuedRequest } from "@/lib/fal-queue";

/**
 * SeedVR2 (ByteDance) video upscaling on fal — the alternative to Topaz for
 * the crisp pipeline. Diffusion-based restoration with strong temporal
 * consistency; in 2026 blind tests it lands within a rounding error of
 * Topaz with a more natural (less "AI-sharpened") texture. Two differences
 * from the Topaz path:
 *  - NO frame interpolation — clips stay at seedance's 24fps and the stitch
 *    resamples to 30fps. Fine for slow ambient motion; revisit if pans read
 *    janky.
 *  - Billing is per megapixel of video data ($0.001/MP × frames), not per
 *    second — see FAL_SEEDVR_PER_MEGAPIXEL in lib/pricing.ts.
 */

export type SeedVRTargetResolution = "720p" | "1080p" | "1440p" | "2160p";

export type SeedVRInput = {
  /** URL of the input video (mp4). */
  videoUrl: string;
  /** Output resolution. The crisp pipeline passes 2160p — same supersampled
   *  4K sources Topaz produced, downscaled to 1080p at stitch time. */
  targetResolution?: SeedVRTargetResolution;
  /** Optional reproducibility seed. */
  seed?: number;
};

export type SeedVROutput = {
  videoUrl: string;
  requestId: string;
};

const clientCache = new Map<string, FalClient>();

function clientForOperator(): FalClient {
  const op = currentOperator();
  let client = clientCache.get(op.email);
  if (!client) {
    client = createFalClient({ credentials: op.falKey });
    clientCache.set(op.email, client);
  }
  return client;
}

/** Test-only: clear the cache. */
export function __resetSeedVRForTests(): void {
  clientCache.clear();
}

const SEEDVR_ENDPOINT = "fal-ai/seedvr/upscale/video";

function buildSeedVRPayload(input: SeedVRInput): { video_url: string } & Record<string, unknown> {
  const { videoUrl, targetResolution = "2160p", seed } = input;
  return {
    video_url: videoUrl,
    upscale_mode: "target",
    target_resolution: targetResolution,
    output_format: "X264 (.mp4)",
    output_quality: "high",
    ...(seed !== undefined ? { seed } : {}),
  };
}

function parseSeedVRResult(data: unknown, requestId: string): SeedVROutput {
  const video = (data as { video?: { url?: string } })?.video;
  if (!video?.url) throw new Error("seedvr returned no video url");
  return { videoUrl: video.url, requestId };
}

/** Queue-based SeedVR2: enqueue and return immediately. Pair with checkQueued
 *  (poll) + collectSeedVRUpscale — SeedVR2 is the slowest stage in the crisp
 *  pipeline (it's what pushed animate scenes past Vercel's maxDuration,
 *  observed 2026-08-12), so it must never hold an invocation open. */
export async function submitSeedVRUpscale(input: SeedVRInput): Promise<FalQueuedRequest> {
  return submitQueued(SEEDVR_ENDPOINT, buildSeedVRPayload(input));
}

/** Fetch the finished upscale for a submitSeedVRUpscale request. */
export async function collectSeedVRUpscale(req: FalQueuedRequest): Promise<SeedVROutput> {
  const data = await collectQueued(req);
  return parseSeedVRResult(data, req.requestId);
}

export async function upscaleVideoSeedVR(input: SeedVRInput): Promise<SeedVROutput> {
  const client = clientForOperator();
  const result = await client.subscribe(SEEDVR_ENDPOINT, {
    input: buildSeedVRPayload(input),
    logs: false,
  });
  return parseSeedVRResult(result.data, result.requestId);
}
