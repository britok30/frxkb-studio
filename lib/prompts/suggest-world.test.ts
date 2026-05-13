import { describe, it, expect, vi, beforeEach } from "vitest";

const generateJSONMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/claude", () => ({ generateJSON: generateJSONMock }));

import {
  buildSuggestSystem,
  buildSuggestUser,
  suggestWorld,
  pickAltitudeExamples,
  SuggestedWorldSchema,
  type WorldHistoryEntry,
} from "./suggest-world";
import { NICHE_POOL } from "./niche-pool";

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
  it("optimizes for save-worthy design-inspiration imagery (moodboard altitude)", () => {
    const sys = buildSuggestSystem();
    expect(sys).toMatch(/save-worthy|moodboard|screenshot/i);
    expect(sys).toMatch(/designer|interior designer|architect/i);
  });

  it("varies on emotional register + visual signature, not on raw era/region formula", () => {
    const sys = buildSuggestSystem();
    expect(sys).toMatch(/emotional register/i);
    expect(sys).toMatch(/visual signature|screenshot moment/i);
  });

  it("frames dedupe loosely — same region with different season/light/scale is welcome", () => {
    const sys = buildSuggestSystem();
    expect(sys).toMatch(/skip exact|exact restatements/i);
  });
});

describe("buildSuggestUser", () => {
  it("includes the format", () => {
    const out = buildSuggestUser({ format: "reel", worldType: "interior", history: [] });
    expect(out).toMatch(/reel/);
  });

  it("notes it's the first piece when history is empty", () => {
    const out = buildSuggestUser({ format: "reel", worldType: "interior", history: [] });
    expect(out).toMatch(/first piece/i);
  });

  it("lists every past world's niche, signature, and keywords", () => {
    const out = buildSuggestUser({ format: "reel", worldType: "interior", history: sampleHistory });
    expect(out).toContain("1960s Brazilian modernist living rooms");
    expect(out).toContain("1960s-brazilian-modernism-travertine-palms");
    expect(out).toContain("travertine");
    expect(out).toContain("Tuscan farmhouse interiors at dusk");
    expect(out).toMatch(/skip exact restatements/i);
  });

  it("includes the variety nudge when there's history", () => {
    const out = buildSuggestUser({ format: "reel", worldType: "interior", history: sampleHistory });
    expect(out).toMatch(/emotional register|visual signature|freshest/i);
  });

  it("includes recentlyShown niches with an emotional-pivot instruction", () => {
    const out = buildSuggestUser({
      format: "reel",
      worldType: "interior",
      history: [],
      recentlyShown: [
        "1970s Japanese ryokan interiors at dusk",
        "Kyoto tea house in autumn",
      ],
    });
    expect(out).toContain("1970s Japanese ryokan interiors at dusk");
    expect(out).toContain("Kyoto tea house in autumn");
    expect(out).toMatch(/Shift the feeling|different emotional register/i);
    expect(out).toMatch(/already proposed/i);
  });

  it("omits the recentlyShown block when none provided or empty", () => {
    const a = buildSuggestUser({ format: "reel", worldType: "interior", history: [] });
    expect(a).not.toMatch(/Already proposed/i);
    const b = buildSuggestUser({ format: "reel", worldType: "interior", history: [], recentlyShown: [] });
    expect(b).not.toMatch(/Already proposed/i);
  });

  it("renders the altitude-calibration block when altitudeExamples is provided", () => {
    const out = buildSuggestUser({
      format: "reel",
      worldType: "interior",
      history: [],
      altitudeExamples: [
        "A Kyoto townhouse with paper screens, tatami, ikebana, gray cypress beams",
        "A Mallorcan farmhouse with whitewashed walls, esparto baskets, indigo linen, terracotta floors",
      ],
    });
    expect(out).toMatch(/Altitude calibration/i);
    expect(out).toContain("A Kyoto townhouse with paper screens");
    expect(out).toContain("A Mallorcan farmhouse with whitewashed walls");
  });

  it("omits the altitude-calibration block when altitudeExamples is empty (legacy non-calibrated path)", () => {
    const out = buildSuggestUser({
      format: "reel",
      worldType: "interior",
      history: [],
      altitudeExamples: [],
    });
    expect(out).not.toMatch(/Altitude calibration/i);
  });
});

describe("pickAltitudeExamples", () => {
  it("samples N items from NICHE_POOL[worldType]", () => {
    const out = pickAltitudeExamples("interior", [], [], 3);
    expect(out).toHaveLength(3);
    for (const ex of out) {
      expect(NICHE_POOL.interior).toContain(ex);
    }
  });

  it("filters out niches already in the operator's history (case-insensitive)", () => {
    // Pick a real pool entry and put a slightly-different-case version in history.
    const target = NICHE_POOL.interior[0];
    const history: WorldHistoryEntry[] = [
      { niche: target.toUpperCase(), worldSignature: "x-y-z", worldKeywords: ["x", "y", "z"] },
    ];
    // Sample everything to confirm the target never makes it through.
    const out = pickAltitudeExamples("interior", history, [], NICHE_POOL.interior.length);
    expect(out).not.toContain(target);
  });

  it("filters out niches the operator already skipped this session", () => {
    const target = NICHE_POOL.exterior[0];
    const out = pickAltitudeExamples("exterior", [], [target], NICHE_POOL.exterior.length);
    expect(out).not.toContain(target);
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

    const out = await suggestWorld({ format: "reel", worldType: "interior", history: [] });

    expect(out).toEqual(valid);
    const args = generateJSONMock.mock.calls[0][0];
    expect(args.toolName).toBe("submit_world");
    expect(args.maxTokens).toBe(800);
  });

it("rejects too-short niche", async () => {
    generateJSONMock.mockResolvedValue({ ...valid, niche: "x" });
    await expect(
      suggestWorld({ format: "reel", worldType: "interior", history: [] })
    ).rejects.toThrow();
  });

  it("rejects too-short rationale", async () => {
    generateJSONMock.mockResolvedValue({ ...valid, rationale: "x" });
    await expect(
      suggestWorld({ format: "reel", worldType: "interior", history: [] })
    ).rejects.toThrow();
  });

  it("SuggestedWorldSchema accepts a well-formed object", () => {
    expect(() => SuggestedWorldSchema.parse(valid)).not.toThrow();
  });
});
