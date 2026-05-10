import { createFalClient, type FalClient } from "@fal-ai/client";
import { currentOperator } from "@/lib/operators";

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
 * Upscale a video via Topaz Video AI on fal.ai. Defaults to Proteus at 2×.
 * H264_output is forced true so the result is directly playable in browsers
 * and CapCut without re-encoding.
 *
 * Pricing on fal: $0.01/sec up to 720p output, $0.02/sec for ≤1080p,
 * $0.08/sec for >1080p output. With 2× from a 720p input → 1440p, we land
 * in the $0.08/sec tier.
 */
export async function upscaleVideo(input: TopazInput): Promise<TopazOutput> {
  const client = clientForOperator();
  const {
    videoUrl,
    model = "Proteus",
    upscaleFactor = 2,
    compression,
    recoverDetail,
  } = input;

  const result = await client.subscribe("fal-ai/topaz/upscale/video", {
    input: {
      video_url: videoUrl,
      model,
      upscale_factor: upscaleFactor,
      H264_output: true,
      ...(compression !== undefined ? { compression } : {}),
      ...(recoverDetail !== undefined ? { recover_detail: recoverDetail } : {}),
    },
    logs: false,
  });

  const data = result.data as { video?: { url?: string } };
  if (!data?.video?.url) throw new Error("topaz returned no video url");

  return {
    videoUrl: data.video.url,
    requestId: result.requestId,
  };
}
