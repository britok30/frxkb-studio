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
 * Audio generation is bundled at no extra cost — but for ambient design reels
 * we don't want vocals/music baked in (operator adds music in CapCut), so we
 * leave generate_audio at its default but treat the audio as discardable.
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

  const result = await client.subscribe("bytedance/seedance-2.0/fast/image-to-video", {
    input: {
      prompt: motionPrompt,
      image_url: imageUrl,
      duration: String(durationSec),
      resolution,
      aspect_ratio: aspectRatio,
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
