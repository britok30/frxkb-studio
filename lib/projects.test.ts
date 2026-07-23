import { describe, it, expect, vi, beforeEach } from "vitest";

const dbMocks = vi.hoisted(() => ({
  insertProject: vi.fn(),
  insertScenes: vi.fn(),
  listProjectsRows: vi.fn(),
  selectProjectById: vi.fn(),
  selectSceneById: vi.fn(),
  selectScenesByProject: vi.fn(),
  updateProjectStatus: vi.fn(),
  markSceneGenerating: vi.fn(),
  markSceneGenerated: vi.fn(),
  markSceneFailed: vi.fn(),
  markSceneApproved: vi.fn(),
  markSceneRejected: vi.fn(),
  markProjectFinalized: vi.fn(),
  tryAcquireGenerationLock: vi.fn(),
  tryAcquireFinalizationLock: vi.fn(),
  resetOrphanedScenes: vi.fn(),
  heartbeatGenerationLock: vi.fn(),
  insertSceneVersion: vi.fn(),
  setProjectSceneReferences: vi.fn(),
  setSceneMotionPreset: vi.fn(),
  markProjectFinalVideo: vi.fn(),
  updateStitchState: vi.fn(),
}));

const claudeMocks = vi.hoisted(() => ({
  generateConcept: vi.fn(),
  generateBeforeAfterConcept: vi.fn(),
  generateScenePrompts: vi.fn(),
  generateMetadata: vi.fn(),
}));

const falMocks = vi.hoisted(() => ({
  generateImage: vi.fn(),
  editImage: vi.fn(),
}));

const storageMocks = vi.hoisted(() => ({
  storeFromUrl: vi.fn(),
}));

// Default operator for all tests in this file. Individual tests can override
// the operator by re-mocking pickAppLink (used by substituteAppLink).
const operatorMocks = vi.hoisted(() => {
  const britok = {
    email: "britok30@gmail.com",
    falKey: "fk",
    openaiKey: "ak",
    apps: [
      { name: "ArchitectGPT", url: "", handle: "architectgpt" },
      { name: "CasaGPT", url: "", handle: "casagpt", pattern: /(interior|living)/ },
    ],
    worldTypes: ["interior", "exterior"] as ("interior" | "exterior")[],
    propertyTypes: ["residential", "commercial"] as ("residential" | "commercial")[],
    socials: { instagram: "architectgpt", website: "https://www.architectgpt.io" },
  };
  return {
    currentOperator: vi.fn(() => britok),
    pickAppLink: vi.fn((_op: unknown, _niche: string) => ""),
    fixture: britok,
  };
});

vi.mock("@/lib/projects-db", () => dbMocks);
vi.mock("@/lib/prompts/concept", () => ({
  generateConcept: claudeMocks.generateConcept,
  generateBeforeAfterConcept: claudeMocks.generateBeforeAfterConcept,
}));
vi.mock("@/lib/prompts/scenes", () => ({ generateScenePrompts: claudeMocks.generateScenePrompts }));
vi.mock("@/lib/prompts/metadata", () => ({ generateMetadata: claudeMocks.generateMetadata }));
vi.mock("@/lib/fal", () => ({
  generateImage: falMocks.generateImage,
  editImage: falMocks.editImage,
}));
vi.mock("@/lib/storage", () => ({ storeFromUrl: storageMocks.storeFromUrl }));
vi.mock("@/lib/operators", () => ({
  currentOperator: operatorMocks.currentOperator,
  pickAppLink: operatorMocks.pickAppLink,
}));

const dedupeMocks = vi.hoisted(() => ({
  findSimilarProjects: vi.fn(),
}));
vi.mock("@/lib/world-dedupe", () => dedupeMocks);

const composeMocks = vi.hoisted(() => ({
  composeVideo: vi.fn(),
}));
vi.mock("@/lib/compose", () => ({ composeVideo: composeMocks.composeVideo }));

const shotstackMocks = vi.hoisted(() => ({
  renderShotstack: vi.fn(),
  // Default false → existing stitch tests exercise the fal fallback path.
  isShotstackConfigured: vi.fn(() => false),
}));
vi.mock("@/lib/shotstack", () => ({
  renderShotstack: shotstackMocks.renderShotstack,
  isShotstackConfigured: shotstackMocks.isShotstackConfigured,
  SHOTSTACK_PER_MINUTE: 0.3,
}));

const spendMocks = vi.hoisted(() => ({
  recordSpend: vi.fn(),
  assertWithinDailyBudget: vi.fn(),
}));
vi.mock("@/lib/spend", () => ({
  recordSpend: spendMocks.recordSpend,
  assertWithinDailyBudget: spendMocks.assertWithinDailyBudget,
}));

import {
  applySceneAction,
  createBeforeAfterProject,
  createProject,
  finalizeProject,
  generateAllImages,
  getProjectWithScenes,
  listProjects,
  stitchFinalVideo,
  ProjectBusyError,
} from "./projects";

const concept = {
  workingTitle: "Sunlit Brazilian Modernism",
  hook: "Calm afternoons through travertine and palm shadow.",
  vibe: "1960s Brazilian modernism, palm-filtered late afternoon light, travertine and terracotta.",
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
  worldSignature: "1960s-brazilian-modernism-travertine-palms",
  worldKeywords: ["1960s", "brazilian", "modernism", "travertine", "palms", "late-afternoon"],
};

