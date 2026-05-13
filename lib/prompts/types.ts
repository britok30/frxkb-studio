import { z } from "zod";

export const FormatSchema = z.enum(["reel", "carousel", "before-after"]);
export type Format = z.infer<typeof FormatSchema>;

/**
 * Architecture content splits cleanly into two visual lanes — interior spaces
 * (rooms, materials, indoor light) vs exterior shots (facades, landscapes,
 * outdoor light). Concept + scene + thumbnail prompts get this as context so
 * the visual world stays on one side of the line for the whole project.
 */
export const WorldTypeSchema = z.enum(["interior", "exterior"]);
export type WorldType = z.infer<typeof WorldTypeSchema>;

// Before-after projects derive their aspect from the uploaded image, so the
// schema accepts a few more options than the AI-generated formats use natively.
export const AspectRatioSchema = z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]);
export type AspectRatio = z.infer<typeof AspectRatioSchema>;

/** Kebab-case slug used for duplicate detection. e.g.
 *  "1960s-brazilian-modernism-travertine-palms-late-afternoon". */
const WORLD_SIGNATURE_RE = /^[a-z0-9]+(?:-[a-z0-9]+){2,}$/;

export const ConceptBriefSchema = z.object({
  workingTitle: z.string().min(3).max(120),
  hook: z.string().min(8).max(240),
  vibe: z.string().min(8).max(1500),
  // 2000 char ceiling — Anthropic's tool_use doesn't enforce JSON-schema
  // maxLength, and Claude regularly overshoots prose fields. Generous bound
  // here + safeTruncate at the parse boundary in concept.ts catches the rest.
  notes: z.string().max(2000).default(""),
  /** Per-piece commitment to 8-15 specific objects (furniture, plants, art,
   *  ceramics, textiles, daily-life items — and for exteriors, landscape
   *  elements / pool / lighting / site features) that belong to THIS home's
   *  cultural lineage. Drives downstream scene prompts so every scene draws
   *  from the same lineage-specific vocabulary. Default [] for backwards
   *  compat with concept rows persisted before this field existed. */
  objectSet: z.array(z.string().min(2).max(80)).min(8).max(15).default([]),
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
  "workingTitle" | "hook" | "vibe" | "notes" | "objectSet"
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
    case "reel":
      // 3 × 5s = 15s. Matches Seedance's native 4-15s range (no clamp) and
      // gives each scene more time to breathe — slow cuts are the whole
      // differentiator vs the 1-2s maximalist Reels norm.
      return { aspectRatio: "9:16", sceneCount: 3, sceneDurationSec: 5 };
    case "carousel":
      return { aspectRatio: "1:1", sceneCount: 10, sceneDurationSec: 0 };
    case "before-after":
      // Two scenes: the uploaded "before" + the AI-generated "after." Aspect
      // is overridden per-project from the uploaded image's actual dimensions
      // (defaultsForFormat returns 1:1 as a placeholder; the real value lives
      // on projects.aspectRatio). Both scenes animate at 7s — paired length
      // for CapCut edits, comfortably inside seedance's 4-15s native range.
      return { aspectRatio: "1:1", sceneCount: 2, sceneDurationSec: 7 };
  }
}
