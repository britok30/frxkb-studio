// Virtual staging — the prompts. Three jobs:
//   1. generateStagingBrief: GPT-6 SEES the empty-room photo (+ the client's
//      furniture photos) and writes the room read, the furniture plan, and
//      the edit instruction. Vision is what makes the plan fit THIS room —
//      a 10×11 bedroom with one window gets a different plan than a 20×30
//      great room, and the captions later lean on the same read.
//   2. buildStagingEditPrompt: wraps that plan in the deterministic staging
//      lock (add-only, preserve everything) before it hits gpt-image-2.5.
//   3. generateStagingMetadata: GPT-6 SEES the before AND the after and
//      writes the captions / listing blurb / client note about what is
//      actually in the render — never a template.

import { z } from "zod";
import { generateJSON } from "@/lib/llm";
import { StagingMetadataSchema, type StagingMetadata } from "./metadata";
import { getStagingStyle, type StagingStyleId } from "./types";

// ── Deterministic locks ─────────────────────────────────────────────────────

/**
 * Prepended to every staging edit. Where ARCHITECTURE_LOCK (restyle formats)
 * allows finishes to change, staging allows NOTHING that exists to change —
 * the deliverable is a listing photo and the buyer will walk into the real
 * room. Add-only.
 */
export const STAGING_LOCK =
  "Virtually stage this real-estate photograph of an empty room for a property listing. Keep it the EXACT same photograph: identical camera position, lens, framing, crop, and perspective. Preserve — pixel-faithfully — every existing element: the walls and their paint colour, the flooring material, colour, and grain direction, the ceiling, trim, baseboards, doors, windows and what is visible through them, blinds, built-ins, fireplace, radiators, vents, outlets, switches, light fixtures, and the existing daylight and shadows. Do NOT repaint, refloor, remove, move, resize, or restyle anything that is already there, and do not add or enlarge windows or openings. ONLY ADD furniture, rugs, lamps, art, mirrors, plants, and decor — placed at correct human scale, in correct perspective, sitting properly on the floor, with contact shadows and lighting that match the room's existing light. Leave clear walking paths and never block a door, a window, a closet, or a vent. The result must read as a professional staging photograph a buyer would believe. No people, no pets, no text, no logos, no watermarks. Furnish it as follows: ";

/** Re-asserted at the END of the prompt — long furniture lists can pull the
 *  model back toward "redesign the room"; the closer pins it to add-only. */
export const STAGING_LOCK_CLOSE =
  " FINAL CHECK — same photograph, same room, same finishes, same windows and views; the ONLY difference from the original is the added furniture and decor, which must be scale-correct and lit by the room's own light.";

/** Appended when the client supplied furniture photos. */
export function furnitureReferenceGuidance(refCount: number): string {
  if (refCount <= 0) return "";
  const noun = refCount === 1 ? "image is" : `${refCount} images are`;
  return ` The additional attached ${noun} the client's own furniture: reproduce those exact pieces — same design, silhouette, material, and colour — and place them in this room where the plan calls for them, scaled correctly for the space. Fill the rest of the room with complementary pieces that match their style; the client's pieces are the anchors.`;
}

/** The instruction gpt-image-2.5 actually receives. */
export function buildStagingEditPrompt(opts: {
  /** The stager's furniture plan for this room (scene.prompt). */
  plan: string;
  furnitureReferenceCount: number;
  /** Operator's one-off regen direction, layered last. */
  direction?: string;
}): string {
  const direction = opts.direction?.trim();
  return [
    STAGING_LOCK,
    opts.plan.trim(),
    furnitureReferenceGuidance(opts.furnitureReferenceCount),
    direction
      ? ` Additional direction from the operator (apply on top of the plan; it never overrides the preservation rules): ${direction}.`
      : "",
    STAGING_LOCK_CLOSE,
  ].join("");
}

/**
 * The unfurnish edit. Everything freestanding goes; the architecture is
 * reconstructed where things were. This is the "restage" prep: the output
 * becomes the empty room the staging pass furnishes.
 */
