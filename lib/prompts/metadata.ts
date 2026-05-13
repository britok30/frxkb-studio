import { z } from "zod";
import { generateJSON } from "@/lib/claude";
import type { Format, PromptableConcept, WorldType } from "./types";

// ── Hashtag caps (per platform) ─────────────────────────────────────────────
// TikTok and IG algorithms now favor 3-5 focused tags over the old 30-cap
// dump; YouTube Shorts prominently surfaces the first 1-3.
const REEL_PLATFORM_HASHTAGS = z.array(z.string().min(1).max(40)).min(3).max(5);
const SHORTS_HASHTAGS = z.array(z.string().min(1).max(40)).min(1).max(3);

// ── Locked hashtags per visual lane ────────────────────────────────────────
// Operator-mandated anchor tags that ALWAYS appear in IG + TikTok hashtag
// arrays. Claude is told about them in the system prompt + we enforce them
// server-side at finalize. Shorts hashtags stay free since the 1-3 slot cap
// is too tight to lock multiple tags.
const LOCKED_HASHTAGS_BY_WORLD: Record<WorldType, string[]> = {
  interior: ["interiordesign", "interiors"],
  exterior: ["architecture", "architect", "architectura"],
};

/** Total hashtag slots on IG/TikTok per lane (locks + variable design tags). */
const HASHTAG_TARGET_TOTAL = 5;

// ── Variant schemas ────────────────────────────────────────────────────────

/**
 * Reel metadata: cross-posted to TikTok, Instagram Reels, and YouTube Shorts.
 * Each platform gets its own caption shape because the conventions differ:
 * TikTok rewards a punchy 1-line hook, IG allows longer copy with a story
 * arc, Shorts wants an SEO-leaning title (Shorts are searched on YouTube).
 *
 * Hashtags live in their own arrays — never inline in the caption — so the
 * operator pastes caption + hashtag block separately on each platform.
 */
export const ReelMetadataSchema = z.object({
  kind: z.literal("reel"),
  tiktokCaption: z.string().min(20).max(300),
  tiktokHashtags: REEL_PLATFORM_HASHTAGS,
  instagramCaption: z.string().min(20).max(2200),
  instagramHashtags: REEL_PLATFORM_HASHTAGS,
  shortsTitle: z.string().min(8).max(100),
  shortsDescription: z.string().min(40).max(5000),
  shortsHashtags: SHORTS_HASHTAGS,
  pinnedComment: z.string().min(10).max(800),
});
export type ReelMetadata = z.infer<typeof ReelMetadataSchema>;

/**
 * Carousel metadata: Instagram-native format. Just one caption + hashtags.
 */
export const CarouselMetadataSchema = z.object({
  kind: z.literal("carousel"),
  instagramCaption: z.string().min(20).max(2200),
  instagramHashtags: REEL_PLATFORM_HASHTAGS,
});
export type CarouselMetadata = z.infer<typeof CarouselMetadataSchema>;

export const MetadataSchema = z.discriminatedUnion("kind", [
  ReelMetadataSchema,
  CarouselMetadataSchema,
]);
export type Metadata = z.infer<typeof MetadataSchema>;

export type MetadataInput = {
  concept: PromptableConcept;
  niche: string;
  format: Format;
  worldType: WorldType;
  sceneCount: number;
  totalDurationSec: number;
  /** App names from the operator's config (operator.apps[].name). Drives the
   *  CTA copy — Claude only learns about apps that are actually live. */
  appNames: string[];
};

// ── System prompts (per variant) ───────────────────────────────────────────

/** One-liner blurbs for each app the operator might run. Only shown to
 *  Claude when the corresponding app is in the operator's active config. */
const APP_BLURBS: Record<string, string> = {
  ArchitectGPT: "**ArchitectGPT** — generates architecture concepts and reimagines exteriors",
  CasaGPT: "**CasaGPT** — interior design assistant for homes and rooms",
  InteriorGPT: "**InteriorGPT** — interior design assistant",
};

function appsBlock(appNames: string[]): string {
  if (appNames.length === 0) {
    // No apps configured — drop the CTA section entirely. Should be rare.
    return "The operator has no app CTAs configured — write metadata that stands on its own. No app mentions, no {APP_LINK} placeholder.";
  }
  if (appNames.length === 1) {
    const name = appNames[0];
    const blurb = APP_BLURBS[name] ?? `**${name}**`;
    return `The operator runs one AI app and wants every post to subtly drive traffic to it:
- ${blurb}

When mentioning ${name}, be subtle and value-driven, never salesy. Use the placeholder URL "{APP_LINK}" — the operator substitutes the real link. Never mention ${name} at the front of any post — keep openings clean. Mentions only in description bodies and pinned comments.`;
  }
  // Multi-app fallback (legacy path; current operator config has one app each).
  const list = appNames.map((n) => `- ${APP_BLURBS[n] ?? `**${n}**`}`).join("\n");
  return `The operator builds multiple AI apps that may be relevant to mention in CTAs:
${list}

When mentioning any of them, be subtle and value-driven, never salesy. Use the placeholder URL "{APP_LINK}" — the operator substitutes the real link. Mention only the app most relevant to the concept. Never mention an app at the front of any post — keep openings clean. Mentions only in description bodies and pinned comments.`;
}

