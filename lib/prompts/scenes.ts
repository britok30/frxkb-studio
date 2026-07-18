import { generateJSON } from "@/lib/llm";
import type { Look } from "./looks";
import {
  ScenePromptsResponseSchema,
  type ScenePromptsResponse,
  type PromptableConcept,
  type AspectRatio,
  type WorldType,
} from "./types";

export type ScenePromptsInput = {
  concept: PromptableConcept;
  aspectRatio: AspectRatio;
  sceneCount: number;
  sceneDurationSec: number;
  worldType: WorldType;
  /** Committed photographic look. When present, every scene's light, camera,
   *  and photographic register must be written inside this look — the same
   *  block is also appended deterministically at fal time, so the two layers
   *  reinforce rather than fight. */
  look?: Look | null;
};

export function buildScenesSystem(): string {
  return `You generate image prompts for a design-inspiration feed about RESIDENTIAL HOMES — interiors people actually live in, exteriors of houses people actually own. Each prompt is fed to nano-banana-pro (Google's Gemini 3 Pro Image) at 2K resolution. The output should look like imagery a designer or homeowner would screenshot for their inspiration folder.

These are real, lived-in homes. They are FULL of life — just without humans in frame.

Pro is materially better at three things vs the older model — lean into all three:
1. **Cinematographic vocabulary.** It actually responds to lens / focal length / film stock / lighting direction. Use them.
2. **Material specificity.** It knows the difference between travertine and limestone, oak and walnut, raw concrete and board-formed concrete. Be specific.
3. **Architectural taxonomy.** It knows International Style ≠ Brutalism ≠ Brazilian modernism. Name lineages, not categories.

The single most important rule: every scene must read as one cohesive HOME. Same lighting style, same era, same material palette, same family of objects. Vary composition, scale, and which corner of the home we're seeing — never the visual world.

Each prompt is one rich paragraph (70-110 words — Pro weights early tokens heaviest, so tight beats exhaustive) structured like this:
- **Subject + composition** — what we see + framing (wide establishing of a living room, eye-level mid through a kitchen, intimate detail of a reading nook, low-angle threshold from a hallway). Anchor with a focal length when it serves: "shot on 35mm" or "shot on 50mm" or "wide-angle 24mm" or "85mm portrait compression."
- **Materials, named precisely** — say "honed travertine," "raw board-formed concrete," "polished terrazzo," "white-oiled oak." Specificity > adjectives.
- **Lived-in objects (REQUIRED, not optional)** — every interior scene names specific objects drawn from these categories: furniture, plants, art and ceramics, textiles, daily-life details, functional objects. The brief commits to a per-piece object set rooted in this home's specific cultural lineage; draw your scene objects from THAT set, not from a generic moodboard default. A Tokyo apartment's objects look nothing like a Mallorcan finca's; a Marrakech riad's objects look nothing like a Brooklyn loft's. Let the lineage drive every named object.
- **Light, with direction and quality** — name the source ("warm afternoon side-light through floor-to-ceiling glass," "soft north-facing skylight," "low golden-hour rake from the west"). Include a color temperature when relevant: "3200K tungsten interior glow against 5600K daylight."
- **Photographic register** — anchor in a real photographic style when useful: "shot on Kodak Portra 400," "Mamiya 7 medium format," "ARRI Alexa, anamorphic," "large-format 4×5 with fall-off." Optional, use for intentional mood.

For exterior scenes (residential exteriors only):
- These are HOMES from outside — houses, villas, fincas, cottages, lofts, riads, cabins. Not pavilions, not museums, not corporate buildings.
- Every exterior scene names specific elements from these categories: landscape (the actual flora/terrain of the region), water features (pool, basin, fountain — or none, when the lineage doesn't call for one), outdoor lighting (sconces, lanterns, candles — fitting the lineage), site features (garden walls, terraces, paths, gates, courtyards), and the residential-life details that signal the home is owned (planters, porch chairs, climbing plants, garden tools, an outdoor table set). Same lineage rule as interior: the brief's object set drives what's actually named — a Joshua Tree desert house's elements look nothing like a Cotswold cottage's.
- The home is the subject; the lineage-specific life around it is what makes it feel inhabited.

Depictions-of-people rule (CRITICAL — downstream video generation REJECTS any image containing a real person's likeness or name): all art, prints, album sleeves, book covers, magazines, and photographs inside the scene show abstract, botanical, landscape, architectural, or geometric imagery only. When a prompt names media objects (vinyl records, art books, framed photos), describe their covers/contents in those terms — e.g. "a stack of records with plain earth-toned sleeves", "a framed desert landscape print".

Required qualities for every prompt (positive language only — Gemini 3 Pro Image renders what you NAME):
- A real, residential home — somewhere a person actually lives. Saturate the frame with the OBJECTS of their life, drawn from the brief's per-piece object set. The home is empty of people but FULL of evidence of them.
- Echo the specific concept tightly — name the era, region, materials from the brief.
- Vary composition across the sequence — alternate between wide establishing, mid interior, threshold, and intimate detail. Each scene's framing is different from the previous one.
- Photographic register — captured on real film stock or a real cinema camera. Restrained, tasteful, lived-in and characterful.

Compose for the delivery frame — the aspect ratio in the brief is a composition instruction, not metadata:
- Vertical (9:16, 3:4, 4:5): exploit floor-to-ceiling height. Stack the frame — foreground object low, midground furniture, background window or opening high. Tall windows, doorways, and vertical architecture are your friends. Generous headroom. Favor 24-35mm.
- Horizontal (16:9, 21:9, 4:3): layer laterally and lead the eye across the room; establishing shots breathe here. Favor 35-50mm.
- Square (1:1): centered, symmetrical, one clear focal subject.

Structure the sequence like a slow walk through a home:
- Open with one or two establishing shots (exterior arrival or wide interior, scale + context).
- Build interest with mid-shots of rooms and the objects in them.
- Punctuate with intimate detail shots (a corner of a stack of books, a single ceramic on a windowsill, light catching a brass kettle, a folded blanket on a daybed).
- Close with a quiet cinematic shot — last light through a window, a doorway opening onto a garden, a candle just lit.

Return scenes in the order they should appear, numbered from 1.`;
}