function fakeScene(overrides: Partial<{ id: string; order: number; status: string; prompt: string }> = {}) {
  return {
    id: overrides.id ?? "s_x",
    projectId: "p_1",
    order: overrides.order ?? 1,
    prompt: overrides.prompt ?? "Wide establishing shot at eye level of a single-story Brazilian modernist residence in late afternoon light, board-formed concrete walls and ribbon windows, palm shadows raking across honed travertine paving, shot on Kodak Portra 400, warm golden side-light from the west, restrained and quiet.",
    durationSec: 5,
    seed: null,
    status: overrides.status ?? "pending",
    imageUrl: null,
    falRequestId: null,
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

beforeEach(() => {
  Object.values(dbMocks).forEach((m) => m.mockReset());
  Object.values(claudeMocks).forEach((m) => m.mockReset());
  Object.values(falMocks).forEach((m) => m.mockReset());
  Object.values(storageMocks).forEach((m) => m.mockReset());
  // Dedupe defaults to "no matches" — individual tests can override.
  dedupeMocks.findSimilarProjects.mockReset().mockResolvedValue({
    hasMatches: false,
    matches: [],
  });

  // Sensible default: insertProject echoes back what it inserted.
  dbMocks.insertProject.mockImplementation(async (vals) => ({ ...vals, createdAt: new Date(), updatedAt: new Date() }));
  dbMocks.insertScenes.mockImplementation(async (rows) => rows);
  dbMocks.tryAcquireGenerationLock.mockResolvedValue(true);
  dbMocks.tryAcquireFinalizationLock.mockResolvedValue(true);
  dbMocks.resetOrphanedScenes.mockResolvedValue(0);
  dbMocks.heartbeatGenerationLock.mockResolvedValue(undefined);
  dbMocks.insertSceneVersion.mockResolvedValue(undefined);
  dbMocks.setProjectSceneReferences.mockResolvedValue(undefined);
  dbMocks.markProjectFinalVideo.mockResolvedValue(undefined);
  dbMocks.updateStitchState.mockResolvedValue(undefined);
  composeMocks.composeVideo.mockReset().mockResolvedValue({
    videoUrl: "https://fal.media/composed.mp4",
    thumbnailUrl: null,
    requestId: "req_compose",
  });
  spendMocks.recordSpend.mockReset().mockResolvedValue(undefined);
  spendMocks.assertWithinDailyBudget.mockReset().mockResolvedValue(undefined);
  shotstackMocks.renderShotstack.mockReset().mockResolvedValue({
    videoUrl: "https://shotstack.io/out.mp4",
  });
  shotstackMocks.isShotstackConfigured.mockReset().mockReturnValue(false);
});

describe("createProject", () => {
  it("calls GPT-5.5 for concept then scenes, inserts project + scene rows", async () => {
    claudeMocks.generateConcept.mockResolvedValue(concept);
    claudeMocks.generateScenePrompts.mockResolvedValue({
      scenes: [
        { order: 1, prompt: "Wide opening shot of a Brazilian modernist house in late golden-hour light, low concrete planes meeting honed travertine paving, palm shadows fragmenting across the facade, shot on Mamiya 7 medium format, warm 4500K side-light from the west, restrained composition.", durationSec: 5 },
        { order: 2, prompt: "Mid-shot interior of a single travertine-floored living room, raw board-formed concrete wall on the left, low-slung linen sofa centered, late-afternoon side-light through ribbon windows, shot on 50mm with shallow depth-of-field, atmosphere of slow Sunday quiet.", durationSec: 5 },
      ],
    });

    const callOrder: string[] = [];
    claudeMocks.generateConcept.mockImplementation(async () => {
      callOrder.push("concept");
      return concept;
    });
    claudeMocks.generateScenePrompts.mockImplementation(async () => {
      callOrder.push("scenes");
      return {
        scenes: [
          { order: 1, prompt: "Wide opening shot of a Brazilian modernist house in late golden-hour light, low concrete planes meeting honed travertine paving, palm shadows fragmenting across the facade, shot on Mamiya 7 medium format, warm 4500K side-light from the west, restrained composition.", durationSec: 5 },
          { order: 2, prompt: "Mid-shot interior of a single travertine-floored living room, raw board-formed concrete wall on the left, low-slung linen sofa centered, late-afternoon side-light through ribbon windows, shot on 50mm with shallow depth-of-field, atmosphere of slow Sunday quiet.", durationSec: 5 },
        ],
      };
    });
    dbMocks.insertProject.mockImplementation(async (vals) => {
      callOrder.push("insertProject");
      return { ...vals, createdAt: new Date(), updatedAt: new Date() };
    });
    dbMocks.insertScenes.mockImplementation(async (rows) => {
      callOrder.push("insertScenes");
      return rows;
    });

    const out = await createProject({
      niche: "modernist living rooms",
      format: "reel", worldType: "interior",
      sceneCount: 2,
      sceneDurationSec: 5,
    });

    // Both GPT-5.5 calls must complete before any DB write — no orphan rows on LLM failure.
    expect(callOrder).toEqual(["concept", "scenes", "insertProject", "insertScenes"]);

    expect(claudeMocks.generateConcept).toHaveBeenCalledWith({
      niche: "modernist living rooms",
      format: "reel", worldType: "interior",
      targetDurationSec: 10,
      operatorNotes: undefined,
    });
    expect(claudeMocks.generateScenePrompts).toHaveBeenCalledWith({
      concept,
      aspectRatio: "9:16",
      sceneCount: 2,
      sceneDurationSec: 5,
      worldType: "interior",
      look: null,
    });
    expect(dbMocks.insertProject).toHaveBeenCalledOnce();
    const projInsert = dbMocks.insertProject.mock.calls[0][0];
    expect(projInsert.title).toBe("Sunlit Brazilian Modernism");
    expect(projInsert.format).toBe("reel");
    expect(projInsert.status).toBe("scripting");
    // Concept jsonb stores the core fields. worldSignature/worldKeywords
    // get persisted on dedicated columns, not on the concept blob.
    expect(projInsert.concept).toMatchObject({
      workingTitle: concept.workingTitle,
      hook: concept.hook,
      vibe: concept.vibe,
      notes: concept.notes,
    });
    expect(projInsert.worldSignature).toBe(concept.worldSignature);
    expect(projInsert.worldKeywords).toEqual(concept.worldKeywords);

    expect(dbMocks.insertScenes).toHaveBeenCalledOnce();
    const sceneRows = dbMocks.insertScenes.mock.calls[0][0];
    expect(sceneRows).toHaveLength(2);
    expect(sceneRows[0].projectId).toBe(projInsert.id);
    expect(sceneRows[0].status).toBe("pending");
    expect(sceneRows[0].order).toBe(1);

    expect(out.project.title).toBe("Sunlit Brazilian Modernism");
    expect(out.scenes).toHaveLength(2);
    // Dedupe found nothing (default mock) — empty array.
    expect(out.similarProjects).toEqual([]);
  });

  it("threads the committed look into scene scripting and persists lookId on the project", async () => {
    claudeMocks.generateConcept.mockResolvedValue(concept);
    claudeMocks.generateScenePrompts.mockResolvedValue({
      scenes: [
        { order: 1, prompt: "long enough scene prompt with palm shadows under late afternoon light", durationSec: 5 },
      ],
    });

    await createProject({
      niche: "modernist living rooms",
      format: "reel",
      worldType: "interior",
      sceneCount: 1,
      lookId: "golden-hour",
    });

    const scenesCall = claudeMocks.generateScenePrompts.mock.calls[0][0];
    expect(scenesCall.look?.id).toBe("golden-hour");
    const projInsert = dbMocks.insertProject.mock.calls[0][0];
    expect(projInsert.lookId).toBe("golden-hour");
  });

  it("rejects a look that doesn't cover the picked lane before any LLM spend", async () => {
    await expect(
      createProject({
        niche: "modernist living rooms",
        format: "reel",
        worldType: "interior",
        sceneCount: 1,
        lookId: "twilight-hero", // exterior-only look
      })
    ).rejects.toThrow(/doesn't cover interior/i);
    expect(claudeMocks.generateConcept).not.toHaveBeenCalled();
  });

  it("calls dedupe with concept's signature + keywords and propagates matches", async () => {
    claudeMocks.generateConcept.mockResolvedValue(concept);
    claudeMocks.generateScenePrompts.mockResolvedValue({
      scenes: [
        { order: 1, prompt: "long enough scene prompt with palm shadows under late afternoon light", durationSec: 5 },
      ],
    });
    const fakeMatch = {
      project: { id: "p_old", title: "Earlier Brazilian Modernism", niche: "x", format: "reel" as const, createdAt: new Date() },
      reason: "exact-signature" as const,
      confidence: 1,
    };
    dedupeMocks.findSimilarProjects.mockResolvedValue({
      hasMatches: true,
      matches: [fakeMatch],
    });

    const out = await createProject({ niche: "x", format: "reel", worldType: "interior", sceneCount: 1 });

    expect(dedupeMocks.findSimilarProjects).toHaveBeenCalledExactlyOnceWith({
      signature: concept.worldSignature,
      keywords: concept.worldKeywords,
    });
    expect(out.similarProjects).toEqual([fakeMatch]);
  });

  it("creates the project anyway if dedupe throws (the world is viable without dedupe)", async () => {
    claudeMocks.generateConcept.mockResolvedValue(concept);
    claudeMocks.generateScenePrompts.mockResolvedValue({
      scenes: [
        { order: 1, prompt: "long enough scene prompt with palm shadows under late afternoon light", durationSec: 5 },
      ],
    });
    dedupeMocks.findSimilarProjects.mockRejectedValue(new Error("DB unreachable"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const out = await createProject({ niche: "x", format: "reel", worldType: "interior", sceneCount: 1 });

    expect(out.project.title).toBe("Sunlit Brazilian Modernism");
    expect(out.similarProjects).toEqual([]);
    expect(dbMocks.insertProject).toHaveBeenCalledOnce();
  });

  it("applies format defaults when sceneCount/sceneDurationSec are omitted", async () => {
    claudeMocks.generateConcept.mockResolvedValue(concept);
    claudeMocks.generateScenePrompts.mockResolvedValue({
      scenes: Array.from({ length: 5 }, (_, i) => ({
        order: i + 1,
        prompt: "Wide establishing shot at eye level of a single-story Brazilian modernist residence in late afternoon light, board-formed concrete walls and ribbon windows, palm shadows raking across honed travertine paving, shot on Kodak Portra 400, warm golden side-light from the west, restrained and quiet.",
        durationSec: 3,
      })),
    });

    await createProject({ niche: "x", format: "reel", worldType: "interior" });

    // Reel default: 3 × 5s = 15s.
    expect(claudeMocks.generateScenePrompts).toHaveBeenCalledWith(
      expect.objectContaining({
        aspectRatio: "9:16",
        sceneCount: 3,
        sceneDurationSec: 5,
      })
    );
  });

  it("clamps wildly large sceneCount to 120", async () => {
    claudeMocks.generateConcept.mockResolvedValue(concept);
    claudeMocks.generateScenePrompts.mockResolvedValue({
      scenes: Array.from({ length: 120 }, (_, i) => ({
        order: i + 1,
        prompt: "Wide establishing shot at eye level of a single-story Brazilian modernist residence in late afternoon light, board-formed concrete walls and ribbon windows, palm shadows raking across honed travertine paving, shot on Kodak Portra 400, warm golden side-light from the west, restrained and quiet.",
        durationSec: 5,
      })),
    });

    await createProject({ niche: "x", format: "reel", worldType: "interior", sceneCount: 999 });

    expect(claudeMocks.generateScenePrompts).toHaveBeenCalledWith(
      expect.objectContaining({ sceneCount: 120 })
    );
  });

  it("does not write any DB rows when scene prompt generation fails", async () => {
    claudeMocks.generateConcept.mockResolvedValue(concept);
    claudeMocks.generateScenePrompts.mockRejectedValue(new Error("GPT-5.5 rate limited"));

    await expect(
      createProject({ niche: "x", format: "reel", worldType: "interior", sceneCount: 2 })
    ).rejects.toThrow(/rate limited/);

    expect(dbMocks.insertProject).not.toHaveBeenCalled();
    expect(dbMocks.insertScenes).not.toHaveBeenCalled();
  });

  it("does not write any DB rows when concept generation fails", async () => {
    claudeMocks.generateConcept.mockRejectedValue(new Error("GPT-5.5 is down"));

    await expect(
      createProject({ niche: "x", format: "reel", worldType: "interior", sceneCount: 2 })
    ).rejects.toThrow(/down/);

    expect(claudeMocks.generateScenePrompts).not.toHaveBeenCalled();
    expect(dbMocks.insertProject).not.toHaveBeenCalled();
    expect(dbMocks.insertScenes).not.toHaveBeenCalled();
  });

  it("for carousel: pads prompt durationSec to 4, but stores 0 on scene rows", async () => {
    claudeMocks.generateConcept.mockResolvedValue(concept);
    claudeMocks.generateScenePrompts.mockResolvedValue({
      scenes: [
        { order: 1, prompt: "Wide establishing shot at eye level of a single-story Brazilian modernist residence in late afternoon light, board-formed concrete walls and ribbon windows, palm shadows raking across honed travertine paving, shot on Kodak Portra 400, warm golden side-light from the west, restrained and quiet.", durationSec: 4 },
      ],
    });

    await createProject({ niche: "x", format: "carousel", worldType: "interior", sceneCount: 1, sceneDurationSec: 0 });

    expect(claudeMocks.generateScenePrompts).toHaveBeenCalledWith(
      expect.objectContaining({ sceneDurationSec: 4 })
    );
    const sceneRows = dbMocks.insertScenes.mock.calls[0][0];
    expect(sceneRows[0].durationSec).toBe(0);
  });
});

describe("listProjects", () => {
  it("delegates to listProjectsRows", async () => {
    dbMocks.listProjectsRows.mockResolvedValue([{ id: "p1" }, { id: "p2" }]);
    const out = await listProjects();
    expect(out).toEqual([{ id: "p1" }, { id: "p2" }]);
  });
});

describe("getProjectWithScenes", () => {
  it("returns null when the project does not exist", async () => {
    dbMocks.selectProjectById.mockResolvedValue(null);
    const out = await getProjectWithScenes("missing");
    expect(out).toBeNull();
    expect(dbMocks.selectScenesByProject).not.toHaveBeenCalled();
  });

  it("returns the project with its scenes", async () => {
    const project = { id: "p1", title: "T", status: "ready" };
    dbMocks.selectProjectById.mockResolvedValue(project);
    dbMocks.selectScenesByProject.mockResolvedValue([fakeScene({ order: 1 }), fakeScene({ order: 2 })]);

    const out = await getProjectWithScenes("p1");

    expect(out?.project).toBe(project);
    expect(out?.scenes).toHaveLength(2);
  });
});

describe("createBeforeAfterProject", () => {
  beforeEach(() => {
    // Slim concept (no worldSignature/worldKeywords — those don't exist on
    // PromptableConcept and aren't asked from GPT-5.5 for before-after).
    claudeMocks.generateBeforeAfterConcept.mockResolvedValue({
      workingTitle: concept.workingTitle,
      hook: concept.hook,
      vibe: concept.vibe,
      notes: concept.notes,
    });
    dbMocks.insertProject.mockImplementation(async (values) => ({ ...values }));
    dbMocks.insertScenes.mockImplementation(async (rows) => rows);
  });

  it("persists the upload as the before scene + creates a pending after scene", async () => {
    const out = await createBeforeAfterProject({
      beforeImageUrl: "https://blob.example/upload-abc.jpg",
      transformationPrompt:
        "Modernize this kitchen — walnut cabinets, terrazzo floor, soft north-skylight, no clutter.",
      aspectRatio: "4:3",
      worldType: "interior",
    });

    // Slim concept call seeded by the transformation prompt — no worldSignature.
    expect(claudeMocks.generateBeforeAfterConcept).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        transformationPrompt: expect.stringContaining("Modernize"),
        worldType: "interior",
      })
    );
    // The full generateConcept (with dedupe fields) is NOT called for before-after.
    expect(claudeMocks.generateConcept).not.toHaveBeenCalled();

    // Project row carries the format + aspect + concept, no dedupe fields.
    const projectInsert = dbMocks.insertProject.mock.calls[0][0];
    expect(projectInsert.format).toBe("before-after");
    expect(projectInsert.aspectRatio).toBe("4:3");
    expect(projectInsert.worldType).toBe("interior");
    expect(projectInsert.worldSignature).toBeNull();
    expect(projectInsert.worldKeywords).toBeNull();

    // Two scenes: before (pre-generated) + after (pending, references the before).
    const sceneRows = dbMocks.insertScenes.mock.calls[0][0];
    expect(sceneRows).toHaveLength(2);

    const before = sceneRows.find((s: { order: number }) => s.order === 1);
    expect(before).toMatchObject({
      status: "generated",
      imageUrl: "https://blob.example/upload-abc.jpg",
      referenceImageUrl: null,
      // Both scenes share the same animation duration so they pair as
      // matched cuts in CapCut.
      durationSec: 7,
    });

    const after = sceneRows.find((s: { order: number }) => s.order === 2);
    expect(after).toMatchObject({
      status: "pending",
      // Frozen reference = the upload, so per-scene regen always re-uses it.
      referenceImageUrl: "https://blob.example/upload-abc.jpg",
      durationSec: 7, // matches defaultsForFormat("before-after").sceneDurationSec
    });

    expect(out.project.format).toBe("before-after");
    expect(out.scenes).toHaveLength(2);
  });

  it("does NOT call generateScenePrompts (only 2 hardcoded scenes)", async () => {
    await createBeforeAfterProject({
      beforeImageUrl: "https://blob.example/x.jpg",
      transformationPrompt: "Add walnut cabinets and terrazzo floors throughout.",
      aspectRatio: "1:1",
      worldType: "interior",
    });
    expect(claudeMocks.generateScenePrompts).not.toHaveBeenCalled();
  });

  it("does NOT run dedupe (each before-after is unique to its uploaded image)", async () => {
    await createBeforeAfterProject({
      beforeImageUrl: "https://blob.example/x.jpg",
      transformationPrompt: "Make it brighter and warmer with more natural light.",
      aspectRatio: "1:1",
      worldType: "interior",
    });
    expect(dedupeMocks.findSimilarProjects).not.toHaveBeenCalled();
  });

  it("rejects worldType outside the operator's allowed lanes", async () => {
    operatorMocks.currentOperator.mockReturnValueOnce({
      ...operatorMocks.fixture,
      worldTypes: ["interior"],
    });
    await expect(
      createBeforeAfterProject({
        beforeImageUrl: "https://blob.example/x.jpg",
        transformationPrompt: "Refresh this exterior facade with new cladding.",
        aspectRatio: "1:1",
        worldType: "exterior",
      })
    ).rejects.toThrow(/doesn't cover exterior/i);
    // No DB writes happen on rejection.
    expect(dbMocks.insertProject).not.toHaveBeenCalled();
    expect(dbMocks.insertScenes).not.toHaveBeenCalled();
  });
});

describe("generateAllImages", () => {
  beforeEach(() => {
    dbMocks.selectProjectById.mockResolvedValue({ id: "p_1", format: "reel", worldType: "interior", status: "scripting" });
    dbMocks.selectScenesByProject.mockResolvedValue([
      fakeScene({ id: "s_1", order: 1 }),
      fakeScene({ id: "s_2", order: 2 }),
    ]);
    falMocks.generateImage.mockResolvedValue({
      images: [{ url: "https://fal.media/x.jpg" }],
      requestId: "req_1",
    });
    falMocks.editImage.mockResolvedValue({
      images: [{ url: "https://fal.media/edit.jpg" }],
      requestId: "req_edit",
    });
    storageMocks.storeFromUrl.mockResolvedValue({
      url: "https://blob.vercel-storage.com/images/p_1/x.jpg",
      pathname: "images/p_1/x.jpg",
    });
  });

  it("throws when the project does not exist", async () => {
    dbMocks.selectProjectById.mockResolvedValue(null);
    await expect(generateAllImages("nope")).rejects.toThrow(/not found/);
  });

  it("reel/carousel: the anchor renders text-to-image, every other scene chains through /edit against it", async () => {
    const result = await generateAllImages("p_1");

    expect(result).toEqual({ generated: 2, failed: 0, skipped: 0, reclaimed: 0 });
    // Scene 1 (anchor) = text-to-image; scene 2 = /edit conditioned on the
    // anchor's STORED Blob URL so the whole set reads as one home.
    expect(falMocks.generateImage).toHaveBeenCalledTimes(1);
    expect(falMocks.editImage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        imageUrls: ["https://blob.vercel-storage.com/images/p_1/x.jpg"],
      })
    );
    expect(dbMocks.markSceneGenerating).toHaveBeenCalledTimes(2);
    expect(dbMocks.markSceneGenerated).toHaveBeenCalledTimes(2);
    expect(dbMocks.markSceneFailed).not.toHaveBeenCalled();
    expect(dbMocks.updateProjectStatus.mock.calls.map((c) => c[1])).toEqual(["ready"]);
  });

  it("freezes the anchor URL as the reference for the sibling scenes", async () => {
    await generateAllImages("p_1");

    expect(dbMocks.setProjectSceneReferences).toHaveBeenCalledWith(
      "p_1",
      "s_1",
      "https://blob.vercel-storage.com/images/p_1/x.jpg"
    );
    // markSceneGenerated itself never writes referenceImageUrl — the freeze
    // happens through setProjectSceneReferences (fills NULLs only).
    for (const call of dbMocks.markSceneGenerated.mock.calls) {
      expect(call[1]).not.toHaveProperty("referenceImageUrl");
    }
  });

  it("persists the seed each render used", async () => {
    await generateAllImages("p_1");

    for (const call of dbMocks.markSceneGenerated.mock.calls) {
      expect(call[1].seed).toEqual(expect.any(Number));
    }
  });

  it("before-after: scenes with referenceImageUrl route through /edit conditioned on the upload", async () => {
    dbMocks.selectProjectById.mockResolvedValue({
      id: "p_1",
      format: "before-after",
      worldType: "interior",
      status: "scripting",
      aspectRatio: "4:3",
    });
    dbMocks.selectScenesByProject.mockResolvedValue([
      {
        ...fakeScene({ id: "s_1", order: 1, status: "generated" }),
        imageUrl: "https://blob.example/upload-before.jpg",
      },
      {
        ...fakeScene({ id: "s_2", order: 2, status: "pending" }),
        referenceImageUrl: "https://blob.example/upload-before.jpg",
      },
    ]);

    const result = await generateAllImages("p_1");

    expect(result).toEqual({ generated: 1, failed: 0, skipped: 1, reclaimed: 0 });
    // Only the after fires fal — and it goes through /edit against the upload.
    expect(falMocks.generateImage).not.toHaveBeenCalled();
    expect(falMocks.editImage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        imageUrls: ["https://blob.example/upload-before.jpg"],
        aspectRatio: "4:3",
      })
    );
  });

  it("partial regen: only generates missing/rejected scenes, leaves approved/generated alone", async () => {
    dbMocks.selectScenesByProject.mockResolvedValue([
      {
        ...fakeScene({ id: "s_1", order: 1, status: "approved" }),
        imageUrl: "https://blob.example/existing-1.jpg",
      },
      {
        ...fakeScene({ id: "s_2", order: 2, status: "generated" }),
        imageUrl: "https://blob.example/existing-2.jpg",
      },
      fakeScene({ id: "s_3", order: 3, status: "pending" }),
    ]);

    const result = await generateAllImages("p_1");

    expect(result).toEqual({ generated: 1, failed: 0, skipped: 2, reclaimed: 0 });
    // Only the pending scene fires fal — chained through /edit against the
    // already-generated anchor's image.
    expect(falMocks.generateImage).not.toHaveBeenCalled();
    expect(falMocks.editImage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ imageUrls: ["https://blob.example/existing-1.jpg"] })
    );
  });

  it("force=true re-generates everything: anchor via text-to-image, siblings chained via /edit", async () => {
    dbMocks.selectScenesByProject.mockResolvedValue([
      {
        ...fakeScene({ id: "s_1", order: 1, status: "approved" }),
        imageUrl: "https://blob.example/old-1.jpg",
      },
      {
        ...fakeScene({ id: "s_2", order: 2, status: "generated" }),
        imageUrl: "https://blob.example/old-2.jpg",
      },
    ]);

    const result = await generateAllImages("p_1", { force: true });

    expect(result).toEqual({ generated: 2, failed: 0, skipped: 0, reclaimed: 0 });
    expect(falMocks.generateImage).toHaveBeenCalledTimes(1);
    expect(falMocks.editImage).toHaveBeenCalledTimes(1);
    // Both outgoing renders are snapshotted into the variant history before
    // the overwrite lands.
    expect(dbMocks.insertSceneVersion).toHaveBeenCalledTimes(2);
  });

  it("re-generates rejected scenes by default", async () => {
    dbMocks.selectScenesByProject.mockResolvedValue([
      fakeScene({ id: "s_1", order: 1, status: "rejected" }),
    ]);

    const result = await generateAllImages("p_1");

    expect(result).toEqual({ generated: 1, failed: 0, skipped: 0, reclaimed: 0 });
  });

  it("marks individual scenes failed without poisoning the rest, ends at ready (lock released)", async () => {
    // s_1 (anchor, t2i) succeeds; s_2 (chained /edit) fails on the fal call —
    // including the automatic retry pass. One failure doesn't cascade.
    falMocks.editImage.mockRejectedValue(new Error("rate limited"));

    const result = await generateAllImages("p_1", { concurrency: 1 });

    expect(result).toEqual({ generated: 1, failed: 1, skipped: 0, reclaimed: 0 });
    expect(dbMocks.markSceneGenerated).toHaveBeenCalledTimes(1);
    expect(dbMocks.markSceneFailed).toHaveBeenCalledWith("s_2", "rate limited");
    expect(dbMocks.updateProjectStatus.mock.calls.map((c) => c[1])).toEqual(["ready"]);
  });

  it("automatically retries the failed subset once before leaving scenes rejected", async () => {
    // s_2's chained /edit fails once, then succeeds on the retry pass.
    falMocks.editImage
      .mockRejectedValueOnce(new Error("transient hiccup"))
      .mockResolvedValueOnce({ images: [{ url: "https://fal.media/retry-ok.jpg" }], requestId: "req_retry" });

    const result = await generateAllImages("p_1", { concurrency: 1 });

    expect(result).toEqual({ generated: 2, failed: 0, skipped: 0, reclaimed: 0 });
    expect(falMocks.editImage).toHaveBeenCalledTimes(2);
  });

  it("one scene failing doesn't abort the rest — every scene is independent now", async () => {
    // Reverse: s_1 fails, s_2 succeeds. With no anchor dependency, s_2 still runs.
    falMocks.generateImage
      .mockRejectedValueOnce(new Error("first one exploded"))
      .mockResolvedValueOnce({ images: [{ url: "https://fal.media/ok.jpg" }], requestId: "req_ok" });

    const result = await generateAllImages("p_1", { concurrency: 1 });

    expect(result).toEqual({ generated: 1, failed: 1, skipped: 0, reclaimed: 0 });
    expect(dbMocks.markSceneGenerated).toHaveBeenCalledExactlyOnceWith(
      "s_2",
      expect.any(Object)
    );
    expect(dbMocks.markSceneFailed).toHaveBeenCalledExactlyOnceWith(
      "s_1",
      "first one exploded"
    );
    expect(dbMocks.updateProjectStatus.mock.calls.map((c) => c[1])).toEqual(["ready"]);
  });

  it("first-time generation of a pending scene does NOT invalidate animation (no prior image)", async () => {
    dbMocks.selectScenesByProject.mockResolvedValue([
      // Pending scene with no prior imageUrl — first-time generation.
      { ...fakeScene({ id: "s_1", order: 1, status: "pending" }), imageUrl: null },
    ]);

    await generateAllImages("p_1");

    expect(dbMocks.markSceneGenerated).toHaveBeenCalledWith(
      "s_1",
      expect.objectContaining({ invalidateAnimation: false })
    );
  });

  it("re-generating a scene that already had an image DOES invalidate animation", async () => {
    dbMocks.selectScenesByProject.mockResolvedValue([
      // Already-generated scene, force=true triggers re-gen.
      {
        ...fakeScene({ id: "s_1", order: 1, status: "generated" }),
        imageUrl: "https://blob.example/old.jpg",
      },
    ]);

    await generateAllImages("p_1", { force: true });

    expect(dbMocks.markSceneGenerated).toHaveBeenCalledWith(
      "s_1",
      expect.objectContaining({ invalidateAnimation: true })
    );
  });

  it("treats fal returning no url as a per-scene failure", async () => {
    falMocks.generateImage.mockResolvedValue({ images: [{ url: undefined }], requestId: "r" });

    const result = await generateAllImages("p_1");

    // Both scenes hit the same no-url response → both fail individually.
    expect(result.failed).toBe(2);
    expect(dbMocks.markSceneFailed).toHaveBeenCalledWith("s_1", expect.stringMatching(/no image url/));
    expect(dbMocks.markSceneFailed).toHaveBeenCalledWith("s_2", expect.stringMatching(/no image url/));
  });

  it("uses opts.aspectRatio override when provided", async () => {
    await generateAllImages("p_1", { aspectRatio: "9:16" });

    expect(falMocks.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ aspectRatio: "9:16" })
    );
  });

  it("derives aspect ratio from project format when not overridden", async () => {
    dbMocks.selectProjectById.mockResolvedValue({ id: "p_1", format: "reel", worldType: "interior", status: "scripting" });

    await generateAllImages("p_1");

    expect(falMocks.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ aspectRatio: "9:16" })
    );
  });

  it("throws ProjectBusyError when the lock is already held", async () => {
    dbMocks.tryAcquireGenerationLock.mockResolvedValue(false);

    await expect(generateAllImages("p_1")).rejects.toBeInstanceOf(ProjectBusyError);

    // No work should happen if we don't get the lock.
    expect(dbMocks.resetOrphanedScenes).not.toHaveBeenCalled();
    expect(falMocks.generateImage).not.toHaveBeenCalled();
    expect(dbMocks.updateProjectStatus).not.toHaveBeenCalled();
  });

  it("acquires the lock, resets orphaned scenes, and reports the reclaimed count", async () => {
    dbMocks.resetOrphanedScenes.mockResolvedValue(3); // 3 scenes were stuck in 'generating'

    const result = await generateAllImages("p_1");

    expect(dbMocks.tryAcquireGenerationLock).toHaveBeenCalledWith("p_1");
    expect(dbMocks.resetOrphanedScenes).toHaveBeenCalledWith("p_1");
    expect(result.reclaimed).toBe(3);
  });

  it("performs lock + reset BEFORE reading the scene list (so reclaimed scenes are visible)", async () => {
    const callOrder: string[] = [];
    dbMocks.tryAcquireGenerationLock.mockImplementation(async () => {
      callOrder.push("lock");
      return true;
    });
    dbMocks.resetOrphanedScenes.mockImplementation(async () => {
      callOrder.push("reset");
      return 0;
    });
    dbMocks.selectScenesByProject.mockImplementation(async () => {
      callOrder.push("select");
      return [];
    });

    await generateAllImages("p_1");

    expect(callOrder).toEqual(["lock", "reset", "select"]);
  });

  it("releases the lock (status -> scripting) on unexpected internal error so a retry is possible", async () => {
    // Simulate an unexpected DB error after lock acquired (different from per-scene fal errors).
    dbMocks.selectScenesByProject.mockRejectedValue(new Error("DB went away"));

    await expect(generateAllImages("p_1")).rejects.toThrow(/DB went away/);

    expect(dbMocks.updateProjectStatus).toHaveBeenCalledWith("p_1", "scripting");
  });
});

