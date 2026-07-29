import { z } from "zod";
import { generateJSON } from "@/lib/llm";
import {
  laneKey,
  MAINSTREAM_CANON,
  pickStyleLenses,
} from "./style-catalogue";
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
/**
 * Re-assertion of the lock, APPENDED after the style's own text. Nano weights
 * both ends of a prompt, and a lead-only lock loses to a style description
 * that implies new massing (verified 2026-07-24: "Brutalist Modern" and
 * "Streamline Moderne" both rotated the camera and rebuilt the facade while
 * "Googie" — same lock, restyle-only wording — held perfectly).
 */
export const ARCHITECTURE_LOCK_CLOSE =
  " FINAL CHECK — this must remain the SAME photograph of the SAME building from the SAME camera as the reference image: identical viewpoint, angle, framing, crop, and perspective; identical building footprint, massing, roofline, corner geometry, and window/door placement; identical background and horizon. Nothing structural is added, removed, reshaped, or re-angled — only surfaces, materials, colour, furnishings, decor, planting, and lighting change.";

export const ARCHITECTURE_LOCK =
  "This is the SAME space, only restyled — keep it the exact same photograph. Reproduce the base image's camera EXACTLY, as a locked tripod shot: identical camera position, angle, height, lens and focal length, framing, crop, and perspective/vanishing point. Keep the room's footprint, wall positions, ceiling height, and the exact size and placement of every window, door, and structural opening unchanged. Change ONLY the furnishings, finishes, materials, colour palette, textiles, decor, art, plants, and lighting. Restyle it as follows: ";

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
  /** Style names used in the studio's recent videos (most recent first).
   *  Fed as an avoid-list so consecutive videos don't repeat the lineup. */
  recentStyleNames?: string[];
  /** "styles" (default) = the YouTube long-form job: a tour of NAMED design
   *  movements. "concepts" = before-after: distinct design DIRECTIONS for
   *  one operator brief, which must obey that brief rather than march
   *  through the textbook canon. */
  mode?: "styles" | "concepts";
};

