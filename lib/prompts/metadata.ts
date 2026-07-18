import { z } from "zod";
import { generateJSON } from "@/lib/llm";
import type { Format, PromptableConcept, PropertyType, WorldType } from "./types";

// ── Hashtag caps (per platform) ─────────────────────────────────────────────
// TikTok and IG algorithms now favor 3-5 focused tags over the old 30-cap
// dump; YouTube Shorts prominently surfaces the first 1-3.
const REEL_PLATFORM_HASHTAGS = z.array(z.string().min(1).max(40)).min(3).max(5);
const SHORTS_HASHTAGS = z.array(z.string().min(1).max(40)).min(1).max(3);

// ── Locked hashtags per visual lane ────────────────────────────────────────
// Operator-mandated anchor tags that ALWAYS appear in IG + TikTok hashtag
// arrays. GPT-5.5 is told about them in the system prompt + we enforce them
// server-side at finalize. Shorts hashtags stay free since the 1-3 slot cap
// is too tight to lock multiple tags.
const LOCKED_HASHTAGS_BY_WORLD: Record<WorldType, string[]> = {
  interior: ["interiordesign", "interiors"],
  exterior: ["architecture", "architect", "archdaily"],
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

/**
 * YouTube long-form metadata (style-explorer). A single SEO-optimised package:
 * a title, the short overlay text the operator burns into their thumbnail, a
 * fully-assembled description (hook + body + chapters + CTA + hashtags), tags,
 * and the hashtag set. The `description` is assembled deterministically in
 * finalize (assembleYouTubeMetadata) so the chapter list matches the actual
 * styles and the CTA links are real, never hallucinated.
 */
export const YouTubeMetadataSchema = z.object({
  kind: z.literal("youtube"),
  title: z.string().min(8).max(100),
  thumbnailText: z.string().min(2).max(40),
  description: z.string().min(40).max(5000),
  tags: z.array(z.string().min(1).max(60)).min(3).max(15),
  hashtags: z.array(z.string().min(1).max(40)).min(2).max(5),
});
export type YouTubeMetadata = z.infer<typeof YouTubeMetadataSchema>;

export const MetadataSchema = z.discriminatedUnion("kind", [
  ReelMetadataSchema,
  CarouselMetadataSchema,
  YouTubeMetadataSchema,
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
   *  CTA copy — GPT-5.5 only learns about apps that are actually live. */
  appNames: string[];
};

// ── System prompts (per variant) ───────────────────────────────────────────

/** One-liner blurbs for each app the operator might run. Only shown to
 *  GPT-5.5 when the corresponding app is in the operator's active config. */
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
 * Apps are passed in at runtime (operator-aware) so GPT-5.5 only learns
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

/** Per-lane hashtag-locks rule that GPT-5.5 needs to obey. We also enforce
 *  server-side, but explaining the rule keeps GPT-5.5's variable choices
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
    // Floor matches the 40-80 guidance above (a sub-40-char title is wasting
    // YouTube search real estate); soft ceiling 80 with headroom to 100.
    shortsTitle: { type: "string", minLength: 40, maxLength: 100 },
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
      // Inject the discriminator client-side — GPT-5.5 returns the field shape,
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
    default:
      // style-explorer has no metadata variant yet — YouTube SEO metadata
      // (title/description/tags/chapters) lands in a later slice. Finalize is
      // gated off for this format in the UI, so this should be unreachable.
      throw new Error(
        `Metadata generation is not supported for format "${input.format}" yet.`
      );
  }
}

// ── YouTube long-form metadata (style-explorer) ─────────────────────────────
//
// A separate generator from the social `generateMetadata` above: YouTube
// long-form is searched (not just fed), so the title/description/tags are
// optimised for SEO + click-through rather than caption vibes. GPT-5.5 writes
// the creative fields; finalize assembles the final description deterministically
// (chapters from the real styles, CTA with real links).

const YouTubeDraftSchema = z.object({
  title: z.string().min(8).max(100),
  thumbnailText: z.string().min(2).max(40),
  descriptionHook: z.string().min(20).max(220),
  descriptionBody: z.string().min(120).max(3500),
  tags: z.array(z.string().min(2).max(60)).min(6).max(12),
  hashtags: z.array(z.string().min(2).max(40)).min(3).max(5),
});
export type YouTubeDraft = z.infer<typeof YouTubeDraftSchema>;

export type YouTubeMetadataInput = {
  /** What the space actually IS — the operator's own base description (e.g. "a
   *  double-height living room with floor-to-ceiling windows onto a garden").
   *  Grounds the title + description in the real space instead of a generic
   *  "residential interior". */
  spaceDescription: string;
  /** Operator steering — location ("South Florida"), tier ("high-end"), angle. */
  notes?: string;
  worldType: WorldType;
  propertyType: PropertyType;
  /** Ordered style names featured in the video (excludes the "Original" intro). */
  styleNames: string[];
};

function buildYouTubeSystem(): string {
  return `You write YouTube metadata for a long-form video that takes ONE real space and reimagines it in several named interior/architectural design styles — a "styles of this space" walkthrough. The video is a visual montage; you are NOT writing a voiceover.

Optimise for YouTube search AND click-through. Follow every rule below — these reflect current YouTube SEO best practice.

TITLE — the single biggest CTR lever:
- 50-65 characters. Put the primary keyword in the FIRST 3-5 words.
- Be SPECIFIC to the actual space. If the description makes the room/space type clear (living room, kitchen, bedroom, facade, lobby…), NAME it — never fall back to a generic "residential interior." Fold in the location/tier from the operator's steering when it sharpens the hook.
- Make ONE honest, specific promise built on the payoff: the SAME space, many distinct styles. Use the NUMBER of styles.
- Write it like a human editor, not a fill-in-the-blank template. AVOID formulaic shapes like "X Design Styles: 1 Same Space, N Looks" or anything with a "Category: subtitle" colon. Vary it — a question, a bold claim, a "this [room], N ways" hook all work. It should feel scroll-stopping and natural.
- You may CAPITALISE one power word for emphasis (e.g. "the SAME room") — at most one. No clickbait, no full ALL-CAPS, no emoji. It must match what the video delivers (YouTube penalises mismatches).

THUMBNAIL TEXT — the punchy overlay the operator burns into their thumbnail:
- 1-3 words, ABSOLUTE max 5. Under ~20 characters. Bold, readable at a glance on a phone.
- It must NOT be the title, a truncation of the title, or a full sentence. The title carries the specifics; the thumbnail is the 2-3 word gut-punch — and it can name the space (e.g. "1 LIVING ROOM", "10 WAYS", "SAME ROOM", "WHICH ONE?").

DESCRIPTION HOOK (descriptionHook):
- The first ~150 characters — the ONLY part most viewers see before "...more". One or two sentences that restate the promise while referencing the ACTUAL space (the real room/space type from the description), primary keyword early and natural. No links, no hashtags here.

DESCRIPTION BODY (descriptionBody):
- 150-300 words of genuinely useful context: what the video shows, the design styles featured, who it helps (homeowners choosing a direction, designers gathering references), and what makes the styles distinct. Keyword-rich but written for a human — never stuffed.
- Refer to the REAL space ("this double-height living room", "this kitchen") rather than a generic "room" — mirror the operator's description, don't flatten it.
- Do NOT include links, chapters/timestamps, hashtags, or "like and subscribe" — those are appended automatically. Prose only.

TAGS:
- 8-12 tags. Mix 2-3 exact-match primary keywords (e.g. "interior design styles"), 3-5 specific long-tail phrases (e.g. "living room design ideas 2026"), and a couple of broader category tags. Lowercase, no # prefix.

HASHTAGS:
- 3-5, no # prefix, ordered strongest-first (the first few render above the title). Real, popular, on-topic tags (e.g. interiordesign, homedecor, designideas).`;
}

function buildYouTubeUser(input: YouTubeMetadataInput): string {
  const space = `${input.propertyType} ${input.worldType}`;
  const lines = [
    `The video takes ONE specific space and reimagines it in ${input.styleNames.length} distinct interior/architectural design styles — the same space, restyled each time.`,
    `THE SPACE — ground the title, thumbnail, and description in THIS, the operator's own words. Name the actual room/space type when it's clear (living room, kitchen, bedroom, facade, lobby…); do NOT default to a generic "${space}":`,
    `"${input.spaceDescription.trim()}"`,
    `Styles featured, in order: ${input.styleNames.join(", ")}.`,
  ];
  if (input.notes && input.notes.trim()) {
    lines.push(
      `Operator steering — let it shape the angle, tone, and any location keyword: ${input.notes.trim()}`
    );
  }
  lines.push(
    "",
    `Write metadata that ranks and earns the click for someone searching design ideas for THIS exact kind of space. Make it specific to the room above — not boilerplate.`
  );
  return lines.join("\n");
}

const YOUTUBE_TOOL_SCHEMA = {
  type: "object",
  properties: {
    title: {
      type: "string",
      minLength: 8,
      maxLength: 100,
      description: "SEO title. 55-65 chars, primary keyword in the first 3-5 words, one honest specific promise, include the number of styles. At most ONE capitalised power word. No emoji, no all-caps, no clickbait.",
    },
    thumbnailText: {
      type: "string",
      minLength: 2,
      maxLength: 40,
      description: "Overlay text for the thumbnail. 1-3 words (max 5), under ~20 chars, punchy. COMPLEMENTS the title, does not repeat it (e.g. \"1 ROOM, 10 WAYS\", \"SAME SPACE\", \"WHICH ONE?\").",
    },
    descriptionHook: {
      type: "string",
      minLength: 20,
      maxLength: 220,
      description: "First ~150 chars of the description (all most viewers see before '...more'). 1-2 sentences restating the promise with the primary keyword early. No links or hashtags.",
    },
    descriptionBody: {
      type: "string",
      minLength: 120,
      maxLength: 3500,
      description: "150-300 words of useful, keyword-rich-but-human context: what the video shows, the styles featured, who it helps, what makes each distinct. NO links, NO chapters/timestamps, NO hashtags, NO subscribe CTA — those are appended automatically.",
    },
    tags: {
      type: "array",
      minItems: 6,
      maxItems: 12,
      items: { type: "string", minLength: 2, maxLength: 60 },
      description: "8-12 search tags: 2-3 exact-match primary keywords, 3-5 long-tail phrases, a couple broad category tags. Lowercase, no # prefix.",
    },
    hashtags: {
      type: "array",
      minItems: 3,
      maxItems: 5,
      items: { type: "string", minLength: 2, maxLength: 40 },
      description: "3-5 hashtags, no # prefix, strongest first (the first few show above the title). Real, popular, on-topic.",
    },
  },
  required: ["title", "thumbnailText", "descriptionHook", "descriptionBody", "tags", "hashtags"],
  additionalProperties: false,
} as const;

/** tool_use treats maxLength as a soft hint. Trim the text fields to their caps
 *  before Zod so a slightly-long title/thumbnail/description never hard-fails
 *  finalize (mirrors safeTruncateConcept). */
function coerceYouTubeDraft(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const o = { ...(raw as Record<string, unknown>) };
  const caps: Array<{ key: string; max: number }> = [
    { key: "title", max: 100 },
    { key: "thumbnailText", max: 40 },
    { key: "descriptionHook", max: 220 },
    { key: "descriptionBody", max: 3500 },
  ];
  for (const { key, max } of caps) {
    const v = o[key];
    if (typeof v === "string" && v.length > max) {
      console.warn(`[youtube] GPT-5.5 overshot ${key} (${v.length} > ${max}); truncating.`);
      o[key] = v.slice(0, max).trimEnd();
    }
  }
  return o;
}

export async function generateYouTubeMetadata(input: YouTubeMetadataInput): Promise<YouTubeDraft> {
  const raw = await generateJSON<unknown>({
    system: buildYouTubeSystem(),
    user: buildYouTubeUser(input),
    schema: YOUTUBE_TOOL_SCHEMA as unknown as Record<string, unknown>,
    toolName: "submit_youtube_metadata",
    maxTokens: 2500,
  });
  return YouTubeDraftSchema.parse(coerceYouTubeDraft(raw));
}

/**
 * Assemble the final, paste-ready YouTube description from GPT-5.5's creative
 * draft + the project's real styles and the operator's real links. Done
 * deterministically (not by GPT-5.5) so chapters match the actual styles and the
 * CTA links are never hallucinated. Chapter start times are computed from the
 * stitch's uniform per-still hold (Original at 00:00, style k at k ×
 * perStillSec) — matches stitchFinalVideo's default timing; re-stitching with
 * a custom perStillSec shifts them proportionally.
 */
export function assembleYouTubeMetadata(opts: {
  draft: YouTubeDraft;
  styleNames: string[];
  appName: string;
  instagram: string;
  website: string;
  /** Seconds each still holds in the stitched long-form. Defaults to the
   *  stitch default (7s). */
  perStillSec?: number;
}): YouTubeMetadata {
  const hashtags = opts.draft.hashtags.map((h) => h.replace(/^#/, ""));
  const per = opts.perStillSec ?? 7;
  const stamp = (sec: number) =>
    `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
  const chapterLines = [
    "00:00 Intro",
    ...opts.styleNames.map((s, i) => `${stamp((i + 1) * per)} ${s}`),
  ].join("\n");
  const cta = [
    "———",
    `Design your own space with ${opts.appName} 👇`,
    `🌐 ${opts.website}`,
    `📸 Instagram: @${opts.instagram}`,
  ].join("\n");
  const description = [
    opts.draft.descriptionHook.trim(),
    "",
    opts.draft.descriptionBody.trim(),
    "",
    "⏱ CHAPTERS:",
    chapterLines,
    "",
    cta,
    "",
    hashtags.map((h) => `#${h}`).join(" "),
  ]
    .join("\n")
    .slice(0, 5000);
  return {
    kind: "youtube",
    title: opts.draft.title.trim(),
    thumbnailText: opts.draft.thumbnailText.trim(),
    description,
    tags: opts.draft.tags,
    hashtags,
  };
}
