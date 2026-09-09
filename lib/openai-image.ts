// OpenAI image editing — the virtual-staging renderer. Where every other
// still in the studio goes through fal nano-banana (a generation endpoint
// that *re-imagines* from references), staging needs a true EDIT: the
// buyer's photo must survive pixel-faithfully with furniture composited in.
// gpt-image-2.5-sunburst is OpenAI's editing-precision model (released
// 2026-09-08): `images.edit` takes the room photo plus up to 15 more
// reference images (client furniture), honours `input_fidelity: "high"` to
// preserve the source, and renders at an arbitrary canvas so the after
// matches the upload's aspect exactly.
// https://developers.openai.com/api/docs/guides/image-generation

import OpenAI, { toFile } from "openai";
import { currentOperator } from "@/lib/operators";
import type { AspectRatio } from "@/lib/prompts/types";

/** Editing-precision model. `gpt-image-2.5-flare` is the faster sibling —
 *  not used here because staging lives or dies on how faithfully the room
 *  is preserved, not on latency. */
export const STAGING_IMAGE_MODEL = "gpt-image-2.5-sunburst";

/** images.edit accepts 16 images total for GPT image models. */
export const OPENAI_EDIT_MAX_IMAGES = 16;

export type StagingQuality = "high" | "xhigh";

// One client per operator — same pattern as lib/llm.ts / lib/thumbnail.ts.
const clientCache = new Map<string, OpenAI>();

function getClient(): OpenAI {
  const op = currentOperator();
  let client = clientCache.get(op.email);
  if (!client) {
    client = new OpenAI({ apiKey: op.openaiKey });
    clientCache.set(op.email, client);
  }
  return client;
}

/** Test-only: clear the cached clients. */
export function __resetOpenAIImageForTests(): void {
  clientCache.clear();
}

/**
 * Output canvas per upload aspect. gpt-image-2/2.5 accept any WIDTHxHEIGHT
 * with both sides divisible by 16 and ≤2560×1440-class pixel counts without
 * the "experimental" flag; these sit around 2048 on the long edge — MLS
 * photo territory, sharp enough to zoom, well under the ceiling.
 */
export function stagingSizeFor(aspect: AspectRatio): `${number}x${number}` {
  switch (aspect) {
    case "16:9":
      return "2048x1152";
    case "9:16":
      return "1152x2048";
    case "4:3":
      return "2048x1536";
    case "3:4":
      return "1536x2048";
    case "1:1":
      return "1536x1536";
  }
}

async function fetchAsUploadable(url: string, name: string) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Couldn't download ${name} (${res.status}). Re-upload and try again.`);
  }
  const type = (res.headers.get("content-type") ?? "image/jpeg").split(";")[0].trim();
  const ext = type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
  const buffer = Buffer.from(await res.arrayBuffer());
  return await toFile(buffer, `${name}.${ext}`, { type });
}

export type StageImageInput = {
  /** Public Blob URL of the operator's empty-room photo — image #1, the one
   *  the edit is anchored to. */
  beforeUrl: string;
  /** Client furniture photos (public URLs). Sent after the room photo so the
   *  prompt can refer to them as "the attached furniture references". */
  furnitureReferenceUrls?: string[];
  /** The fully assembled edit instruction (lock + plan + guidance). */
  prompt: string;
  aspectRatio: AspectRatio;
  /** high = the default; xhigh = 2.5's new top tier for a final hero pass. */
  quality?: StagingQuality;
};

export type StageImageResult = {
  /** JPEG bytes of the staged room. */
  buffer: Buffer;
  contentType: "image/jpeg";
  model: string;
  size: string;
};

/**
 * Render the staged "after" for one room photo. Blocking call (30-120s) —
 * only ever invoked from inside an Inngest step or a per-scene regen, never
 * fanned out inside a request handler.
 */
export async function stageImage(input: StageImageInput): Promise<StageImageResult> {
  const refs = (input.furnitureReferenceUrls ?? []).slice(0, OPENAI_EDIT_MAX_IMAGES - 1);
  const [before, ...furniture] = await Promise.all([
    fetchAsUploadable(input.beforeUrl, "room"),
    ...refs.map((url, i) => fetchAsUploadable(url, `furniture-${i + 1}`)),
  ]);
  const size = stagingSizeFor(input.aspectRatio);

  const result = await getClient().images.edit({
    model: STAGING_IMAGE_MODEL,
    // Room photo FIRST — the mask (unused) and the model's edit anchor both
    // bind to image[0]; the furniture refs follow as guidance.
    image: [before, ...furniture],
    prompt: input.prompt,
    // The whole point: keep the buyer's room. Low fidelity re-imagines
    // finishes and window views; high keeps them.
    input_fidelity: "high",
    quality: input.quality ?? "high",
    size,
    output_format: "jpeg",
    output_compression: 92,
  });

  const b64 = result.data?.[0]?.b64_json;
  if (!b64) throw new Error(`${STAGING_IMAGE_MODEL} returned no image`);
  return {
    buffer: Buffer.from(b64, "base64"),
    contentType: "image/jpeg",
    model: STAGING_IMAGE_MODEL,
    size,
  };
}
