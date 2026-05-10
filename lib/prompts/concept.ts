import { generateJSON } from "@/lib/claude";
import { ConceptBriefSchema, type ConceptBrief, type Format } from "./types";

export type ConceptInput = {
  niche: string;
  format: Format;
  targetDurationSec?: number;
  operatorNotes?: string;
};

export function buildConceptSystem(): string {
  return `You are a creative director for a faceless ambient YouTube/Reels channel about architecture and interior design. The audience watches in the background while working, studying, or relaxing — think "lo-fi but for design."

Your job is to write a concept brief for a single piece of content. The brief is the visual contract that every downstream scene must obey.

Be specific and committed. "Modernist living rooms" is too vague. "1960s Brazilian modernist living rooms with travertine floors, palm shadows, and dusk light" is the right altitude.

Hard constraints for every brief:
- Faceless. No people. No close-ups of hands or feet.
- No on-screen text, signage, or branding.
- A single coherent visual world: one era, one climate, one quality of light, one material palette.
- Calm and slow. No clutter, no drama. Restraint over spectacle.
- Avoid generic "modern luxury home" tropes. Pick a specific lineage (regional, period, or material-driven).

You will return six fields:
- workingTitle: a short evocative title (3-7 words) for the operator's reference. Not a YouTube title — that comes later.
- hook: one sentence that captures the essence of the piece — what makes it watchable for 8 minutes in the background.
- vibe: a paragraph describing the era, region, materials, palette, light quality, and atmosphere. This is the visual contract. Be concrete: name the materials, the time of day, the color cast.
- notes: bullet-style visual rules to lock the scene generator onto. Things that must stay consistent across all scenes (e.g. "warm afternoon light, low sun angle, no overcast scenes" or "always shoot at human-eye height, never aerial").
- worldSignature: a stable kebab-case identifier (3-6 hyphenated tokens) that uniquely captures THIS world. Used downstream to detect if an operator has already produced near-identical content. Include the most defining axes — period, region, material, light. Examples:
    "1960s-brazilian-modernism-travertine-palms"
    "tuscan-farmhouse-terracotta-linen-dusk"
    "japanese-shoji-tea-room-morning"
  Lowercase, hyphens only, 8-80 chars total. NO trailing year-only tokens. NO operator-specific words.
- worldKeywords: 5-12 lowercase canonical tags that describe the world. Used for fuzzy duplicate detection. Pick from these axes when relevant: era ("1960s"), region ("brazilian"), style ("modernism", "brutalism"), space type ("living-room", "facade"), material ("travertine", "concrete"), light ("late-afternoon", "overcast"), atmosphere ("calm", "humid"). Hyphens for multi-word tokens. NO duplicates of workingTitle words verbatim — these are normalized tags.

The downstream pipeline uses your brief to seed 30+ image prompts that must read as one continuous video. Commit to specifics so it does.`;
}

export function buildConceptUser(input: ConceptInput): string {
  const lines = [
    `Niche: ${input.niche}`,
    `Format: ${input.format} (yt-long = ambient slideshow ~5-10 min, reel = vertical 30-60s, carousel = static slides)`,
  ];
  if (input.targetDurationSec) {
    lines.push(`Target duration: ${input.targetDurationSec} seconds`);
  }
  if (input.operatorNotes && input.operatorNotes.trim()) {
    lines.push(`Operator notes: ${input.operatorNotes.trim()}`);
  }
  lines.push(
    "",
    "If the niche is broad, pick a tight, evocative angle. Lean into a specific era, region, or material palette. Avoid the most obvious choices unless the operator's notes pin you to them."
  );
  return lines.join("\n");
}

const CONCEPT_TOOL_SCHEMA = {
  type: "object",
  properties: {
    workingTitle: { type: "string", minLength: 3, maxLength: 120 },
    hook: { type: "string", minLength: 8, maxLength: 240 },
    vibe: { type: "string", minLength: 8, maxLength: 800 },
    notes: { type: "string", maxLength: 1200 },
    worldSignature: {
      type: "string",
      minLength: 8,
      maxLength: 80,
      pattern: "^[a-z0-9]+(?:-[a-z0-9]+){2,}$",
    },
    worldKeywords: {
      type: "array",
      minItems: 5,
      maxItems: 12,
      items: { type: "string", minLength: 2, maxLength: 40 },
    },
  },
  required: ["workingTitle", "hook", "vibe", "notes", "worldSignature", "worldKeywords"],
  additionalProperties: false,
} as const;

export async function generateConcept(input: ConceptInput): Promise<ConceptBrief> {
  const raw = await generateJSON<unknown>({
    system: buildConceptSystem(),
    user: buildConceptUser(input),
    schema: CONCEPT_TOOL_SCHEMA as unknown as Record<string, unknown>,
    toolName: "submit_concept",
    maxTokens: 1500,
  });
  return ConceptBriefSchema.parse(raw);
}