export const UNFURNISH_PROMPT =
  "Remove ALL furniture and decor from this real-estate photograph so the room is completely empty and ready to be staged from scratch. Take out every freestanding and movable item: sofas, chairs, tables, beds, dressers, desks, shelving units, rugs, lamps, wall art, mirrors, TVs and wall-mounted screens, curtains and drapes that hang on rods, plants, cushions, boxes, clutter, cables, and every personal item. KEEP everything that is part of the property: walls and their paint colour, flooring, ceiling, trim and baseboards, doors, windows and blinds or shutters that are fitted to the window, built-in cabinetry and shelving, kitchen and bathroom fixtures, fireplace, radiators, vents, outlets, switches, ceiling and wall light fixtures. Keep the EXACT same photograph: identical camera position, lens, framing, crop, and perspective; identical daylight, shadows from the windows, and colour. Where an item is removed, reconstruct the floor, wall, baseboard, and any partially hidden window or door behind it so they continue seamlessly, matching the visible material, grain direction, and colour — no smudges, no ghost outlines, no invented features. The result must look like an honest listing photo of the same vacant room. No people, no text, no watermarks.";

/** Deterministic MLS disclosure — the line every staged listing photo needs. */
export const STAGING_DISCLOSURE =
  "Virtually staged. Furniture and decor shown are digital renderings for illustration and do not convey with the property.";

// ── 1. Staging brief (vision) ───────────────────────────────────────────────

export const StagingBriefResponseSchema = z.object({
  roomType: z.string().min(3).max(60),
  workingTitle: z.string().min(3).max(120),
  hook: z.string().min(8).max(240),
  roomRead: z.string().min(40).max(1500),
  styleName: z.string().min(3).max(60),
  styleSubtitle: z.string().min(3).max(120),
  furniturePlan: z.array(z.string().min(4).max(160)).min(6).max(15),
  stagingPrompt: z.string().min(120).max(2200),
  notes: z.string().max(1200).default(""),
});
export type StagingBriefResponse = z.infer<typeof StagingBriefResponseSchema>;

export type StagingBriefInput = {
  /** Public Blob URL of the empty-room photo. */
  beforeImageUrl: string;
  /** Public Blob URLs of the client's furniture photos (0-8). */
  furnitureReferenceUrls?: string[];
  /** Operator-chosen room, or "auto" to identify from the photo. */
  roomType?: string;
  styleId?: StagingStyleId | string;
  /** Free-text direction: target buyer, must-haves, palette, "keep the
   *  desk on the window wall", etc. */
  brief?: string;
  /** The photo is currently FURNISHED and will be emptied before staging —
   *  read the architecture, ignore the existing furniture. */
  furnished?: boolean;
};

