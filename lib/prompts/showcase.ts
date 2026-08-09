import { z } from "zod";
import { generateJSON } from "@/lib/llm";
import type { WorldType } from "./types";

/**
 * Showcase: the operator brings their OWN images (client photos or renders)
 * and the studio turns them into a reel or a YouTube long-form. This module
 * is the single GPT vision pass at creation time — it looks at every upload
 * and writes:
 *  - a concept brief (title + vibe) grounding the metadata in the real space
 *  - per-shot copy: a short NAME (chapter/card label), a subtitle, and a
 *    rich one-sentence DESCRIPTION of what's visible — the description
 *    becomes the scene prompt that later drives the motion-prompt call, so
 *    it must name concrete visible elements (materials, light, objects)
 *    that Seedance can set in motion.
 */

export const ShowcaseShotSchema = z.object({
  /** 1-based index matching the upload order. */
  index: z.number().int().min(1),
  /** Short display name — the YouTube chapter / name-card label
   *  (e.g. "Kitchen", "Primary Suite", "West Facade at Dusk"). */
  name: z.string().min(2).max(60),
  /** One-line card subtitle — what makes this shot worth lingering on. */
  subtitle: z.string().min(2).max(120),
  /** One rich sentence describing what is VISIBLE in the image — feeds the
   *  motion-prompt call, so concrete nouns matter more than adjectives. */
  description: z.string().min(20).max(500),
});

export const ShowcaseResponseSchema = z.object({
  /** Working title for the whole set (project title + metadata seed). */
  workingTitle: z.string().min(4).max(120),
  /** The set's mood/identity in one or two sentences. */
  vibe: z.string().min(10).max(400),
  shots: z.array(ShowcaseShotSchema).min(1).max(20),
});
export type ShowcaseResponse = z.infer<typeof ShowcaseResponseSchema>;

export type ShowcaseInput = {
  /** Public Blob URLs of the operator's uploads, in presentation order. */
  imageUrls: string[];
  worldType: WorldType;
  /** Shapes the copy: reel = punchy social set; long-form = YouTube tour
   *  with chapter-worthy names. */
  deliverable: "reel" | "long-form";
  operatorNotes?: string;
};

function buildShowcaseSystem(input: ShowcaseInput): string {
  const lane = input.worldType === "interior" ? "interior" : "exterior architectural";
  const shape =
    input.deliverable === "long-form"
      ? "a YouTube long-form tour — each shot becomes a CHAPTER, so names must read as chapter titles (the room or vantage, specific but short)"
      : "a short-form reel — names stay short and cinematic";
  return `You are writing presentation copy for a set of real ${lane} images an operator uploaded — client photos or finished renders of ONE property. They become ${shape}.

For EVERY image, in the exact order given:
- name: the room or vantage, short and specific ("Kitchen", "Courtyard Entry", "Primary Bath"). Never generic ("Image 3", "Nice room").
- subtitle: one line on what makes the shot worth lingering on.
- description: ONE sentence, 20-60 words, describing what is actually VISIBLE — lead with the space, then concrete elements (materials, light quality, furniture, plants, openings). This sentence later directs a video model that animates the still, so name real, animatable things that exist in the frame. Describe only what you can see; never invent elements.

Also write a workingTitle for the whole set and a vibe (its mood/identity in 1-2 sentences). Ground both in what the images actually show.`;
}

function buildShowcaseUser(input: ShowcaseInput): string {
  return [
    `${input.imageUrls.length} images, in presentation order (Image 1 = the first frame of the ${input.deliverable}).`,
    ...(input.operatorNotes?.trim()
      ? ["", `Operator notes: ${input.operatorNotes.trim()}`]
      : []),
    "",
    `Return workingTitle, vibe, and one shot entry per image, numbered 1 through ${input.imageUrls.length} in the same order.`,
  ].join("\n");
}

const SHOWCASE_TOOL_SCHEMA = {
  type: "object",
  properties: {
    workingTitle: { type: "string", minLength: 4, maxLength: 120 },
    vibe: { type: "string", minLength: 10, maxLength: 400 },
    shots: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        properties: {
          index: { type: "integer", minimum: 1 },
          name: { type: "string", minLength: 2, maxLength: 60 },
          subtitle: { type: "string", minLength: 2, maxLength: 120 },
          description: { type: "string", minLength: 20, maxLength: 500 },
        },
        required: ["index", "name", "subtitle", "description"],
        additionalProperties: false,
      },
    },
  },
  required: ["workingTitle", "vibe", "shots"],
  additionalProperties: false,
} as const;

export async function generateShowcaseCopy(input: ShowcaseInput): Promise<ShowcaseResponse> {
  const raw = await generateJSON<unknown>({
    system: buildShowcaseSystem(input),
    user: buildShowcaseUser(input),
    images: input.imageUrls,
    schema: SHOWCASE_TOOL_SCHEMA as unknown as Record<string, unknown>,
    toolName: "submit_showcase",
    // ~120 tokens of copy per shot plus title/vibe/scaffolding headroom.
    maxTokens: Math.min(6000, input.imageUrls.length * 200 + 800),
  });

  const parsed = ShowcaseResponseSchema.parse(raw);
  if (parsed.shots.length < input.imageUrls.length) {
    throw new Error(
      `GPT-5.5 returned ${parsed.shots.length} shots, expected ${input.imageUrls.length}.`
    );
  }
  // Force order to upload order — same defensive trim/renumber as motion
  // prompts: the model can't be trusted to echo `index` verbatim.
  const shots = parsed.shots
    .slice(0, input.imageUrls.length)
    .map((s, i) => ({ ...s, index: i + 1 }));
  return { ...parsed, shots };
}