/**
 * Shared preamble — channel identity, app CTA rules, voice constraints.
 * Each format-specific system prompt appends its own field requirements.
 *
 * Apps are passed in at runtime (operator-aware) so Claude only learns
 * about apps that are actually live in the operator's config.
 */
function metadataPreamble(appNames: string[]): string {
  return `You write metadata for a faceless ambient slideshow about architecture and interior design. The video itself is silent (no voiceover) — your copy should reflect "watch and feel" energy, not narration. Think "this is what a Sunday afternoon feels like in 1965 São Paulo" — not "in this video we explore 10 amazing rooms."

${appsBlock(appNames)}

Hard nos across every field:
- No "Don't forget to like and subscribe."
- No "In this video we will…"
- No emojis in titles or description bodies. Captions may use 1 sparingly (TikTok/IG only).
- No clickbait ("YOU WON'T BELIEVE", "THIS CHANGED EVERYTHING").
- No ALL CAPS.`;
}

/** Per-lane hashtag-locks rule that Claude needs to obey. We also enforce
 *  server-side, but explaining the rule keeps Claude's variable choices
 *  thematically distinct from the locks (no duplicates, no near-duplicates). */
function lockedHashtagsRule(worldType: WorldType): string {
  const locked = LOCKED_HASHTAGS_BY_WORLD[worldType];
  const variableSlots = HASHTAG_TARGET_TOTAL - locked.length;
  const lockedList = locked.map((t) => `'${t}'`).join(", ");
  return `Hashtag rule for this ${worldType} project — both tiktokHashtags AND instagramHashtags MUST include the locked anchors ${lockedList} (lowercase, no '#' prefix in the array values). Use the remaining ${variableSlots} slot${variableSlots === 1 ? "" : "s"} for design-specific tags (era, region, material, style, mood). Don't pick variable tags that overlap with the locks. Total = ${HASHTAG_TARGET_TOTAL} per array.`;
}

export function buildReelMetadataSystem(
  appNames: string[],
  worldType: WorldType
): string {
  // Pinned-comment example uses the first configured app — keeps the example
  // honest to what the operator actually runs.
  const pinnedExampleApp = appNames[0] ?? "the app";
  return `${metadataPreamble(appNames)}

This is a REEL — short vertical video cross-posted to TikTok, Instagram Reels, and YouTube Shorts. Each platform has different conventions; write distinct copy for each. Hashtags live in their own fields — NEVER include hashtags inline in caption text.

${lockedHashtagsRule(worldType)}

Field requirements:
- **tiktokCaption**: 60-150 chars. One punchy hook line. Native TikTok voice — direct, present-tense, no preamble. No hashtags inline. No "POV:" unless it actually fits the niche.
- **tiktokHashtags**: 5 tags total. Follow the lane rule above (locked anchors + design tags). Lowercase, no # prefix in the array values.
- **instagramCaption**: 80-300 chars. Slightly more story-shaped than TikTok — opens with the hook, second line adds mood/context. Single line break between sentences. No hashtags inline.
- **instagramHashtags**: 5 tags total. Follow the lane rule above. Lowercase, no #.
- **shortsTitle**: 40-80 chars. Shorts are SEARCHED on YouTube — write with light SEO in mind: include the era/region/material as keywords, but keep it human. Numbers ok if relevant.
- **shortsDescription**: 100-400 chars. 1-2 short paragraphs. Para 1: the hook. Para 2: subtle app CTA using "{APP_LINK}" once, phrased as if the operator uses the app to riff on these spaces.
- **shortsHashtags**: 1-3 tags. Shorts only surfaces the first 1-2 prominently — pick the strongest anchor for the lane plus optionally one niche tag. Lowercase, no #.
- **pinnedComment**: 1-2 conversational sentences. Mentions the relevant app naturally with "{APP_LINK}". Reusable across all three platforms. Example tone: "Sketched a few of these in ${pinnedExampleApp} before generating — link if you want to riff: {APP_LINK}".`;
}

export function buildCarouselMetadataSystem(
  appNames: string[],
  worldType: WorldType,
  format: Format = "carousel",
): string {
  // Before-after IS the demo for the operator's app — the transformation
  // earned the right to a soft CTA, and viewers expect "you can do this too"
  // at the end. Pure carousels stay clean (organic ambient content).
  const captionRule =
    format === "before-after"
      ? `- **instagramCaption**: 100-400 chars. Open with the transformation moment (what changed, in one sentence). Second sentence adds mood/atmosphere. Close with ONE soft CTA inviting viewers to try the same with the operator's app — use the literal placeholder "{APP_LINK}" exactly once, at the end. The operator substitutes the real URL. Example shape: "...Reimagine your own at {APP_LINK}." No hashtags inline.`
      : `- **instagramCaption**: 100-400 chars. Longer than a Reel caption since carousel viewers spend more time on the post. Open with the hook, second sentence adds mood/context, third sentence (optional) invites the swipe ("swipe to walk through it"). No hashtags inline. No app mention in the caption text.`;
  return `${metadataPreamble(appNames)}

This is an INSTAGRAM ${format === "before-after" ? "BEFORE/AFTER" : "CAROUSEL"} — a swipeable static slide post, Instagram-native. The viewer swipes through the slides at their own pace.

${lockedHashtagsRule(worldType)}

Field requirements:
${captionRule}
- **instagramHashtags**: 5 tags total. Follow the lane rule above. Lowercase, no #.`;
}

