import { createFalClient, type FalClient } from "@fal-ai/client";
import { currentOperator } from "@/lib/operators";

export type SeedanceResolution = "480p" | "720p" | "1080p" | "4k";
export type SeedanceAspectRatio = "auto" | "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16";

export type SeedanceInput = {
  /** URL of the still that becomes the first frame. JPG/PNG/WebP, ≤30 MB. */
  imageUrl: string;
  /** Optional last frame. When set, the clip transitions first → last —
   *  this is the before→after morph and the style-morph format. */
  endImageUrl?: string;
  /** Describes the motion — camera move, what happens in the scene. */
  motionPrompt: string;
  /** Clip length in seconds, 4-15. Defaults to 4. */
  durationSec?: number;
  /** Resolution. Higher = more cost (token-billed by pixels). We default to
   *  1080p — Reels' delivery ceiling; native 1080p detail beats an upscaled
   *  720p. "4k" exists on the standard endpoint but costs ~9× 720p, so it's
   *  reserved for deliberate hero use. */
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
 * Animate a still into a short video via Seedance 2.0 (standard tier,
 * image-to-video). Standard is required for 1080p/4k output and for
 * end_image_url (first+last-frame) — the Fast tier caps at 720p and lacks
 * both. Token-billed by pixels: 720p ≈ $0.30/s, 1080p ≈ $0.68/s, 4k ≈ $2.72/s.
 *
 * Audio is ON (generate_audio: true) — synced ambient sound is included in
 * the price either way, and a reel that ships with ambient audio beats a
 * silent clip the operator has to score from scratch.
 */
export async function generateVideo(input: SeedanceInput): Promise<SeedanceOutput> {
  const client = clientForOperator();
  const {
    imageUrl,
    endImageUrl,
    motionPrompt,
    durationSec = 4,
    resolution = "1080p",
    aspectRatio = "9:16",
    seed,
  } = input;

  // Seedance 2.0 accepts duration "auto" or 4–15s as a string. Anything below
  // 4 gets bumped to 4 so the API doesn't reject it.
  const apiDuration = String(Math.min(15, Math.max(4, durationSec)));
  const result = await client.subscribe("bytedance/seedance-2.0/image-to-video", {
    input: {
      prompt: motionPrompt,
      image_url: imageUrl,
      ...(endImageUrl ? { end_image_url: endImageUrl } : {}),
      duration: apiDuration,
      resolution,
      aspect_ratio: aspectRatio,
      generate_audio: true,
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
