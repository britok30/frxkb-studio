import { describe, it, expect, vi, beforeEach } from "vitest";

const generateJSONMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/llm", () => ({ generateJSON: generateJSONMock }));

import {
  buildMotionSystem,
  buildMotionUser,
  generateMotionPrompts,
} from "./motion";
import type { PromptableConcept } from "./types";

const concept: PromptableConcept = {
  workingTitle: "Sunlit Brazilian Modernism",
  hook: "Calm afternoons through travertine and palm shadow.",
  vibe: "1960s Brazilian modernism, palm-filtered late afternoon light.",
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

const scenes = [
  { order: 1, prompt: "Wide opening shot of a single-story Brazilian modernist residence in late afternoon, board-formed concrete walls, ribbon windows, palm shadows on travertine paving." },
  { order: 2, prompt: "Mid-shot interior of a travertine-floored living room, low concrete plinth, linen sofa, ribbon window letting in golden side-light." },
  { order: 3, prompt: "Detail shot of palm shadows raking across a textured travertine floor, late afternoon golden light." },
];

beforeEach(() => {
  generateJSONMock.mockReset();
});

describe("buildMotionSystem", () => {
  it("encodes the calm/slow tone via an affirmative camera-move allowlist (no negation — seedance has no negative_prompt)", () => {
    const sys = buildMotionSystem();
    expect(sys).toMatch(/calm|slow|restrained|meditative/i);
    // Affirmative allowlist — explicit list of allowed moves.
    expect(sys).toMatch(/slow dolly in/i);
    expect(sys).toMatch(/locked-off static|gentle pan|slow tilt/i);
    // No-humans rule preserved (nano-banana renders people poorly), but
    // motion may animate plants, candles, steam, fabric — anything in the home.
    expect(sys).toMatch(/no humans appear|empty of people|no humans/i);
  });

  it("does NOT include the old negation patterns (whip-pans, no people, etc.)", () => {
    const sys = buildMotionSystem();
    expect(sys).not.toMatch(/never fast pans|no zoom-bursts|no whip-pans/i);
    expect(sys).not.toMatch(/no people, no faces appearing or moving/i);
  });

  it("anchors in cinematography vocabulary", () => {
    const sys = buildMotionSystem();
    expect(sys).toMatch(/dolly|pan|tilt/i);
  });
});

describe("buildMotionUser", () => {
  it("packs concept and lists every scene with its order + prompt", () => {
    const out = buildMotionUser({ concept, scenes });
    expect(out).toContain("Sunlit Brazilian Modernism");
    expect(out).toContain("1. Wide opening shot of a single-story");
    expect(out).toContain("2. Mid-shot interior");
    expect(out).toContain("3. Detail shot of palm shadows");
    expect(out).toContain("Output one motion per scene, numbered 1 through 3");
  });
});

describe("generateMotionPrompts", () => {
  function fakeMotions(n: number) {
    return {
      motions: Array.from({ length: n }, (_, i) => ({
        order: i + 1,
        motion:
          "Slow dolly-in toward the back of the room, gentle dust motes drifting through the slanted golden light.",
      })),
    };
  }

  it("returns GPT-5.5's motions in scene order", async () => {
    generateJSONMock.mockResolvedValue(fakeMotions(3));

    const out = await generateMotionPrompts({ concept, scenes });

    expect(out.motions).toHaveLength(3);
    expect(out.motions[0].order).toBe(1);
    expect(out.motions[2].order).toBe(3);
  });

it("trims excess motions and aligns each to its input scene's order", async () => {
    generateJSONMock.mockResolvedValue({
      motions: Array.from({ length: 8 }, (_, i) => ({
        order: i + 50,
        motion: "Slow dolly-in toward the back of the room with gentle dust motes drifting through the light.",
      })),
    });

    const out = await generateMotionPrompts({ concept, scenes });

    expect(out.motions).toHaveLength(3);
    expect(out.motions.map((m) => m.order)).toEqual([1, 2, 3]);
  });

  it("preserves non-contiguous scene orders — animate retries pass partial targets like [2, 4, 5]", async () => {
    // Three target scenes with gappy orders, simulating 'retry the failed ones'.
    const partialScenes = [
      { order: 2, prompt: scenes[1].prompt },
      { order: 4, prompt: scenes[2].prompt },
      { order: 5, prompt: scenes[0].prompt },
    ];
    generateJSONMock.mockResolvedValue({
      motions: [
        { order: 1, motion: "Slow dolly-in toward the back of the room with gentle dust motes drifting." },
        { order: 2, motion: "Static camera with subtle wind rustling palm shadows on travertine." },
        { order: 3, motion: "Gentle parallax left to right across the textured floor in golden light." },
      ],
    });

    const out = await generateMotionPrompts({ concept, scenes: partialScenes });

    // Each returned motion's order must match the corresponding INPUT scene's
    // order, not GPT-5.5's 1..N output, otherwise the downstream Map lookup in
    // animateAllScenes (`motionByOrder.get(scene.order)`) misses on retries.
    expect(out.motions.map((m) => m.order)).toEqual([2, 4, 5]);
  });

  it("throws when GPT-5.5 returns fewer motions than scenes", async () => {
    generateJSONMock.mockResolvedValue(fakeMotions(2));
    await expect(generateMotionPrompts({ concept, scenes })).rejects.toThrow(
      /2 motions, expected 3/
    );
  });

  it("rejects motions that fail schema (too short)", async () => {
    generateJSONMock.mockResolvedValue({
      motions: [{ order: 1, motion: "x" }],
    });
    await expect(
      generateMotionPrompts({ concept, scenes: [scenes[0]] })
    ).rejects.toThrow();
  });
});

describe("camera-move presets", () => {
  it("catalog ids are unique and every directive uses allowlisted, affirmative language", async () => {
    const { CAMERA_MOVES, getCameraMove } = await import("./motion");
    const ids = CAMERA_MOVES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of CAMERA_MOVES) {
      expect(m.directive.length).toBeGreaterThan(5);
      expect(m.directive).not.toMatch(/\bno \b|\bnot\b|\bnever\b/i);
    }
    expect(getCameraMove("orbit-left")?.name).toBe("Orbit left");
    expect(getCameraMove("nope")).toBeNull();
    expect(getCameraMove(null)).toBeNull();
  });

  it("buildMotionUser marks locked scenes with the exact directive and states the lock rule", async () => {
    const { buildMotionUser, getCameraMove } = await import("./motion");
    const out = buildMotionUser({
      concept: { workingTitle: "T", hook: "h", vibe: "v", notes: "", objectSet: [] },
      scenes: [
        { order: 1, prompt: "Scene one prompt", motionPreset: "orbit-left" },
        { order: 2, prompt: "Scene two prompt" },
      ],
    });
    expect(out).toContain(`[CAMERA LOCKED: "${getCameraMove("orbit-left")!.directive}"]`);
    expect(out).toMatch(/lead the motion prompt with that exact directive verbatim/i);
    expect(out).toContain("2. Scene two prompt");
    expect(out).not.toContain("2. [CAMERA LOCKED");
  });

  it("buildMotionUser omits the lock rule when nothing is locked", async () => {
    const { buildMotionUser } = await import("./motion");
    const out = buildMotionUser({
      concept: { workingTitle: "T", hook: "h", vibe: "v", notes: "", objectSet: [] },
      scenes: [{ order: 1, prompt: "Scene one prompt" }],
    });
    expect(out).not.toMatch(/LOCKED/);
  });
});
