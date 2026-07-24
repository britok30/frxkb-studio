// YouTube thumbnail generator — gpt-image-2 image edit. The operator uploads
// a base image (usually a frame/render from the video), writes the text they
// want burned in, and gpt-image-2 restyles it into a high-CTR thumbnail.
// Output is normalized to YouTube's exact spec: 1280×720 JPEG.

import OpenAI, { toFile } from "openai";
import sharp from "sharp";
import { nanoid } from "nanoid";
import { currentOperator } from "@/lib/operators";
import { storeBuffer } from "@/lib/storage";
import { recordSpend } from "@/lib/spend";
import { GPT_IMAGE_2_THUMBNAIL_USD } from "@/lib/pricing";

// One client per operator — same pattern as lib/llm.ts.
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
export function __resetThumbnailForTests(): void {
  clientCache.clear();
}

function buildPrompt(text: string, notes?: string): string {
  return [
    "Redesign this image into a high-CTR YouTube thumbnail.",
    `Overlay EXACTLY this text and nothing else: "${text}".`,
    "Typography: large, thick, bold sans-serif — instantly readable at small sizes; high contrast against the scene (add a subtle outline or soft drop shadow if the background is busy).",
    "Keep the original scene as the visual base. Punch up color, contrast, and depth for thumbnail pop, but keep it photographic — no cartoon look.",
    "Composition: the text must not cover the focal subject; keep clean margins so nothing important sits at the extreme edges.",
    "No watermarks, no logos, no extra words beyond the given text.",
    notes?.trim() ? `Operator direction: ${notes.trim()}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export type ThumbnailResult = {
  /** Public Blob URL of the finished 1280×720 JPEG. */
  url: string;
};

export async function generateThumbnail(input: {
  /** Public Blob URL of the operator-uploaded base image. */
  sourceImageUrl: string;
  /** The text to burn into the thumbnail (title/hook). */
  text: string;
  /** Optional extra art direction ("text top-left", "make it moodier", …). */
  notes?: string;
}): Promise<ThumbnailResult> {
  const res = await fetch(input.sourceImageUrl);
  if (!res.ok) {
    throw new Error(`Couldn't download the base image (${res.status}). Re-upload and try again.`);
  }
  const sourceBuffer = Buffer.from(await res.arrayBuffer());

  const result = await getClient().images.edit({
    model: "gpt-image-2",
    image: await toFile(sourceBuffer, "base.png", { type: "image/png" }),
    prompt: buildPrompt(input.text, input.notes),
    // Closest supported landscape size (3:2) — normalized to 16:9 below.
    size: "1536x1024",
  });

  const b64 = result.data?.[0]?.b64_json;
  if (!b64) throw new Error("gpt-image-2 returned no image");

  // YouTube spec: 1280×720, under 2MB. Center-crop the 3:2 render to 16:9
  // then encode JPEG — quality 90 lands well under the cap.
  const jpeg = await sharp(Buffer.from(b64, "base64"))
    .resize(1280, 720, { fit: "cover", position: "centre" })
    .jpeg({ quality: 90 })
    .toBuffer();

  const stored = await storeBuffer({
    buffer: jpeg,
    kind: "thumbnails",
    projectId: "tool",
    filename: `yt-${nanoid(8)}.jpg`,
    contentType: "image/jpeg",
  });

  await recordSpend({
    kind: "image-edit",
    amountUsd: GPT_IMAGE_2_THUMBNAIL_USD,
    meta: { tool: "thumbnail", model: "gpt-image-2" },
  });

  return { url: stored.url };
}