export function buildStylesSystem(mode: StyleInput["mode"] = "styles"): string {
  if (mode === "concepts") return buildConceptsSystem();
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
- **Go deeper than the obvious canon.** Every model defaults to the same dozen staples (Mid-Century Modern, Japandi, Industrial, Art Deco, Coastal, Scandinavian…) — a returning viewer should NOT see the same lineup video after video. Rotate across the full depth of nameable, searchable design languages: regional vernaculars (Provençal, Andalusian, Moroccan Riad, Mexican Hacienda, Kyoto Machiya, Alpine Chalet, British Colonial…), era-specific movements (Memphis, Postmodern, Bauhaus, Victorian, Hollywood Regency, 70s Conversation-Pit…), and current named directions (Organic Modern, Quiet Luxury, Dark Academia, Wabi-Sabi, Cottagecore, Maximalist Eclectic…). Aim for roughly one-third familiar search anchors and two-thirds fresher-but-still-searchable picks.

**Every space must be fully furnished, distinctive, and editorial — never dull, never empty:**
- FULLY dress the space for its style. A complete, considered scene: the right furniture and layout, rugs, textiles, art on the walls, lighting fixtures, plants, ceramics, books, and the small styling details that sell the look. An exterior gets its landscaping, planting, paving, outdoor furniture, and lighting. Never a bare, half-empty, or under-decorated room.
- Commit HARD to each style's signature. Name characterful, specific pieces and materials that unmistakably belong to it — a real "Hans Wegner shell chair", "travertine plinth", "bouclé sofa", not vague "modern furniture". A designer should name the style at a glance.
- Avoid the generic-AI default — the beige sofa, grey walls, one sad fiddle-leaf fig that every model reaches for. Each render should read like an editorial interiors shoot: full of personality, intent, and a point of view. Bold, beautiful, magazine-grade — not a furniture-catalogue stock photo.
- Push variety hard across the set: different palettes, different material families, different eras and moods, so the video never feels like the same room twice.

For EACH style return three fields:
- styleName: the on-screen card TITLE. Short (2-5 words), recognisable, search-friendly. Title Case. This is what the YouTube viewer reads, so make it the name they'd type into a search bar.
- styleSubtitle: the on-screen card SUBTITLE — one short line (4-10 words, max ~120 chars) that sits under the title and tells the viewer what defines this look. Name the feeling and a material or two, e.g. "Warm minimalism in oak, linen, and paper light." Sentence case, no trailing period needed. It must read as card copy, not a full sentence of prose.
- editPrompt: a single instruction describing ONLY the restyle for this named style. It MUST read as a re-dressing of the EXISTING building in the reference image — start with a restyle verb ("Restyle…", "Re-dress…", "Refinish…"). NEVER write "Create a…", "Design a…", "Build a…", or "A [style] building/exterior/space with…": those read as instructions to generate a NEW building and the model will rebuild the facade and move the camera. Equally, never describe massing, silhouette, rooflines, curved or chamfered corners, added volumes, canopies, towers, or new openings — even when the style is famous for them; express the style through SURFACE and CONTENTS only (materials, finishes, colour, glazing treatment, furnishings, planting, lighting, signage-free decor) applied to the geometry that already exists. A fixed instruction that locks the camera angle, framing, perspective, and architecture of the base is prepended automatically — so DO NOT write about the camera, framing, viewpoint, walls, windows, doors, or layout. Spend every word on the restyle, concretely and fully: name the materials (e.g. "white oak, lime-wash plaster, bouclé"), the palette, 5-8 specific furniture/decor pieces that fully furnish the space, the textiles and rugs, the wall art, the lighting fixtures, the plants/objects, and the quality/mood of light. Commit to the style's signature; picture an editorial, fully-styled room — not a sparse one. Keep it free of people and of any on-screen text, signage, or branding — richly inhabited and lived-in, never staged-showroom-empty.

Honor the operator's notes (location, tier, any angle) as a bias on style selection and on the light/mood — don't water them down.`;
}

/**
 * Before-after mode. Same inviolable camera/architecture lock as the styles
 * job, but a different brief: the operator has a real space and a real ask,
 * and wants to SEE several ways it could go. Naming textbook movements here
 * produced the same nine staples on every project (Art Deco even when the
 * brief said "nothing too flamboyant") — so this prompt asks for design
 * directions that answer the brief instead.
 */
function buildConceptsSystem(): string {
  return `You are an interior/architectural designer presenting options to a client. They have sent you a photograph of a REAL space and a brief. You propose several genuinely different directions that space could go — the kind of options a designer pins on a board, each one a real answer to what the client asked for.

You can SEE the space in this message. Study it first: read its architecture, geometry, camera angle, window and door positions, ceiling, proportions, existing materials, and the light already in the room.

**The one inviolable rule: the space's ARCHITECTURE and the CAMERA never change.** Every direction is the SAME photograph of the SAME space, re-dressed. Across all directions these stay identical to the photo:
- the camera position, angle, height, lens/focal length, framing, and crop
- the perspective and vanishing point
- the room's footprint, wall positions, ceiling height, and overall geometry
- the size and placement of every window, door, and structural opening

What each direction DOES change: furniture, finishes and materials, colour palette, textiles, decor and art, lighting fixtures, surface treatments, and the overall mood and quality of light. The client must instantly recognise their own space — dressed differently.

**What makes a good SET of directions:**
- THE BRIEF RULES. Every direction must satisfy every constraint the client gave. If they said "nothing too flamboyant", none of your options may be theatrical — not even one "for contrast". If they named a budget, a mood, a must-keep feature, or something to avoid, obey it in all of them. Violating the brief is the single worst failure here.
- They are options, not a museum tour. Do NOT march through the textbook canon (Mid-Century Modern, Japandi, Industrial Loft, Art Deco, Coastal, Scandinavian, Modern Farmhouse…). A client seeing nine famous style labels knows they got a generic answer. Differentiate by the decisions a designer actually makes: material family, palette temperature and depth, formality, era of the furniture, how much pattern, how the light is handled.
- They are genuinely distinct from each other — a client should be able to say "that one, not that one". Two warm-minimal variants with different names is a failed set.
- Every direction suits THIS space's program, proportions and existing light — no option that fights the bones of the room.

**Every direction must be fully furnished, distinctive, and editorial — never dull, never empty:**
- FULLY dress the space: the right furniture and layout, rugs, textiles, art on the walls, lighting fixtures, plants, ceramics, books, the small styling details that sell it. An exterior gets landscaping, planting, paving, outdoor furniture and lighting. Never a bare, half-empty, or under-decorated room.
- Name characterful, specific pieces and materials — "burled oak sideboard", "unlacquered brass sconce", "limewash in bone", not "modern furniture".
- Avoid the generic-AI default: the beige sofa, grey walls, one sad fiddle-leaf fig. Each render should read like an editorial interiors shoot with a point of view.

For EACH direction return three fields:
- styleName: the on-screen card TITLE. Short (2-4 words), Title Case. Name the DIRECTION, not a movement from the canon — lead with the material, palette or feeling that defines it ("Warm Oak Minimal", "Bone & Brass", "Deep Green Study", "Soft Plaster Calm"). It should read like a designer's board label a client would repeat back.
- styleSubtitle: the on-screen card SUBTITLE — one short line (4-10 words, max ~120 chars) naming the feeling plus a material or two. Sentence case, no trailing period needed.
- editPrompt: a single instruction describing ONLY the restyle. It MUST read as a re-dressing of the EXISTING space — start with a restyle verb ("Restyle…", "Re-dress…", "Refinish…"). NEVER write "Create a…", "Design a…", "Build a…" or "A [style] room with…": those read as instructions to generate a NEW space and the model will rebuild it and move the camera. Never describe massing, rooflines, added volumes or new openings. A fixed instruction locking the camera, framing, perspective and architecture is prepended automatically — so DO NOT write about the camera, framing, viewpoint, walls, windows, doors, or layout. Spend every word on the restyle: the materials, the palette, 5-8 specific furniture/decor pieces that fully furnish the space, textiles and rugs, wall art, lighting fixtures, plants/objects, and the quality and mood of the light. Keep it free of people and of any on-screen text, signage, or branding — richly inhabited and lived-in, never staged-showroom-empty.

Honor the client's brief above everything else.`;
}

