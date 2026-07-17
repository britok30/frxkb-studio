import { z } from "zod";
import { generateJSON } from "@/lib/llm";
import type { Format, WorldType } from "./types";
import { NICHE_POOL, sampleN } from "./niche-pool";

export const SuggestedWorldSchema = z.object({
  /** A specific niche string the operator can paste straight into the wizard. */
  niche: z.string().min(8).max(200),
  /** One-sentence justification — surfaced to the operator so they understand
   *  why this angle was picked. */
  rationale: z.string().min(8).max(280),
});
export type SuggestedWorld = z.infer<typeof SuggestedWorldSchema>;

/** A compact representation of a past project — fed to GPT-5.5 as the avoid-list. */
export type WorldHistoryEntry = {
  niche: string;
  worldSignature: string;
  worldKeywords: string[];
};

export type SuggestWorldInput = {
  format: Format;
  /** Visual lane the operator picked — GPT-5.5 scopes the suggestion to one
   *  side so an interior request never returns a facade niche. */
  worldType: WorldType;
  /** Recent past worlds the operator (or studio) has already produced.
   *  GPT-5.5 is instructed to avoid anything close to these. */
  history: WorldHistoryEntry[];
  /** Niches we already showed the operator THIS session and they rejected via
   *  "Try another." Persisted only client-side, sent on every retry — without
   *  this, GPT-5.5 has no signal that we rejected a previous suggestion (since
   *  rejected suggestions never hit the DB). */
  recentlyShown?: string[];
  /** Altitude-calibration examples drawn from NICHE_POOL[worldType]. Injected
   *  into the user prompt so GPT-5.5 calibrates to object-led, lineage-anchored
   *  niches instead of falling back to its own academic defaults (which is
   *  what produced the historic "Costa Brava drift" failure mode). Auto-
   *  populated by suggestWorld() if omitted; tests pass [] to skip injection. */
  altitudeExamples?: string[];
};

/** How many NICHE_POOL samples to inject as altitude calibration. Three is
 *  enough to span emotional registers without bloating the prompt. */
const ALTITUDE_EXAMPLE_COUNT = 3;

/** Sample N altitude-calibration niches from NICHE_POOL[worldType], filtering
 *  out any that already appear (case-insensitive substring match) in the
 *  operator's history or current-session rejected list. Otherwise we'd suggest
 *  GPT-5.5 a niche the operator just skipped. */
export function pickAltitudeExamples(
  worldType: WorldType,
  history: WorldHistoryEntry[],
  recentlyShown: string[] = [],
  count: number = ALTITUDE_EXAMPLE_COUNT,
): string[] {
  const seen = new Set<string>(
    [...history.map((h) => h.niche), ...recentlyShown].map((n) => n.toLowerCase().trim()),
  );
  const eligible = NICHE_POOL[worldType].filter((n) => !seen.has(n.toLowerCase().trim()));
  return sampleN(eligible, count);
}

export function buildSuggestSystem(): string {
  return `You are a creative director for a design-inspiration feed (Instagram/Reels/TikTok) that markets ArchitectGPT to architects, interior designers, and design-obsessed scrollers. Every piece is moodboard fuel — imagery a designer screenshots for their inspiration folder or a homeowner saves with "I want my home to feel like this."

The subject is ALWAYS a residential home — a real place a real person lives. Houses, villas, cottages, lofts, fincas, riads, cabins, townhouses, apartments. Never museums, galleries, hotels, offices, restaurants, or showrooms.

Your job: propose ONE specific world (the niche) for the next piece. The niche should describe a HOME, not just an aesthetic.

What "save-worthy" looks like:
- A residential world rooted in a real place — homes people fantasize about visiting, living in, or designing toward.
- A clear material palette someone could name in one breath (lime-washed plaster, oak, linen; or concrete, steel, glass; or travertine, terracotta, raw wood).
- A specific quality of light that makes the materials photograph beautifully — low golden rake, soft north skylight, overcast diffusion, summer haze, late blue hour, dappled tree shadow.
- A specific emotional register a designer feels INSIDE the imagery — hush, longing, stillness, awe, intimacy, anticipation, reverence, slowness, soft melancholy, suspension.
- Strong cultural identity over abstract style. Beloved regional vernaculars, recognizable architectural lineages, and material traditions with depth all pass. Pure category words ("modern home," "luxury") do not — name the lineage that gives a category meaning.
- An implied way of LIVING in this home — the kinds of plants, art, books, ceramics, textiles, daily-life objects that would naturally belong there. The niche should make a designer instantly picture not just the architecture but the contents.
- Name 2-4 anchor objects of the lineage in the niche string itself — "A Kyoto townhouse with paper screens, tatami, ikebana, gray cypress beams" beats "Japanese minimalism." Object-led niches transitively prime the downstream concept brief.

Variety method (internal, do NOT include in output):
Brainstorm FIVE candidate worlds that all fit the operator's lane. Vary primarily on:
- Emotional register — pick a different feeling for each candidate.
- Visual signature — what's the one screenshot moment in each world that would make a designer hit save?
- Light + atmosphere — different times of day, weather, season.

Region, era, and named lineage follow from those — they're texture, not driver. Commit to the candidate with the strongest, most inhabitable identity. Output only the final niche, never the brainstorm.

History handling:
You'll receive past worlds the operator has produced. Skip exact restatements. But same region with a different season, light, or scale is a different world — riding a vein the operator clearly loves is fine. Variety here comes from emotional register and visual signature, not from forcing geographic spread.

Output two fields:
- niche: ONE sentence (no period, 8-200 chars). Place-led, emotionally specific, materially concrete. Suitable to paste into the wizard.
- rationale: ONE sentence on why this is the screenshot moment given the operator's history. Helps them decide.`;
}

