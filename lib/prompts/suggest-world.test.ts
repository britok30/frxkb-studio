import { describe, it, expect, vi, beforeEach } from "vitest";

const generateJSONMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/claude", () => ({ generateJSON: generateJSONMock }));

import {
  buildSuggestSystem,
  buildSuggestUser,
  suggestWorld,
  SuggestedWorldSchema,
  type WorldHistoryEntry,
} from "./suggest-world";

beforeEach(() => {
  generateJSONMock.mockReset();
});

const sampleHistory: WorldHistoryEntry[] = [
  {
    niche: "1960s Brazilian modernist living rooms",
    worldSignature: "1960s-brazilian-modernism-travertine-palms",
    worldKeywords: ["1960s", "brazilian", "modernism", "travertine", "palms", "late-afternoon"],
  },
  {
    niche: "Tuscan farmhouse interiors at dusk",
    worldSignature: "tuscan-farmhouse-terracotta-linen-dusk",
    worldKeywords: ["tuscan", "farmhouse", "terracotta", "linen", "dusk"],
  },
];

describe("buildSuggestSystem", () => {
  it("encodes the avoid-duplicate rule + variety bias", () => {
    const sys = buildSuggestSystem();
    expect(sys).toMatch(/AVOID/);
    expect(sys).toMatch(/UNDEREXPLORED|underrepresented/i);
    expect(sys).toMatch(/three axes|era \+ region \+ material/i);
  });

  it("forbids generic luxury tropes (consistent with concept system prompt)", () => {
    expect(buildSuggestSystem()).toMatch(/luxury/);
  });
});

describe("buildSuggestUser", () => {
  it("includes the format", () => {
    const out = buildSuggestUser({ format: "yt-long", history: [] });
    expect(out).toMatch(/yt-long/);
  });

  it("notes it's the first piece when history is empty", () => {
    const out = buildSuggestUser({ format: "reel", history: [] });
    expect(out).toMatch(/first piece/i);
  });

  it("lists every past world's niche, signature, and keywords", () => {
    const out = buildSuggestUser({ format: "yt-long", history: sampleHistory });
    expect(out).toContain("1960s Brazilian modernist living rooms");
    expect(out).toContain("1960s-brazilian-modernism-travertine-palms");
    expect(out).toContain("travertine");
    expect(out).toContain("Tuscan farmhouse interiors at dusk");
    expect(out).toMatch(/DO NOT repeat/);
  });

  it("includes the variety nudge when there's history", () => {
    const out = buildSuggestUser({ format: "yt-long", history: sampleHistory });
    expect(out).toMatch(/Surprise|axis the history is thin/i);
  });

  it("includes recentlyShown niches with a 'pivot hard' instruction", () => {
    const out = buildSuggestUser({
      format: "yt-long",
      history: [],
      recentlyShown: [
        "1970s Japanese ryokan interiors at dusk",
        "Kyoto tea house in autumn",
      ],
    });
    expect(out).toContain("1970s Japanese ryokan interiors at dusk");
    expect(out).toContain("Kyoto tea house in autumn");
    expect(out).toMatch(/Pivot hard/);
    expect(out).toMatch(/already proposed/i);
  });

  it("omits the recentlyShown block when none provided or empty", () => {
    const a = buildSuggestUser({ format: "yt-long", history: [] });
    expect(a).not.toMatch(/Already proposed/i);
    const b = buildSuggestUser({ format: "yt-long", history: [], recentlyShown: [] });
    expect(b).not.toMatch(/Already proposed/i);
  });
});

describe("suggestWorld", () => {
  const valid = {
    niche: "1965 Nordic country houses with pine boards and snow-light",
    rationale:
      "Your library skews late-afternoon Mediterranean — adding cold, northern winter light fills an underexplored axis.",
  };

  it("calls generateJSON with submit_world tool and returns parsed result", async () => {
    generateJSONMock.mockResolvedValue(valid);

    const out = await suggestWorld({ format: "yt-long", history: [] });

    expect(out).toEqual(valid);
    const args = generateJSONMock.mock.calls[0][0];
    expect(args.toolName).toBe("submit_world");
    expect(args.maxTokens).toBe(800);
  });

  it("uses temperature=1 for variety (otherwise Claude converges on its top answer)", async () => {
    generateJSONMock.mockResolvedValue(valid);
    await suggestWorld({ format: "yt-long", history: [] });
    expect(generateJSONMock.mock.calls[0][0].temperature).toBe(1);
  });

  it("rejects too-short niche", async () => {
    generateJSONMock.mockResolvedValue({ ...valid, niche: "x" });
    await expect(
      suggestWorld({ format: "yt-long", history: [] })
    ).rejects.toThrow();
  });

  it("rejects too-short rationale", async () => {
    generateJSONMock.mockResolvedValue({ ...valid, rationale: "x" });
    await expect(
      suggestWorld({ format: "yt-long", history: [] })
    ).rejects.toThrow();
  });

  it("SuggestedWorldSchema accepts a well-formed object", () => {
    expect(() => SuggestedWorldSchema.parse(valid)).not.toThrow();
  });
});
