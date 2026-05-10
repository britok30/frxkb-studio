import { describe, it, expect, vi, beforeEach } from "vitest";

const generateJSONMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/claude", () => ({ generateJSON: generateJSONMock }));

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
  it("encodes the calm/slow constraint and forbids fast moves", () => {
    const sys = buildMotionSystem();
    expect(sys).toMatch(/calm|slow|restrained/i);
    expect(sys).toMatch(/no fast pans|no zoom-bursts|never fast/i);
    expect(sys).toMatch(/no people/i);
  });

  it("anchors in cinematography vocabulary", () => {
    const sys = buildMotionSystem();
    expect(sys).toMatch(/dolly-in|parallax|tilt down/i);
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

  it("returns Claude's motions in scene order", async () => {
    generateJSONMock.mockResolvedValue(fakeMotions(3));

    const out = await generateMotionPrompts({ concept, scenes });

    expect(out.motions).toHaveLength(3);
    expect(out.motions[0].order).toBe(1);
    expect(out.motions[2].order).toBe(3);
  });

  it("uses temperature for variety (different image shouldn't always get same move)", async () => {
    generateJSONMock.mockResolvedValue(fakeMotions(3));
    await generateMotionPrompts({ concept, scenes });
    const args = generateJSONMock.mock.calls[0][0];
    expect(args.temperature).toBeGreaterThan(0);
    expect(args.toolName).toBe("submit_motions");
  });

  it("trims excess motions and renumbers from 1 if Claude over-returned", async () => {
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

  it("throws when Claude returns fewer motions than scenes", async () => {
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
