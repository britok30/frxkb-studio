import { nanoid } from "nanoid";
import { generateImage } from "@/lib/fal";
import { storeFromUrl } from "@/lib/storage";
import type { PromptableConcept, AspectRatio, Format } from "@/lib/prompts/types";

export type ThumbnailInput = {
  projectId: string;
  concept: PromptableConcept;
  format: Format;
};

export type ThumbnailResult = {
  /** Public Vercel Blob URL of the uploaded thumbnail. */
  imageUrl: string;
  requestId: string;
};

export function thumbnailAspect(format: Format): AspectRatio {
  switch (format) {
    case "yt-long":
      return "16:9";
    case "reel":
      return "9:16";
    case "carousel":
      return "1:1";
  }
}

/**
 * Build a thumbnail-optimized prompt distinct from the slideshow scenes.
 * Goals:
 *  - One hero subject (not a complex composition).
 *  - Strong directional light, magazine-cover energy.
 *  - Negative space on one side so the operator can drop text in CapCut later.
 *  - Echoes the same visual identity as the slideshow (vibe + notes pinned).
 */
export function buildThumbnailPrompt(concept: PromptableConcept): string {
  return [
    "Editorial architectural photograph in the style of an Architectural Digest, Wallpaper, or Cabin Porn cover. ONE hero subject only — a single facade, a single interior, a single threshold, a single material edge — not a complex scene. Composition is magazine-grade: strong directional light, clear focal point, deliberate negative space on the right or left third for a title overlay. Highly detailed at 2K, photographic register, restrained.",
    "Anchor in real photographic vocabulary: shot on Mamiya 7 medium format or large-format 4×5, available natural light, color-graded for editorial print. Materials named precisely. Light direction explicit (low west-side rake at golden hour, soft north-skylight, etc.).",
    "Hard constraints: no people, no faces, no body parts, no silhouettes that could read as human. No on-screen text, signage, brands, watermarks, or readable writing of any kind. Not illustrative, not 3D-render, not maximalist, not stylized.",
    "",
    `Concept: ${concept.workingTitle}.`,
    `Visual world: ${concept.vibe}`,
    concept.notes ? `Locked visual rules: ${concept.notes}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function generateThumbnail(input: ThumbnailInput): Promise<ThumbnailResult> {
  const aspectRatio = thumbnailAspect(input.format);
  const prompt = buildThumbnailPrompt(input.concept);

  const result = await generateImage({ prompt, aspectRatio });
  const first = result.images[0];
  if (!first?.url) throw new Error("fal returned no thumbnail image url");

  const filename = `thumbnail-${nanoid(6)}.jpg`;
  const stored = await storeFromUrl({
    url: first.url,
    kind: "thumbnails",
    projectId: input.projectId,
    filename,
  });

  return {
    imageUrl: stored.url,
    requestId: result.requestId,
  };
}