export function buildStagingBriefSystem(): string {
  return `You are a senior virtual stager for a real-estate photography studio. A listing agent has sent you a photograph of an EMPTY (or nearly empty) room. Your job is to plan the staging that will help that room sell: read the room precisely, decide the furniture, and write the edit instruction the image model will follow.

You can SEE the room photo in this message (image 1). If more images follow, they are the client's OWN furniture pieces they want placed in the room — identify each one (what it is, its material and colour) and build the plan around them.

Study image 1 first and read it like a stager walking the room:
- What room it is (or could most credibly be sold as) and its approximate size and proportions.
- The flooring (material, colour, plank direction), wall colour, ceiling height and features, trim, and any fixed elements (fireplace, built-ins, radiators, closets, kitchen runs).
- Every window and door: where they are, which walls are free, where the natural focal wall is, and which way people will walk through the room.
- The light: direction, warmth, time of day. Added furniture must sit in THIS light.

Staging rules (these are what separate a believable listing photo from an AI render):
- The room, its finishes, its windows, and its light NEVER change. You only ADD furniture and decor. Never propose paint, flooring, window treatments that replace what exists, structural changes, or removing anything.
- Scale is everything. Furniture must be sized to the actual room — a small bedroom gets a queen, not a king with two nightstands and a bench. Leave 30-36 inches of walkway; never block a door, a window, a closet, or a vent.
- Stage for the buyer, not for a magazine. Neutral, warm, current, aspirational-but-believable. One anchored seating or sleeping arrangement, a rug that anchors it, layered lighting (a floor or table lamp), art at eye level on the focal wall, one or two plants, a few styled surfaces. No clutter, no personal photos, no TV unless the room is obviously a media room.
- Define the room's purpose at a glance: a buyer should know in one second that this is the dining room / the primary bedroom / the home office.
- If the operator named a room type, style, or gave a brief, obey it literally — those are hard constraints. If they left the style to you, choose the style the room's finishes and likely buyer call for.
- If the client supplied furniture photos, those pieces are mandatory anchors: name them in the plan exactly as they appear (material, colour, shape) and place them where they fit; fill the rest with complementary pieces.

Return these fields:
- roomType: the room as it should be staged and sold ("Living room", "Primary bedroom", "Home office", "Dining room" …). Honour the operator's choice if given.
- workingTitle: 3-7 words, an internal title for this staging ("Sunlit Oak-Floor Living Room").
- hook: ONE sentence (max 240 chars) — what this staging makes the buyer feel about the room.
- roomRead: 3-5 concrete sentences describing what is actually in the photo — room size/proportions, flooring, wall colour, ceiling, windows and light direction, fixed features, and the focal wall. Specific enough that a caption writer who never saw the photo could describe the room accurately. No furniture (there is none yet).
- styleName: the staging style used, Title Case, 2-4 words ("Warm Transitional", "Scandinavian", "Modern Farmhouse").
- styleSubtitle: one short line (4-10 words) — the palette and materials of the staging ("Oatmeal linen, white oak, brushed brass").
- furniturePlan: 6-15 items, each "piece — placement" ("Oatmeal bouclé three-seat sofa — centred on the long wall facing the windows"). Include the rug, lighting, art, and plants. Mark any client piece with "(client's piece)".
- stagingPrompt: ONE paragraph (120-2200 chars) — the instruction the image model follows. Begin with "Furnish this [roomType] as a [styleName] space:". Then list the pieces from the plan with their placement, materials, and colours; the rug; the lighting; the art and decor; the plants; and one closing sentence about the mood of the finished room. Do NOT mention the camera, the walls, the floor, the windows, or the light — a fixed preservation instruction is prepended automatically and covers them. Do NOT say "create", "design", "transform", or "renovate" — only "furnish", "place", "add", "hang", "layer". No people, no text.
- notes: 0-5 terse bullet lines of constraints worth carrying to a regeneration (e.g. "keep the window wall clear — it's the view", "queen only, the room is ~11 ft wide"). May be empty.`;
}

export function buildStagingBriefUser(input: StagingBriefInput): string {
  const refs = input.furnitureReferenceUrls ?? [];
  const style = getStagingStyle(input.styleId);
  const lines: string[] = [
    input.furnished
      ? "Plan the virtual staging for the room photographed in image 1. NOTE: the photo is currently FURNISHED. Every freestanding item in it will be digitally removed BEFORE your plan is rendered, so read ONLY the architecture — floors, walls, ceiling, windows, doors, built-ins, light — and plan the furniture from scratch as if the room were empty. Do not describe, keep, or reuse the existing furniture in roomRead or the plan (the roomRead should describe the room as it will look once cleared)."
      : "Plan the virtual staging for the empty room photographed in image 1.",
    "",
    input.roomType && input.roomType !== "auto"
      ? `Room type (operator's choice — stage it as this): ${input.roomType}`
      : "Room type: identify it from the photo and stage it as the room it will sell best as.",
    style.id === "auto"
      ? "Style: your call — pick what the finishes and likely buyer call for, and name it."
      : `Style (operator's choice — a hard constraint): ${style.name} — ${style.hint}.`,
  ];
  if (input.brief && input.brief.trim()) {
    lines.push(
      "",
      `THE BRIEF — obey every constraint here literally (target buyer, must-haves, palette, things to avoid):\n${input.brief.trim()}`
    );
  }
  if (refs.length > 0) {
    lines.push(
      "",
      `Images 2-${refs.length + 1} are the client's OWN furniture (${refs.length} piece${refs.length === 1 ? "" : "s"}). Identify each, name it precisely in the plan marked "(client's piece)", and place them in the room. They are mandatory.`
    );
  }
  lines.push(
    "",
    "Return the staging brief. Remember: the room, its finishes, windows, and light stay exactly as photographed — you only add furniture and decor."
  );
  return lines.join("\n");
}

