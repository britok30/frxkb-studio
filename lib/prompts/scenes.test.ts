import { describe, it, expect, vi, beforeEach } from "vitest";

const generateJSONMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/claude", () => ({
  generateJSON: generateJSONMock,
}));

import { buildScenesSystem, buildScenesUser, generateScenePrompts } from "./scenes";
import type { PromptableConcept } from "./types";

const concept: PromptableConcept = {
  workingTitle: "Sunlit Brazilian Modernism",
  hook: "Calm afternoons through travertine and palm shadow.",
  vibe: "1960s Brazilian modernist houses, palm-filtered light.",
  notes: "Eye-level. Never overcast.",
};

beforeEach(() => {
  generateJSONMock.mockReset();
});

function fakeScenes(n: number, durationSec = 5) {
  return Array.from({ length: n }, (_, i) => ({
    order: i + 1,
    prompt: `Wide establishing shot of scene ${i + 1}: a Brazilian modernist residence in late afternoon light, board-formed concrete walls and ribbon windows, palm shadows raking across honed travertine paving, shot on Kodak Portra 400, warm golden side-light from the west, restrained and quiet.`,
    durationSec,
  }));
}

describe("buildScenesSystem", () => {
  it("encodes coherence rules: no people, no text, no identical compositions in a row", () => {
    const sys = buildScenesSystem();
    expect(sys).toMatch(/no people/i);
    expect(sys).toMatch(/no on-screen text/i);
    expect(sys).toMatch(/no identical compositions/i);
    expect(sys).toMatch(/wide establishing.*mid.*detail/i);
    // Pro-specific guidance — cinematographic vocabulary + material specificity.
    expect(sys).toMatch(/cinematographic|focal length|film stock/i);
    expect(sys).toMatch(/material specificity|named precisely/i);
  });
});

describe("buildScenesUser", () => {
  it("packs concept fields, aspect ratio, count, and per-scene duration", () => {
    const out = buildScenesUser({
      concept,
      aspectRatio: "16:9",
      sceneCount: 30,
      sceneDurationSec: 5,
    });
    expect(out).toContain("Sunlit Brazilian Modernism");
    expect(out).toContain("Aspect ratio for downstream rendering: 16:9");
    expect(out).toContain("Number of scenes: 30");
    expect(out).toContain("Per-scene duration: 5s");
    expect(out).toContain("Eye-level. Never overcast.");
  });

  it("skips empty concept notes cleanly", () => {
    const out = buildScenesUser({
      concept: { ...concept, notes: "" },
      aspectRatio: "9:16",
      sceneCount: 8,
      sceneDurationSec: 4,
    });
    expect(out).not.toMatch(/Visual rules to lock down/i);
  });
});

describe("generateScenePrompts", () => {
  it("returns Claude's scenes when count matches", async () => {
    generateJSONMock.mockResolvedValue({ scenes: fakeScenes(8) });

    const out = await generateScenePrompts({
      concept,
      aspectRatio: "9:16",
      sceneCount: 8,
      sceneDurationSec: 4,
    });

    expect(out.scenes).toHaveLength(8);
    expect(out.scenes[0].order).toBe(1);
    expect(out.scenes[7].order).toBe(8);
  });

  it("trims excess scenes and renumbers from 1 if Claude returned too many", async () => {
    generateJSONMock.mockResolvedValue({
      scenes: fakeScenes(12).map((s, i) => ({ ...s, order: i + 50 })),
    });

    const out = await generateScenePrompts({
      concept,
      aspectRatio: "16:9",
      sceneCount: 8,
      sceneDurationSec: 5,
    });

    expect(out.scenes).toHaveLength(8);
    expect(out.scenes.map((s) => s.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("throws when Claude returns fewer scenes than requested", async () => {
    generateJSONMock.mockResolvedValue({ scenes: fakeScenes(3) });

    await expect(
      generateScenePrompts({
        concept,
        aspectRatio: "16:9",
        sceneCount: 8,
        sceneDurationSec: 5,
      })
    ).rejects.toThrow(/3 scenes, expected 8/);
  });

  it("throws if a scene fails schema (prompt too short)", async () => {
    generateJSONMock.mockResolvedValue({
      scenes: [{ order: 1, prompt: "too short", durationSec: 5 }],
    });

    await expect(
      generateScenePrompts({
        concept,
        aspectRatio: "16:9",
        sceneCount: 1,
        sceneDurationSec: 5,
      })
    ).rejects.toThrow();
  });

  it("uses submit_scenes as the tool name", async () => {
    generateJSONMock.mockResolvedValue({ scenes: fakeScenes(1) });

    await generateScenePrompts({
      concept,
      aspectRatio: "16:9",
      sceneCount: 1,
      sceneDurationSec: 5,
    });

    expect(generateJSONMock.mock.calls[0][0].toolName).toBe("submit_scenes");
  });
});