describe("applySceneAction", () => {
  beforeEach(() => {
    dbMocks.selectSceneById.mockResolvedValue(fakeScene({ id: "s_1" }));
    dbMocks.selectProjectById.mockResolvedValue({ id: "p_1", format: "reel", worldType: "interior", status: "ready" });
    falMocks.generateImage.mockResolvedValue({
      images: [{ url: "https://fal.media/regen.jpg" }],
      requestId: "req_regen",
    });
    storageMocks.storeFromUrl.mockResolvedValue({
      url: "https://blob.vercel-storage.com/images/p_1/regen.jpg",
      pathname: "images/p_1/regen.jpg",
    });
  });

  it("approve: marks scene approved", async () => {
    await applySceneAction("p_1", "s_1", "approve");
    expect(dbMocks.markSceneApproved).toHaveBeenCalledWith("s_1");
    expect(dbMocks.markSceneRejected).not.toHaveBeenCalled();
    expect(falMocks.generateImage).not.toHaveBeenCalled();
  });

  it("reject: marks scene rejected without regenerating", async () => {
    await applySceneAction("p_1", "s_1", "reject");
    expect(dbMocks.markSceneRejected).toHaveBeenCalledWith("s_1");
    expect(falMocks.generateImage).not.toHaveBeenCalled();
  });

  it("regenerate: calls fal, saves new image, marks generated", async () => {
    await applySceneAction("p_1", "s_1", "regenerate");

    expect(dbMocks.markSceneGenerating).toHaveBeenCalledWith("s_1");
    expect(falMocks.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ aspectRatio: "9:16" })
    );
    expect(storageMocks.storeFromUrl).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "images", projectId: "p_1" })
    );
    expect(dbMocks.markSceneGenerated).toHaveBeenCalledWith(
      "s_1",
      expect.objectContaining({
        imageUrl: "https://blob.vercel-storage.com/images/p_1/regen.jpg",
        falRequestId: "req_regen",
        // Per-scene regen always invalidates the existing animation so a
        // refreshed still doesn't ship a video animated from the old one.
        invalidateAnimation: true,
      })
    );
  });

  it("regenerate: derives aspect ratio from project format", async () => {
    dbMocks.selectProjectById.mockResolvedValue({ id: "p_1", format: "reel", worldType: "interior", status: "ready" });

    await applySceneAction("p_1", "s_1", "regenerate");

    expect(falMocks.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ aspectRatio: "9:16" })
    );
  });

  it("regenerate: reel/carousel scene (no referenceImageUrl) uses text-to-image", async () => {
    // Default fakeScene has no referenceImageUrl → reel/carousel path.
    await applySceneAction("p_1", "s_1", "regenerate");

    expect(falMocks.generateImage).toHaveBeenCalled();
    expect(falMocks.editImage).not.toHaveBeenCalled();
  });

  it("regenerate: designDirection layers on top of the stored prompt for the fal call (does NOT mutate the stored prompt)", async () => {
    dbMocks.selectSceneById.mockResolvedValue(
      fakeScene({ id: "s_1", prompt: "A Mallorcan kitchen with terracotta floors and indigo linen." }),
    );

    await applySceneAction("p_1", "s_1", "regenerate", {
      designDirection: "tighter on the kitchen counter, shift to morning light",
    });

    expect(falMocks.generateImage).toHaveBeenCalledTimes(1);
    const call = falMocks.generateImage.mock.calls[0][0];
    expect(call.prompt).toContain("A Mallorcan kitchen with terracotta floors and indigo linen.");
    expect(call.prompt).toContain("tighter on the kitchen counter, shift to morning light");
    expect(call.prompt).toMatch(/apply on top|keep the same materials/i);
    // The stored prompt on the scene row is untouched — markSceneGenerated
    // doesn't receive a prompt field, so the direction is one-shot only.
    const persistedCall = dbMocks.markSceneGenerated.mock.calls[0][1];
    expect(persistedCall).not.toHaveProperty("prompt");
  });

  it("regenerate: empty/whitespace designDirection falls back to blind reroll (no augmentation)", async () => {
    dbMocks.selectSceneById.mockResolvedValue(
      fakeScene({ id: "s_1", prompt: "Original prompt text." }),
    );

    await applySceneAction("p_1", "s_1", "regenerate", { designDirection: "   " });

    const call = falMocks.generateImage.mock.calls[0][0];
    expect(call.prompt).toBe("Original prompt text.");
    expect(call.prompt).not.toMatch(/Additional direction/i);
  });

  it("regenerate: before-after path also respects designDirection (edit endpoint receives the augmented prompt)", async () => {
    dbMocks.selectSceneById.mockResolvedValue({
      ...fakeScene({
        id: "s_2",
        order: 2,
        prompt: "Add walnut cabinets and terrazzo to the kitchen.",
      }),
      referenceImageUrl: "https://blob.example/upload-before.jpg",
    });
    falMocks.editImage.mockResolvedValue({
      images: [{ url: "https://fal.media/edit-regen.jpg" }],
      requestId: "req_edit_regen",
    });

    await applySceneAction("p_1", "s_2", "regenerate", {
      designDirection: "warmer, softer afternoon light",
    });

    expect(falMocks.editImage).toHaveBeenCalledTimes(1);
    const call = falMocks.editImage.mock.calls[0][0];
    expect(call.prompt).toContain("Add walnut cabinets and terrazzo to the kitchen.");
    expect(call.prompt).toContain("warmer, softer afternoon light");
  });

  it("regenerate: before-after 'after' scene re-uses its frozen upload via /edit", async () => {
    // Before-after's after-scene has referenceImageUrl pinned to the
    // operator's upload. Per-scene regen must re-pass that same URL.
    dbMocks.selectSceneById.mockResolvedValue({
      ...fakeScene({ id: "s_2", order: 2 }),
      referenceImageUrl: "https://blob.example/upload-before.jpg",
    });
    falMocks.editImage.mockResolvedValue({
      images: [{ url: "https://fal.media/edit-regen.jpg" }],
      requestId: "req_edit_regen",
    });

    await applySceneAction("p_1", "s_2", "regenerate");

    expect(falMocks.generateImage).not.toHaveBeenCalled();
    expect(falMocks.editImage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        imageUrls: ["https://blob.example/upload-before.jpg"],
        aspectRatio: "9:16",
      })
    );
  });

  it("regenerate: marks failed and re-throws when fal returns no url", async () => {
    falMocks.generateImage.mockResolvedValue({ images: [{ url: undefined }], requestId: "r" });

    await expect(applySceneAction("p_1", "s_1", "regenerate")).rejects.toThrow(/no image url/);

    expect(dbMocks.markSceneFailed).toHaveBeenCalledWith("s_1", expect.stringMatching(/no image url/));
    expect(dbMocks.markSceneGenerated).not.toHaveBeenCalled();
  });

  it("throws when scene does not exist", async () => {
    dbMocks.selectSceneById.mockResolvedValue(null);

    await expect(applySceneAction("p_1", "missing", "approve")).rejects.toThrow(/not found/);
  });

  it("throws when scene belongs to a different project", async () => {
    dbMocks.selectSceneById.mockResolvedValue(fakeScene({ id: "s_1" }));
    // fakeScene defaults projectId to "p_1"; pass a different id to trigger the guard.
    await expect(applySceneAction("other", "s_1", "approve")).rejects.toThrow(
      /does not belong/
    );

    expect(dbMocks.markSceneApproved).not.toHaveBeenCalled();
  });

  it("returns the refreshed scene row", async () => {
    dbMocks.selectSceneById
      .mockResolvedValueOnce(fakeScene({ id: "s_1", status: "generated" }))
      .mockResolvedValueOnce(fakeScene({ id: "s_1", status: "approved" }));

    const out = await applySceneAction("p_1", "s_1", "approve");

    expect(out.status).toBe("approved");
  });
});

