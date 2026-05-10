import { generateJSON } from "@/lib/claude";
import {
  ScenePromptsResponseSchema,
  type ScenePromptsResponse,
  type PromptableConcept,
  type AspectRatio,
} from "./types";

export type ScenePromptsInput = {
  concept: PromptableConcept;
  aspectRatio: AspectRatio;
  sceneCount: number;
  sceneDurationSec: number;
};

export function buildScenesSystem(): string {
  return `You generate image prompts for a faceless ambient slideshow. Each prompt is fed to nano-banana-pro (Google's Gemini 3 Pro Image) at 2K resolution and becomes one scene of the video.

Pro is materially better at three things vs the older model — lean into all three:
1. **Cinematographic vocabulary.** It actually responds to lens / focal length / film stock / lighting direction. Use them.
2. **Material specificity.** It knows the difference between travertine and limestone, oak and walnut, raw concrete and board-formed concrete. Be specific.
3. **Architectural taxonomy.** It knows International Style ≠ Brutalism ≠ Brazilian modernism. Name lineages, not categories.

The single most important rule: every scene must read as one cohesive piece. Same lighting style, same era, same material palette, same overall mood. Vary composition, scale, and subject — never the visual world.

Each prompt is one rich paragraph (60-100 words) structured like this:
- **Subject + composition** — what we see + framing (wide establishing shot, eye-level mid, intimate detail, low-angle threshold). Anchor with a focal length when it serves: "shot on 35mm" or "shot on 50mm" or "wide-angle 24mm" or "85mm portrait compression."
- **Materials, named precisely** — say "honed travertine," "raw board-formed concrete," "polished terrazzo," "white-oiled oak." Specificity > adjectives.
- **Light, with direction and quality** — name the source ("warm afternoon side-light through floor-to-ceiling glass," "soft north-facing skylight," "low golden-hour rake from the west"). Include a color temperature when relevant: "3200K tungsten interior glow against 5600K daylight."
- **Photographic register** — anchor in a real photographic style when useful: "shot on Kodak Portra 400," "Mamiya 7 medium format," "ARRI Alexa, anamorphic," "large-format 4×5 with fall-off." Optional, use for intentional mood.
- **Atmospheric notes** — silence, texture, the season, what the air feels like.

Hard constraints, every prompt:
- No people. No faces. No body parts. No silhouettes that read as human.
- No on-screen text, signage, brands, or readable writing of any kind.
- No generic "modern luxury home" filler — every scene must echo the specific concept.
- No identical compositions in a row — alternate between wide establishing / mid interior / threshold / intimate detail.
- Cinematic, photographic, restrained. Not illustrative, not 3D-render, not maximalist.

Structure the sequence like a slow film:
- Open with one or two establishing shots (exterior context, scale).
- Build interest with mid-shots of rooms and connections.
- Punctuate with intimate detail shots (a window jamb, a corner of a stair, a single object on a surface, a material edge).
- Close with a quiet cinematic shot — last light, a closing threshold, an exterior at dusk.

Return scenes in the order they should appear, numbered from 1.`;
}

export function buildScenesUser(input: ScenePromptsInput): string {
  const { concept, aspectRatio, sceneCount, sceneDurationSec } = input;
  return [
    `Concept: ${concept.workingTitle}`,
    `Hook: ${concept.hook}`,
    `Vibe: ${concept.vibe}`,
    concept.notes ? `Visual rules to lock down:\n${concept.notes}` : "",
    "",
    `Aspect ratio for downstream rendering: ${aspectRatio}`,
    `Number of scenes: ${sceneCount}`,
    `Per-scene duration: ${sceneDurationSec}s`,
    "",
    `Produce exactly ${sceneCount} scenes, numbered 1 through ${sceneCount}, as a continuous visual sequence. Each scene's durationSec should be ${sceneDurationSec} unless varying it serves the pacing.`,
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

  // Defensive: enforce the requested count and renumber from 1 if Claude drifted.
  const trimmed = parsed.scenes.slice(0, input.sceneCount);
  if (trimmed.length < input.sceneCount) {
    throw new Error(
      `Claude returned ${trimmed.length} scenes, expected ${input.sceneCount}. Try again or lower the count.`
    );
  }
  return {
    scenes: trimmed.map((s, i) => ({ ...s, order: i + 1 })),
  };
}
