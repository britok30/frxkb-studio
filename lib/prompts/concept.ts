import { z } from "zod";
import { generateJSON } from "@/lib/llm";
import {
  ConceptBriefSchema,
  type ConceptBrief,
  type Format,
  type PromptableConcept,
  type WorldType,
} from "./types";

export type ConceptInput = {
  niche: string;
  format: Format;
  worldType: WorldType;
  targetDurationSec?: number;
  operatorNotes?: string;
  /** Operator-uploaded moodboard / photo references (public Blob URLs, ≤5).
   *  Sent to GPT-5.5 as vision blocks so the brief is grounded in the actual
   *  materials, palette, and mood of the refs — the same images later
   *  condition every nano-banana /edit call. */
  referenceImageUrls?: string[];
};

export function buildConceptSystem(): string {
  return `You are a creative director for a design-inspiration feed (Instagram/Reels/TikTok) marketing ArchitectGPT. The audience is architects, interior designers, and design-obsessed scrollers — they save moodboard-grade imagery for their inspiration folders.

Your job is to write a concept brief for ONE piece. The brief is the visual contract every downstream scene obeys.

The subject is ALWAYS a residential home — a real place a real person lives. Not a museum, not a gallery, not a corporate lobby, not a hotel lobby, not a showroom. A home. Houses, apartments, villas, cottages, lofts, fincas, riads, cabins, townhouses.

What this brief is aiming for:
- A HOME a designer would screenshot — strong sense of place, materials that photograph beautifully, light that flatters them, AND the lived-in objects that signal a real life inside.
- A specific emotional register the imagery sits inside — hush, longing, stillness, awe, intimacy, anticipation, reverence, slowness, soft melancholy, suspension. Pick ONE and let it shape every other choice.
- A material palette someone could name in one breath (e.g., lime-washed plaster + oak + linen, or board-formed concrete + glass + steel + travertine). Three to five materials max — too many reads as clutter.
- A specific quality of light that gives the materials texture and color — low golden rake, soft north skylight, overcast diffusion, summer haze, late blue hour, dappled tree shadow.
- A real, recognizable lineage — beloved regional vernaculars, named architectural movements, traditions with cultural depth. Category words alone ("modern home," "contemporary") are too thin; name the lineage that gives the category meaning.
- A coherent SET OF OBJECTS that would actually live in this home — drawn from these categories: furniture, plants, art and ceramics, textiles, daily-life things, functional objects (and for exteriors: landscape elements, water features / pool, outdoor lighting, site features like garden walls or terraces). Every object must belong to THIS home's specific cultural lineage. Object names rooted in the actual region, era, and craft tradition of the home — a designer sees the niche and instantly knows what kinds of things would be in that room. Generic "design moodboard" defaults are out of scope; commit to lineage-specific names.

Hard constraints:
- A single coherent home: one emotional register, one climate, one quality of light, one material palette, one consistent family of objects.
- The home is FULL of the things of a real life (plants, art, books, ceramics, textiles, things mid-use) but no humans appear in frame. Empty of people, never empty of their stuff.
- No on-screen text, signage, or branding.
- Quiet, tasteful, inhabited — never sterile-magazine-empty, never staged showroom.

**Honor the operator's words.** Read the niche LITERALLY. "Modern" means CONTEMPORARY (current-era, clean lines, current materials), not "vernacular reimagined as modern" or "traditional with modern touches." Same literal reading for any adjective the operator wrote.

**Variety method (internal, do NOT include in tool output):**
Before writing the brief, brainstorm FIVE distinct candidate interpretations that all fit the operator's literal niche. Vary them primarily on:
- Emotional register — assign a different feeling to each candidate.
- Visual signature — what's the one screenshot moment in each candidate that a designer would save?
- Light + atmosphere — different times of day, weather, season.

Material palette, region, era, and named lineage follow from the emotional anchor — they're supporting texture, not the variety driver. Commit to the candidate with the strongest, most inhabitable identity. Output only the chosen brief.

You will return seven fields. **Length matters — these are HARD caps, not soft suggestions:**
- workingTitle: a short evocative title (3-7 words, max 120 chars) for the operator's reference. Lead with the feeling or the place, not the formula.
- hook: ONE sentence (max 240 chars) that captures the essence — what makes it screenshot-worthy.
- vibe: ONE concrete paragraph (max 1500 chars — count yourself, do not overshoot) describing the emotional register, the place, the materials, the light, the atmosphere. Be concrete: name the materials, the time of day, the color cast, the feeling. NOT multiple paragraphs.
- notes: 3-8 short bullet lines (max ~100 chars each, max 2000 chars total) of visual rules to lock the scene generator onto. Things that must stay consistent across all scenes (e.g. "warm afternoon light, low sun angle in every scene" or "always shoot at human-eye height"). Phrase every rule AFFIRMATIVELY — name what must appear, not what must be absent; these lines flow into image prompts, and an image model renders the words it reads. BE TERSE — these are constraints, not prose.
- objectSet: a JSON ARRAY of 8-15 specific objects (each 2-80 chars) that belong to THIS home's cultural lineage. Mix categories — some furniture, some plants, some art/ceramics, some textiles, some daily-life details, some functional objects. For exterior briefs, include landscape elements, water/pool, outdoor lighting, and site features. Every item must be rooted in the actual culture/region/era of the home — not the global "design moodboard" defaults.
- worldSignature: a stable kebab-case identifier (3-6 hyphenated lowercase tokens, 8-80 chars) that uniquely captures THIS world. Used downstream to detect duplicates. Include the most defining axes — period, region, material, light. Shape: "[era]-[region]-[style]-[material]-[light]" or similar combination. Lowercase, hyphens only. NO trailing year-only tokens. NO operator-specific words.
- worldKeywords: 5-12 lowercase canonical tags that describe the world. Used for fuzzy duplicate detection. Pick from these axes when relevant: era ("1960s"), region ("brazilian"), style ("modernism", "brutalism"), space type ("living-room", "facade"), material ("travertine", "concrete"), light ("late-afternoon", "overcast"), atmosphere ("calm", "humid"). Hyphens for multi-word tokens. NO duplicates of workingTitle words verbatim — these are normalized tags.

The downstream pipeline uses your brief to seed image prompts that must read as one continuous moodboard. Commit to specifics so they do.`;
}

