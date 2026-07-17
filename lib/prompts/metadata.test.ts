import { describe, it, expect, vi, beforeEach } from "vitest";

const generateJSONMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/llm", () => ({ generateJSON: generateJSONMock }));

import {
  buildCarouselMetadataSystem,
  buildMetadataUser,
  buildReelMetadataSystem,
  CarouselMetadataSchema,
  generateMetadata,
  MetadataSchema,
  ReelMetadataSchema,
} from "./metadata";
import type { PromptableConcept } from "./types";

const concept: PromptableConcept = {
  workingTitle: "Sunlit Brazilian Modernism",
  hook: "Calm afternoons through travertine and palm shadow.",
  vibe: "1960s Brazilian modernist houses, palm-filtered late afternoon light.",
  notes: "Eye-level, never overcast.",
  objectSet: [
    "low Sergio Rodrigues poltrona",
    "honed travertine coffee table",
    "tall philodendron in a glazed clay pot",
    "stack of art books on the floor",
    "linen-slipcovered sofa",
    "framed Burle Marx landscape print",
    "handmade ceramic vessel set",
    "woven sisal rug worn at the edges",
  ],
};

// Sample valid payloads — what GPT-5.5 *would* return per variant. Note these
// don't include `kind` because generateMetadata injects that client-side.
const validReel = {
  tiktokCaption: "Travertine and palm shadow at the slow end of a São Paulo afternoon.",
  tiktokHashtags: ["architecture", "brazilianmodernism", "interiordesign", "calm"],
  instagramCaption:
    "Travertine and palm shadow at the slow end of a São Paulo afternoon.\nThe quiet half-hour before the city lights come on.",
  instagramHashtags: ["architecture", "brazilianmodernism", "interiordesign", "aesthetic", "calm"],
  shortsTitle: "Brazilian Modernist Afternoon — Travertine and Palm Shadow",
  shortsDescription:
    "1960s Brazilian modernist houses at the slow end of an afternoon. Travertine, palm shadow, the slow tilt of late light.\n\nI sketch a few of these in ArchitectGPT before pulling them in — link if you want to riff: {APP_LINK}",
  shortsHashtags: ["architecture", "brazilianmodernism"],
  pinnedComment:
    "Sketched a few of these in ArchitectGPT before generating — if you want to riff on your own, link's here {APP_LINK}",
};

const validCarousel = {
  instagramCaption:
    "Travertine and palm shadow at the slow end of a São Paulo afternoon.\nSwipe to walk through it.",
  instagramHashtags: ["architecture", "brazilianmodernism", "interiordesign", "aesthetic", "calm"],
};

beforeEach(() => {
  generateJSONMock.mockReset();
});

describe("buildReelMetadataSystem", () => {
  it("forbids hashtags inline in caption text and caps reel hashtags at 5", () => {
    const sys = buildReelMetadataSystem(["ArchitectGPT"], "interior");
    expect(sys).toMatch(/NEVER include hashtags inline/i);
    expect(sys).toMatch(/5 tags total/);
    // Shorts hashtag block is tighter (1-3) since the platform only surfaces
    // the first ones.
    expect(sys).toMatch(/1-3 tags/);
  });

  it("includes the locked-hashtag rule per visual lane", () => {
    const interiorSys = buildReelMetadataSystem(["ArchitectGPT"], "interior");
    expect(interiorSys).toMatch(/'interiordesign'.*'interiors'/);
    expect(interiorSys).toMatch(/3 slots for design-specific tags/);

    const exteriorSys = buildReelMetadataSystem(["ArchitectGPT"], "exterior");
    expect(exteriorSys).toMatch(/'architecture'.*'architect'.*'architectura'/);
    expect(exteriorSys).toMatch(/2 slots for design-specific tags/);
  });

  it("encodes per-platform voice (TikTok ≠ IG ≠ Shorts)", () => {
    const sys = buildReelMetadataSystem(["ArchitectGPT"], "interior");
    expect(sys).toMatch(/tiktokCaption/);
    expect(sys).toMatch(/instagramCaption/);
    expect(sys).toMatch(/shortsTitle/);
    expect(sys).toMatch(/SEO/i); // shorts is search-driven
  });
});

describe("buildCarouselMetadataSystem", () => {
  it("targets Instagram only — field requirements ask for IG fields only (default carousel)", () => {
    const sys = buildCarouselMetadataSystem(["ArchitectGPT"], "interior");
    expect(sys).toMatch(/INSTAGRAM CAROUSEL/);
    const fieldsBlock = sys.split("Field requirements:")[1] ?? "";
    expect(fieldsBlock).toMatch(/instagramCaption/);
    expect(fieldsBlock).toMatch(/instagramHashtags/);
    expect(fieldsBlock).not.toMatch(/youtubeTitle|tiktokCaption|shortsTitle/);
  });

  it("pure carousel: no app mention in caption (organic ambient content)", () => {
    const sys = buildCarouselMetadataSystem(["ArchitectGPT"], "interior", "carousel");
    expect(sys).toMatch(/No app mention in the caption/i);
    // Carousel caption rule should NOT instruct GPT-5.5 to insert {APP_LINK}.
    const fieldsBlock = sys.split("Field requirements:")[1] ?? "";
    expect(fieldsBlock).not.toMatch(/use the literal placeholder "\{APP_LINK\}"/i);
  });

  it("before-after: explicit soft CTA with {APP_LINK} at the end of the caption", () => {
    const sys = buildCarouselMetadataSystem(["ArchitectGPT"], "interior", "before-after");
    expect(sys).toMatch(/INSTAGRAM BEFORE\/AFTER/);
    const fieldsBlock = sys.split("Field requirements:")[1] ?? "";
    expect(fieldsBlock).toMatch(/\{APP_LINK\}/);
    expect(fieldsBlock).toMatch(/soft CTA|Reimagine/i);
  });
});

