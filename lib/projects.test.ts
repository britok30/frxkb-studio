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
}));

const claudeMocks = vi.hoisted(() => ({
  generateConcept: vi.fn(),
  generateScenePrompts: vi.fn(),
  generateMetadata: vi.fn(),
}));

const falMocks = vi.hoisted(() => ({
  generateImage: vi.fn(),
}));

const storageMocks = vi.hoisted(() => ({
  storeFromUrl: vi.fn(),
}));

const thumbnailMocks = vi.hoisted(() => ({ generateThumbnail: vi.fn() }));

// Default operator for all tests in this file. Individual tests can override
// the operator by re-mocking pickAppLink (used by substituteAppLink).
const operatorMocks = vi.hoisted(() => {
  const britok = {
    email: "britok30@gmail.com",
    falKey: "fk",
    anthropicKey: "ak",
    apps: [
      { name: "ArchitectGPT", url: "" },
      { name: "CasaGPT", url: "", pattern: /(interior|living)/ },
    ],
  };
  return {
    currentOperator: vi.fn(() => britok),
    pickAppLink: vi.fn((_op: unknown, _niche: string) => ""),
    fixture: britok,
  };
});

vi.mock("@/lib/projects-db", () => dbMocks);
vi.mock("@/lib/prompts/concept", () => ({ generateConcept: claudeMocks.generateConcept }));
vi.mock("@/lib/prompts/scenes", () => ({ generateScenePrompts: claudeMocks.generateScenePrompts }));
vi.mock("@/lib/prompts/metadata", () => ({ generateMetadata: claudeMocks.generateMetadata }));
vi.mock("@/lib/fal", () => ({ generateImage: falMocks.generateImage }));
vi.mock("@/lib/storage", () => ({ storeFromUrl: storageMocks.storeFromUrl }));
vi.mock("@/lib/thumbnail", () => ({ generateThumbnail: thumbnailMocks.generateThumbnail }));
vi.mock("@/lib/operators", () => ({
  currentOperator: operatorMocks.currentOperator,
  pickAppLink: operatorMocks.pickAppLink,
}));

const dedupeMocks = vi.hoisted(() => ({
  findSimilarProjects: vi.fn(),
}));
vi.mock("@/lib/world-dedupe", () => dedupeMocks);

import {
  applySceneAction,
  createProject,
  finalizeProject,
  generateAllImages,
  getProjectWithScenes,
  listProjects,
  ProjectBusyError,
} from "./projects";

const concept = {
  workingTitle: "Sunlit Brazilian Modernism",
  hook: "Calm afternoons through travertine and palm shadow.",
  vibe: "1960s Brazilian modernism, palm-filtered late afternoon light, travertine and terracotta.",
  notes: "Eye-level, never overcast.",
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
  Object.values(thumbnailMocks).forEach((m) => m.mockReset());
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
});