export function buildConceptUser(input: ConceptInput): string {
  const worldLine =
    input.worldType === "interior"
      ? "World: INTERIOR — inside a residential HOME. Living rooms, kitchens, bedrooms, reading nooks, hallways, studies. Every scene is a room inside someone's actual house, full of plants, art, books, ceramics, textiles, things in use. Empty of people but full of their life."
      : "World: EXTERIOR — a residential HOME from the outside. House, villa, cottage, loft, finca, riad, cabin. Show the home AND the residential life around it (planters, porch chairs, climbing plants, a swimming pool, garden tools, an outdoor table set). The home is the subject; the lived-in details around it make it feel like someone's house, not a museum.";
  const lines = [
    `Niche: ${input.niche}`,
    `Format: ${input.format} (reel = vertical 15-30s animated, carousel = static slides)`,
    worldLine,
  ];
  if (input.targetDurationSec) {
    lines.push(`Target duration: ${input.targetDurationSec} seconds`);
  }
  if (input.operatorNotes && input.operatorNotes.trim()) {
    lines.push(`Operator notes: ${input.operatorNotes.trim()}`);
  }
  if (input.referenceImageUrls && input.referenceImageUrls.length > 0) {
    lines.push(
      "",
      `Reference images: the operator attached ${input.referenceImageUrls.length} moodboard/reference image${input.referenceImageUrls.length === 1 ? "" : "s"} (visible in this message). Ground the brief in what you SEE: name the actual materials, palette, light, and mood present in the references. The material palette and objectSet must be compatible with these images — the same references will visually condition every downstream render.`
    );
  }
  lines.push(
    "",
    "If the niche is broad, pick a tight angle anchored in an emotional register and a specific quality of light. Commit to the candidate that feels most screenshot-worthy to a designer."
  );
  return lines.join("\n");
}

