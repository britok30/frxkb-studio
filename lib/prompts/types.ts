import { z } from "zod";

export const FormatSchema = z.enum(["yt-long", "reel", "carousel"]);
export type Format = z.infer<typeof FormatSchema>;

export const AspectRatioSchema = z.enum(["16:9", "9:16", "1:1"]);
export type AspectRatio = z.infer<typeof AspectRatioSchema>;

/** Kebab-case slug used for duplicate detection. e.g.
 *  "1960s-brazilian-modernism-travertine-palms-late-afternoon". */
const WORLD_SIGNATURE_RE = /^[a-z0-9]+(?:-[a-z0-9]+){2,}$/;

export const ConceptBriefSchema = z.object({
  workingTitle: z.string().min(3).max(120),
  hook: z.string().min(8).max(240),
  vibe: z.string().min(8).max(800),
  notes: z.string().max(1200).default(""),
  /** Stable kebab-case identifier for the world. Used to detect duplicate
   *  projects. Required so dedupe can rely on its presence. */
  worldSignature: z.string().min(8).max(80).regex(WORLD_SIGNATURE_RE),
  /** Canonical lowercase keyword set. Used for fuzzy/keyword-overlap dedupe. */
  worldKeywords: z.array(z.string().min(2).max(40)).min(5).max(12),
});
export type ConceptBrief = z.infer<typeof ConceptBriefSchema>;

/** The subset of ConceptBrief that downstream prompt generators (scene,
 *  metadata, thumbnail) actually read. The dedupe fields live on the project
 *  row; prompt generators don't need them. Keeping this loose lets the
 *  generators accept either a full ConceptBrief OR the trimmed jsonb stored
 *  on `projects.concept`. */
export type PromptableConcept = Pick<
  ConceptBrief,
  "workingTitle" | "hook" | "vibe" | "notes"
>;

export const ScenePromptSchema = z.object({
  order: z.number().int().min(1),
  // Pro responds best to 60-100 word prompts. Min raised from 20 → 200 chars
  // so we don't accept one-liners; max raised slightly to allow rich descriptions.
  prompt: z.string().min(200).max(1500),
  durationSec: z.number().int().min(2).max(15),
});
export type ScenePrompt = z.infer<typeof ScenePromptSchema>;

export const ScenePromptsResponseSchema = z.object({
  scenes: z.array(ScenePromptSchema).min(1).max(120),
});
export type ScenePromptsResponse = z.infer<typeof ScenePromptsResponseSchema>;

export function defaultsForFormat(format: Format): {
  aspectRatio: AspectRatio;
  sceneCount: number;
  sceneDurationSec: number;
} {
  switch (format) {
    case "yt-long":
      // 60 × 10s = 10 min — ambient slideshow that lives comfortably in the
      // YT background-watch sweet spot. Variety per minute matters; long
      // hold-times let each scene breathe.
      return { aspectRatio: "16:9", sceneCount: 60, sceneDurationSec: 10 };
    case "reel":
      // 5 × 3s = 15s. Slow cuts (vs the 1-2s maximalist Reels norm) are the
      // whole differentiator for ambient design content.
      return { aspectRatio: "9:16", sceneCount: 5, sceneDurationSec: 3 };
    case "carousel":
      return { aspectRatio: "1:1", sceneCount: 10, sceneDurationSec: 0 };
  }
}