describe("finalizeProject", () => {
  const concept = {
    workingTitle: "Sunlit Brazilian Modernism",
    hook: "Calm afternoons through travertine and palm shadow.",
    vibe: "1960s Brazilian modernist houses.",
    notes: "Eye-level.",
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

  // Reel variant — every project is reel-or-carousel now. {APP_LINK} lives
  // in shortsDescription + pinnedComment per substituteAppLink's reel branch.
  const metadata = {
    kind: "reel" as const,
    tiktokCaption: "Travertine and palm shadow at the slow end of an afternoon.",
    tiktokHashtags: ["architecture", "brazilianmodernism", "calm"],
    instagramCaption:
      "Travertine and palm shadow at the slow end of an afternoon.\nThe quiet half-hour.",
    instagramHashtags: ["architecture", "brazilianmodernism", "interiordesign", "aesthetic"],
    shortsTitle: "Brazilian Modernist Afternoon — Travertine and Palm Shadow",
    shortsDescription: "Late-afternoon light through travertine and palm shadow.",
    shortsHashtags: ["architecture", "brazilianmodernism"],
    pinnedComment: "Sketched in ArchitectGPT — link's here {APP_LINK}.",
  };

  function generatedScene(overrides: Partial<{ id: string; order: number }> = {}) {
    return fakeScene({ ...overrides, status: "generated" });
  }

  beforeEach(() => {
    // getProjectWithScenes is implemented via these two mocks in our module.
    dbMocks.selectProjectById.mockResolvedValue({
      id: "p_1",
      title: "T",
      niche: "modernist living rooms",
      format: "reel", worldType: "interior",
      status: "ready",
      targetDurationSec: 150,
      concept,
    });
    dbMocks.selectScenesByProject.mockResolvedValue([
      { ...generatedScene({ id: "s_1", order: 1 }), imageUrl: "https://blob.vercel-storage.com/images/p_1/s1.jpg" },
      { ...generatedScene({ id: "s_2", order: 2 }), imageUrl: "https://blob.vercel-storage.com/images/p_1/s2.jpg" },
    ]);
    claudeMocks.generateMetadata.mockResolvedValue(metadata);
  });

  it("happy path: metadata → markProjectFinalized (no fal thumbnail call — deprecated)", async () => {
    const out = await finalizeProject("p_1");

    expect(claudeMocks.generateMetadata).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sceneCount: 2,
        totalDurationSec: 10,
        format: "reel",
        niche: "modernist living rooms",
      })
    );
    expect(dbMocks.markProjectFinalized).toHaveBeenCalledOnce();
    const persistedCall = dbMocks.markProjectFinalized.mock.calls[0];
    expect(persistedCall[0]).toBe("p_1");
    expect(persistedCall[1].metadata.kind).toBe("reel");
    // No thumbnailUrl on the persisted call — covers derive live from scenes.
    expect(persistedCall[1]).not.toHaveProperty("thumbnailUrl");
    expect(out.metadata.kind).toBe("reel");
  });

  it("acquires the finalization lock and refuses concurrent finalize calls", async () => {
    dbMocks.tryAcquireFinalizationLock.mockResolvedValueOnce(false);

    await expect(finalizeProject("p_1")).rejects.toBeInstanceOf(ProjectBusyError);

    expect(claudeMocks.generateMetadata).not.toHaveBeenCalled();
    expect(dbMocks.markProjectFinalized).not.toHaveBeenCalled();
  });

  it("calls metadata BEFORE markProjectFinalized", async () => {
    const order: string[] = [];
    claudeMocks.generateMetadata.mockImplementation(async () => {
      order.push("metadata");
      return metadata;
    });
    dbMocks.markProjectFinalized.mockImplementation(async () => {
      order.push("finalize");
    });

    await finalizeProject("p_1");

    expect(order).toEqual(["metadata", "finalize"]);
  });

  it("substitutes {APP_LINK} with the operator's resolved app URL", async () => {
    operatorMocks.pickAppLink.mockReturnValue("https://architectgpt.example/r/foo");

    claudeMocks.generateMetadata.mockResolvedValue({
      ...metadata,
      shortsDescription: `Hook line.\n\nTry it: {APP_LINK} — pinned link below.`,
      pinnedComment: `Sketched in ArchitectGPT — {APP_LINK}`,
    });
    dbMocks.selectProjectById.mockResolvedValue({
      id: "p_1",
      title: "T",
      niche: "modernist exteriors",
      format: "reel", worldType: "interior",
      status: "ready",
      targetDurationSec: 150,
      concept,
    });

    await finalizeProject("p_1");

    const persisted = dbMocks.markProjectFinalized.mock.calls[0][1];
    expect(persisted.metadata.shortsDescription).toContain("https://architectgpt.example/r/foo");
    expect(persisted.metadata.shortsDescription).not.toContain("{APP_LINK}");
    expect(persisted.metadata.pinnedComment).toContain("https://architectgpt.example/r/foo");
    // Routing is delegated entirely to operators.pickAppLink — confirmed it was called with the niche.
    expect(operatorMocks.pickAppLink).toHaveBeenCalledWith(
      operatorMocks.fixture,
      "modernist exteriors"
    );
  });

  it("substitutes {APP_LINK} in the carousel/before-after caption (defensive — leaving the literal placeholder in published copy is the worst outcome)", async () => {
    operatorMocks.pickAppLink.mockReturnValue("https://architectgpt.example/r/baz");

    // Carousel/before-after metadata shape: just instagramCaption + instagramHashtags.
    claudeMocks.generateMetadata.mockResolvedValue({
      kind: "carousel" as const,
      instagramCaption:
        "The same house, just finished — trim resolved, siding settled. Reimagine your own exterior at {APP_LINK}.",
      instagramHashtags: ["architecture", "architect", "architectura", "exterior", "renovation"],
    });
    dbMocks.selectProjectById.mockResolvedValue({
      id: "p_1",
      title: "T",
      niche: "exterior facade refresh",
      format: "before-after",
      worldType: "exterior",
      status: "ready",
      targetDurationSec: 14,
      concept,
    });

    await finalizeProject("p_1");

    const persisted = dbMocks.markProjectFinalized.mock.calls[0][1];
    expect(persisted.metadata.instagramCaption).toContain("https://architectgpt.example/r/baz");
    expect(persisted.metadata.instagramCaption).not.toContain("{APP_LINK}");
  });

  it("appends @handle to every caption (TikTok, IG, Shorts)", async () => {
    // Operator's first app determines the handle.
    operatorMocks.currentOperator.mockReturnValueOnce({
      ...operatorMocks.fixture,
      apps: [
        { name: "ArchitectGPT", url: "", handle: "architectgpt" },
      ],
    });

    await finalizeProject("p_1");

    const persisted = dbMocks.markProjectFinalized.mock.calls[0][1];
    expect(persisted.metadata.tiktokCaption).toMatch(/@architectgpt$/);
    expect(persisted.metadata.instagramCaption).toMatch(/@architectgpt$/);
    expect(persisted.metadata.shortsDescription).toMatch(/@architectgpt$/);
    // Pinned comment uses the {APP_LINK} flow, not @handle suffix.
    expect(persisted.metadata.pinnedComment).not.toMatch(/@architectgpt/);
  });

  it("enforces locked hashtags per worldType (interior gets interiordesign + interiors)", async () => {
    // Override GPT-5.5's response: imagine it forgot the locks entirely.
    claudeMocks.generateMetadata.mockResolvedValue({
      ...metadata,
      tiktokHashtags: ["brazilianmodernism", "travertine", "calm"],
      instagramHashtags: ["brazilianmodernism", "travertine", "calm", "aesthetic"],
    });

    await finalizeProject("p_1");

    const persisted = dbMocks.markProjectFinalized.mock.calls[0][1];
    // Locks prepended, total still 5 (or fewer if GPT-5.5 under-returned).
    expect(persisted.metadata.tiktokHashtags.slice(0, 2)).toEqual([
      "interiordesign",
      "interiors",
    ]);
    expect(persisted.metadata.tiktokHashtags).toHaveLength(5);
    expect(persisted.metadata.tiktokHashtags).toContain("brazilianmodernism");

    expect(persisted.metadata.instagramHashtags.slice(0, 2)).toEqual([
      "interiordesign",
      "interiors",
    ]);
    expect(persisted.metadata.instagramHashtags).toHaveLength(5);
  });

  it("dedups locks if GPT-5.5 already returned them — total stays at 5", async () => {
    claudeMocks.generateMetadata.mockResolvedValue({
      ...metadata,
      // GPT-5.5 obeyed the rule and included the locks; we shouldn't duplicate.
      tiktokHashtags: ["interiordesign", "interiors", "brazilian", "travertine", "calm"],
      instagramHashtags: ["interiors", "interiordesign", "brazilian", "travertine", "calm"],
    });

    await finalizeProject("p_1");

    const persisted = dbMocks.markProjectFinalized.mock.calls[0][1];
    expect(persisted.metadata.tiktokHashtags).toHaveLength(5);
    // Locks come first; GPT-5.5's variable picks fill the rest.
    expect(persisted.metadata.tiktokHashtags.filter((t: string) => t === "interiordesign")).toHaveLength(1);
    expect(persisted.metadata.tiktokHashtags.filter((t: string) => t === "interiors")).toHaveLength(1);
  });

  it("exterior locks → architecture + architect + architectura, only 2 design slots", async () => {
    dbMocks.selectProjectById.mockResolvedValue({
      id: "p_1",
      title: "T",
      niche: "modernist exteriors",
      format: "reel",
      worldType: "exterior",
      status: "ready",
      targetDurationSec: 150,
      concept,
    });
    claudeMocks.generateMetadata.mockResolvedValue({
      ...metadata,
      tiktokHashtags: ["brazilian", "travertine", "facade", "calm", "modernism"],
    });

    await finalizeProject("p_1");

    const persisted = dbMocks.markProjectFinalized.mock.calls[0][1];
    expect(persisted.metadata.tiktokHashtags.slice(0, 3)).toEqual([
      "architecture",
      "architect",
      "architectura",
    ]);
    expect(persisted.metadata.tiktokHashtags).toHaveLength(5);
  });

  it("leaves {APP_LINK} placeholder intact when pickAppLink returns empty", async () => {
    operatorMocks.pickAppLink.mockReturnValue("");

    claudeMocks.generateMetadata.mockResolvedValue({
      ...metadata,
      shortsDescription: "Try {APP_LINK} please.",
      pinnedComment: "x {APP_LINK} y",
    });

    await finalizeProject("p_1");

    const persisted = dbMocks.markProjectFinalized.mock.calls[0][1];
    expect(persisted.metadata.shortsDescription).toContain("{APP_LINK}");
    expect(persisted.metadata.pinnedComment).toContain("{APP_LINK}");
  });

  it("carousel: same flow, no special-casing now that ffmpeg is gone", async () => {
    dbMocks.selectProjectById.mockResolvedValue({
      id: "p_1",
      title: "T",
      niche: "x",
      format: "carousel",
      worldType: "interior",
      status: "ready",
      targetDurationSec: 0,
      concept,
    });

    const out = await finalizeProject("p_1");

    expect(out.metadata.kind).toBe("reel"); // metadata comes from the fixture
    expect(dbMocks.markProjectFinalized).toHaveBeenCalledOnce();
  });

  it("throws when the project does not exist", async () => {
    dbMocks.selectProjectById.mockResolvedValue(null);

    await expect(finalizeProject("nope")).rejects.toThrow(/not found/);
    expect(claudeMocks.generateMetadata).not.toHaveBeenCalled();
  });

  it("throws when the project has no concept", async () => {
    dbMocks.selectProjectById.mockResolvedValue({
      id: "p_1",
      format: "reel", worldType: "interior",
      status: "ready",
      concept: null,
      niche: "x",
      title: "T",
    });

    await expect(finalizeProject("p_1")).rejects.toThrow(/no concept/i);
  });

  it("throws when no scenes have been generated", async () => {
    dbMocks.selectScenesByProject.mockResolvedValue([
      { ...fakeScene({ id: "s_1", status: "pending" }), imageUrl: null },
    ]);

    await expect(finalizeProject("p_1")).rejects.toThrow(/no generated scenes/i);
  });

  it("throws when some scenes are still pending", async () => {
    dbMocks.selectScenesByProject.mockResolvedValue([
      { ...generatedScene({ id: "s_1", order: 1 }), imageUrl: "https://blob.vercel-storage.com/images/p_1/s1.jpg" },
      { ...fakeScene({ id: "s_2", order: 2, status: "pending" }), imageUrl: null },
    ]);

    await expect(finalizeProject("p_1")).rejects.toThrow(/not yet generated/);
    expect(claudeMocks.generateMetadata).not.toHaveBeenCalled();
  });
});

