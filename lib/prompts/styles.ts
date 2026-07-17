import { z } from "zod";
import { generateJSON } from "@/lib/llm";
import type { PropertyType, WorldType } from "./types";

// ── Style explorer ───────────────────────────────────────────────────────────
//
// The base is a text-to-image render of a space the operator DESCRIBES (we
// never use someone else's photo). buildBaseImagePrompt turns that description
// into a clean, neutral base image; the operator reviews/regenerates it, then:
// GPT-5.5 — using vision, so it actually sees the rendered base — proposes N
// distinct, nameable design styles. Each style becomes a scene whose editPrompt
// is fed to nano-banana-pro/edit with the base pinned as the reference,
// producing "the same space, restyled." The set powers a YouTube long-form "X
// styles of this [space]" walkthrough. Names are the on-screen card copy (done
// in CapCut), so they must be recognisable and search-friendly.

const StyleSchema = z.object({
  styleName: z.string().min(2).max(60),
  styleSubtitle: z.string().min(2).max(120),
  editPrompt: z.string().min(80).max(1500),
});
export type Style = z.infer<typeof StyleSchema>;

const StylesResponseSchema = z.object({
  styles: z.array(StyleSchema).min(1).max(20),
});
export type StylesResponse = z.infer<typeof StylesResponseSchema>;

/**
 * Fixed camera + architecture lock prepended to EVERY styled edit prompt at
 * fan-out. Deterministic — NOT left to per-style GPT-5.5 wording, because GPT-5.5
 * occasionally softened the lock for individual styles and a few edits drifted
 * to a new camera angle. Leads the prompt (the edit model weights early tokens
 * most) and ends mid-sentence so the style's restyle text continues it.
 */
export const ARCHITECTURE_LOCK =
  "This is the SAME space, only restyled — keep it the exact same photograph. Match the base image's camera EXACTLY: identical camera position, angle, height, lens and focal length, framing, crop, and perspective/vanishing point — do not move, rotate, zoom, tilt, or re-crop the camera. Keep the room's footprint, wall positions, ceiling height, and the exact size and placement of every window, door, and structural opening unchanged. Change ONLY the furnishings, finishes, materials, colour palette, textiles, decor, art, plants, and lighting. Restyle it as follows: ";

export type StyleInput = {
  /** Public Blob URL of the uploaded base. Sent to GPT-5.5 as a vision block. */
  baseImageUrl: string;
  worldType: WorldType;
  propertyType: PropertyType;
  /** How many distinct styles to propose (operator-chosen, clamped 3–20). */
  count: number;
  /** Optional steering — location ("South Florida"), tier ("high-end"), or any
   *  angle the operator wants the SEO title to lean into. */
  operatorNotes?: string;
};

export function buildStylesSystem(): string {
  return `You are an art director producing a YouTube long-form video that shows ONE real space reimagined in several distinct interior/architectural design styles. The operator describes the space and the studio renders a neutral base image of it; you propose the styles.

You can SEE the base space in this message (a rendered image of the space). Study it first: read its architecture, geometry, camera angle, window and door positions, ceiling, proportions, and the light already in the room.

**The one inviolable rule: the space's ARCHITECTURE and the CAMERA never change.** Every style is the SAME photograph of the SAME space, re-dressed in a different aesthetic. Across all styles, these stay identical to the base:
- the camera position, angle, height, lens/focal length, framing, and crop
- the perspective and vanishing point
- the room's footprint, wall positions, ceiling height, and overall geometry
- the size and placement of every window, door, and structural opening

Treat the base as a fixed shot: the styled result must read as the EXACT same photo from the EXACT same viewpoint, with only the décor changed. If a style would only work from a different angle or framing, you picked the wrong style — make it work within this exact shot.

What each style DOES change: furniture, finishes and materials, color palette, textiles, decor and art, lighting fixtures, surface treatments, and the overall mood and quality of light. A viewer must instantly recognise it as the same room — only dressed in a different world.

**What makes a good set of styles:**
- Each style is a REAL, NAMEABLE, recognisable design language — the kind of term a viewer would search ("Mid-Century Modern", "Japandi", "Industrial Loft", "Coastal Contemporary", "Art Deco"). Not invented mash-up names; not vague adjectives like "cozy" or "modern" on their own.
- The styles are clearly DISTINCT from one another. Vary the era, the material family, the palette, and the formality so no two read as siblings. Don't ship two beige-minimalist variants.
- Every style genuinely suits THIS space's program and vantage (see the brief below) — don't propose a style that fights the bones of the room.

**Every space must be fully furnished, distinctive, and editorial — never dull, never empty:**
- FULLY dress the space for its style. A complete, considered scene: the right furniture and layout, rugs, textiles, art on the walls, lighting fixtures, plants, ceramics, books, and the small styling details that sell the look. An exterior gets its landscaping, planting, paving, outdoor furniture, and lighting. Never a bare, half-empty, or under-decorated room.
- Commit HARD to each style's signature. Name characterful, specific pieces and materials that unmistakably belong to it — a real "Hans Wegner shell chair", "travertine plinth", "bouclé sofa", not vague "modern furniture". A designer should name the style at a glance.
- Avoid the generic-AI default — the beige sofa, grey walls, one sad fiddle-leaf fig that every model reaches for. Each render should read like an editorial interiors shoot: full of personality, intent, and a point of view. Bold, beautiful, magazine-grade — not a furniture-catalogue stock photo.
- Push variety hard across the set: different palettes, different material families, different eras and moods, so the video never feels like the same room twice.

For EACH style return three fields:
- styleName: the on-screen card TITLE. Short (2-5 words), recognisable, search-friendly. Title Case. This is what the YouTube viewer reads, so make it the name they'd type into a search bar.
- styleSubtitle: the on-screen card SUBTITLE — one short line (4-10 words, max ~120 chars) that sits under the title and tells the viewer what defines this look. Name the feeling and a material or two, e.g. "Warm minimalism in oak, linen, and paper light." Sentence case, no trailing period needed. It must read as card copy, not a full sentence of prose.
- editPrompt: a single instruction describing ONLY the restyle for this named style. A fixed instruction that locks the camera angle, framing, perspective, and architecture of the base is prepended automatically — so DO NOT write about the camera, framing, viewpoint, walls, windows, doors, or layout. Spend every word on the restyle, concretely and fully: name the materials (e.g. "white oak, lime-wash plaster, bouclé"), the palette, 5-8 specific furniture/decor pieces that fully furnish the space, the textiles and rugs, the wall art, the lighting fixtures, the plants/objects, and the quality/mood of light. Commit to the style's signature; picture an editorial, fully-styled room — not a sparse one. Keep it free of people and of any on-screen text, signage, or branding — richly inhabited and lived-in, never staged-showroom-empty.

Honor the operator's notes (location, tier, any angle) as a bias on style selection and on the light/mood — don't water them down.`;
}