const STAGING_BRIEF_TOOL_SCHEMA = {
  type: "object",
  properties: {
    roomType: { type: "string", minLength: 3, maxLength: 60 },
    workingTitle: { type: "string", minLength: 3, maxLength: 120 },
    hook: { type: "string", minLength: 8, maxLength: 240 },
    roomRead: {
      type: "string",
      minLength: 40,
      maxLength: 1500,
      description:
        "3-5 concrete sentences: size/proportions, flooring, wall colour, ceiling, windows + light direction, fixed features, focal wall. What IS in the photo — no furniture.",
    },
    styleName: { type: "string", minLength: 3, maxLength: 60 },
    styleSubtitle: { type: "string", minLength: 3, maxLength: 120 },
    furniturePlan: {
      type: "array",
      minItems: 6,
      maxItems: 15,
      items: { type: "string", minLength: 4, maxLength: 160 },
      description: 'JSON ARRAY of "piece — placement" strings. Include rug, lighting, art, plants. Mark client pieces "(client\'s piece)".',
    },
    stagingPrompt: {
      type: "string",
      minLength: 120,
      maxLength: 2200,
      description:
        'ONE paragraph starting "Furnish this [roomType] as a [styleName] space:" listing every piece with placement, material, colour; rug; lighting; art; plants; closing mood sentence. Never mention camera/walls/floor/windows/light. Verbs: furnish, place, add, hang, layer.',
    },
    notes: { type: "string", maxLength: 1200 },
  },
  required: [
    "roomType",
    "workingTitle",
    "hook",
    "roomRead",
    "styleName",
    "styleSubtitle",
    "furniturePlan",
    "stagingPrompt",
    "notes",
  ],
  additionalProperties: false,
} as const;

/** Non-strict tool calling treats maxLength as a hint — trim overshoots
 *  instead of failing the whole creation on a long roomRead. */
function coerceBrief(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const r = { ...(raw as Record<string, unknown>) };
  const clip = (k: string, max: number) => {
    if (typeof r[k] === "string" && (r[k] as string).length > max) {
      r[k] = (r[k] as string).slice(0, max - 1) + "…";
    }
  };
  clip("roomType", 60);
  clip("workingTitle", 120);
  clip("hook", 240);
  clip("roomRead", 1500);
  clip("styleName", 60);
  clip("styleSubtitle", 120);
  clip("stagingPrompt", 2200);
  clip("notes", 1200);
  if (typeof r.notes !== "string") r.notes = "";
  if (Array.isArray(r.furniturePlan)) {
    r.furniturePlan = (r.furniturePlan as unknown[])
      .filter((x): x is string => typeof x === "string" && x.trim().length >= 4)
      .map((x) => (x.length > 160 ? x.slice(0, 159) + "…" : x))
      .slice(0, 15);
  }
  return r;
}

export async function generateStagingBrief(
  input: StagingBriefInput
): Promise<StagingBriefResponse> {
  const images = [input.beforeImageUrl, ...(input.furnitureReferenceUrls ?? [])];
  const raw = await generateJSON<unknown>({
    system: buildStagingBriefSystem(),
    user: buildStagingBriefUser(input),
    images,
    schema: STAGING_BRIEF_TOOL_SCHEMA as unknown as Record<string, unknown>,
    toolName: "submit_staging_brief",
    maxTokens: 3500,
  });
  return StagingBriefResponseSchema.parse(coerceBrief(raw));
}