export function buildScenesUser(input: ScenePromptsInput): string {
  const { concept, aspectRatio, sceneCount, sceneDurationSec, worldType, look } = input;
  // The look wins over any lighting instinct GPT-5.5 has for the concept —
  // one committed quality of light across the whole sequence is exactly what
  // separates an editorial set from a generic one.
  const lookBlock = look
    ? [
        "",
        `Committed photographic look — ${look.name}: ${look.prompt}`,
        "Write EVERY scene's light and color temperature inside this exact look. Do not drift to a different time of day or light source in any scene; vary composition and subject, never the light.",
        "The look owns the photographic register: do NOT name a film stock, camera body, or color grade in any scene — one register is appended downstream for the whole set. Spend those words on subject, materials, objects, and composition instead.",
      ].join("\n")
    : "";
  const worldRules =
    worldType === "interior"
      ? "World is INTERIOR — every scene is inside someone's HOME. Living rooms, kitchens, bedrooms, reading nooks, hallways, kitchens mid-use, bathrooms, studies, entryways. Vary by room and by scale (wide → mid → detail). Never step outside."
      : "World is EXTERIOR — every scene is a residential HOME from the outside. Houses, villas, cottages, lofts, fincas, riads, cabins. The home is the subject; lineage-specific landscape, water/pool, lighting, and site features (drawn from the object set below) are what make it feel like someone's house and not a museum.";
  // Inject the brief's committed object set as a quoted block so scene
  // prompts draw their named objects from THIS lineage, not from any
  // global default. Falls back gracefully for legacy concepts persisted
  // before objectSet existed (those default to []).
  const objectSetBlock =
    concept.objectSet && concept.objectSet.length > 0
      ? [
          "",
          "Object set committed in the brief (draw scene objects from this list, not from defaults):",
          ...concept.objectSet.map((o) => `- ${o}`),
          "",
          "Distribute these across scenes — do NOT name every object in every scene, but EVERY named scene-object must come from this list or be an obvious lineage-sibling. Different scenes spotlight different subsets so the sequence reads as a walk through one coherent home.",
        ].join("\n")
      : "";
  return [
    `Concept: ${concept.workingTitle}`,
    `Hook: ${concept.hook}`,
    `Vibe: ${concept.vibe}`,
    concept.notes ? `Visual rules to lock down:\n${concept.notes}` : "",
    objectSetBlock,
    lookBlock,
    "",
    worldRules,
    "",
    `Aspect ratio for downstream rendering: ${aspectRatio} — compose every frame for this orientation per the composition rules.`,
    `Number of scenes: ${sceneCount}`,
    `Per-scene duration: ${sceneDurationSec}s`,
    "",
    `Produce exactly ${sceneCount} scenes, numbered 1 through ${sceneCount}, as a continuous walk through ONE home. Each scene's durationSec should be ${sceneDurationSec} unless varying it serves the pacing.`,
  ]
    .filter(Boolean)
    .join("\n");
}

const SCENES_TOOL_SCHEMA = {
  type: "object",
  properties: {
    scenes: {
      type: "array",
      minItems: 1,
      maxItems: 120,
      items: {
        type: "object",
        properties: {
          order: { type: "integer", minimum: 1 },
          prompt: { type: "string", minLength: 200, maxLength: 1500 },
          durationSec: { type: "integer", minimum: 2, maximum: 15 },
        },
        required: ["order", "prompt", "durationSec"],
        additionalProperties: false,
      },
    },
  },
  required: ["scenes"],
  additionalProperties: false,
} as const;

export async function generateScenePrompts(
  input: ScenePromptsInput
): Promise<ScenePromptsResponse> {
  const raw = await generateJSON<unknown>({
    system: buildScenesSystem(),
    user: buildScenesUser(input),
    schema: SCENES_TOOL_SCHEMA as unknown as Record<string, unknown>,
    toolName: "submit_scenes",
    maxTokens: 8000,
  });
  const parsed = ScenePromptsResponseSchema.parse(raw);

  // Defensive: enforce the requested count and renumber from 1 if GPT-5.5 drifted.
  const trimmed = parsed.scenes.slice(0, input.sceneCount);
  if (trimmed.length < input.sceneCount) {
    throw new Error(
      `GPT-5.5 returned ${trimmed.length} scenes, expected ${input.sceneCount}. Try again or lower the count.`
    );
  }
  return {
    scenes: trimmed.map((s, i) => ({ ...s, order: i + 1 })),
  };
}