export function buildStylesUser(input: StyleInput): string {
  const programLine = programBrief(input.propertyType, input.worldType);
  const lines = [
    `Propose exactly ${input.count} distinct styles for the base space shown above.`,
    "",
    programLine,
  ];
  if (input.operatorNotes && input.operatorNotes.trim()) {
    lines.push("", `Operator notes (let these bias the style selection and the light/mood): ${input.operatorNotes.trim()}`);
  }
  lines.push(
    "",
    `Return ${input.count} styles, each clearly different from the others, each a real searchable design name, each genuinely flattering to the space you can see above.`
  );
  return lines.join("\n");
}

/** One-line brief describing the program (residential/commercial) × vantage
 *  (interior/exterior), with example style families so GPT-5.5 stays in the
 *  right lane. Examples are guidance, NOT a fixed menu. */
function programBrief(propertyType: PropertyType, worldType: WorldType): string {
  if (propertyType === "residential" && worldType === "interior") {
    return "Program: RESIDENTIAL INTERIOR — a room inside a home. Style families to draw from (not a fixed menu): Scandinavian, Mid-Century Modern, Japandi, Industrial Loft, Bohemian, Coastal Contemporary, Minimalist, Modern Farmhouse, Art Deco, Mediterranean, Traditional, Contemporary Luxe.";
  }
  if (propertyType === "residential" && worldType === "exterior") {
    return "Program: RESIDENTIAL EXTERIOR — a home seen from outside (facade, entry, yard). Style families to draw from (not a fixed menu): Modern, Mediterranean, Spanish Revival, Mid-Century Modern, Contemporary, Coastal/Tropical, Modern Farmhouse, Colonial, Tudor, Desert Contemporary.";
  }
  if (propertyType === "commercial" && worldType === "interior") {
    return "Program: COMMERCIAL INTERIOR — a workspace, lobby, retail floor, restaurant, café, or hospitality space (NOT a home). Style families to draw from (not a fixed menu): Boutique Hotel, Scandinavian Workspace, Industrial Café, Luxury Retail, Biophilic Office, Art Deco Bar, Minimalist Gallery, Warm Contemporary Office, Speakeasy, Mediterranean Restaurant.";
  }
  return "Program: COMMERCIAL EXTERIOR — a storefront, commercial facade, or mixed-use frontage (NOT a home). Style families to draw from (not a fixed menu): Modern Glass, Industrial Brick, Mediterranean Plaza, Contemporary Mixed-Use, Boutique Storefront, Art Deco Facade, Minimalist Concrete, Coastal Hospitality.";
}

/** Static parts of the tool schema. The styles array's min/max items are set
 *  per-call to the requested count to nudge GPT-5.5 to the exact number. */