// Per OpenAI docs: JSON-schema maxLength is NOT enforced server-side,
// even with strict mode. The recommended pattern is to put the limit in the
// field's `description` (GPT-5.5 reads it as natural-language guidance and
// obeys ~reliably) AND validate client-side. We do both — descriptions
// below + safeTruncate before Zod.parse as a safety net.
const CONCEPT_TOOL_SCHEMA = {
  type: "object",
  properties: {
    workingTitle: {
      type: "string",
      minLength: 3,
      maxLength: 120,
      description: "Short evocative title for the operator's reference. 3-7 WORDS. Hard cap 120 characters — DO NOT exceed.",
    },
    hook: {
      type: "string",
      minLength: 8,
      maxLength: 240,
      description: "One sentence that captures the essence of the piece. Hard cap 240 characters — keep it punchy.",
    },
    vibe: {
      type: "string",
      minLength: 8,
      maxLength: 1500,
      description: "A SINGLE concrete paragraph (not multiple paragraphs) describing era/region/materials/light/mood. Hard cap 1500 characters — DO NOT exceed.",
    },
    notes: {
      type: "string",
      maxLength: 2000,
      description: "Bullet-style visual rules. Each bullet under 100 chars. 3-8 bullets total. Hard cap 2000 characters across all bullets — DO NOT exceed. Be terse.",
    },
    objectSet: {
      type: "array",
      minItems: 8,
      maxItems: 15,
      items: { type: "string", minLength: 2, maxLength: 80 },
      description: "JSON ARRAY of 8-15 specific objects (NOT a comma-separated string) that belong to THIS home's cultural lineage. Mix furniture, plants, art/ceramics, textiles, daily-life details, functional objects (and for exteriors: landscape elements, water/pool, outdoor lighting, site features). Every object must be rooted in the actual culture, region, and era of the home — not the global design-moodboard defaults. Each item 2-80 chars.",
    },
    worldSignature: {
      type: "string",
      minLength: 8,
      maxLength: 80,
      pattern: "^[a-z0-9]+(?:-[a-z0-9]+){2,}$",
      description: "Kebab-case identifier, 3-6 hyphenated lowercase tokens. 8-80 characters total.",
    },
    worldKeywords: {
      type: "array",
      minItems: 5,
      maxItems: 12,
      items: { type: "string", minLength: 2, maxLength: 40 },
      description: "JSON ARRAY of 5-12 lowercase canonical tag strings (NOT a comma-separated string — must be a real array). Each tag 2-40 characters. Hyphens for multi-word tokens. Example shape: [\"1960s\", \"brazilian\", \"modernism\", \"travertine\", \"palms\", \"late-afternoon\"].",
    },
  },
  required: ["workingTitle", "hook", "vibe", "notes", "objectSet", "worldSignature", "worldKeywords"],
  additionalProperties: false,
} as const;

/**
 * Non-strict function calling treats JSON-schema constraints (maxLength, type, etc.)
 * as soft hints. GPT-5.5 regularly overshoots prose fields AND occasionally
 * returns the wrong type (e.g. comma-separated string for an array field).
 * Rather than throw on Zod parse, we coerce + trim before validation — a
 * graceful safety net. Logs warnings when corrections happen so we can spot
 * prompt-tuning opportunities.
 *
 * Truncation only on prose fields (vibe, notes) — workingTitle/hook/worldSignature
 * are left alone since mid-word slices produce gibberish.
 */