// ── Tool schemas (per variant) ─────────────────────────────────────────────

const REEL_TOOL_SCHEMA = {
  type: "object",
  properties: {
    tiktokCaption: { type: "string", minLength: 20, maxLength: 300 },
    tiktokHashtags: {
      type: "array",
      minItems: 3,
      maxItems: 5,
      items: { type: "string", minLength: 1, maxLength: 40 },
    },
    instagramCaption: { type: "string", minLength: 20, maxLength: 2200 },
    instagramHashtags: {
      type: "array",
      minItems: 3,
      maxItems: 5,
      items: { type: "string", minLength: 1, maxLength: 40 },
    },
    shortsTitle: { type: "string", minLength: 8, maxLength: 100 },
    shortsDescription: { type: "string", minLength: 40, maxLength: 5000 },
    shortsHashtags: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: { type: "string", minLength: 1, maxLength: 40 },
    },
    pinnedComment: { type: "string", minLength: 10, maxLength: 800 },
  },
  required: [
    "tiktokCaption",
    "tiktokHashtags",
    "instagramCaption",
    "instagramHashtags",
    "shortsTitle",
    "shortsDescription",
    "shortsHashtags",
    "pinnedComment",
  ],
  additionalProperties: false,
} as const;

const CAROUSEL_TOOL_SCHEMA = {
  type: "object",
  properties: {
    instagramCaption: { type: "string", minLength: 20, maxLength: 2200 },
    instagramHashtags: {
      type: "array",
      minItems: 3,
      maxItems: 5,
      items: { type: "string", minLength: 1, maxLength: 40 },
    },
  },
  required: ["instagramCaption", "instagramHashtags"],
  additionalProperties: false,
} as const;

// ── Per-variant user-message + tool name ───────────────────────────────────

export function buildMetadataUser(input: MetadataInput): string {
  const { concept, niche, format, sceneCount, totalDurationSec } = input;
  const durationLabel =
    totalDurationSec === 0
      ? `${sceneCount} static slides`
      : totalDurationSec < 60
        ? `~${totalDurationSec}s`
        : `~${Math.round((totalDurationSec / 60) * 10) / 10} min`;

  return [
    `Concept: ${concept.workingTitle}`,
    `Hook: ${concept.hook}`,
    `Vibe: ${concept.vibe}`,
    concept.notes ? `Visual rules: ${concept.notes}` : "",
    "",
    `Niche: ${niche}`,
    `Format: ${format}`,
    `Scenes: ${sceneCount}`,
    `Duration: ${durationLabel}`,
    "",
    "Write the metadata for this piece. Follow the CTA rules from the system prompt for any app mentions.",
  ]
    .filter(Boolean)
    .join("\n");
}

// ── Public entry point ─────────────────────────────────────────────────────

export async function generateMetadata(input: MetadataInput): Promise<Metadata> {
  switch (input.format) {
    case "reel": {
      const raw = await generateJSON<unknown>({
        system: buildReelMetadataSystem(input.appNames, input.worldType),
        user: buildMetadataUser(input),
        schema: REEL_TOOL_SCHEMA as unknown as Record<string, unknown>,
        toolName: "submit_reel_metadata",
        maxTokens: 3000,
      });
      // Inject the discriminator client-side — Claude returns the field shape,
      // we tag it for the discriminated union.
      return ReelMetadataSchema.parse({ kind: "reel", ...(raw as object) });
    }
    case "carousel":
    case "before-after": {
      // Before-after posts ship to Instagram as a carousel-style post (before
      // still + after still + after video). Same metadata shape (one caption
      // + 3-5 hashtags) but a different caption rule — before-after gets a
      // soft CTA at the end, pure carousel stays clean. The format param
      // routes the system prompt; substituteAppLink in projects.ts runs the
      // {APP_LINK} replacement on the resulting caption either way.
      const raw = await generateJSON<unknown>({
        system: buildCarouselMetadataSystem(input.appNames, input.worldType, input.format),
        user: buildMetadataUser(input),
        schema: CAROUSEL_TOOL_SCHEMA as unknown as Record<string, unknown>,
        toolName: "submit_carousel_metadata",
        maxTokens: 1500,
      });
      return CarouselMetadataSchema.parse({ kind: "carousel", ...(raw as object) });
    }
  }
}
