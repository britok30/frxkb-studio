import { z } from "zod";
import { generateJSON } from "@/lib/llm";
import type { PromptableConcept } from "./types";

export const MotionPromptSchema = z.object({
  order: z.number().int().min(1),
  /** Short directive for seedance describing camera + subject motion.
   *  Cap is 360 chars — a valid 50-word sentence regularly runs past 280. */
  motion: z.string().min(20).max(360),
});
export type MotionPrompt = z.infer<typeof MotionPromptSchema>;

export const MotionPromptsResponseSchema = z.object({
  motions: z.array(MotionPromptSchema).min(1).max(120),
});
export type MotionPromptsResponse = z.infer<typeof MotionPromptsResponseSchema>;

// Camera-move preset catalog lives in ./camera-moves (client-safe — the
// scene-card picker imports it directly; this module pulls in lib/llm which
// can't ship to the browser). Re-exported here for server-side callers.
export { CAMERA_MOVES, getCameraMove, type CameraMove } from "./camera-moves";
import { getCameraMove } from "./camera-moves";

export type MotionPromptsInput = {
  concept: PromptableConcept;
  /** The same scene array that was used to generate stills. motionPreset,
   *  when present, is a CAMERA_MOVES id the operator locked for that scene. */
  scenes: { order: number; prompt: string; motionPreset?: string | null }[];
};

export function buildMotionSystem(): string {
  return `You write motion descriptions for an ambient design slideshow getting animated by Seedance 2.0 (image-to-video). Each scene's still becomes a 5-9s clip; your job is to direct the camera + subtle motion that brings it alive while keeping the meditative ambient register.

Seedance 2.0 has no negative_prompt field — every word in the prompt becomes a positive token in its latent. Phrase ALL guidance affirmatively. Naming a forbidden camera move (e.g. "no whip-pan") risks pulling that move INTO the output.

**Camera move vocabulary — pick exactly ONE per clip from this allowlist:**
- slow dolly in
- slow dolly out
- slow push-in through an opening (a doorway, archway, or window — the reveal move; use on threshold shots)
- slow orbit left / slow orbit right (a gentle arc around the subject — best on exteriors and object-centered detail shots)
- gentle rack focus (focus glides from a foreground detail to the room beyond — use when the still has clear foreground/background layers)
- gentle pan left
- gentle pan right
- slow tilt up
- slow tilt down
- locked-off static (the camera holds; only environmental motion happens)
- subtle handheld (very gentle — almost imperceptible drift)

Match the move to the shot: orbits flatter exteriors and single-subject details, push-through-reveals belong on thresholds, rack focus needs layered depth, dollies and statics work anywhere.

Use rhythmic adjectives only — slow, gentle, subtle, gradual, smooth. No technical specs (no fps, no f-stops, no shutter values).

Across a sequence, do NOT repeat the same camera move on consecutive clips. Cycle through the vocabulary deliberately so the reel reads as composed, not one-note.

**Subject motion (separate from camera motion) — what happens in the scene:**
- Interior scenes: subtle environmental motion AND subtle motion on lived-in objects (curtain breeze, steam rising from a fresh espresso, a candle flame just settling, dust in a light beam, the spine of an open book lifting in a draft, a vinyl record spinning down to a stop, leaves of a fiddle-leaf fig stirring near a window).
- Exterior scenes: foreground/background parallax with the camera move, wind through olive leaves or climbing roses, a slow shadow shift across a stone wall, ripples on a pool, a porch curtain breathing.
- Detail shots: a single natural motion (a leaf twitching, water rippling in a clay basin, light creeping along a material edge, the curl of steam off a kettle).
- Threshold shots (doorways, windows): light shifting through the opening, a curtain catching breeze, a wind chime turning slowly.

**Scene continuity — describe what's already in the still:**
The still IS the world. Describe motion of elements that are ALREADY visible in the image — wind moving leaves that exist in the frame, steam from a cup that exists in the frame, light shifting on walls that exist in the frame. No humans appear or act; everything else in the home (plants, candles, fabric, steam, light, water, dust, shadow) is fair game.

**Format, every motion prompt:**
- One sentence, 20-50 words.
- Lead with the camera move from the allowlist, then describe the environmental motion that brings the still alive.
- Affirmative phrasing only. Describe what IS, not what isn't.

Return one motion description per scene, in scene order, numbered to match.`;
}

export function buildMotionUser(input: MotionPromptsInput): string {
  const { concept, scenes } = input;
  const anyLocked = scenes.some((s) => getCameraMove(s.motionPreset));
  return [
    `Concept: ${concept.workingTitle}`,
    `Vibe: ${concept.vibe}`,
    "",
    `Scenes (${scenes.length}). For each, write the motion direction that animates the still it describes.`,
    ...(anyLocked
      ? [
          "",
          "Some scenes carry an operator-LOCKED camera move, marked below. For those scenes, lead the motion prompt with that exact directive verbatim — your only creative territory is the subject/environmental motion after it. The no-consecutive-repeats rule does not override a lock.",
        ]
      : []),
    "",
    ...scenes.map((s) => {
      const locked = getCameraMove(s.motionPreset);
      return locked
        ? `${s.order}. [CAMERA LOCKED: "${locked.directive}"] ${s.prompt}`
        : `${s.order}. ${s.prompt}`;
    }),
    "",
    `Output one motion per scene, numbered 1 through ${scenes.length}, in the same order. Each motion must serve THAT specific image and feel different from neighbors so the reel doesn't read as one note.`,
  ].join("\n");
}

const MOTION_TOOL_SCHEMA = {
  type: "object",
  properties: {
    motions: {
      type: "array",
      minItems: 1,
      maxItems: 120,
      items: {
        type: "object",
        properties: {
          order: { type: "integer", minimum: 1 },
          motion: { type: "string", minLength: 20, maxLength: 360 },
        },
        required: ["order", "motion"],
        additionalProperties: false,
      },
    },
  },
  required: ["motions"],
  additionalProperties: false,
} as const;

export async function generateMotionPrompts(
  input: MotionPromptsInput
): Promise<MotionPromptsResponse> {
  const raw = await generateJSON<unknown>({
    system: buildMotionSystem(),
    user: buildMotionUser(input),
    schema: MOTION_TOOL_SCHEMA as unknown as Record<string, unknown>,
    toolName: "submit_motions",
    maxTokens: 3000,
  });

  const parsed = MotionPromptsResponseSchema.parse(raw);
  if (parsed.motions.length < input.scenes.length) {
    throw new Error(
      `GPT-5.5 returned ${parsed.motions.length} motions, expected ${input.scenes.length}.`
    );
  }
  // Trim to the input length and force each motion's `order` to match the
  // input scene at the same index. We can't trust GPT-5.5 to echo `order`
  // verbatim, AND we can't assume the input is contiguous 1..N — animate
  // retries pass partial targets like [2, 4, 5] when some scenes are already
  // animated. Preserving input.scenes[i].order keeps the downstream
  // motionByOrder lookup matching the actual scene rows.
  return {
    motions: parsed.motions.slice(0, input.scenes.length).map((m, i) => ({
      ...m,
      order: input.scenes[i].order,
    })),
  };
}
