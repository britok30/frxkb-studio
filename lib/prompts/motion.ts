import { z } from "zod";
import { generateJSON } from "@/lib/claude";
import type { PromptableConcept } from "./types";

export const MotionPromptSchema = z.object({
  order: z.number().int().min(1),
  /** Short directive for seedance describing camera + subject motion. */
  motion: z.string().min(20).max(280),
});
export type MotionPrompt = z.infer<typeof MotionPromptSchema>;

export const MotionPromptsResponseSchema = z.object({
  motions: z.array(MotionPromptSchema).min(1).max(120),
});
export type MotionPromptsResponse = z.infer<typeof MotionPromptsResponseSchema>;

export type MotionPromptsInput = {
  concept: PromptableConcept;
  /** The same scene array that was used to generate stills. */
  scenes: { order: number; prompt: string }[];
};

export function buildMotionSystem(): string {
  return `You write motion descriptions for an ambient design slideshow getting animated by Seedance 2.0 (image-to-video). Each scene's still becomes a 3-4s clip; your job is to direct the camera + subtle motion that brings it alive WITHOUT breaking the meditative ambient register.

The studio's whole identity is calm, slow, restrained. Treat motion the same way:
- Slow camera moves only. Never fast pans, no zoom-bursts, no whip-pans, no shake.
- Anchor in cinematography vocabulary: "slow dolly-in," "gentle parallax shift," "static camera with subtle wind through plants," "slow vertical tilt down."
- One verb per clip. Pick the move that best serves THIS image. Vary across the sequence — don't dolly-in every clip.
- For interior scenes: dolly-in or static with subtle environmental motion (curtain breeze, dust in light beam).
- For exterior scenes: gentle pan, parallax with foreground/background separation, or slow reveal.
- For detail shots: static with subtle natural motion (a leaf twitching, water rippling, cloth shifting).
- For threshold shots (doorways, windows): slow approach or hold with light shifting.

Hard constraints, every motion prompt:
- One sentence, 20-50 words.
- Lead with the camera move, then what's happening in the scene.
- No people, no faces appearing or moving (the still has none — keep it that way).
- No new objects entering frame. The still IS the world.
- No text, no graphics, no UI.

Return one motion description per scene, in scene order, numbered to match.`;
}

export function buildMotionUser(input: MotionPromptsInput): string {
  const { concept, scenes } = input;
  return [
    `Concept: ${concept.workingTitle}`,
    `Vibe: ${concept.vibe}`,
    "",
    `Scenes (${scenes.length}). For each, write the motion direction that animates the still it describes.`,
    "",
    ...scenes.map((s) => `${s.order}. ${s.prompt}`),
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
          motion: { type: "string", minLength: 20, maxLength: 280 },
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
    // Variety matters here — same image shouldn't always get the same camera
    // move when the operator regenerates.
    temperature: 0.8,
  });

  const parsed = MotionPromptsResponseSchema.parse(raw);
  if (parsed.motions.length < input.scenes.length) {
    throw new Error(
      `Claude returned ${parsed.motions.length} motions, expected ${input.scenes.length}.`
    );
  }
  // Trim + renumber to match input scenes 1..N (defensive against drift).
  return {
    motions: parsed.motions.slice(0, input.scenes.length).map((m, i) => ({
      ...m,
      order: i + 1,
    })),
  };
}