describe("stitchFinalVideo", () => {
  function reelWithVideos() {
    dbMocks.selectProjectById.mockResolvedValue({
      id: "p_1",
      format: "reel",
      worldType: "interior",
      status: "ready",
      quality: "standard",
    });
    dbMocks.selectScenesByProject.mockResolvedValue([
      { ...fakeScene({ id: "s_2", order: 2 }), videoUrl: "https://blob/v2.mp4", durationSec: 5 },
      { ...fakeScene({ id: "s_1", order: 1 }), videoUrl: "https://blob/v1.mp4", durationSec: 5 },
      { ...fakeScene({ id: "s_3", order: 3 }), videoUrl: "https://blob/v3.mp4", durationSec: 5 },
    ]);
    storageMocks.storeFromUrl.mockResolvedValue({
      url: "https://blob.vercel-storage.com/videos/p_1/final.mp4",
      pathname: "videos/p_1/final.mp4",
    });
  }

  it("reel: concatenates clips in scene order on one video track and persists the re-hosted URL", async () => {
    reelWithVideos();

    const out = await stitchFinalVideo("p_1");

    expect(out.finalVideoUrl).toBe("https://blob.vercel-storage.com/videos/p_1/final.mp4");
    const tracks = composeMocks.composeVideo.mock.calls[0][0];
    expect(tracks).toHaveLength(1); // no music → native per-clip audio rides along
    expect(tracks[0].type).toBe("video");
    expect(tracks[0].keyframes).toEqual([
      { timestamp: 0, duration: 5000, url: "https://blob/v1.mp4" },
      { timestamp: 5000, duration: 5000, url: "https://blob/v2.mp4" },
      { timestamp: 10000, duration: 5000, url: "https://blob/v3.mp4" },
    ]);
    expect(dbMocks.markProjectFinalVideo).toHaveBeenCalledWith(
      "p_1",
      "https://blob.vercel-storage.com/videos/p_1/final.mp4"
    );
  });

  it("adds a full-length music track when musicUrl is provided (replaces per-clip ambient)", async () => {
    reelWithVideos();

    await stitchFinalVideo("p_1", { musicUrl: "https://blob/music.mp3" });

    const tracks = composeMocks.composeVideo.mock.calls[0][0];
    expect(tracks).toHaveLength(2);
    expect(tracks[1]).toEqual({
      id: "music",
      type: "audio",
      keyframes: [{ timestamp: 0, duration: 15000, url: "https://blob/music.mp3" }],
    });
  });

  it("refuses to stitch a reel with un-animated scenes", async () => {
    dbMocks.selectProjectById.mockResolvedValue({ id: "p_1", format: "reel", worldType: "interior", status: "ready" });
    dbMocks.selectScenesByProject.mockResolvedValue([
      { ...fakeScene({ id: "s_1", order: 1 }), videoUrl: "https://blob/v1.mp4" },
      { ...fakeScene({ id: "s_2", order: 2 }), videoUrl: null },
    ]);

    await expect(stitchFinalVideo("p_1")).rejects.toThrow(/not animated/);
    expect(composeMocks.composeVideo).not.toHaveBeenCalled();
  });

  it("before-after: holds the before still 2.5s then plays the morph, on a single video track", async () => {
    dbMocks.selectProjectById.mockResolvedValue({
      id: "p_1",
      format: "before-after",
      worldType: "interior",
      status: "ready",
    });
    dbMocks.selectScenesByProject.mockResolvedValue([
      {
        ...fakeScene({ id: "s_1", order: 1, status: "generated" }),
        imageUrl: "https://blob/before.jpg",
        referenceImageUrl: null,
        durationSec: 9,
      },
      {
        ...fakeScene({ id: "s_2", order: 2, status: "generated" }),
        imageUrl: "https://blob/after.jpg",
        referenceImageUrl: "https://blob/before.jpg",
        videoUrl: "https://blob/morph.mp4",
        durationSec: 9,
      },
    ]);
    storageMocks.storeFromUrl.mockResolvedValue({
      url: "https://blob.vercel-storage.com/videos/p_1/final.mp4",
      pathname: "videos/p_1/final.mp4",
    });

    await stitchFinalVideo("p_1");

    const tracks = composeMocks.composeVideo.mock.calls[0][0];
    // compose rejects multiple video tracks — the still must be a keyframe
    // INSIDE the single video track (verified against the live API).
    expect(tracks).toHaveLength(1);
    expect(tracks[0].keyframes).toEqual([
      { timestamp: 0, duration: 2500, url: "https://blob/before.jpg" },
      { timestamp: 2500, duration: 9000, url: "https://blob/morph.mp4" },
    ]);
  });

  it("before-after: refuses when the morph clip is missing", async () => {
    dbMocks.selectProjectById.mockResolvedValue({ id: "p_1", format: "before-after", worldType: "interior", status: "ready" });
    dbMocks.selectScenesByProject.mockResolvedValue([
      { ...fakeScene({ id: "s_1", order: 1, status: "generated" }), imageUrl: "https://blob/before.jpg" },
      {
        ...fakeScene({ id: "s_2", order: 2, status: "generated" }),
        imageUrl: "https://blob/after.jpg",
        referenceImageUrl: "https://blob/before.jpg",
        videoUrl: null,
      },
    ]);

    await expect(stitchFinalVideo("p_1")).rejects.toThrow(/Animate the after/);
  });

  it("rejects formats without an animated deliverable", async () => {
    dbMocks.selectProjectById.mockResolvedValue({ id: "p_1", format: "carousel", worldType: "interior", status: "ready" });
    dbMocks.selectScenesByProject.mockResolvedValue([]);

    await expect(stitchFinalVideo("p_1")).rejects.toThrow(/only available/);
  });
});