export function buildStylesUser(input: StyleInput): string {
  const isConcepts = input.mode === "concepts";
  const programLine = programBrief(input.propertyType, input.worldType, isConcepts);
  const lines = isConcepts
    ? [
        `Propose exactly ${input.count} distinct design directions for the REAL space photographed above.`,
        "",
        programLine,
      ]
    : [
        `Propose exactly ${input.count} distinct styles for the base space shown above.`,
        "",
        programLine,
      ];
  if (input.operatorNotes && input.operatorNotes.trim()) {
    lines.push(
      "",
      isConcepts
        ? `THE BRIEF — this governs every direction you propose. Obey it literally: any constraint here ("nothing too flamboyant", "no pets", "keep the fireplace", a budget, a mood, a target buyer) is a HARD requirement, and a direction that violates it is a failed answer:\n${input.operatorNotes.trim()}`
        : `Operator notes (let these bias the style selection and the light/mood): ${input.operatorNotes.trim()}`
    );
  }
  // ── Rotating lenses (styles mode) ───────────────────────────────────────
  // The real anti-recycling mechanism: each project is dealt a different
  // subset of the catalogue's axes, so consecutive videos are pushed into
  // structurally different territory instead of relying on the model to
  // diversify itself (it doesn't — see style-catalogue.ts).
  if (isConcepts) {
    // Concepts mode gets rotation too — otherwise the SAME brief twice
    // ("modernize this kitchen") yields the same nine directions. These are
    // starting points to spread the options across, NOT labels to reuse:
    // the brief still governs, and names stay material/palette/feeling-led.
    const lenses = pickStyleLenses(laneKey(input.propertyType, input.worldType), {
      axisCount: 3,
      examplesPerAxis: 6,
    });
    lines.push(
      "",
      `STARTING POINTS — spread your ${input.count} directions across these territories so no two feel like siblings. Treat them as raw material to ADAPT to the brief, never as style labels to hand back:`,
      ...lenses.map((l) => `  · ${l.name} (${l.hint}) — e.g. ${l.examples.join(", ")}`),
      `If the brief rules one of these out, drop it — the brief always wins.`
    );
  }
  if (!isConcepts) {
    const lenses = pickStyleLenses(laneKey(input.propertyType, input.worldType));
    const fromLenses = Math.max(1, Math.ceil(input.count * 0.7));
    lines.push(
      "",
      `THIS VIDEO'S EXPLORATION LENSES — at least ${fromLenses} of your ${input.count} picks must come from these axes. The example names are PROMPTS, not a menu: pick from them, or name something else that genuinely belongs to the same axis.`,
      ...lenses.map(
        (l) => `  · ${l.name} (${l.hint}) — e.g. ${l.examples.join(", ")}`
      ),
      "",
      `MAINSTREAM CANON CAP — at most 3 of your ${input.count} picks may come from this over-used set, and only where one genuinely suits the space: ${MAINSTREAM_CANON.join(", ")}. A lineup built mostly from those names is the generic answer this brief exists to avoid.`
    );
  }
  if (input.recentStyleNames && input.recentStyleNames.length > 0) {
    lines.push(
      "",
      `Already used in the studio's recent videos (most recent first): ${input.recentStyleNames.join(", ")}.`,
      `Freshness rule: reuse AT MOST ${Math.max(1, Math.floor(input.count / 4))} of those, and only when they're a perfect fit for this space — fill the rest with directions NOT on that list.`
    );
  }
  lines.push(
    "",
    isConcepts
      ? `Return ${input.count} directions, each clearly different from the others, each obeying the brief, each genuinely achievable in the real space you can see above.`
      : `Return ${input.count} styles, each clearly different from the others, each a real searchable design name, each genuinely flattering to the space you can see above.`
  );
  return lines.join("\n");
}

