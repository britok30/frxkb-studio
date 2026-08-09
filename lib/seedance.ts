import { createFalClient, type FalClient } from "@fal-ai/client";
import { currentOperator } from "@/lib/operators";

export type SeedanceResolution = "480p" | "720p" | "1080p" | "4k";
export type SeedanceAspectRatio = "auto" | "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16";
/** Which Seedance generation to run. 2.5 (2026-08) tops out at 720p (no
 *  1080p/4k, no fast tier) but produces noticeably better motion; it goes
 *  up to 30s per clip and supports synchronized audio (we keep audio off). */
export type SeedanceModel = "seedance-2.0" | "seedance-2.5";

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
  /** Use the Fast tier endpoint — same model quality per fal, lower latency,
   *  ~$0.24/s vs $0.68/s. Caps at 720p, so the caller pairs it with a bigger
   *  Topaz factor (3× → 4K). end_image_url calls stay on the standard
   *  endpoint (fast-tier support was unverified at integration time).
   *  2.0-only — 2.5 has no fast tier. */
  fast?: boolean;
  /** Seedance generation. Defaults to 2.0 (the proven pipeline). */
  model?: SeedanceModel;
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
 * Animate a still into a short video via Seedance image-to-video.
 * 2.0 standard tier: 720p ≈ $0.30/s, 1080p ≈ $0.68/s, 4k ≈ $2.72/s. 2.0 fast
 * (opt-in via `fast`): ≈ $0.24/s, 720p max — same output quality per fal,
 * just lower latency; the crisp pipeline recovers resolution via Topaz.
 * 2.5 (opt-in via `model`): 720p ≈ $0.47/s, no 1080p — better motion; pairs
 * with Topaz 3× like the fast tier.
 *
 * Audio is OFF (generate_audio: false) — each clip used to get its own
 * unrelated ambience, which never synced across cuts. Clips ship silent;
 * the operator lays one music bed at stitch time (stitch panel upload).
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
    fast = false,
    model = "seedance-2.0",
  } = input;

  const is25 = model === "seedance-2.5";
  if (is25 && fast) {
    throw new Error("Seedance 2.5 has no fast tier — drop the fast flag.");
  }
  if (is25 && (resolution === "1080p" || resolution === "4k")) {
    throw new Error(`Seedance 2.5 caps at 720p — got ${resolution}.`);
  }
  if (fast && (resolution === "1080p" || resolution === "4k")) {
    throw new Error(`Seedance fast tier caps at 720p — got ${resolution}.`);
  }
  if (fast && endImageUrl) {
    throw new Error("Seedance fast tier is not used for morphs (end_image_url) — use the standard tier.");
  }

  // Duration is a string: "auto" or a range that widened in 2.5 (4–30s vs
  // 2.0's 4–15s). Anything below 4 gets bumped so the API doesn't reject it.
  const apiDuration = String(Math.min(is25 ? 30 : 15, Math.max(4, durationSec)));
  const endpoint = is25
    ? "bytedance/seedance-2.5/image-to-video"
    : fast
      ? "bytedance/seedance-2.0/fast/image-to-video"
      : "bytedance/seedance-2.0/image-to-video";
  let result;
  try {
    result = await client.subscribe(endpoint, {
      input: {
        prompt: motionPrompt,
        image_url: imageUrl,
        ...(endImageUrl ? { end_image_url: endImageUrl } : {}),
        duration: apiDuration,
        resolution,
        aspect_ratio: aspectRatio,
        generate_audio: false,
        ...(seed !== undefined ? { seed } : {}),
      },
      logs: false,
    });
  } catch (err) {
    // Surface fal's validation detail — a bare "Unprocessable Entity" hides
    // actionable causes like content_policy_violation ("image may contain
    // likenesses of real people" — e.g. a rendered celebrity album cover).
    const body = (err as { body?: { detail?: Array<{ msg?: string }> | string } }).body;
    const detail = Array.isArray(body?.detail)
      ? body.detail.map((d) => d.msg).filter(Boolean).join("; ")
      : typeof body?.detail === "string"
        ? body.detail
        : null;
    if (detail) {
      throw new Error(`seedance rejected the request: ${detail}`);
    }
    throw err;
  }

  const data = result.data as { video: { url: string } };
  if (!data?.video?.url) throw new Error("seedance returned no video url");

  return {
    videoUrl: data.video.url,
    requestId: result.requestId,
  };
}
