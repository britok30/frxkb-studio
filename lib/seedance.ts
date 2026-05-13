import { createFalClient, type FalClient } from "@fal-ai/client";
import { currentOperator } from "@/lib/operators";

export type SeedanceResolution = "480p" | "720p" | "1080p";
export type SeedanceAspectRatio = "auto" | "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16";

export type SeedanceInput = {
  /** URL of the still that becomes the first frame. JPG/PNG/WebP, ≤30 MB. */
  imageUrl: string;
  /** Describes the motion — camera move, what happens in the scene. */
  motionPrompt: string;
  /** Clip length in seconds, 4-15. Defaults to 4. */
  durationSec?: number;
  /** Resolution. Higher = more cost. We default to 720p (Reels native). */
  resolution?: SeedanceResolution;
  /** Aspect of the output. Defaults to "9:16" since we only call this for reels. */
  aspectRatio?: SeedanceAspectRatio;
  /** Optional reproducibility seed. */
  seed?: number;
};

export type SeedanceOutput = {
  videoUrl: string;
  requestId: string;
};

// One client per operator, same pattern as lib/fal.ts.
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
export function __resetSeedanceForTests(): void {
  clientCache.clear();
}

/**
 * Animate a still into a short video via Seedance 2.0 Fast (image-to-video).
 * The Fast tier is ~20% cheaper than the standard tier ($0.2419/sec vs
 * $0.3024/sec at 720p) with comparable quality for short ambient clips.
 *
 * Audio is disabled (generate_audio: false) — operator adds music in CapCut.
 * Per fal docs the price is identical with audio on or off, so this is just
 * keeping the output clean rather than a cost win.
 */
export async function generateVideo(input: SeedanceInput): Promise<SeedanceOutput> {
  const client = clientForOperator();
  const {
    imageUrl,
    motionPrompt,
    durationSec = 4,
    resolution = "720p",
    aspectRatio = "9:16",
    seed,
  } = input;

  // Seedance 2.0 accepts duration "auto" or 4–15s as a string. Anything below
  // 4 (e.g. our 3s reel default) gets bumped to 4 so the API doesn't reject it.
  const apiDuration = String(Math.min(15, Math.max(4, durationSec)));
  const result = await client.subscribe("bytedance/seedance-2.0/fast/image-to-video", {
    input: {
      prompt: motionPrompt,
      image_url: imageUrl,
      duration: apiDuration,
      resolution,
      aspect_ratio: aspectRatio,
      // Ambient design reels — operator adds music in CapCut, so silence the
      // model's auto-generated audio track. Per fal docs the cost is identical
      // either way, so this is a free win.
      generate_audio: false,
      ...(seed !== undefined ? { seed } : {}),
    },
    logs: false,
  });

  const data = result.data as { video: { url: string } };
  if (!data?.video?.url) throw new Error("seedance returned no video url");

  return {
    videoUrl: data.video.url,
    requestId: result.requestId,
  };
}
