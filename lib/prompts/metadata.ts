import { z } from "zod";
import { generateJSON } from "@/lib/claude";
import type { Format, PromptableConcept } from "./types";

export const MetadataSchema = z.object({
  youtubeTitle: z.string().min(8).max(100),
  youtubeTitleAlternates: z.array(z.string().min(8).max(100)).min(0).max(4),
  youtubeDescription: z.string().min(80).max(5000),
  youtubeTags: z.array(z.string().min(1).max(50)).min(3).max(20),
  instagramCaption: z.string().min(20).max(2200),
  hashtags: z.array(z.string().min(1).max(60)).min(3).max(20),
  pinnedComment: z.string().min(10).max(800),
});
export type Metadata = z.infer<typeof MetadataSchema>;

export type MetadataInput = {
  concept: PromptableConcept;
  niche: string;
  format: Format;
  sceneCount: number;
  totalDurationSec: number;
};

export function buildMetadataSystem(): string {
  return `You write metadata for a faceless ambient slideshow video about architecture and interior design. The channel uses your output to feed YouTube long-form, Reels, and Instagram.

The operator builds two AI apps that may be relevant to mention in CTAs:
- **ArchitectGPT** — generates architecture concepts and reimagines exteriors
- **CasaGPT** — interior design assistant for homes and rooms

When mentioning either app, be subtle and value-driven, never salesy. Use the placeholder URL "{APP_LINK}" — the operator substitutes their real link. Mention only the app most relevant to the concept (architecture/exterior → ArchitectGPT; interior/rooms → CasaGPT). Do NOT mention either app in the YouTube title or in the Instagram caption proper — keep the front of every post clean. Mentions only in description body, hashtags, and pinned comment.

The video itself is faceless and silent (no voiceover). Your copy should reflect "watch and feel" energy, not narration. Think "this is what a Sunday afternoon feels like in 1965 São Paulo" — not "in this video we explore 10 amazing rooms."

Requirements:
- **youtubeTitle**: 40-65 chars. Evocative, searchable, no clickbait punctuation. Numbers ok if relevant. No emojis. No ALL CAPS.
- **youtubeTitleAlternates**: 2 variants exploring a different angle each (e.g. mood-led, period-led, materials-led).
- **youtubeDescription**: 3-4 short paragraphs, ~600-1000 chars total.
  - Para 1: a one-line hook that captures the vibe.
  - Para 2: short context — era, region, materials, mood.
  - Para 3: subtle tools mention. Use "{APP_LINK}" exactly once when referencing the relevant app. Phrase it as if the operator uses the app to explore these spaces — not as an ad.
  - Para 4 (optional): a soft invitation ("press play, do nothing, breathe") — never "subscribe for more."
- **youtubeTags**: 8-12 entries. Lowercase, no #, no quotes. Mix broad (architecture, interior design) and specific (brazilian modernism, travertine, dusk light).
- **instagramCaption**: 80-280 chars. Opens with the hook, ends with 5-8 inline hashtags. No app mention in the caption text — at most one of those hashtags can be #architectgpt or #casagpt if natural.
- **hashtags**: 8-10 without the # symbol. Mix broad and specific. Lowercase.
- **pinnedComment**: 1-2 sentences. Conversational. Mentions the relevant app naturally with "{APP_LINK}". Example tone: "I sketched a few of these in ArchitectGPT before generating — if you want to riff on your own, link's here {APP_LINK}."

Hard nos:
- No "Don't forget to like and subscribe."
- No "In this video we will…"
- No emoji in description or title body.
- No clickbait ("YOU WON'T BELIEVE").`;
}

export function buildMetadataUser(input: MetadataInput): string {
  const { concept, niche, format, sceneCount, totalDurationSec } = input;
  const durationLabel =
    totalDurationSec === 0
      ? `${sceneCount} static slides`
      : totalDurationSec < 60
        ? `~${totalDurationSec}s`
        : `~${Math.round((totalDurationSec / 60) * 10) / 10} min`;

  return [
    `Concept: ${concept.workingTitle}`,
    `Hook: ${concept.hook}`,
    `Vibe: ${concept.vibe}`,
    concept.notes ? `Visual rules: ${concept.notes}` : "",
    "",
    `Niche: ${niche}`,
    `Format: ${format}`,
    `Scenes: ${sceneCount}`,
    `Duration: ${durationLabel}`,
    "",
    "Write the metadata for this piece. Pick which app — ArchitectGPT or CasaGPT — is more relevant for this niche and only mention that one.",
  ]
    .filter(Boolean)
    .join("\n");
}

const METADATA_TOOL_SCHEMA = {
  type: "object",
  properties: {
    youtubeTitle: { type: "string", minLength: 8, maxLength: 100 },
    youtubeTitleAlternates: {
      type: "array",
      maxItems: 4,
      items: { type: "string", minLength: 8, maxLength: 100 },
    },
    youtubeDescription: { type: "string", minLength: 80, maxLength: 5000 },
    youtubeTags: {
      type: "array",
      minItems: 3,
      maxItems: 20,
      items: { type: "string", minLength: 1, maxLength: 50 },
    },
    instagramCaption: { type: "string", minLength: 20, maxLength: 2200 },
    hashtags: {
      type: "array",
      minItems: 3,
      maxItems: 20,
      items: { type: "string", minLength: 1, maxLength: 60 },
    },
    pinnedComment: { type: "string", minLength: 10, maxLength: 800 },
  },
  required: [
    "youtubeTitle",
    "youtubeTitleAlternates",
    "youtubeDescription",
    "youtubeTags",
    "instagramCaption",
    "hashtags",
    "pinnedComment",
  ],
  additionalProperties: false,
} as const;

export async function generateMetadata(input: MetadataInput): Promise<Metadata> {
  const raw = await generateJSON<unknown>({
    system: buildMetadataSystem(),
    user: buildMetadataUser(input),
    schema: METADATA_TOOL_SCHEMA as unknown as Record<string, unknown>,
    toolName: "submit_metadata",
    maxTokens: 4000,
  });
  return MetadataSchema.parse(raw);
}