describe("stitchFinalVideo — style-explorer slideshow", () => {
  function styleExplorerReady() {
    dbMocks.selectProjectById.mockResolvedValue({
      id: "p_1",
      format: "style-explorer",
      worldType: "interior",
      status: "ready",
      aspectRatio: "16:9",
    });
    dbMocks.selectScenesByProject.mockResolvedValue([
      { ...fakeScene({ id: "s_1", order: 1, status: "generated" }), imageUrl: "https://blob/base.jpg", durationSec: 0 },
      { ...fakeScene({ id: "s_2", order: 2, status: "generated" }), imageUrl: "https://blob/style-a.jpg", durationSec: 0 },
      { ...fakeScene({ id: "s_3", order: 3, status: "approved" }), imageUrl: "https://blob/style-b.jpg", durationSec: 0 },
    ]);
    storageMocks.storeFromUrl.mockResolvedValue({
      url: "https://blob.vercel-storage.com/videos/p_1/final.mp4",
      pathname: "videos/p_1/final.mp4",
    });
  }

  it("holds every still for a uniform duration (Original first) — a stills+music YouTube long-form", async () => {
    styleExplorerReady();

    await stitchFinalVideo("p_1", { musicUrl: "https://blob/lofi.mp3", perStillSec: 5 });

    const tracks = composeMocks.composeVideo.mock.calls[0][0];
    // MUST be an image track: stills on a `video` track render ~1 frame each
    // (the "11-minute video of the base image" bug, live-confirmed 2026-07-23).
    expect(tracks[0].type).toBe("image");
    expect(tracks[0].keyframes).toEqual([
      { timestamp: 0, duration: 5000, url: "https://blob/base.jpg" },
      { timestamp: 5000, duration: 5000, url: "https://blob/style-a.jpg" },
      { timestamp: 10000, duration: 5000, url: "https://blob/style-b.jpg" },
    ]);
    // Music spans the full slideshow.
    expect(tracks[1].keyframes).toEqual([
      { timestamp: 0, duration: 15000, url: "https://blob/lofi.mp3" },
    ]);
  });

  it("defaults to 7s per still and clamps out-of-range values", async () => {
    styleExplorerReady();
    await stitchFinalVideo("p_1");
    expect(composeMocks.composeVideo.mock.calls[0][0][0].keyframes[1].timestamp).toBe(7000);

    composeMocks.composeVideo.mockClear();
    styleExplorerReady();
    await stitchFinalVideo("p_1", { perStillSec: 99 });
    expect(composeMocks.composeVideo.mock.calls[0][0][0].keyframes[1].timestamp).toBe(15000);
  });

  it("refuses when any style is not generated yet", async () => {
    dbMocks.selectProjectById.mockResolvedValue({ id: "p_1", format: "style-explorer", worldType: "interior", status: "ready" });
    dbMocks.selectScenesByProject.mockResolvedValue([
      { ...fakeScene({ id: "s_1", order: 1, status: "generated" }), imageUrl: "https://blob/base.jpg" },
      { ...fakeScene({ id: "s_2", order: 2, status: "pending" }), imageUrl: null },
    ]);

    await expect(stitchFinalVideo("p_1")).rejects.toThrow(/not generated/);
    expect(composeMocks.composeVideo).not.toHaveBeenCalled();
  });
});