describe("operator-aware app CTA copy", () => {
  it("only mentions apps the operator actually has configured (single app)", () => {
    const sys = buildReelMetadataSystem(["ArchitectGPT"], "interior");
    expect(sys).toMatch(/ArchitectGPT/);
    // CasaGPT was pulled from rotation — must NOT bleed into the prompt.
    expect(sys).not.toMatch(/CasaGPT/);
    // Single-app phrasing — no "pick one" guidance.
    expect(sys).toMatch(/runs one AI app/i);
  });

  it("uses multi-app guidance when the operator has multiple apps", () => {
    const sys = buildReelMetadataSystem(["ArchitectGPT", "CasaGPT"], "interior");
    expect(sys).toMatch(/ArchitectGPT/);
    expect(sys).toMatch(/CasaGPT/);
    expect(sys).toMatch(/most relevant to the concept/i);
  });

  it("drops the CTA section entirely when the operator has zero apps", () => {
    const sys = buildReelMetadataSystem([], "interior");
    expect(sys).toMatch(/no app CTAs configured/i);
    expect(sys).not.toMatch(/ArchitectGPT|CasaGPT|InteriorGPT/);
  });
});

describe("buildMetadataUser", () => {
  it("packs concept fields, niche, format, scene count, and duration label", () => {
    const out = buildMetadataUser({
      concept,
      niche: "modernist living rooms",
      format: "reel",
      sceneCount: 5,
      totalDurationSec: 150,
      appNames: ["ArchitectGPT"],
      worldType: "interior",
    });
    expect(out).toContain("Sunlit Brazilian Modernism");
    expect(out).toContain("modernist living rooms");
    expect(out).toContain("reel");
    expect(out).toContain("Scenes: 5");
    expect(out).toContain("Duration: ~2.5 min");
  });

  it("formats short durations as seconds", () => {
    const out = buildMetadataUser({
      concept,
      niche: "x",
      format: "reel",
      sceneCount: 8,
      totalDurationSec: 32,
      appNames: ["ArchitectGPT"],
      worldType: "interior",
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
      appNames: ["ArchitectGPT"],
      worldType: "interior",
    });
    expect(out).toContain("Duration: 6 static slides");
  });
});

describe("generateMetadata — branches by format", () => {
  it("reel: uses the reel tool name and tags result as kind=reel", async () => {
    generateJSONMock.mockResolvedValue(validReel);

    const out = await generateMetadata({
      concept,
      niche: "modernist living rooms",
      format: "reel",
      sceneCount: 5,
      totalDurationSec: 20,
      appNames: ["ArchitectGPT"],
      worldType: "interior",
    });

    expect(out.kind).toBe("reel");
    if (out.kind !== "reel") throw new Error("type narrowing"); // for ts
    expect(out.tiktokHashtags).toHaveLength(4);
    expect(out.shortsTitle).toBe(validReel.shortsTitle);
    const args = generateJSONMock.mock.calls[0][0];
    expect(args.toolName).toBe("submit_reel_metadata");
  });

  it("carousel: uses the carousel tool name and tags result as kind=carousel", async () => {
    generateJSONMock.mockResolvedValue(validCarousel);

    const out = await generateMetadata({
      concept,
      niche: "modernist living rooms",
      format: "carousel",
      sceneCount: 6,
      totalDurationSec: 0,
      appNames: ["ArchitectGPT"],
      worldType: "interior",
    });

    expect(out.kind).toBe("carousel");
    if (out.kind !== "carousel") throw new Error("type narrowing");
    expect(out.instagramHashtags).toHaveLength(5);
    const args = generateJSONMock.mock.calls[0][0];
    expect(args.toolName).toBe("submit_carousel_metadata");
  });

  it("rejects when GPT-5.5 returns a payload that fails the schema", async () => {
    // 6 hashtags exceeds the 5-cap for IG.
    generateJSONMock.mockResolvedValue({
      ...validReel,
      tiktokHashtags: ["a", "b", "c", "d", "e", "f"],
    });
    await expect(
      generateMetadata({
        concept,
        niche: "x",
        format: "reel",
        sceneCount: 5,
        totalDurationSec: 20,
        appNames: ["ArchitectGPT"],
        worldType: "interior",
      })
    ).rejects.toThrow();
  });
});

describe("Schema parsing", () => {
  it("ReelMetadataSchema accepts a well-formed object with kind=reel", () => {
    expect(() =>
      ReelMetadataSchema.parse({ kind: "reel", ...validReel })
    ).not.toThrow();
  });

  it("CarouselMetadataSchema accepts a well-formed object with kind=carousel", () => {
    expect(() =>
      CarouselMetadataSchema.parse({ kind: "carousel", ...validCarousel })
    ).not.toThrow();
  });

  it("MetadataSchema (discriminated union) routes to the right variant by kind", () => {
    expect(() => MetadataSchema.parse({ kind: "reel", ...validReel })).not.toThrow();
    expect(() =>
      MetadataSchema.parse({ kind: "carousel", ...validCarousel })
    ).not.toThrow();
  });

  it("rejects more than 5 hashtags on reel platforms (TikTok/IG cap)", () => {
    expect(() =>
      ReelMetadataSchema.parse({
        kind: "reel",
        ...validReel,
        instagramHashtags: ["a", "b", "c", "d", "e", "f"],
      })
    ).toThrow();
  });

  it("rejects more than 3 hashtags on YouTube Shorts", () => {
    expect(() =>
      ReelMetadataSchema.parse({
        kind: "reel",
        ...validReel,
        shortsHashtags: ["a", "b", "c", "d"],
      })
    ).toThrow();
  });
});
