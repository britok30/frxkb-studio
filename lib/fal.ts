import { createFalClient, type FalClient } from "@fal-ai/client";
import { currentOperator } from "@/lib/operators";

// Pro accepts a wider set of aspect ratios than the original nano-banana, but
// the studio only ever uses these three. Keep the union tight so callers
// can't accidentally request something the wizard doesn't support.
export type AspectRatio = "16:9" | "9:16" | "1:1" | "4:3" | "3:4";
export type Resolution = "1K" | "2K" | "4K";

export type NanoBananaInput = {
  prompt: string;
  numImages?: number;
  outputFormat?: "jpeg" | "png";
  aspectRatio?: AspectRatio;
  /** 1K is the cost-efficient default. 2K is +50% cost, 4K is 2× cost. Bump
   *  only for hero shots / Instagram carousels where viewers might zoom. */
  resolution?: Resolution;
  /** Seed for reproducibility / variety control. nano-banana-pro has strong
   *  stylistic priors — same prompt + same seed lands on the same composition.
   *  Pass a fresh random seed per call to break out of mode-collapse defaults
   *  (the "every modernist living room is the same beige sectional" effect). */
  seed?: number;
};

export type NanoBananaOutput = {
  images: { url: string; contentType?: string }[];
  description?: string;
  requestId: string;
};

// One FalClient per operator. createFalClient is cheap, but caching keeps
// keep-alive connections warm across calls within a single Vercel function
// instance. Map keyed by operator email.
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

/** Test-only: clear the cache so each test starts fresh. */
export function __resetFalForTests(): void {
  clientCache.clear();
}

/**
 * Generate one or more images via fal-ai/nano-banana-pro (Gemini 3 Pro Image).
 * Pro is ~4× the cost of the original nano-banana ($0.15/img at 1K vs $0.039)
 * but materially better fidelity, prompt following, and detail. Aspect ratio
 * is now a first-class API param (no more prompt-injection trick).
 */
export async function generateImage(input: NanoBananaInput): Promise<NanoBananaOutput> {
  const client = clientForOperator();
  const {
    prompt,
    numImages = 1,
    outputFormat = "png",
    aspectRatio = "1:1",
    // 2K default — visibly sharper than 1K, especially on Retina displays where
    // viewers might pause to look. Costs 1.5× of 1K ($0.225 vs $0.15 per image).
    resolution = "2K",
    seed,
  } = input;

  const result = await client.subscribe("fal-ai/nano-banana-pro", {
    input: {
      prompt,
      aspect_ratio: aspectRatio,
      resolution,
      num_images: numImages,
      output_format: outputFormat,
      ...(seed !== undefined ? { seed } : {}),
    },
    logs: false,
  });

  const data = result.data as {
    images: { url: string; content_type?: string }[];
    description?: string;
  };

  return {
    images: data.images.map((img) => ({ url: img.url, contentType: img.content_type })),
    description: data.description,
    requestId: result.requestId,
  };
}

export type NanoBananaEditInput = NanoBananaInput & {
  /** Reference images to condition the new generation on. Up to 14. The model
   *  generates a NEW image guided by these references — it doesn't pixel-edit
   *  them. Used to lock palette/materials/lighting across a sequence. */
  imageUrls: string[];
};

/**
 * Generate an image conditioned on one or more reference images via
 * fal-ai/nano-banana-pro/edit. Despite the name "edit," this is a generation
 * endpoint that uses the references for style/composition guidance — not
 * pixel-level editing.
 *
 * Cost is $0.15/img at 1K/2K (flat — actually CHEAPER than text-to-image at
 * 2K which is $0.225). 4K doubles to $0.30.
 *
 * Used downstream of generateImage for non-anchor scenes: anchor scene runs
 * text-to-image, scenes 2+ run editImage with the anchor URL so the world
 * stays visually locked across the reel.
 */
export async function editImage(input: NanoBananaEditInput): Promise<NanoBananaOutput> {
  const client = clientForOperator();
  const {
    prompt,
    imageUrls,
    numImages = 1,
    outputFormat = "png",
    aspectRatio = "1:1",
    resolution = "2K",
    seed,
  } = input;

  if (imageUrls.length === 0) {
    throw new Error("editImage requires at least one reference image URL.");
  }
  if (imageUrls.length > 14) {
    throw new Error(`editImage accepts up to 14 reference images, got ${imageUrls.length}.`);
  }

  const result = await client.subscribe("fal-ai/nano-banana-pro/edit", {
    input: {
      prompt,
      image_urls: imageUrls,
      aspect_ratio: aspectRatio,
      resolution,
      num_images: numImages,
      output_format: outputFormat,
      ...(seed !== undefined ? { seed } : {}),
    },
    logs: false,
  });

  const data = result.data as {
    images: { url: string; content_type?: string }[];
    description?: string;
  };

  return {
    images: data.images.map((img) => ({ url: img.url, contentType: img.content_type })),
    description: data.description,
    requestId: result.requestId,
  };
}
