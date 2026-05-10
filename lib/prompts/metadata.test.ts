import { describe, it, expect, vi, beforeEach } from "vitest";

const generateJSONMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/claude", () => ({ generateJSON: generateJSONMock }));

import { buildMetadataSystem, buildMetadataUser, generateMetadata, MetadataSchema } from "./metadata";
import type { PromptableConcept } from "./types";

const concept: PromptableConcept = {
  workingTitle: "Sunlit Brazilian Modernism",
  hook: "Calm afternoons through travertine and palm shadow.",
  vibe: "1960s Brazilian modernist houses, palm-filtered late afternoon light.",
  notes: "Eye-level, never overcast.",
};

const valid = {
  youtubeTitle: "Sunlit Brazilian Modernism — Afternoon Light",
  youtubeTitleAlternates: [
    "Travertine and Palm Shadow: A Brazilian Modernist Hour",
    "Slow Afternoon: 1960s São Paulo Through a Window",
  ],
  youtubeDescription:
    "Travertine, palm shadow, the slow tilt of late afternoon light across a concrete plane.\n\nA visual study of 1960s Brazilian modernist houses — the era when Niemeyer's language softened into the domestic. Watch on, do nothing, let the rooms move past.\n\nI sketch a few of these spaces in ArchitectGPT before pulling them into the slideshow — if you want to play with the same idea, the link is here {APP_LINK}.\n\nPress play and breathe out.",
  youtubeTags: ["architecture", "interior design", "brazilian modernism", "ambient", "travertine"],
  instagramCaption:
    "Travertine and palm shadow at the slow end of a São Paulo afternoon. #architecture #brazilianmodernism #interiordesign #ambientvibes #design #moodboard",
  hashtags: [
    "architecture",
    "brazilianmodernism",
    "interiordesign",
    "ambient",
    "design",
    "travertine",
    "moodboard",
    "calmcontent",
  ],
  pinnedComment:
    "I sketched a few of these in ArchitectGPT before generating the slideshow — if you want to riff on your own home or build a concept, the link's here {APP_LINK}.",
};

beforeEach(() => {
  generateJSONMock.mockReset();
});

describe("buildMetadataSystem", () => {
  it("encodes the apps + 'no app in title or IG caption' rule + faceless framing", () => {
    const sys = buildMetadataSystem();
    expect(sys).toMatch(/ArchitectGPT/);
    expect(sys).toMatch(/CasaGPT/);
    expect(sys).toMatch(/Do NOT mention either app in the YouTube title/);
    expect(sys).toMatch(/Instagram caption/);
    expect(sys).toMatch(/faceless and silent/);
    expect(sys).toMatch(/\{APP_LINK\}/);
  });

  it("forbids generic creator-speak", () => {
    const sys = buildMetadataSystem();
    expect(sys).toMatch(/Don't forget to like and subscribe/);
    expect(sys).toMatch(/clickbait/i);
  });
});

describe("buildMetadataUser", () => {
  it("packs concept fields, niche, format, scene count, and duration label", () => {
    const out = buildMetadataUser({
      concept,
      niche: "modernist living rooms",
      format: "yt-long",
      sceneCount: 30,
      totalDurationSec: 150,
    });
    expect(out).toContain("Sunlit Brazilian Modernism");
    expect(out).toContain("modernist living rooms");
    expect(out).toContain("yt-long");
    expect(out).toContain("Scenes: 30");
    expect(out).toContain("Duration: ~2.5 min");
  });

  it("formats short durations as seconds", () => {
    const out = buildMetadataUser({
      concept,
      niche: "x",
      format: "reel",
      sceneCount: 8,
      totalDurationSec: 32,
    });
    expect(out).toContain("Duration: ~32s");
  });

  it("describes carousel format as static slides instead of duration", () => {
    const out = buildMetadataUser({
      concept,
      niche: "x",
      format: "carousel",
      sceneCount: 6,
      totalDurationSec: 0,
    });
    expect(out).toContain("Duration: 6 static slides");
  });
});

describe("generateMetadata", () => {
  it("calls generateJSON with submit_metadata tool and returns parsed result", async () => {
    generateJSONMock.mockResolvedValue(valid);

    const out = await generateMetadata({
      concept,
      niche: "modernist living rooms",
      format: "yt-long",
      sceneCount: 30,
      totalDurationSec: 150,
    });

    expect(out.youtubeTitle).toBe(valid.youtubeTitle);
    expect(out.hashtags).toHaveLength(valid.hashtags.length);
    const args = generateJSONMock.mock.calls[0][0];
    expect(args.toolName).toBe("submit_metadata");
    expect(args.maxTokens).toBe(4000);
  });

  it("rejects metadata that fails schema (title too short)", async () => {
    generateJSONMock.mockResolvedValue({ ...valid, youtubeTitle: "x" });
    await expect(
      generateMetadata({
        concept,
        niche: "x",
        format: "yt-long",
        sceneCount: 1,
        totalDurationSec: 5,
      })
    ).rejects.toThrow();
  });

  it("MetadataSchema accepts a well-formed object", () => {
    expect(() => MetadataSchema.parse(valid)).not.toThrow();
  });
});