// ── 3. Staging metadata (vision on before + after) ──────────────────────────

export type StagingMetadataInput = {
  beforeImageUrl: string;
  /** Unfurnish projects: the cleared room between before and after. */
  clearedImageUrl?: string | null;
  afterImageUrl: string;
  roomType: string;
  styleName: string;
  roomRead: string;
  furniturePlan: string[];
  brief?: string | null;
  hook?: string;
  /** Operator's live app names (drives the soft {APP_LINK} CTA). */
  appNames: string[];
  /** Operator's public handle, used for the client note sign-off context. */
  instagramHandle?: string;
};

/** Anchor tags for staging posts — enforced server-side too (projects.ts). */
export const STAGING_LOCKED_HASHTAGS = ["virtualstaging", "realestate"];

/** What each app IS, so the CTA reads true. */
const STAGING_APP_BLURBS: Record<string, string> = {
  "AI Virtual Stage":
    "AI Virtual Stage — a virtual staging platform for listing agents: upload an empty (or furnished) room photo and get it staged like this one. The natural CTA shape is an invitation to stage their own listing (\"Stage your own listing at {APP_LINK}\").",
  ArchitectGPT: "ArchitectGPT — an AI design app that reimagines spaces and exteriors.",
  InteriorGPT: "InteriorGPT — an AI interior design assistant.",
};

export function buildStagingMetadataSystem(appNames: string[]): string {
  const app = appNames[0];
  const cta = app
    ? `The operator runs ${STAGING_APP_BLURBS[app] ?? `${app}, an AI design app.`} The Instagram caption may close with ONE soft, value-led invitation to try it, naming ${app} and using the literal placeholder "{APP_LINK}" exactly once at the very end (the operator substitutes the real URL). Never open with it, never make it salesy. TikTok, the listing blurb, and the client note never mention the app.`
    : `No app CTA — write copy that stands on its own. Never write "{APP_LINK}".`;
  return `You write the copy that ships with a virtual-staging before/after for a real-estate listing. You can SEE the images in this message: image 1 is the room as the client photographed it (if it was furnished, image 2 is the same room digitally CLEARED of all furniture and the LAST image is the restaged result; if it was already empty there are just two images — the empty room and the staged room). Everything you write must be about THESE images — the actual flooring, the actual light, the actual pieces placed — so that nothing you write could be pasted onto a different room.

Before writing, look at both: what was the room's problem when empty (scale hard to read, no purpose, cold), and what did the staging do (named pieces, where they went, how the room now reads)? Reference at least three specific things visible in the after (a piece, its material or colour, its placement) and at least one true thing about the original room (floor, light, window, proportions).

${cta}

Hard rules:
- No "Don't forget to like and subscribe", no "In this video", no clickbait, no ALL CAPS, no emojis in the listing blurb or client note (captions may use one, sparingly).
- Never claim the furniture is real or included. Never invent square footage or features you can't see.
- Never write generic staging copy ("staging helps buyers visualise the space"). Every sentence earns its place by being about this room.
- Hashtags: lowercase, no '#', 5 per array. Both arrays MUST include 'virtualstaging' and 'realestate'; fill the other 3 with specific tags (room type, style, city if the brief names one, listing-photo tags). No duplicates, no near-duplicates.

Fields:
- instagramCaption: 300-800 chars, 3 short stanzas separated by single line breaks. Stanza 1: the empty room in one honest, specific line, then the reveal. Stanza 2: what the staging did — the named pieces, the palette, why they fit THIS room's light and proportions. Stanza 3: an engagement close that is specific ("Swipe — would you keep the walnut credenza on the window wall?"), then the {APP_LINK} line if an app is configured. No hashtags inline.
- instagramHashtags: 5 tags per the rule above.
- tiktokCaption: 80-300 chars, 1-2 lines: a punchy reveal line naming the room and one specific staging choice, then a question. No hashtags inline.
- tiktokHashtags: 5 tags per the rule above.
- listingBlurb: 2-3 sentences (200-600 chars) an agent can paste into the MLS/remarks for this room — describes the room's real attributes (light, floors, proportions, focal wall) and how the staging demonstrates its use. Must end with the exact sentence: "Photo virtually staged."
- clientNote: 3-5 sentences (250-900 chars), a message the operator sends the agent or homeowner along with the two files. Name the room, say what was staged and in what style, mention that the two files are attached (before + after), and remind them the after must be labelled as virtually staged wherever it's published. Warm, professional, no hype.
- altText: accessible alt text for the AFTER image, ≤200 chars, literal: room, key pieces, light.`;
}