function safeTruncateConcept(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const obj = { ...(raw as Record<string, unknown>) };

  // Length truncation for prose fields.
  const prose: Array<{ key: string; max: number }> = [
    { key: "vibe", max: 1500 },
    { key: "notes", max: 2000 },
  ];
  for (const { key, max } of prose) {
    const v = obj[key];
    if (typeof v === "string" && v.length > max) {
      console.warn(
        `[concept] GPT-5.5 overshot ${key} (${v.length} > ${max}); truncating.`
      );
      obj[key] = v.slice(0, max - 1) + "…";
    }
  }

  // Type coercion: worldKeywords sometimes comes back as "tag1, tag2, tag3"
  // instead of ["tag1","tag2","tag3"]. Split on commas/newlines, trim, drop
  // empties, lowercase.
  if (typeof obj.worldKeywords === "string") {
    console.warn(
      `[concept] GPT-5.5 returned worldKeywords as a string; coercing to array.`
    );
    obj.worldKeywords = (obj.worldKeywords as string)
      .split(/[,\n]/)
      .map((t) => t.trim().toLowerCase().replace(/^#/, ""))
      .filter((t) => t.length >= 2 && t.length <= 40);
  }

  // Same coercion for objectSet — GPT-5.5 occasionally returns a single
  // string instead of an array. Preserves capitalization (object names like
  // "Hans Wegner chair" need it, unlike worldKeywords which are lowercase tags).
  if (typeof obj.objectSet === "string") {
    console.warn(
      `[concept] GPT-5.5 returned objectSet as a string; coercing to array.`
    );
    obj.objectSet = (obj.objectSet as string)
      .split(/[,\n]/)
      .map((t) => t.trim().replace(/^[-*•]\s*/, ""))
      .filter((t) => t.length >= 2 && t.length <= 80);
  }
  // Trim individual objectSet items that exceeded the 80-char cap rather than
  // failing the whole brief on Zod validation.
  if (Array.isArray(obj.objectSet)) {
    obj.objectSet = (obj.objectSet as unknown[])
      .filter((t): t is string => typeof t === "string")
      .map((t) => (t.length > 80 ? t.slice(0, 79) + "…" : t))
      .filter((t) => t.length >= 2);
  }

  return obj;
}

export async function generateConcept(input: ConceptInput): Promise<ConceptBrief> {
  const raw = await generateJSON<unknown>({
    system: buildConceptSystem(),
    user: buildConceptUser(input),
    images: input.referenceImageUrls,
    schema: CONCEPT_TOOL_SCHEMA as unknown as Record<string, unknown>,
    toolName: "submit_concept",
    // Bumped 1500 → 1800 to absorb the new objectSet field (8-15 items) on
    // top of the existing six fields.
    maxTokens: 1800,
  });
  return ConceptBriefSchema.parse(safeTruncateConcept(raw));
}

// ── Before-after concept (slim) ────────────────────────────────────────────
// Before-after projects don't dedupe (each one is unique to its uploaded
// image), so we skip worldSignature + worldKeywords entirely. Returns just
// the four PromptableConcept fields the downstream thumbnail + metadata
// generators actually read.

const BeforeAfterConceptSchema = z.object({
  workingTitle: z.string().min(3).max(120),
  hook: z.string().min(8).max(240),
  vibe: z.string().min(8).max(1500),
  notes: z.string().max(2000).default(""),
  objectSet: z.array(z.string().min(2).max(80)).min(8).max(15).default([]),
});

const BEFORE_AFTER_CONCEPT_TOOL_SCHEMA = {
  type: "object",
  properties: {
    workingTitle: {
      type: "string",
      minLength: 3,
      maxLength: 120,
      description: "Short evocative title for the operator's reference. 3-7 words. Hard cap 120 characters.",
    },
    hook: {
      type: "string",
      minLength: 8,
      maxLength: 240,
      description: "One sentence capturing the transformation's vibe. Hard cap 240 characters.",
    },
    vibe: {
      type: "string",
      minLength: 8,
      maxLength: 1500,
      description: "A SINGLE concrete paragraph describing the after's materials/light/mood. Hard cap 1500 characters — DO NOT exceed.",
    },
    notes: {
      type: "string",
      maxLength: 2000,
      description: "Bullet-style visual rules for the after. Each bullet under 100 chars. 0-6 bullets total. Hard cap 2000 characters — be terse.",
    },
    objectSet: {
      type: "array",
      minItems: 8,
      maxItems: 15,
      items: { type: "string", minLength: 2, maxLength: 80 },
      description: "JSON ARRAY of 8-15 specific objects (NOT a comma-separated string) that belong in the transformed home's cultural lineage. Mix furniture, plants, art/ceramics, textiles, daily-life details (and for exteriors: landscape, water/pool, outdoor lighting, site features). Each object must be rooted in the actual culture/region implied by the transformation request — not generic moodboard defaults.",
    },
  },
  required: ["workingTitle", "hook", "vibe", "notes", "objectSet"],
  additionalProperties: false,
} as const;

export type BeforeAfterConceptInput = {
  /** Operator's transformation prompt (e.g. "Modernize this kitchen with
   *  walnut cabinets and terrazzo floor"). Used as the niche-equivalent. */
  transformationPrompt: string;
  worldType: WorldType;
};

function buildBeforeAfterConceptSystem(): string {
  return `You write a one-paragraph creative brief for a single AI-driven before/after RESIDENTIAL transformation. The before is a real photo of someone's home (interior or exterior) that the operator uploaded; the after is what your brief shapes.

The after should land as design inspiration — moodboard-grade imagery a designer would screenshot, not a renovation catalog photo. It should look like a real, lived-in home a real person owns.

Be concrete and committed. Name materials, light direction, color cast, AND the lived-in objects that bring the space to life (plants, art, books, ceramics, textiles, things mid-use).

Aim for:
- A specific emotional register (hush, warmth, intimacy, awe, slowness, anticipation — pick one and let it shape every other choice).
- A material palette someone could name in one breath (three to five materials max).
- A specific quality of light that makes those materials photograph beautifully.
- A real, recognizable lineage when the operator's intent leans that way — beloved regional vernaculars or named movements.
- A SET OF 8-15 specific objects that belong in this transformed home, drawn from these categories: furniture, plants, art/ceramics, textiles, daily-life things, functional objects (and for exteriors: landscape elements, water/pool, outdoor lighting, site features). Every object must be rooted in the actual culture/region implied by the operator's transformation request — never the generic "design moodboard" defaults.

Hard constraints:
- A single coherent home: one mood, one material palette, one quality of light, one consistent family of objects.
- The home is FULL of life (plants, art, books, ceramics, textiles, things in use) but no humans appear in frame.
- Quiet, tasteful, inhabited — never sterile-magazine-empty, never staged showroom.

Return five fields. **Length matters — these are HARD caps:**
- workingTitle: short evocative title (3-7 words, max 120 chars) for the operator's reference.
- hook: ONE sentence (max 240 chars) capturing the transformation's vibe.
- vibe: ONE concrete paragraph (max 1500 chars — do not overshoot) describing the after's emotional register, materials, light, and atmosphere. Be concrete.
- notes: 0-6 short bullet lines (max 2000 chars total, be terse) of visual rules to lock the after to the operator's intent (e.g. "warm afternoon light, low sun angle"). May be empty.
- objectSet: JSON ARRAY of 8-15 specific objects rooted in the after's cultural lineage (furniture, plants, art/ceramics, textiles, daily-life details, and for exteriors landscape/pool/lighting/site features). Each item 2-80 chars.`;
}

function buildBeforeAfterConceptUser(input: BeforeAfterConceptInput): string {
  const worldLine =
    input.worldType === "interior"
      ? "World: INTERIOR — the before is a room photo; the after stays inside."
      : "World: EXTERIOR — the before is a facade photo; the after stays architecture-led.";
  return [
    `Operator's transformation request: ${input.transformationPrompt}`,
    worldLine,
    "",
    "Lean into the operator's intent and anchor it in a specific emotional register and quality of light. If they said 'modernize', go specific (which materials, what era of modern). If they said 'warmer', name the light source and the feeling. Don't water it down.",
  ].join("\n");
}

export async function generateBeforeAfterConcept(
  input: BeforeAfterConceptInput
): Promise<PromptableConcept> {
  const raw = await generateJSON<unknown>({
    system: buildBeforeAfterConceptSystem(),
    user: buildBeforeAfterConceptUser(input),
    schema: BEFORE_AFTER_CONCEPT_TOOL_SCHEMA as unknown as Record<string, unknown>,
    toolName: "submit_before_after_concept",
    maxTokens: 1800,
  });
  return BeforeAfterConceptSchema.parse(safeTruncateConcept(raw));
}
