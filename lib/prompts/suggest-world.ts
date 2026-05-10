import { z } from "zod";
import { generateJSON } from "@/lib/claude";
import type { Format } from "./types";

export const SuggestedWorldSchema = z.object({
  /** A specific niche string the operator can paste straight into the wizard. */
  niche: z.string().min(8).max(200),
  /** One-sentence justification — surfaced to the operator so they understand
   *  why this angle was picked. */
  rationale: z.string().min(8).max(280),
});
export type SuggestedWorld = z.infer<typeof SuggestedWorldSchema>;

/** A compact representation of a past project — fed to Claude as the avoid-list. */
export type WorldHistoryEntry = {
  niche: string;
  worldSignature: string;
  worldKeywords: string[];
};

export type SuggestWorldInput = {
  format: Format;
  /** Recent past worlds the operator (or studio) has already produced.
   *  Claude is instructed to avoid anything close to these. */
  history: WorldHistoryEntry[];
  /** Niches we already showed the operator THIS session and they rejected via
   *  "Try another." Persisted only client-side, sent on every retry — without
   *  this, Claude has no signal that we rejected a previous suggestion (since
   *  rejected suggestions never hit the DB). */
  recentlyShown?: string[];
};

export function buildSuggestSystem(): string {
  return `You are a creative director for a faceless ambient YouTube/Reels channel about architecture and interior design. The audience watches in the background while working — calm, slow, restrained content.

Your single job here is to PROPOSE a fresh, specific niche the operator hasn't already produced. Variety across the channel matters. Repeating a world wastes the audience's attention and the operator's budget.

What makes a strong niche:
- A tight intersection of THREE axes: era + region + material/atmosphere. Vague is fatal. "Modernist homes" is too broad. "1965 Nordic country houses with pine boards and snow-light" is the right altitude.
- A specific time of day or season baked in (golden hour, overcast morning, summer dusk, etc.). Light is the most underrated axis.
- Something that feels like a coherent visual world, not a category. The operator should be able to picture three rooms in it without thinking.
- AVOID generic luxury / "modern home" tropes. Pick a specific lineage (regional, period, or material-driven).

You will receive a list of past worlds the operator has already produced. AVOID:
- Exact matches on era + region + material combo.
- Subtle re-skins of the same world (e.g. don't suggest "1962 Brazilian modernism" if "1960s Brazilian modernism" exists).
- Same region + adjacent decade (e.g. avoid "1965 Italian Riviera" if "1968 Italian Riviera" exists).

Lean toward UNDEREXPLORED axes if the operator's history clusters somewhere. If they've done a lot of mid-century, suggest something pre-war or post-2000. If lots of European, try Asian, South American, or North African.

Output two fields:
- niche: a single sentence (no period at end), 8-200 chars, suitable to paste into the wizard's niche field. Concrete and committed.
- rationale: one sentence explaining what makes this fresh given the history. Helps the operator decide.`;
}

export function buildSuggestUser(input: SuggestWorldInput): string {
  const lines = [
    `Format: ${input.format} (yt-long = 8-min ambient slideshow, reel = 15s vertical, carousel = 6 still slides)`,
    "",
  ];

  if (input.history.length === 0) {
    lines.push(
      "Past worlds: NONE. This is the operator's first piece — pick something with strong identity and visual presence to set the channel's voice."
    );
  } else {
    lines.push("Past worlds (most recent first) — DO NOT repeat or near-repeat any of these:");
    for (const h of input.history) {
      lines.push(`- "${h.niche}" [${h.worldSignature}] ${h.worldKeywords.join(", ")}`);
    }
    lines.push(
      "",
      "Find an axis the history is thin on. Surprise the operator with something they wouldn't immediately suggest themselves."
    );
  }

  if (input.recentlyShown && input.recentlyShown.length > 0) {
    lines.push(
      "",
      "Already proposed in THIS session and rejected by the operator — DO NOT propose anything in the same world or near it. They want something different:",
    );
    for (const r of input.recentlyShown) {
      lines.push(`- "${r}"`);
    }
    lines.push(
      "",
      "Pivot hard. If you've been suggesting interiors, suggest exteriors. If you've been suggesting Asian regions, suggest South American or Nordic. If you've been suggesting late afternoon, suggest dawn or overcast."
    );
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
  const raw = await generateJSON<unknown>({
    system: buildSuggestSystem(),
    user: buildSuggestUser(input),
    schema: SUGGEST_TOOL_SCHEMA as unknown as Record<string, unknown>,
    toolName: "submit_world",
    maxTokens: 800,
    // Bumped from default — we WANT variety here. Default tool-use temperature
    // makes Claude converge on its single "best" answer for the same input,
    // which means clicking "Try another" returns the same world.
    temperature: 1,
  });
  return SuggestedWorldSchema.parse(raw);
}