export function buildStagingMetadataUser(input: StagingMetadataInput): string {
  return [
    input.clearedImageUrl
      ? "This was a RESTAGE: image 1 is the client's furnished room (context only), image 2 is the room digitally cleared, image 3 is the virtual restaging. The PUBLISHED before/after pair is image 2 (the cleared, empty room) and image 3 — write the captions as empty room → staged room. You may mention it was cleared first, but never describe the old furniture as if the viewer will see it."
      : "",
    `Room: ${input.roomType}`,
    `Staging style: ${input.styleName}`,
    input.hook ? `Stager's hook: ${input.hook}` : "",
    "",
    `The stager's read of the empty room (image 1): ${input.roomRead}`,
    "",
    "The furniture plan that was rendered (verify against image 2 — only mention what is actually visible):",
    ...input.furniturePlan.map((p) => `- ${p}`),
    input.brief && input.brief.trim() ? `\nThe operator's brief: ${input.brief.trim()}` : "",
    "",
    "Write the staging package copy. Look at both images before you write.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

const STAGING_METADATA_TOOL_SCHEMA = {
  type: "object",
  properties: {
    instagramCaption: { type: "string", minLength: 200, maxLength: 2200 },
    instagramHashtags: {
      type: "array",
      minItems: 3,
      maxItems: 5,
      items: { type: "string", minLength: 1, maxLength: 40 },
    },
    tiktokCaption: { type: "string", minLength: 40, maxLength: 600 },
    tiktokHashtags: {
      type: "array",
      minItems: 3,
      maxItems: 5,
      items: { type: "string", minLength: 1, maxLength: 40 },
    },
    listingBlurb: {
      type: "string",
      minLength: 100,
      maxLength: 1200,
      description: 'MLS-ready 2-3 sentences about THIS room; must end with "Photo virtually staged."',
    },
    clientNote: { type: "string", minLength: 150, maxLength: 1500 },
    altText: { type: "string", minLength: 10, maxLength: 300 },
  },
  required: [
    "instagramCaption",
    "instagramHashtags",
    "tiktokCaption",
    "tiktokHashtags",
    "listingBlurb",
    "clientNote",
    "altText",
  ],
  additionalProperties: false,
} as const;

/** Guarantee the MLS sentence closes the blurb even if the model forgot. */
export function ensureBlurbDisclosure(blurb: string): string {
  const trimmed = blurb.trim();
  if (/photo virtually staged\.?$/i.test(trimmed)) return trimmed;
  return `${trimmed.replace(/\s+$/, "")} Photo virtually staged.`;
}

export async function generateStagingMetadata(
  input: StagingMetadataInput
): Promise<StagingMetadata> {
  const raw = await generateJSON<Record<string, unknown>>({
    system: buildStagingMetadataSystem(input.appNames),
    user: buildStagingMetadataUser(input),
    images: [
      input.beforeImageUrl,
      ...(input.clearedImageUrl ? [input.clearedImageUrl] : []),
      input.afterImageUrl,
    ],
    schema: STAGING_METADATA_TOOL_SCHEMA as unknown as Record<string, unknown>,
    toolName: "submit_staging_metadata",
    maxTokens: 3000,
  });
  const blurb = typeof raw.listingBlurb === "string" ? raw.listingBlurb : "";
  return StagingMetadataSchema.parse({
    kind: "staging",
    ...raw,
    listingBlurb: ensureBlurbDisclosure(blurb),
    disclosure: STAGING_DISCLOSURE,
  });
}