function buildStylesToolSchema(count: number): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      styles: {
        type: "array",
        minItems: count,
        maxItems: count,
        description: `JSON ARRAY of exactly ${count} distinct styles. Each must be a real, recognisable, search-friendly design language — no two alike.`,
        items: {
          type: "object",
          properties: {
            styleName: {
              type: "string",
              minLength: 2,
              maxLength: 60,
              description: "On-screen card TITLE. 2-5 words, Title Case, recognisable and searchable (e.g. \"Mid-Century Modern\", \"Japandi\", \"Industrial Loft\").",
            },
            styleSubtitle: {
              type: "string",
              minLength: 2,
              maxLength: 120,
              description: "On-screen card SUBTITLE. One short line (4-10 words), sentence case, naming the feeling + a material or two (e.g. \"Warm minimalism in oak, linen, and paper light\"). Card copy, not prose. Hard cap 120 chars.",
            },
            editPrompt: {
              type: "string",
              minLength: 80,
              maxLength: 1500,
              description: "Describes ONLY the restyle for this style (materials, palette, 5-8 specific furniture/decor pieces, textiles, wall art, lighting, plants, mood/light). Do NOT mention the camera, framing, viewpoint, walls, windows, doors, or layout — a fixed camera + architecture lock is prepended automatically. No people, no text/signage. Hard cap 1500 chars.",
            },
          },
          required: ["styleName", "styleSubtitle", "editPrompt"],
          additionalProperties: false,
        },
      },
    },
    required: ["styles"],
    additionalProperties: false,
  };
}

/** tool_use treats array length + maxLength as soft hints. Coerce: trim
 *  overshooting editPrompts, drop blanks, dedupe style names case-insensitively
 *  (a repeated style is a wasted scene), and cap at the requested count. */
function coerceStyles(raw: unknown, count: number): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const obj = raw as { styles?: unknown };
  if (!Array.isArray(obj.styles)) return raw;

  const seen = new Set<string>();
  const cleaned: Style[] = [];
  for (const s of obj.styles) {
    if (!s || typeof s !== "object") continue;
    const rec = s as Record<string, unknown>;
    const styleName = typeof rec.styleName === "string" ? rec.styleName.trim() : "";
    let styleSubtitle = typeof rec.styleSubtitle === "string" ? rec.styleSubtitle.trim() : "";
    let editPrompt = typeof rec.editPrompt === "string" ? rec.editPrompt.trim() : "";
    if (!styleName || !editPrompt) continue;
    const key = styleName.toLowerCase();
    if (seen.has(key)) {
      console.warn(`[styles] GPT-5.5 returned a duplicate style "${styleName}"; dropping.`);
      continue;
    }
    if (editPrompt.length > 1500) {
      console.warn(`[styles] editPrompt for "${styleName}" overshot (${editPrompt.length} > 1500); truncating.`);
      editPrompt = editPrompt.slice(0, 1499) + "…";
    }
    if (styleSubtitle.length > 120) styleSubtitle = styleSubtitle.slice(0, 119) + "…";
    // Subtitle is card polish, not load-bearing — if GPT-5.5 omitted it, fall
    // back to the title so the row still satisfies the schema.
    if (!styleSubtitle) styleSubtitle = styleName;
    seen.add(key);
    cleaned.push({ styleName: styleName.slice(0, 60), styleSubtitle, editPrompt });
  }

  return { styles: cleaned.slice(0, count) };
}

/**
 * Turn the operator's free-text description of a space into a text-to-image
 * prompt for the BASE render. The base is deliberately neutral — a clean,
 * legible starting point that reads as "the space" so the style edits have
 * clear architecture to preserve and restyle. The operator reviews this render
 * (and regenerates it) before any styles are generated.
 */
export function buildBaseImagePrompt(
  description: string,
  worldType: WorldType,
  propertyType: PropertyType
): string {
  const vantage =
    worldType === "interior"
      ? "Realistic interior photograph of the space"
      : "Realistic exterior architectural photograph of the building";
  const program = propertyType === "commercial" ? "commercial" : "residential";
  return [
    description.trim(),
    "",
    `${vantage} (${program}). Show it clearly and NEUTRALLY so it can be restyled afterwards: even, soft natural daylight; eye-level, straight-on composition; the architecture, layout, windows/openings, ceiling, and proportions all clearly legible. Lightly and tastefully furnished in a plain contemporary way — a clean starting point, NOT a strong style. No people, no on-screen text, no signage, no watermark.`,
  ].join("\n");
}

export async function generateStyles(input: StyleInput): Promise<StylesResponse> {
  const raw = await generateJSON<unknown>({
    system: buildStylesSystem(),
    user: buildStylesUser(input),
    images: [input.baseImageUrl],
    schema: buildStylesToolSchema(input.count),
    toolName: "submit_styles",
    // Each editPrompt can run ~1500 chars (~400 tokens); budget per style plus
    // headroom for the names and JSON scaffolding.
    maxTokens: Math.min(8000, input.count * 500 + 1000),
  });
  return StylesResponseSchema.parse(coerceStyles(raw, input.count));
}
