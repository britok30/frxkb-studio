import { describe, it, expect, vi, beforeEach } from "vitest";

const dbMocks = vi.hoisted(() => ({
  selectDedupeCandidates: vi.fn(),
}));

vi.mock("@/lib/projects-db", () => dbMocks);

import { jaccard, findSimilarProjects } from "./world-dedupe";

beforeEach(() => {
  dbMocks.selectDedupeCandidates.mockReset();
});

describe("jaccard", () => {
  it("returns 1 for identical sets", () => {
    expect(jaccard(["a", "b", "c"], ["a", "b", "c"])).toBe(1);
  });

  it("returns 0 for disjoint sets", () => {
    expect(jaccard(["a", "b"], ["x", "y"])).toBe(0);
  });

  it("returns 0 when either set is empty", () => {
    expect(jaccard([], ["a"])).toBe(0);
    expect(jaccard(["a"], [])).toBe(0);
    expect(jaccard([], [])).toBe(0);
  });

  it("computes correctly for partial overlap", () => {
    // intersect = {a,b}; union = {a,b,c,d}; 2/4 = 0.5
    expect(jaccard(["a", "b", "c"], ["a", "b", "d"])).toBe(0.5);
  });

  it("normalizes case + whitespace", () => {
    expect(jaccard(["Brazilian", "Modernism"], ["brazilian", " modernism "])).toBe(1);
  });

  it("ignores duplicate keywords (set semantics)", () => {
    // Both lists really contain {a,b}
    expect(jaccard(["a", "a", "b"], ["a", "b", "b"])).toBe(1);
  });
});

describe("findSimilarProjects", () => {
  const baseProject = {
    id: "p_1",
    title: "Sunlit Brazilian Modernism",
    niche: "modernist living rooms",
    format: "reel" as const,
    createdAt: new Date(),
  };

  function fakeProjectRow(overrides: Partial<{ id: string; title: string; worldSignature: string | null; worldKeywords: string[] | null }> = {}) {
    return {
      ...baseProject,
      ...overrides,
      // Stub fields the dedupe code doesn't read but the type requires:
      status: "ready" as const,
      targetDurationSec: null,
      concept: null,
      metadata: null,
      thumbnailUrl: null,
      worldSignature: overrides.worldSignature ?? null,
      worldKeywords: overrides.worldKeywords ?? null,
      updatedAt: new Date(),
    };
  }

  it("returns no matches when DB returns nothing", async () => {
    dbMocks.selectDedupeCandidates.mockResolvedValue([]);

    const out = await findSimilarProjects({
      signature: "1960s-brazilian-modernism-travertine-palms",
      keywords: ["1960s", "brazilian", "modernism", "travertine", "palms"],
    });

    expect(out.hasMatches).toBe(false);
    expect(out.matches).toEqual([]);
  });

  it("flags exact signature match with confidence 1", async () => {
    dbMocks.selectDedupeCandidates.mockResolvedValue([
      fakeProjectRow({
        worldSignature: "1960s-brazilian-modernism-travertine-palms",
        worldKeywords: ["something", "else", "entirely", "here", "now"],
      }),
    ]);

    const out = await findSimilarProjects({
      signature: "1960s-brazilian-modernism-travertine-palms",
      keywords: ["different", "keywords", "here"],
    });

    expect(out.hasMatches).toBe(true);
    expect(out.matches[0].reason).toBe("exact-signature");
    expect(out.matches[0].confidence).toBe(1);
  });

  it("flags keyword overlap above threshold (0.5)", async () => {
    dbMocks.selectDedupeCandidates.mockResolvedValue([
      fakeProjectRow({
        worldSignature: "different-signature-here",
        // 4/6 = 0.66 overlap
        worldKeywords: ["1960s", "brazilian", "modernism", "travertine", "extra-a", "extra-b"],
      }),
    ]);

    const out = await findSimilarProjects({
      signature: "1960s-brazilian-modernism-travertine-palms",
      keywords: ["1960s", "brazilian", "modernism", "travertine"],
    });

    expect(out.hasMatches).toBe(true);
    expect(out.matches[0].reason).toBe("keyword-overlap");
    expect(out.matches[0].confidence).toBeGreaterThanOrEqual(0.5);
    expect(out.matches[0].confidence).toBeLessThan(1);
  });

  it("does NOT flag keyword overlap below threshold", async () => {
    dbMocks.selectDedupeCandidates.mockResolvedValue([
      fakeProjectRow({
        worldSignature: "different",
        // 1/8 = 0.125 — below 0.5
        worldKeywords: ["1960s", "german", "bauhaus", "concrete", "winter", "overcast", "blue", "industrial"],
      }),
    ]);

    const out = await findSimilarProjects({
      signature: "1960s-brazilian-modernism-travertine-palms",
      keywords: ["1960s", "brazilian", "modernism", "travertine"],
    });

    expect(out.hasMatches).toBe(false);
  });

  it("sorts matches by confidence descending and caps at 3", async () => {
    dbMocks.selectDedupeCandidates.mockResolvedValue([
      fakeProjectRow({ id: "low", worldKeywords: ["1960s", "brazilian", "x", "y"] }), // 2/6 = 0.33 - filtered out
      fakeProjectRow({
        id: "exact",
        worldSignature: "1960s-brazilian-modernism-travertine-palms",
      }),
      fakeProjectRow({
        id: "high",
        worldKeywords: ["1960s", "brazilian", "modernism", "travertine"], // 4/4 = 1
      }),
      fakeProjectRow({
        id: "mid",
        worldKeywords: ["1960s", "brazilian", "modernism", "x", "y"], // 3/6 = 0.5
      }),
      fakeProjectRow({
        id: "extra",
        worldKeywords: ["1960s", "brazilian", "modernism", "travertine", "x"], // 4/5 = 0.8
      }),
    ]);

    const out = await findSimilarProjects({
      signature: "1960s-brazilian-modernism-travertine-palms",
      keywords: ["1960s", "brazilian", "modernism", "travertine"],
    });

    expect(out.matches).toHaveLength(3);
    // Highest first.
    expect(out.matches[0].confidence).toBeGreaterThanOrEqual(out.matches[1].confidence);
    expect(out.matches[1].confidence).toBeGreaterThanOrEqual(out.matches[2].confidence);
  });

  it("excludes a given project id from matches (self-exclusion)", async () => {
    dbMocks.selectDedupeCandidates.mockResolvedValue([
      fakeProjectRow({
        id: "self",
        worldSignature: "1960s-brazilian-modernism-travertine-palms",
      }),
    ]);

    const out = await findSimilarProjects({
      signature: "1960s-brazilian-modernism-travertine-palms",
      keywords: ["1960s", "brazilian", "modernism"],
      excludeProjectId: "self",
    });

    expect(out.hasMatches).toBe(false);
  });

  it("handles candidates with null worldSignature + null worldKeywords gracefully (legacy rows)", async () => {
    dbMocks.selectDedupeCandidates.mockResolvedValue([
      fakeProjectRow({ id: "legacy", worldSignature: null, worldKeywords: null }),
    ]);

    const out = await findSimilarProjects({
      signature: "1960s-brazilian-modernism-travertine-palms",
      keywords: ["1960s", "brazilian"],
    });

    expect(out.hasMatches).toBe(false);
  });
});
