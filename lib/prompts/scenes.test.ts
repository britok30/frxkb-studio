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
  it("anchors every scene in a residential HOME (not a museum, gallery, or showroom)", () => {
    const sys = buildScenesSystem();
    expect(sys).toMatch(/residential|home|house/i);
    // Category families are named in the prompt — but as categories, not as
    // specific brand-name objects (specifics live in the per-piece objectSet).
    expect(sys).toMatch(/plants/i);
    expect(sys).toMatch(/art|ceramic/i);
    expect(sys).toMatch(/textile/i);
  });

  it("requires the cultural-lineage rule and references the per-piece object set", () => {
    const sys = buildScenesSystem();
    expect(sys).toMatch(/cultural lineage|lineage drive/i);
    expect(sys).toMatch(/object set|objectSet/i);
  });

  it("encodes composition + cinematographic guidance in affirmative language", () => {
    const sys = buildScenesSystem();
    expect(sys).toMatch(/vary composition|alternate between/i);
    expect(sys).toMatch(/wide establishing.*mid.*detail/i);
    expect(sys).toMatch(/cinematographic|focal length|film stock/i);
    expect(sys).toMatch(/material specificity|named precisely/i);
  });

  it("does NOT include the dead 'uninhabited / empty rooms / blank walls' commands that were stripping all life from outputs", () => {
    const sys = buildScenesSystem();
    expect(sys).not.toMatch(/uninhabited|empty rooms|vacant spaces|untouched architectural surfaces/i);
    expect(sys).not.toMatch(/blank walls|unmarked surfaces/i);
  });

  it("does NOT cite specific brand-name objects in the system prompt (those become global defaults Claude reaches for every time)", () => {
    const sys = buildScenesSystem();
    expect(sys).not.toMatch(/Hans Wegner|fiddle-leaf fig|Braun record player|design monographs/);
  });

  it("does NOT include negation patterns ('no people', 'no on-screen text') — those positively prime the bad tokens", () => {
    const sys = buildScenesSystem();
    expect(sys).not.toMatch(/no people\.|no faces|no body parts|no silhouettes/i);
    expect(sys).not.toMatch(/no on-screen text|no signage|no brands|no watermark/i);
  });
});

describe("buildScenesUser", () => {
  it("packs concept fields, aspect ratio, count, and per-scene duration", () => {
    const out = buildScenesUser({
      concept,
      aspectRatio: "16:9",
      sceneCount: 30,
      sceneDurationSec: 5,
      worldType: "interior",
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
      worldType: "interior",
    });
    expect(out).not.toMatch(/Visual rules to lock down/i);
  });

  it("injects the brief's objectSet so scene prompts draw from THIS lineage's objects, not from defaults", () => {
    const out = buildScenesUser({
      concept,
      aspectRatio: "9:16",
      sceneCount: 5,
      sceneDurationSec: 5,
      worldType: "interior",
    });
    expect(out).toMatch(/Object set committed in the brief/i);
    // Every objectSet item should appear in the user prompt.
    for (const item of concept.objectSet) {
      expect(out).toContain(item);
    }
    // Distribution rule keeps Claude from naming every object in every scene.
    expect(out).toMatch(/Distribute these across scenes/i);
  });

  it("omits the objectSet block when concept has none (legacy concepts persisted before objectSet existed)", () => {
    const out = buildScenesUser({
      concept: { ...concept, objectSet: [] },
      aspectRatio: "9:16",
      sceneCount: 5,
      sceneDurationSec: 5,
      worldType: "interior",
    });
    expect(out).not.toMatch(/Object set committed in the brief/i);
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
      worldType: "interior",
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
      worldType: "interior",
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
        worldType: "interior",
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
        worldType: "interior",
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
      worldType: "interior",
    });

    expect(generateJSONMock.mock.calls[0][0].toolName).toBe("submit_scenes");
  });
});
