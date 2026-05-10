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
  } = input;

  const result = await client.subscribe("fal-ai/nano-banana-pro", {
    input: {
      prompt,
      aspect_ratio: aspectRatio,
      resolution,
      num_images: numImages,
      output_format: outputFormat,
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