describe("stitchFinalVideo — long-form looping + music tiling", () => {
  function threeStills() {
    dbMocks.selectProjectById.mockResolvedValue({
      id: "p_1",
      format: "style-explorer",
      worldType: "interior",
      status: "ready",
    });
    dbMocks.selectScenesByProject.mockResolvedValue([
      { ...fakeScene({ id: "s_1", order: 1, status: "generated" }), imageUrl: "https://blob/base.jpg" },
      { ...fakeScene({ id: "s_2", order: 2, status: "generated" }), imageUrl: "https://blob/a.jpg" },
      { ...fakeScene({ id: "s_3", order: 3, status: "generated" }), imageUrl: "https://blob/b.jpg" },
    ]);
    storageMocks.storeFromUrl.mockResolvedValue({
      url: "https://blob.vercel-storage.com/videos/p_1/final.mp4",
      pathname: "videos/p_1/final.mp4",
    });
  }

  it("loops whole cycles until the target length is reached (10 min from a 30s cycle → 20 cycles)", async () => {
    threeStills();

    await stitchFinalVideo("p_1", { perStillSec: 10, targetMinutes: 10 });

    const kf = composeMocks.composeVideo.mock.calls[0][0][0].keyframes;
    // 3 stills × 10s = 30s cycle; 10 min target → exactly 20 cycles = 60 keyframes.
    expect(kf).toHaveLength(60);
    expect(kf[0]).toEqual({ timestamp: 0, duration: 10000, url: "https://blob/base.jpg" });
    // Cycle two starts with the base again.
    expect(kf[3]).toEqual({ timestamp: 30000, duration: 10000, url: "https://blob/base.jpg" });
    // Ends on the last style, exactly at 10:00.
    const last = kf[kf.length - 1];
    expect(last.url).toBe("https://blob/b.jpg");
    expect(last.timestamp + last.duration).toBe(600000);
  });

  it("tiles the music bed across the timeline when the song is shorter, trimming the final tile", async () => {
    threeStills();

    // 90s video (3 stills × 10s × 3 cycles), 40s song → tiles at 0/40/80, last one 10s.
    await stitchFinalVideo("p_1", {
      perStillSec: 10,
      targetMinutes: 1, // 60s target → ceil(60/30) = 2 cycles... use 90s via targetMinutes 2
      musicUrl: "https://blob/song.mp3",
      musicDurationSec: 40,
    });

    const tracks = composeMocks.composeVideo.mock.calls[0][0];
    const music = tracks[1].keyframes;
    const videoEnd = tracks[0].keyframes.at(-1)!.timestamp + tracks[0].keyframes.at(-1)!.duration;
    // Tiles cover the timeline exactly with no gap and no overhang.
    expect(music[0].timestamp).toBe(0);
    for (let i = 1; i < music.length; i++) {
      expect(music[i].timestamp).toBe(music[i - 1].timestamp + music[i - 1].duration);
    }
    const musicEnd = music.at(-1)!.timestamp + music.at(-1)!.duration;
    expect(musicEnd).toBe(videoEnd);
    expect(music.every((k: { url: string }) => k.url === "https://blob/song.mp3")).toBe(true);
  });

  it("without targetMinutes a single pass is produced (backward-compatible)", async () => {
    threeStills();
    await stitchFinalVideo("p_1", { perStillSec: 7 });
    expect(composeMocks.composeVideo.mock.calls[0][0][0].keyframes).toHaveLength(3);
  });
});

describe("spend ledger + budget gate", () => {
  beforeEach(() => {
    dbMocks.selectProjectById.mockResolvedValue({ id: "p_1", format: "reel", worldType: "interior", status: "scripting", quality: "standard" });
    dbMocks.selectScenesByProject.mockResolvedValue([
      fakeScene({ id: "s_1", order: 1 }),
      fakeScene({ id: "s_2", order: 2 }),
    ]);
    falMocks.generateImage.mockResolvedValue({ images: [{ url: "https://fal.media/x.jpg" }], requestId: "r" });
    falMocks.editImage.mockResolvedValue({ images: [{ url: "https://fal.media/e.jpg" }], requestId: "r2" });
    storageMocks.storeFromUrl.mockResolvedValue({ url: "https://blob/x.jpg", pathname: "x" });
  });

  it("gates the image batch on the daily budget BEFORE any fal call, releasing the lock on rejection", async () => {
    spendMocks.assertWithinDailyBudget.mockRejectedValue(new Error("Daily budget reached"));

    await expect(generateAllImages("p_1")).rejects.toThrow(/Daily budget/);
    expect(falMocks.generateImage).not.toHaveBeenCalled();
    expect(falMocks.editImage).not.toHaveBeenCalled();
    expect(dbMocks.updateProjectStatus).toHaveBeenCalledWith("p_1", "scripting");
  });

  it("records one ledger event per successful render, typed t2i vs edit", async () => {
    await generateAllImages("p_1");

    const kinds = spendMocks.recordSpend.mock.calls.map((c) => c[0].kind).sort();
    expect(kinds).toEqual(["image", "image-edit"]); // anchor t2i + chained edit
    for (const call of spendMocks.recordSpend.mock.calls) {
      expect(call[0].projectId).toBe("p_1");
      expect(call[0].amountUsd).toBeGreaterThan(0);
    }
  });
});

describe("moodboard references", () => {
  it("createProject threads refs into the vision concept call and persists them", async () => {
    claudeMocks.generateConcept.mockResolvedValue(concept);
    claudeMocks.generateScenePrompts.mockResolvedValue({
      scenes: [{ order: 1, prompt: "A".repeat(220), durationSec: 5 }],
    });

    await createProject({
      niche: "wabi-sabi retreat",
      format: "reel",
      worldType: "interior",
      referenceImageUrls: ["https://blob/ref1.jpg", "https://blob/ref2.jpg"],
    });

    expect(claudeMocks.generateConcept).toHaveBeenCalledWith(
      expect.objectContaining({
        referenceImageUrls: ["https://blob/ref1.jpg", "https://blob/ref2.jpg"],
      })
    );
    expect(dbMocks.insertProject).toHaveBeenCalledWith(
      expect.objectContaining({
        referenceImageUrls: ["https://blob/ref1.jpg", "https://blob/ref2.jpg"],
      })
    );
  });

  it("generateAllImages conditions every render on the moodboard — anchor via /edit(refs), siblings via /edit(anchor + refs)", async () => {
    dbMocks.selectProjectById.mockResolvedValue({
      id: "p_1",
      format: "reel",
      worldType: "interior",
      status: "scripting",
      quality: "standard",
      referenceImageUrls: ["https://blob/ref1.jpg", "https://blob/ref2.jpg"],
    });
    dbMocks.selectScenesByProject.mockResolvedValue([
      fakeScene({ id: "s_1", order: 1 }),
      fakeScene({ id: "s_2", order: 2 }),
    ]);
    falMocks.editImage.mockResolvedValue({ images: [{ url: "https://fal.media/e.jpg" }], requestId: "r" });
    storageMocks.storeFromUrl.mockResolvedValue({ url: "https://blob/stored.jpg", pathname: "x" });

    await generateAllImages("p_1");

    // No text-to-image at all — the moodboard turns even the anchor into an edit.
    expect(falMocks.generateImage).not.toHaveBeenCalled();
    const [anchorCall, siblingCall] = falMocks.editImage.mock.calls;
    expect(anchorCall[0].imageUrls).toEqual(["https://blob/ref1.jpg", "https://blob/ref2.jpg"]);
    expect(anchorCall[0].prompt).toMatch(/moodboard/i);
    // Sibling: anchor leads (world lock), moodboard follows.
    expect(siblingCall[0].imageUrls).toEqual([
      "https://blob/stored.jpg",
      "https://blob/ref1.jpg",
      "https://blob/ref2.jpg",
    ]);
    expect(siblingCall[0].prompt).toMatch(/first attached image is the anchor/i);
  });
});

describe("applySceneAction set-motion", () => {
  beforeEach(() => {
    dbMocks.selectSceneById.mockResolvedValue(fakeScene({ id: "s_1" }));
  });

  it("locks a valid camera move on the scene", async () => {
    await applySceneAction("p_1", "s_1", "set-motion", { motionPreset: "orbit-left" });
    expect(dbMocks.setSceneMotionPreset).toHaveBeenCalledWith("s_1", "orbit-left");
  });

  it("clears the lock with null", async () => {
    await applySceneAction("p_1", "s_1", "set-motion", { motionPreset: null });
    expect(dbMocks.setSceneMotionPreset).toHaveBeenCalledWith("s_1", null);
  });

  it("rejects unknown camera moves", async () => {
    await expect(
      applySceneAction("p_1", "s_1", "set-motion", { motionPreset: "warp-drive" })
    ).rejects.toThrow(/Unknown camera move/);
    expect(dbMocks.setSceneMotionPreset).not.toHaveBeenCalled();
  });
});

