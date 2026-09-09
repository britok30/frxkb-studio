import { z } from "zod";

export const FormatSchema = z.enum([
  "reel",
  "carousel",
  "before-after",
  "style-explorer",
  "staging",
]);
export type Format = z.infer<typeof FormatSchema>;

/**
 * Program axis, orthogonal to WorldType. residential = homes someone lives in;
 * commercial = offices, retail, restaurants, hospitality. Threaded alongside
 * worldType so a prompt can know both the vantage (interior/exterior) and the
 * program (residential/commercial) — e.g. a commercial interior is a lobby,
 * not a living room.
 */
export const PropertyTypeSchema = z.enum(["residential", "commercial"]);
export type PropertyType = z.infer<typeof PropertyTypeSchema>;

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
  // 2000 char ceiling — non-strict function calling doesn't enforce JSON-schema
  // maxLength, and GPT-5.5 regularly overshoots prose fields. Generous bound
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

/** Showcase reel pacing bounds. Researched 2026-08: IG distributes reels up
 *  to 3 min but the algorithm favors <90s for discovery (7-30s is the reach
 *  sweet spot); YT Shorts caps at 3 min. So the budget is TIME, not shots:
 *  total ≤ 90s, each shot 3-10s (10s max also keeps 2.0's 15s clip ceiling
 *  clear of the +1s crossfade pad). AI reels stay locked at 3 × 5s — that's
 *  an editorial choice, not a platform cap. */
export const SHOWCASE_REEL_MAX_TOTAL_SEC = 90;
export const SHOWCASE_SHOT_MIN_SEC = 3;
export const SHOWCASE_SHOT_MAX_SEC = 10;

/** Uniform chapter hold for the style-explorer long-form: every still — and,
 *  when the styles are animated, every clip — occupies exactly this many
 *  seconds of the timeline. Chapter timestamps in the YouTube description are
 *  i × this, so animate + stitch + metadata MUST all read the same value.
 *  Client-safe (imported by cost labels). */
export const STYLE_EXPLORER_HOLD_SEC = 10;

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
      // 20 slides — Instagram raised the carousel cap from 10 to 20.
      return { aspectRatio: "1:1", sceneCount: 20, sceneDurationSec: 0 };
    case "before-after":
      // Stills-only (video retired 2026-07-24): the uploaded "before" + nine
      // AI-proposed "after" concepts (10 images total — a full IG carousel).
      // Aspect is overridden per-project from the uploaded image's actual
      // dimensions (1:1 here is a placeholder; the real value lives on
      // projects.aspectRatio).
      return { aspectRatio: "1:1", sceneCount: 10, sceneDurationSec: 0 };
    case "staging":
      // Virtual staging: the operator's empty-room photo (scene 1, free) +
      // ONE furnished "after" rendered by gpt-image-2.5 (scene 2). Aspect is
      // overridden per-project from the upload (4:3 is the MLS-photo
      // placeholder). Stills only.
      return { aspectRatio: "4:3", sceneCount: 2, sceneDurationSec: 0 };
    case "style-explorer":
      // N styled edits of one uploaded base, for a YouTube long-form "X styles
      // of this space" video. Like before-after, the real aspect comes from
      // the upload (stored on projects.aspectRatio); 16:9 here is the long-form
      // placeholder. Stills by default (durationSec 0); the operator can
      // optionally Animate every style into a STYLE_EXPLORER_HOLD_SEC clip —
      // the stitch swaps to real footage once all styles have one. Default 15
      // styles → a longer SEO walkthrough with more chapter keywords.
      return { aspectRatio: "16:9", sceneCount: 15, sceneDurationSec: 0 };
  }
}

// ── Virtual staging ─────────────────────────────────────────────────────────

/** Staging styles a listing agent actually asks for — the menu every virtual
 *  staging vendor offers. "auto" lets the stager read the room and pick. */
export const STAGING_STYLES = [
  { id: "auto", name: "Let the stager decide", hint: "Reads the room's finishes, light, and likely buyer" },
  { id: "modern", name: "Modern", hint: "Clean lines, low profiles, neutral with one accent" },
  { id: "transitional", name: "Transitional", hint: "Classic shapes, current fabrics — the broadest buyer appeal" },
  { id: "scandinavian", name: "Scandinavian", hint: "Light woods, white, wool, and paper light" },
  { id: "mid-century", name: "Mid-Century Modern", hint: "Walnut, tapered legs, saturated accents" },
  { id: "coastal", name: "Coastal", hint: "Linen, rattan, driftwood, blue-green accents" },
  { id: "farmhouse", name: "Modern Farmhouse", hint: "Reclaimed wood, black metal, cream textiles" },
  { id: "luxury", name: "Luxury Contemporary", hint: "Marble, velvet, brass, statement lighting" },
  { id: "japandi", name: "Japandi", hint: "Low furniture, oak, stone, quiet palette" },
  { id: "industrial", name: "Industrial", hint: "Leather, steel, exposed materials" },
] as const;
export type StagingStyleId = (typeof STAGING_STYLES)[number]["id"];
export const StagingStyleIdSchema = z.enum(
  STAGING_STYLES.map((s) => s.id) as [StagingStyleId, ...StagingStyleId[]]
);

export function getStagingStyle(id: string | null | undefined) {
  return STAGING_STYLES.find((s) => s.id === id) ?? STAGING_STYLES[0];
}

/** Rooms the wizard offers. "auto" = the stager identifies it from the photo. */
export const STAGING_ROOM_TYPES = [
  "auto",
  "Living room",
  "Primary bedroom",
  "Bedroom",
  "Dining room",
  "Kitchen",
  "Home office",
  "Family room",
  "Kids room",
  "Nursery",
  "Basement",
  "Patio / outdoor",
  "Studio / open plan",
] as const;

/** Max client-furniture references a staging can carry. gpt-image-2.5's edit
 *  endpoint takes 16 images total; one slot is the room photo. */
export const STAGING_MAX_FURNITURE_REFS = 8;

/** Persisted on projects.staging — what the stager read + was asked for. */
export type StagingBrief = {
  /** Room identified (or operator-chosen). */
  roomType: string;
  /** Staging style label actually used (Title Case). */
  styleName: string;
  /** Operator's free-text direction, if any. */
  brief: string | null;
  /** The stager's read of the empty room — flooring, walls, light, features.
   *  Feeds the captions so they describe THIS room, not "a room". */
  roomRead: string;
  /** How many client-furniture reference photos were attached. */
  furnitureReferenceCount: number;
  /** The upload was FURNISHED: scene 2 is the cleared (unfurnished) room,
   *  scene 3 the staged after. Undefined/false = upload was already empty. */
  unfurnish?: boolean;
};

/** Scene roles inside a staging project, derived from order + unfurnish. */
export type StagingRole = "original" | "cleared" | "staged";
export function stagingRoleFor(unfurnish: boolean | undefined, order: number): StagingRole {
  if (order === 1) return "original";
  if (unfurnish && order === 2) return "cleared";
  return "staged";
}
