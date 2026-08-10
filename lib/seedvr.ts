import { createFalClient, type FalClient } from "@fal-ai/client";
import { currentOperator } from "@/lib/operators";

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

export async function upscaleVideoSeedVR(input: SeedVRInput): Promise<SeedVROutput> {
  const client = clientForOperator();
  const { videoUrl, targetResolution = "2160p", seed } = input;

  const result = await client.subscribe("fal-ai/seedvr/upscale/video", {
    input: {
      video_url: videoUrl,
      upscale_mode: "target",
      target_resolution: targetResolution,
      output_format: "X264 (.mp4)",
      output_quality: "high",
      ...(seed !== undefined ? { seed } : {}),
    },
    logs: false,
  });

  const data = result.data as { video?: { url?: string } };
  if (!data?.video?.url) throw new Error("seedvr returned no video url");

  return {
    videoUrl: data.video.url,
    requestId: result.requestId,
  };
}