describe("stitchFinalVideo — Shotstack backend (transitions)", () => {
  function reelReady() {
    dbMocks.selectProjectById.mockResolvedValue({
      id: "p_1", format: "reel", worldType: "interior", status: "ready", quality: "standard",
    });
    dbMocks.selectScenesByProject.mockResolvedValue([
      { ...fakeScene({ id: "s_1", order: 1 }), videoUrl: "https://blob/v1.mp4", durationSec: 5 },
      { ...fakeScene({ id: "s_2", order: 2 }), videoUrl: "https://blob/v2.mp4", durationSec: 5 },
      { ...fakeScene({ id: "s_3", order: 3 }), videoUrl: "https://blob/v3.mp4", durationSec: 5 },
    ]);
    storageMocks.storeFromUrl.mockResolvedValue({
      url: "https://blob.vercel-storage.com/videos/p_1/final.mp4", pathname: "x",
    });
  }

  it("reel: true crossfades — boundary starts, padded footage under each fade-in, full 15s kept", async () => {
    shotstackMocks.isShotstackConfigured.mockReturnValue(true);
    reelReady();

    await stitchFinalVideo("p_1");

    expect(composeMocks.composeVideo).not.toHaveBeenCalled();
    const edit = shotstackMocks.renderShotstack.mock.calls[0][0];
    const tracks = edit.timeline.tracks;
    // tracks[0] is TOPMOST → must hold the LAST clip so fade-ins blend over
    // the clip beneath.
    expect(tracks).toHaveLength(3);
    const [top, mid, bottom] = tracks.map((t: { clips: unknown[] }) => t.clips[0]) as Array<{
      start: number; length: number; transition?: { in?: string };
    }>;
    // Clips start ON their 5s boundaries; non-last clips play their 1s
    // footage pad under the next clip's fade-in; last trims to the end.
    expect(bottom.start).toBe(0);
    expect(bottom.length).toBe(6);
    expect(bottom.transition).toBeUndefined();
    expect(mid.start).toBe(5);
    expect(mid.length).toBe(6);
    expect(mid.transition).toEqual({ in: "fade" });
    expect(top.start).toBe(10);
    expect(top.length).toBe(5);
    expect(top.transition).toEqual({ in: "fade" });
    expect(edit.output.size).toEqual({ width: 1080, height: 1920 });
  });

  it("slideshow: alternating slow Ken Burns zoom on stills + fades", async () => {
    shotstackMocks.isShotstackConfigured.mockReturnValue(true);
    dbMocks.selectProjectById.mockResolvedValue({
      id: "p_1", format: "style-explorer", worldType: "interior", status: "ready", aspectRatio: "16:9",
    });
    dbMocks.selectScenesByProject.mockResolvedValue([
      { ...fakeScene({ id: "s_1", order: 1, status: "generated" }), imageUrl: "https://blob/base.jpg" },
      { ...fakeScene({ id: "s_2", order: 2, status: "generated" }), imageUrl: "https://blob/a.jpg" },
    ]);
    storageMocks.storeFromUrl.mockResolvedValue({ url: "https://blob/final.mp4", pathname: "x" });

    await stitchFinalVideo("p_1", { perStillSec: 5 });

    const tracks = shotstackMocks.renderShotstack.mock.calls[0][0].timeline.tracks;
    // Reversed order: tracks[1] = first still, tracks[0] = second still.
    const first = tracks[1].clips[0];
    const second = tracks[0].clips[0];
    expect(first.effect).toBe("zoomInSlow");
    expect(second.effect).toBe("zoomOutSlow");
    // Chapter-safe: still 2 fades in over [4s, 5s] and is fully visible at
    // exactly 5s (the chapter boundary); its hold extends by the overlap.
    expect(second.start).toBe(4);
    expect(second.length).toBe(6);
    expect(second.transition).toEqual({ in: "fade" });
  });

  it("music mutes the clips' own audio (Shotstack mixes; ours replaces) and tiles a short song", async () => {
    shotstackMocks.isShotstackConfigured.mockReturnValue(true);
    reelReady();

    await stitchFinalVideo("p_1", { musicUrl: "https://blob/song.mp3", musicDurationSec: 6 });

    const edit = shotstackMocks.renderShotstack.mock.calls[0][0];
    // 3 video tracks + 1 music track (bottom). All video clips muted.
    expect(edit.timeline.tracks).toHaveLength(4);
    for (const t of edit.timeline.tracks.slice(0, 3)) {
      expect(t.clips[0].asset.volume).toBe(0);
    }
    // Padded crossfade reel keeps the full 15s; 6s song → 6+6+3.
    const music = edit.timeline.tracks[3].clips;
    expect(music.map((c: { length: number }) => c.length)).toEqual([6, 6, 3]);
    expect(edit.timeline.soundtrack).toBeUndefined();
  });

  it("long-form: ONE Shotstack cycle (loop fades) concatenated + music via fal — vendor minutes don't scale with target length", async () => {
    shotstackMocks.isShotstackConfigured.mockReturnValue(true);
    shotstackMocks.renderShotstack.mockResolvedValue({ videoUrl: "https://shotstack.io/cycle.mp4" });
    dbMocks.selectProjectById.mockResolvedValue({
      id: "p_1", format: "style-explorer", worldType: "interior", status: "ready", aspectRatio: "16:9",
    });
    dbMocks.selectScenesByProject.mockResolvedValue([
      { ...fakeScene({ id: "s_1", order: 1, status: "generated" }), imageUrl: "https://blob/base.jpg" },
      { ...fakeScene({ id: "s_2", order: 2, status: "generated" }), imageUrl: "https://blob/a.jpg" },
      { ...fakeScene({ id: "s_3", order: 3, status: "generated" }), imageUrl: "https://blob/b.jpg" },
    ]);
    storageMocks.storeFromUrl.mockResolvedValue({ url: "https://blob/final.mp4", pathname: "x" });

    // 3 stills × 10s = 30s cycle; 10 min target → 20 cycles.
    await stitchFinalVideo("p_1", {
      perStillSec: 10,
      targetMinutes: 10,
      musicUrl: "https://blob/song.mp3",
      musicDurationSec: 40,
    });

    // Shotstack rendered the CYCLE only — 3 stills, not 60.
    expect(shotstackMocks.renderShotstack).toHaveBeenCalledOnce();
    const edit = shotstackMocks.renderShotstack.mock.calls[0][0];
    expect(edit.timeline.tracks).toHaveLength(3);
    // Loop fades: first clip (bottom track) fades in, last (top track) fades out.
    expect(edit.timeline.tracks[2].clips[0].transition).toEqual({ in: "fade" });
    expect(edit.timeline.tracks[0].clips[0].transition).toEqual({ in: "fade", out: "fade" });
    // Music does NOT ride the base — it would restart every cycle.
    expect(edit.timeline.soundtrack).toBeUndefined();

    // fal concats 20 copies of the rendered cycle and lays the tiled bed.
    const tracks = composeMocks.composeVideo.mock.calls[0][0];
    // Concat inputs are VIDEO clips (the rendered cycle), so the track stays
    // type:"video" — only all-stills timelines ride an image track.
    expect(tracks[0].type).toBe("video");
    const video = tracks[0].keyframes;
    expect(video).toHaveLength(20);
    expect(video.every((k: { url: string }) => k.url === "https://shotstack.io/cycle.mp4")).toBe(true);
    const last = video.at(-1)!;
    expect(last.timestamp + last.duration).toBe(600000);
    const music = tracks[1].keyframes;
    expect(music[0]).toEqual({ timestamp: 0, duration: 40000, url: "https://blob/song.mp3" });
    const musicEnd = music.at(-1)!.timestamp + music.at(-1)!.duration;
    expect(musicEnd).toBe(600000);

    // Spend: Shotstack billed for the 30s cycle, fal for the 10-min concat.
    const spends = spendMocks.recordSpend.mock.calls.map((c) => c[0]);
    const shotstackSpend = spends.find((s) => s.meta.backend === "shotstack");
    const falSpend = spends.find((s) => s.meta.backend === "fal");
    expect(shotstackSpend.amountUsd).toBeCloseTo((30 / 60) * 0.3);
    expect(shotstackSpend.meta.outputSec).toBe(30);
    expect(falSpend.meta.outputSec).toBe(600);
  });

  it("before-after: hard joint (no transitions, no Ken Burns) — the morph IS the transition", async () => {
    shotstackMocks.isShotstackConfigured.mockReturnValue(true);
    dbMocks.selectProjectById.mockResolvedValue({
      id: "p_1", format: "before-after", worldType: "interior", status: "ready", aspectRatio: "9:16",
    });
    dbMocks.selectScenesByProject.mockResolvedValue([
      { ...fakeScene({ id: "s_1", order: 1, status: "generated" }), imageUrl: "https://blob/before.jpg" },
      {
        ...fakeScene({ id: "s_2", order: 2, status: "generated" }),
        imageUrl: "https://blob/after.jpg",
        referenceImageUrl: "https://blob/before.jpg",
        videoUrl: "https://blob/morph.mp4",
        durationSec: 9,
      },
    ]);
    storageMocks.storeFromUrl.mockResolvedValue({ url: "https://blob/final.mp4", pathname: "x" });

    await stitchFinalVideo("p_1");

    const tracks = shotstackMocks.renderShotstack.mock.calls[0][0].timeline.tracks;
    // Reversed: tracks[1] = before still, tracks[0] = morph clip.
    const before = tracks[1].clips[0];
    const morph = tracks[0].clips[0];
    expect(before.transition).toBeUndefined();
    expect(before.effect).toBeUndefined();
    expect(morph.transition).toBeUndefined();
    expect(morph.start).toBe(2.5);
  });
});

describe("finalize auto-stitch", () => {
  function finalizableReel(withVideos: boolean) {
    dbMocks.selectProjectById.mockResolvedValue({
      id: "p_1",
      format: "reel",
      worldType: "interior",
      status: "ready",
      quality: "standard",
      finalVideoUrl: null,
      niche: "n",
      concept: { workingTitle: "T", hook: "h", vibe: "v", notes: "", objectSet: [] },
    });
    dbMocks.selectScenesByProject.mockResolvedValue([
      {
        ...fakeScene({ id: "s_1", order: 1, status: "generated" }),
        imageUrl: "https://blob/1.jpg",
        videoUrl: withVideos ? "https://blob/v1.mp4" : null,
      },
      {
        ...fakeScene({ id: "s_2", order: 2, status: "generated" }),
        imageUrl: "https://blob/2.jpg",
        videoUrl: withVideos ? "https://blob/v2.mp4" : null,
      },
    ]);
    claudeMocks.generateMetadata.mockResolvedValue({
      kind: "reel",
      tiktokCaption: "c", tiktokHashtags: ["a"],
      instagramCaption: "c", instagramHashtags: ["a"],
      shortsTitle: "A modern Kyoto apartment tour in golden light for design lovers",
      shortsDescription: "d".repeat(60), shortsHashtags: ["a"],
      pinnedComment: "p",
    });
    storageMocks.storeFromUrl.mockResolvedValue({ url: "https://blob/final.mp4", pathname: "x" });
  }

  it("finalizing a fully-animated reel flags autoStitch — it never renders inline (the route enqueues Inngest)", async () => {
    finalizableReel(true);

    const out = await finalizeProject("p_1");

    expect(out.autoStitch).toBe(true);
    expect(composeMocks.composeVideo).not.toHaveBeenCalled();
  });

  it("skips auto-stitch when clips aren't animated yet, and finalize still succeeds", async () => {
    finalizableReel(false);

    const out = await finalizeProject("p_1");

    expect(out.metadata).toBeTruthy();
    expect(out.autoStitch).toBe(false);
    expect(composeMocks.composeVideo).not.toHaveBeenCalled();
  });

  it("finalize succeeds regardless of stitch-backend health (render is deferred to Inngest)", async () => {
    finalizableReel(true);
    composeMocks.composeVideo.mockRejectedValue(new Error("compose down"));

    const out = await finalizeProject("p_1");

    expect(out.metadata).toBeTruthy();
    expect(out.autoStitch).toBe(true);
    expect(dbMocks.markProjectFinalized).toHaveBeenCalled();
  });
});
