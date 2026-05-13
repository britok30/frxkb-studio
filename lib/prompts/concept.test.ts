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
    const out = buildConceptUser({ niche: "modernist living rooms", format: "reel", worldType: "interior" });
    expect(out).toContain("modernist living rooms");
    expect(out).toContain("reel");
  });

  it("includes target duration when provided", () => {
    const out = buildConceptUser({
      niche: "x",
      format: "reel", worldType: "interior",
      targetDurationSec: 45,
    });
    expect(out).toMatch(/Target duration: 45/);
  });

  it("omits operator notes when not provided or only whitespace", () => {
    expect(buildConceptUser({ niche: "x", format: "reel", worldType: "interior" })).not.toMatch(/Operator notes/i);
    expect(
      buildConceptUser({ niche: "x", format: "reel", worldType: "interior", operatorNotes: "   " })
    ).not.toMatch(/Operator notes/i);
  });

  it("includes operator notes when meaningful", () => {
    const out = buildConceptUser({
      niche: "x",
      format: "reel", worldType: "interior",
      operatorNotes: "lean Mediterranean",
    });
    expect(out).toMatch(/Operator notes: lean Mediterranean/);
  });
});

describe("buildConceptSystem", () => {
  it("anchors every brief in a residential HOME and names category families (plants, art, books, ceramics, textiles)", () => {
    const sys = buildConceptSystem();
    expect(sys).toMatch(/residential|home|house/i);
    expect(sys).toMatch(/plants/i);
    expect(sys).toMatch(/art|ceramic/i);
    expect(sys).toMatch(/textile|linen/i);
  });

  it("requires the cultural-lineage rule for objectSet (no global default object pool)", () => {
    const sys = buildConceptSystem();
    expect(sys).toMatch(/cultural lineage|belong to/i);
    expect(sys).toMatch(/objectSet/);
  });

  it("keeps the no-humans rule (nano-banana renders people poorly) but does NOT command empty rooms", () => {
    const sys = buildConceptSystem();
    expect(sys).toMatch(/no humans|empty of people|no on-screen text/i);
    expect(sys).not.toMatch(/feel lived-in even when empty|empty rooms|uninhabited/i);
  });

  it("does NOT cite specific brand-name objects in the system prompt (those become global defaults Claude reaches for every time)", () => {
    const sys = buildConceptSystem();
    expect(sys).not.toMatch(/Hans Wegner|fiddle-leaf fig|Braun record player|design monographs/);
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

    const out = await generateConcept({ niche: "modernist homes", format: "reel", worldType: "interior" });

    expect(out).toEqual(valid);
    const args = generateJSONMock.mock.calls[0][0];
    expect(args.toolName).toBe("submit_concept");
    expect(args.system).toBe(buildConceptSystem());
    expect(args.user).toContain("modernist homes");
    expect(args.maxTokens).toBe(1800);
  });

  it("throws if Claude returns a brief that fails schema validation", async () => {
    generateJSONMock.mockResolvedValue({ ...valid, hook: "x" }); // hook too short
    await expect(
      generateConcept({ niche: "x", format: "reel", worldType: "interior" })
    ).rejects.toThrow();
  });

  it("rejects an invalid worldSignature (uppercase / spaces / too few tokens)", async () => {
    for (const bad of ["UPPERCASE", "with spaces here", "two-tokens", "trailing-"]) {
      generateJSONMock.mockResolvedValue({ ...valid, worldSignature: bad });
      await expect(generateConcept({ niche: "x", format: "reel", worldType: "interior" })).rejects.toThrow();
    }
  });

  it("rejects worldKeywords with too few entries", async () => {
    generateJSONMock.mockResolvedValue({
      ...valid,
      worldKeywords: ["only", "two"],
    });
    await expect(generateConcept({ niche: "x", format: "reel", worldType: "interior" })).rejects.toThrow();
  });

  it("ConceptBriefSchema accepts a well-formed brief", () => {
    expect(() => ConceptBriefSchema.parse(valid)).not.toThrow();
  });

  it("safety net: truncates an over-length notes field instead of throwing", async () => {
    // Anthropic's tool_use ignores JSON-schema maxLength. Claude regularly
    // overshoots prose fields. We trim to the Zod cap before parse so the
    // pipeline doesn't fail on a single long bullet list.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const longNotes = "x".repeat(3000);
    generateJSONMock.mockResolvedValue({ ...valid, notes: longNotes });

    const out = await generateConcept({
      niche: "modernist homes",
      format: "reel",
      worldType: "interior",
    });

    expect(out.notes.length).toBeLessThanOrEqual(2000);
    expect(out.notes.endsWith("…")).toBe(true);
  });

  it("safety net: coerces worldKeywords from a comma-separated string into an array", async () => {
    // Anthropic tool_use occasionally returns the wrong type. Rather than
    // throw, we split on commas, trim, lowercase, drop oversized tokens.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    generateJSONMock.mockResolvedValue({
      ...valid,
      worldKeywords: "1960s, brazilian, modernism, travertine, palms, late-afternoon",
    });

    const out = await generateConcept({
      niche: "modernist homes",
      format: "reel",
      worldType: "interior",
    });

    expect(Array.isArray(out.worldKeywords)).toBe(true);
    expect(out.worldKeywords).toEqual([
      "1960s",
      "brazilian",
      "modernism",
      "travertine",
      "palms",
      "late-afternoon",
    ]);
  });

  it("safety net: coerces objectSet from a comma-separated string into an array (preserves casing — object names need it)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    generateJSONMock.mockResolvedValue({
      ...valid,
      objectSet:
        "low Sergio Rodrigues poltrona, honed travertine table, tall philodendron, art books, linen sofa, framed Burle Marx print, ceramic vessel, sisal rug",
    });

    const out = await generateConcept({
      niche: "modernist homes",
      format: "reel",
      worldType: "interior",
    });

    expect(Array.isArray(out.objectSet)).toBe(true);
    expect(out.objectSet.length).toBeGreaterThanOrEqual(8);
    expect(out.objectSet[0]).toBe("low Sergio Rodrigues poltrona");
  });

  it("safety net: trims individual objectSet items > 80 chars instead of failing the whole brief", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const longObj = "x".repeat(120);
    generateJSONMock.mockResolvedValue({
      ...valid,
      objectSet: [longObj, ...valid.objectSet],
    });

    const out = await generateConcept({
      niche: "modernist homes",
      format: "reel",
      worldType: "interior",
    });

    expect(out.objectSet[0].length).toBeLessThanOrEqual(80);
    expect(out.objectSet[0].endsWith("…")).toBe(true);
  });

  it("safety net: truncates an over-length vibe instead of throwing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const longVibe = "y".repeat(2000);
    generateJSONMock.mockResolvedValue({ ...valid, vibe: longVibe });

    const out = await generateConcept({
      niche: "x",
      format: "reel",
      worldType: "interior",
    });

    expect(out.vibe.length).toBeLessThanOrEqual(1500);
    expect(out.vibe.endsWith("…")).toBe(true);
  });
});