/** One-line brief describing the program (residential/commercial) × vantage
 *  (interior/exterior), with example style families so GPT-5.5 stays in the
 *  right lane. Examples are guidance, NOT a fixed menu. */
function programBrief(
  propertyType: PropertyType,
  worldType: WorldType,
  omitStyleFamilies = false
): string {
  // NOTE: this used to end with "Style families to draw from: Scandinavian,
  // Mid-Century Modern, Japandi, Industrial Loft, …" — a 12-name menu that
  // became the answer on every residential-interior project. The lenses in
  // style-catalogue.ts replace it; this line now only states the program.
  void omitStyleFamilies;
  const space =
    propertyType === "residential"
      ? worldType === "interior"
        ? "a room inside a home"
        : "a home seen from outside (facade, entry, yard)"
      : worldType === "interior"
        ? "a workspace, lobby, retail floor, restaurant, café or hospitality space (NOT a home)"
        : "a storefront, commercial facade or mixed-use frontage (NOT a home)";
  return `Program: ${propertyType.toUpperCase()} ${worldType.toUpperCase()} — ${space}. Read the photograph for what the space actually is and design for it.`;
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
    `${vantage} (${program}). Show it clearly and NEUTRALLY so it can be restyled afterwards: even, soft natural daylight; eye-level, straight-on composition; the architecture, layout, windows/openings, ceiling, and proportions all clearly legible. The space is empty or very minimally furnished — bare floors, walls, ceiling, and openings fully visible, with at most a few plain built-in elements — so each restyle can furnish it freely. An empty, quiet, photographic frame of pure architecture.`,
  ].join("\n");
}

export async function generateStyles(input: StyleInput): Promise<StylesResponse> {
  const raw = await generateJSON<unknown>({
    system: buildStylesSystem(input.mode),
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