describe("createProject", () => {
  it("calls Claude for concept then scenes, inserts project + scene rows", async () => {
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
      format: "yt-long",
      sceneCount: 2,
      sceneDurationSec: 5,
    });

    // Both Claude calls must complete before any DB write — no orphan rows on LLM failure.
    expect(callOrder).toEqual(["concept", "scenes", "insertProject", "insertScenes"]);

    expect(claudeMocks.generateConcept).toHaveBeenCalledWith({
      niche: "modernist living rooms",
      format: "yt-long",
      targetDurationSec: 10,
      operatorNotes: undefined,
    });
    expect(claudeMocks.generateScenePrompts).toHaveBeenCalledWith({
      concept,
      aspectRatio: "16:9",
      sceneCount: 2,
      sceneDurationSec: 5,
    });
    expect(dbMocks.insertProject).toHaveBeenCalledOnce();
    const projInsert = dbMocks.insertProject.mock.calls[0][0];
    expect(projInsert.title).toBe("Sunlit Brazilian Modernism");
    expect(projInsert.format).toBe("yt-long");
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

  it("calls dedupe with concept's signature + keywords and propagates matches", async () => {
    claudeMocks.generateConcept.mockResolvedValue(concept);
    claudeMocks.generateScenePrompts.mockResolvedValue({
      scenes: [
        { order: 1, prompt: "long enough scene prompt with palm shadows under late afternoon light", durationSec: 5 },
      ],
    });
    const fakeMatch = {
      project: { id: "p_old", title: "Earlier Brazilian Modernism", niche: "x", format: "yt-long" as const, createdAt: new Date() },
      reason: "exact-signature" as const,
      confidence: 1,
    };
    dedupeMocks.findSimilarProjects.mockResolvedValue({
      hasMatches: true,
      matches: [fakeMatch],
    });

    const out = await createProject({ niche: "x", format: "yt-long", sceneCount: 1 });

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

    const out = await createProject({ niche: "x", format: "yt-long", sceneCount: 1 });

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

    await createProject({ niche: "x", format: "reel" });

    // Reel default: 5 × 3s = 15s.
    expect(claudeMocks.generateScenePrompts).toHaveBeenCalledWith(
      expect.objectContaining({
        aspectRatio: "9:16",
        sceneCount: 5,
        sceneDurationSec: 3,
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

    await createProject({ niche: "x", format: "yt-long", sceneCount: 999 });

    expect(claudeMocks.generateScenePrompts).toHaveBeenCalledWith(
      expect.objectContaining({ sceneCount: 120 })
    );
  });

  it("does not write any DB rows when scene prompt generation fails", async () => {
    claudeMocks.generateConcept.mockResolvedValue(concept);
    claudeMocks.generateScenePrompts.mockRejectedValue(new Error("Claude rate limited"));

    await expect(
      createProject({ niche: "x", format: "yt-long", sceneCount: 2 })
    ).rejects.toThrow(/rate limited/);

    expect(dbMocks.insertProject).not.toHaveBeenCalled();
    expect(dbMocks.insertScenes).not.toHaveBeenCalled();
  });

  it("does not write any DB rows when concept generation fails", async () => {
    claudeMocks.generateConcept.mockRejectedValue(new Error("Claude is down"));

    await expect(
      createProject({ niche: "x", format: "yt-long", sceneCount: 2 })
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

    await createProject({ niche: "x", format: "carousel", sceneCount: 1, sceneDurationSec: 0 });

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

describe("generateAllImages", () => {
  beforeEach(() => {
    dbMocks.selectProjectById.mockResolvedValue({ id: "p_1", format: "yt-long", status: "scripting" });
    dbMocks.selectScenesByProject.mockResolvedValue([
      fakeScene({ id: "s_1", order: 1 }),
      fakeScene({ id: "s_2", order: 2 }),
    ]);
    falMocks.generateImage.mockResolvedValue({
      images: [{ url: "https://fal.media/x.jpg" }],
      requestId: "req_1",
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

  it("generates images for pending scenes, marks them generated, sets project ready", async () => {
    const result = await generateAllImages("p_1");

    expect(result).toEqual({ generated: 2, failed: 0, skipped: 0, reclaimed: 0 });
    expect(falMocks.generateImage).toHaveBeenCalledTimes(2);
    expect(dbMocks.markSceneGenerating).toHaveBeenCalledTimes(2);
    expect(dbMocks.markSceneGenerated).toHaveBeenCalledTimes(2);
    expect(dbMocks.markSceneFailed).not.toHaveBeenCalled();
    // Lock acquire flips status to 'generating' atomically (tested separately);
    // the orchestration only updates status once at the end → 'ready'.
    expect(dbMocks.updateProjectStatus.mock.calls.map((c) => c[1])).toEqual(["ready"]);
  });

  it("skips scenes that are already generated or approved unless force=true", async () => {
    dbMocks.selectScenesByProject.mockResolvedValue([
      fakeScene({ id: "s_1", order: 1, status: "approved" }),
      fakeScene({ id: "s_2", order: 2, status: "generated" }),
      fakeScene({ id: "s_3", order: 3, status: "pending" }),
    ]);

    const result = await generateAllImages("p_1");

    expect(result).toEqual({ generated: 1, failed: 0, skipped: 2, reclaimed: 0 });
    expect(falMocks.generateImage).toHaveBeenCalledTimes(1);
  });

  it("force=true re-generates everything", async () => {
    dbMocks.selectScenesByProject.mockResolvedValue([
      fakeScene({ id: "s_1", order: 1, status: "approved" }),
      fakeScene({ id: "s_2", order: 2, status: "generated" }),
    ]);

    const result = await generateAllImages("p_1", { force: true });

    expect(result).toEqual({ generated: 2, failed: 0, skipped: 0, reclaimed: 0 });
  });

  it("re-generates rejected scenes by default", async () => {
    dbMocks.selectScenesByProject.mockResolvedValue([
      fakeScene({ id: "s_1", order: 1, status: "rejected" }),
    ]);

    const result = await generateAllImages("p_1");

    expect(result).toEqual({ generated: 1, failed: 0, skipped: 0, reclaimed: 0 });
  });

  it("marks individual scenes failed without poisoning the rest, ends at ready (lock released)", async () => {
    falMocks.generateImage
      .mockResolvedValueOnce({ images: [{ url: "https://fal.media/a.jpg" }], requestId: "r1" })
      .mockRejectedValueOnce(new Error("rate limited"));

    const result = await generateAllImages("p_1", { concurrency: 1 });

    expect(result).toEqual({ generated: 1, failed: 1, skipped: 0, reclaimed: 0 });
    expect(dbMocks.markSceneGenerated).toHaveBeenCalledTimes(1);
    expect(dbMocks.markSceneFailed).toHaveBeenCalledTimes(1);
    expect(dbMocks.markSceneFailed).toHaveBeenCalledWith("s_2", "rate limited");
    // Project status decoupled from per-scene failures — UI uses scene counts.
    // Always 'ready' on completion so the finalize lock can rely on it.
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

    expect(result.failed).toBe(2);
    expect(dbMocks.markSceneFailed).toHaveBeenCalledWith("s_1", expect.stringMatching(/no image url/));
  });

  it("uses opts.aspectRatio override when provided", async () => {
    await generateAllImages("p_1", { aspectRatio: "9:16" });

    expect(falMocks.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ aspectRatio: "9:16" })
    );
  });

  it("derives aspect ratio from project format when not overridden", async () => {
    dbMocks.selectProjectById.mockResolvedValue({ id: "p_1", format: "reel", status: "scripting" });

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
    dbMocks.selectProjectById.mockResolvedValue({ id: "p_1", format: "yt-long", status: "ready" });
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
      expect.objectContaining({ aspectRatio: "16:9" })
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
    dbMocks.selectProjectById.mockResolvedValue({ id: "p_1", format: "reel", status: "ready" });

    await applySceneAction("p_1", "s_1", "regenerate");

    expect(falMocks.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ aspectRatio: "9:16" })
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
  };

  const metadata = {
    youtubeTitle: "Sunlit Brazilian Modernism",
    youtubeTitleAlternates: ["Travertine and Palm Shadow"],
    youtubeDescription: "A long-enough description for schema purposes — afternoon light through palm shadow.",
    youtubeTags: ["architecture", "modernism", "ambient"],
    instagramCaption: "Travertine and palm shadow at the slow end of an afternoon.",
    hashtags: ["architecture", "modernism", "design", "ambient"],
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
      format: "yt-long",
      status: "ready",
      targetDurationSec: 150,
      concept,
    });
    dbMocks.selectScenesByProject.mockResolvedValue([
      { ...generatedScene({ id: "s_1", order: 1 }), imageUrl: "https://blob.vercel-storage.com/images/p_1/s1.jpg" },
      { ...generatedScene({ id: "s_2", order: 2 }), imageUrl: "https://blob.vercel-storage.com/images/p_1/s2.jpg" },
    ]);
    claudeMocks.generateMetadata.mockResolvedValue(metadata);
    thumbnailMocks.generateThumbnail.mockResolvedValue({
      imageUrl: "https://blob.vercel-storage.com/thumbnails/p_1/thumb.jpg",
      requestId: "req_thumb",
    });
  });

  it("happy path (yt-long): metadata → thumbnail → markProjectFinalized", async () => {
    const out = await finalizeProject("p_1");

    expect(claudeMocks.generateMetadata).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sceneCount: 2,
        totalDurationSec: 10,
        format: "yt-long",
        niche: "modernist living rooms",
      })
    );
    expect(thumbnailMocks.generateThumbnail).toHaveBeenCalledOnce();
    expect(dbMocks.markProjectFinalized).toHaveBeenCalledExactlyOnceWith(
      "p_1",
      expect.objectContaining({
        thumbnailUrl: "https://blob.vercel-storage.com/thumbnails/p_1/thumb.jpg",
        metadata,
      })
    );

    expect(out.thumbnailUrl).toBe("https://blob.vercel-storage.com/thumbnails/p_1/thumb.jpg");
    expect(out.metadata).toEqual(metadata);
  });

  it("acquires the finalization lock and refuses concurrent finalize calls", async () => {
    dbMocks.tryAcquireFinalizationLock.mockResolvedValueOnce(false);

    await expect(finalizeProject("p_1")).rejects.toBeInstanceOf(ProjectBusyError);

    expect(claudeMocks.generateMetadata).not.toHaveBeenCalled();
    expect(thumbnailMocks.generateThumbnail).not.toHaveBeenCalled();
    expect(dbMocks.markProjectFinalized).not.toHaveBeenCalled();
  });

  it("releases the lock (status → ready) when thumbnail generation fails after metadata succeeded", async () => {
    thumbnailMocks.generateThumbnail.mockRejectedValue(new Error("fal exploded"));

    await expect(finalizeProject("p_1")).rejects.toThrow(/fal exploded/);
    expect(dbMocks.updateProjectStatus).toHaveBeenCalledWith("p_1", "ready");
    expect(dbMocks.markProjectFinalized).not.toHaveBeenCalled();
  });

  it("calls metadata BEFORE thumbnail BEFORE markProjectFinalized", async () => {
    const order: string[] = [];
    claudeMocks.generateMetadata.mockImplementation(async () => {
      order.push("metadata");
      return metadata;
    });
    thumbnailMocks.generateThumbnail.mockImplementation(async () => {
      order.push("thumbnail");
      return {
        imageUrl: "https://blob.vercel-storage.com/thumbnails/p_1/thumb.jpg",
        requestId: "r",
      };
    });
    dbMocks.markProjectFinalized.mockImplementation(async () => {
      order.push("finalize");
    });

    await finalizeProject("p_1");

    expect(order).toEqual(["metadata", "thumbnail", "finalize"]);
  });

  it("substitutes {APP_LINK} with the operator's resolved app URL", async () => {
    operatorMocks.pickAppLink.mockReturnValue("https://architectgpt.example/r/foo");

    claudeMocks.generateMetadata.mockResolvedValue({
      ...metadata,
      youtubeDescription: `Hook line.\n\nTry it: {APP_LINK} — pinned link below.`,
      pinnedComment: `Sketched in ArchitectGPT — {APP_LINK}`,
    });
    dbMocks.selectProjectById.mockResolvedValue({
      id: "p_1",
      title: "T",
      niche: "modernist exteriors",
      format: "yt-long",
      status: "ready",
      targetDurationSec: 150,
      concept,
    });

    await finalizeProject("p_1");

    const persisted = dbMocks.markProjectFinalized.mock.calls[0][1];
    expect(persisted.metadata.youtubeDescription).toContain("https://architectgpt.example/r/foo");
    expect(persisted.metadata.youtubeDescription).not.toContain("{APP_LINK}");
    expect(persisted.metadata.pinnedComment).toContain("https://architectgpt.example/r/foo");
    // Routing is delegated entirely to operators.pickAppLink — confirmed it was called with the niche.
    expect(operatorMocks.pickAppLink).toHaveBeenCalledWith(
      operatorMocks.fixture,
      "modernist exteriors"
    );
  });

  it("leaves {APP_LINK} placeholder intact when pickAppLink returns empty", async () => {
    operatorMocks.pickAppLink.mockReturnValue("");

    claudeMocks.generateMetadata.mockResolvedValue({
      ...metadata,
      youtubeDescription: "Try {APP_LINK} please.",
      pinnedComment: "x {APP_LINK} y",
    });

    await finalizeProject("p_1");

    const persisted = dbMocks.markProjectFinalized.mock.calls[0][1];
    expect(persisted.metadata.youtubeDescription).toContain("{APP_LINK}");
    expect(persisted.metadata.pinnedComment).toContain("{APP_LINK}");
  });

  it("carousel: same flow, no special-casing now that ffmpeg is gone", async () => {
    dbMocks.selectProjectById.mockResolvedValue({
      id: "p_1",
      title: "T",
      niche: "x",
      format: "carousel",
      status: "ready",
      targetDurationSec: 0,
      concept,
    });

    const out = await finalizeProject("p_1");

    expect(out.thumbnailUrl).toBe("https://blob.vercel-storage.com/thumbnails/p_1/thumb.jpg");
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
      format: "yt-long",
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
