import { createFalClient, type FalClient } from "@fal-ai/client";
import { currentOperator } from "@/lib/operators";
import { collectQueued, submitQueued, type FalQueuedRequest } from "@/lib/fal-queue";

// Mirrors the fal SDK's accepted enum (verified against @fal-ai/client types).
// "Proteus" is our default — the all-purpose enhancement model. Other entries
// are kept for operator override later if a specific niche benefits.
export type TopazModel =
  | "Proteus"
  | "Artemis HQ"
  | "Artemis MQ"
  | "Artemis LQ"
  | "Nyx"
  | "Nyx Fast"
  | "Nyx XL"
  | "Nyx HF"
  | "Gaia HQ"
  | "Gaia CG";

export type TopazInput = {
  /** URL of the input video (mp4). */
  videoUrl: string;
  /** Enhancement model. We default to Proteus — Topaz's general-purpose model
   *  best for most non-rendered footage. */
  model?: TopazModel;
  /** 1-4. Defaults to 2 (720p → 1440p, plenty for Reels with CapCut headroom). */
  upscaleFactor?: number;
  /** Optional artifact removal (0-1). null = model decides. */
  compression?: number;
  /** Optional detail recovery (0-1). null = model decides. */
  recoverDetail?: number;
  /** Target output frame rate. When set, fal auto-engages Apollo (Topaz's
   *  frame-interpolation model) alongside Proteus to interpolate from the
   *  source FPS up to this. Callers pass 30 (the delivery frame rate;
   *  seedance ships 24fps,
   *  which reads as janky on smooth pans). Delivery is always 30fps — the
   *  stitch renders 30, so interpolating past that is money burned. Doubles
   *  the per-second tier price. Set to 0 to disable. */
  targetFps?: number;
};

export type TopazOutput = {
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
export function __resetTopazForTests(): void {
  clientCache.clear();
}

/**
 * Upscale a video via Topaz Video AI on fal.ai. Defaults to Proteus at 2×
 * with target_fps=60 frame interpolation (Apollo) on top.
 * H264_output is forced true so the result is directly playable in browsers
 * and CapCut without re-encoding.
 *
 * Pricing on fal: $0.01/sec up to 720p output, $0.02/sec for ≤1080p,
 * $0.08/sec for >1080p output. Per-second tier DOUBLES when target_fps is
 * set (Apollo interpolation surcharge), so an interpolated >1080p output
 * lands in the $0.16/sec tier.
 */
const TOPAZ_ENDPOINT = "fal-ai/topaz/upscale/video";

function buildTopazPayload(input: TopazInput): { video_url: string } & Record<string, unknown> {
  const {
    videoUrl,
    model = "Proteus",
    upscaleFactor = 2,
    compression,
    recoverDetail,
    targetFps = 30,
  } = input;
  return {
    video_url: videoUrl,
    model,
    upscale_factor: upscaleFactor,
    H264_output: true,
    ...(targetFps > 0 ? { target_fps: targetFps } : {}),
    ...(compression !== undefined ? { compression } : {}),
    ...(recoverDetail !== undefined ? { recover_detail: recoverDetail } : {}),
  };
}

function parseTopazResult(data: unknown, requestId: string): TopazOutput {
  const video = (data as { video?: { url?: string } })?.video;
  if (!video?.url) throw new Error("topaz returned no video url");
  return { videoUrl: video.url, requestId };
}

/** Queue-based Topaz: enqueue and return immediately. Pair with checkQueued
 *  (poll) + collectUpscale — the multi-minute upscale never holds a
 *  serverless invocation open. */
export async function submitUpscale(input: TopazInput): Promise<FalQueuedRequest> {
  return submitQueued(TOPAZ_ENDPOINT, buildTopazPayload(input));
}

/** Fetch the finished upscale for a submitUpscale request. */
export async function collectUpscale(req: FalQueuedRequest): Promise<TopazOutput> {
  const data = await collectQueued(req);
  return parseTopazResult(data, req.requestId);
}

export async function upscaleVideo(input: TopazInput): Promise<TopazOutput> {
  const client = clientForOperator();
  const result = await client.subscribe(TOPAZ_ENDPOINT, {
    input: buildTopazPayload(input),
    logs: false,
  });
  return parseTopazResult(result.data, result.requestId);
}
