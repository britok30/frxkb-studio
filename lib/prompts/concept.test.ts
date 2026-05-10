import { describe, it, expect, vi, beforeEach } from "vitest";

const generateJSONMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/claude", () => ({
  generateJSON: generateJSONMock,
}));

import { buildConceptUser, buildConceptSystem, generateConcept } from "./concept";
import { ConceptBriefSchema } from "./types";

beforeEach(() => {
  generateJSONMock.mockReset();
});

describe("buildConceptUser", () => {
  it("includes niche and format", () => {
    const out = buildConceptUser({ niche: "modernist living rooms", format: "yt-long" });
    expect(out).toContain("modernist living rooms");
    expect(out).toContain("yt-long");
  });

  it("includes target duration when provided", () => {
    const out = buildConceptUser({
      niche: "x",
      format: "reel",
      targetDurationSec: 45,
    });
    expect(out).toMatch(/Target duration: 45/);
  });

  it("omits operator notes when not provided or only whitespace", () => {
    expect(buildConceptUser({ niche: "x", format: "reel" })).not.toMatch(/Operator notes/i);
    expect(
      buildConceptUser({ niche: "x", format: "reel", operatorNotes: "   " })
    ).not.toMatch(/Operator notes/i);
  });

  it("includes operator notes when meaningful", () => {
    const out = buildConceptUser({
      niche: "x",
      format: "reel",
      operatorNotes: "lean Mediterranean",
    });
    expect(out).toMatch(/Operator notes: lean Mediterranean/);
  });
});

describe("buildConceptSystem", () => {
  it("encodes the faceless / no-text constraints", () => {
    const sys = buildConceptSystem();
    expect(sys).toMatch(/faceless/i);
    expect(sys).toMatch(/no on-screen text/i);
    expect(sys).toMatch(/no people/i);
  });

  it("describes worldSignature + worldKeywords (used for dedupe)", () => {
    const sys = buildConceptSystem();
    expect(sys).toMatch(/worldSignature/);
    expect(sys).toMatch(/worldKeywords/);
    expect(sys).toMatch(/duplicate/i);
  });
});

describe("generateConcept", () => {
  const valid = {
    workingTitle: "Sunlit Brazilian Modernism",
    hook: "Calm afternoons through travertine and palm shadow.",
    vibe: "1960s Brazilian modernist houses, low concrete planes, palm-filtered light, terracotta and travertine, late afternoon warmth.",
    notes: "Always low sun. Eye-level. Never overcast.",
    worldSignature: "1960s-brazilian-modernism-travertine-palms",
    worldKeywords: [
      "1960s",
      "brazilian",
      "modernism",
      "travertine",
      "palms",
      "late-afternoon",
    ],
  };

  it("calls generateJSON with submit_concept tool and returns parsed brief", async () => {
    generateJSONMock.mockResolvedValue(valid);

    const out = await generateConcept({ niche: "modernist homes", format: "yt-long" });

    expect(out).toEqual(valid);
    const args = generateJSONMock.mock.calls[0][0];
    expect(args.toolName).toBe("submit_concept");
    expect(args.system).toBe(buildConceptSystem());
    expect(args.user).toContain("modernist homes");
    expect(args.maxTokens).toBe(1500);
  });

  it("throws if Claude returns a brief that fails schema validation", async () => {
    generateJSONMock.mockResolvedValue({ ...valid, hook: "x" }); // hook too short
    await expect(
      generateConcept({ niche: "x", format: "reel" })
    ).rejects.toThrow();
  });

  it("rejects an invalid worldSignature (uppercase / spaces / too few tokens)", async () => {
    for (const bad of ["UPPERCASE", "with spaces here", "two-tokens", "trailing-"]) {
      generateJSONMock.mockResolvedValue({ ...valid, worldSignature: bad });
      await expect(generateConcept({ niche: "x", format: "yt-long" })).rejects.toThrow();
    }
  });

  it("rejects worldKeywords with too few entries", async () => {
    generateJSONMock.mockResolvedValue({
      ...valid,
      worldKeywords: ["only", "two"],
    });
    await expect(generateConcept({ niche: "x", format: "yt-long" })).rejects.toThrow();
  });

  it("ConceptBriefSchema accepts a well-formed brief", () => {
    expect(() => ConceptBriefSchema.parse(valid)).not.toThrow();
  });
});