export function buildSuggestUser(input: SuggestWorldInput): string {
  const worldLine =
    input.worldType === "interior"
      ? "Visual lane: INTERIOR — inside someone's HOME. Living rooms, kitchens, bedrooms, reading nooks, hallways, studies. Spaces full of plants, art, books, ceramics, and the textures of a life. Skip facade-led or landscape-led framings — those are a separate lane."
      : "Visual lane: EXTERIOR — a residential HOME from the outside (a house, villa, cottage, finca, riad, loft, cabin). Show the home AND the residential life around it: planters by the door, a porch with cane chairs, climbing plants on stone, a swimming pool, garden tools, an outdoor table set. Skip pavilions, museums, corporate buildings, and pure-landscape framings — those are a separate lane.";
  const lines = [
    `Format: ${input.format} (reel = 15s vertical animated, carousel = 6 still slides)`,
    worldLine,
    "",
  ];

  if (input.history.length === 0) {
    lines.push(
      "Past worlds: NONE. This is the operator's first piece — pick a world with a strong, save-worthy identity to set the feed's voice."
    );
  } else {
    lines.push("Past worlds (most recent first) — skip exact restatements, but riding a similar vein with a different season/light/scale is welcome:");
    for (const h of input.history) {
      lines.push(`- "${h.niche}" [${h.worldSignature}] ${h.worldKeywords.join(", ")}`);
    }
    lines.push(
      "",
      "Lean into whichever emotional register and visual signature feels freshest — region and era are texture, not the variety lever."
    );
  }

  if (input.recentlyShown && input.recentlyShown.length > 0) {
    lines.push(
      "",
      "Already proposed in THIS session and skipped by the operator — try a different emotional register and screenshot moment:",
    );
    for (const r of input.recentlyShown) {
      lines.push(`- "${r}"`);
    }
    lines.push(
      "",
      "Shift the feeling first: if the last suggestions felt hushed and still, try anticipatory or reverent. If they were warm and golden, try overcast intimacy or blue-hour suspension. Region is allowed to stay; the feeling has to move."
    );
  }

  // Altitude calibration. The strongest known anti-genericness lever — without
  // this, GPT-5.5's suggest defaults collapse to a handful of academic niches
  // ("1960s Brazilian modernism," "Mediterranean villas at golden hour"). With
  // these examples in front of it, GPT-5.5 either picks one verbatim or invents
  // something at the same altitude.
  if (input.altitudeExamples && input.altitudeExamples.length > 0) {
    lines.push(
      "",
      "Altitude calibration — examples of the altitude we want (object-led, lineage-anchored, residential). You may propose ONE of these verbatim if it genuinely fits and isn't already in the operator's history, OR invent something fresh that hits the same altitude. Whichever you pick, name 2-4 anchor objects of the lineage in the niche string itself:",
    );
    for (const ex of input.altitudeExamples) {
      lines.push(`- "${ex}"`);
    }
  }

  return lines.join("\n");
}

const SUGGEST_TOOL_SCHEMA = {
  type: "object",
  properties: {
    niche: { type: "string", minLength: 8, maxLength: 200 },
    rationale: { type: "string", minLength: 8, maxLength: 280 },
  },
  required: ["niche", "rationale"],
  additionalProperties: false,
} as const;

export async function suggestWorld(input: SuggestWorldInput): Promise<SuggestedWorld> {
  // Auto-populate altitude examples from NICHE_POOL when caller didn't pass
  // them explicitly (production path). Tests pass altitudeExamples: [] to
  // exercise the legacy non-calibrated prompt shape.
  const altitudeExamples =
    input.altitudeExamples ??
    pickAltitudeExamples(input.worldType, input.history, input.recentlyShown);
  const raw = await generateJSON<unknown>({
    system: buildSuggestSystem(),
    user: buildSuggestUser({ ...input, altitudeExamples }),
    schema: SUGGEST_TOOL_SCHEMA as unknown as Record<string, unknown>,
    toolName: "submit_world",
    maxTokens: 800,
  });
  return SuggestedWorldSchema.parse(raw);
}
