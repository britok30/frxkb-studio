import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  class FakeProjectBusyError extends Error {
    readonly code = "PROJECT_BUSY";
    constructor(id: string) {
      super(`Project ${id} is already generating.`);
      this.name = "ProjectBusyError";
    }
  }
  return {
    generateAllImages: vi.fn(),
    animateAllScenes: vi.fn(),
    planAnimate: vi.fn(),
    animatePlannedScene: vi.fn(),
    finishAnimate: vi.fn(),
    prepareStitch: vi.fn(),
    renderStitch: vi.fn(),
    finishStitch: vi.fn(),
    failStitch: vi.fn(),
    ProjectBusyError: FakeProjectBusyError,
    getOperator: vi.fn(),
    withOperator: vi.fn(),
  };
});

vi.mock("@/lib/projects", () => ({
  generateAllImages: hoisted.generateAllImages,
  animateAllScenes: hoisted.animateAllScenes,
  planAnimate: hoisted.planAnimate,
  animatePlannedScene: hoisted.animatePlannedScene,
  finishAnimate: hoisted.finishAnimate,
  prepareStitch: hoisted.prepareStitch,
  renderStitch: hoisted.renderStitch,
  finishStitch: hoisted.finishStitch,
  failStitch: hoisted.failStitch,
  ProjectBusyError: hoisted.ProjectBusyError,
}));

vi.mock("@/lib/operators", () => ({
  getOperator: hoisted.getOperator,
  withOperator: hoisted.withOperator,
}));

// Mock the inngest client so importing functions.ts doesn't try to wire up
// a real client (we're testing the inner handlers, not Inngest itself).
vi.mock("./client", () => ({
  inngest: {
    createFunction: (_opts: unknown, _trigger: unknown, fn: unknown) => fn,
  },
}));

import { handleGenerate, handleAnimate, handleStitch } from "./functions";

const FakeProjectBusyError = hoisted.ProjectBusyError;

const stubOperator = {
  email: "britok30@gmail.com",
  envSuffix: "BRITOK30",
  falKey: "fal-key",
  openaiKey: "ant-key",
  apps: [],
};

// Minimal step.run that just invokes the inner fn — Inngest's real step.run
// also memoizes for retries, but we don't exercise that path in unit tests.
const passthroughStep = {
  run: <T>(_name: string, fn: () => Promise<T>) => fn(),
};

beforeEach(() => {
  hoisted.generateAllImages.mockReset();
  hoisted.animateAllScenes.mockReset();
  hoisted.planAnimate.mockReset();
  hoisted.animatePlannedScene.mockReset();
  hoisted.finishAnimate.mockReset().mockResolvedValue(undefined);
  hoisted.prepareStitch.mockReset();
  hoisted.renderStitch.mockReset();
  hoisted.finishStitch.mockReset();
  hoisted.failStitch.mockReset().mockResolvedValue(undefined);
  hoisted.getOperator.mockReset();
  hoisted.withOperator.mockReset();
  // Default: passthrough — call the fn immediately. Tests can override.
  hoisted.withOperator.mockImplementation((_op: unknown, fn: () => unknown) => fn());
});

describe("handleGenerate", () => {
  it("resolves the operator from event.data.operatorEmail and runs generateAllImages inside withOperator", async () => {
    hoisted.getOperator.mockReturnValue(stubOperator);
    hoisted.generateAllImages.mockResolvedValue({
      generated: 5,
      failed: 0,
      skipped: 0,
      reclaimed: 0,
    });

    const result = await handleGenerate(
      {
        event: {
          data: {
            projectId: "p_1",
            operatorEmail: "britok30@gmail.com",
            force: true,
            concurrency: 4,
            aspectRatio: "16:9",
          },
        },
      },
      passthroughStep
    );

    expect(hoisted.getOperator).toHaveBeenCalledWith("britok30@gmail.com");
    expect(hoisted.withOperator).toHaveBeenCalledWith(stubOperator, expect.any(Function));
    expect(hoisted.generateAllImages).toHaveBeenCalledWith("p_1", {
      force: true,
      concurrency: 4,
      aspectRatio: "16:9",
    });
    expect(result).toEqual({ generated: 5, failed: 0, skipped: 0, reclaimed: 0 });
  });

  it("throws when the operator email isn't configured (so Inngest can surface it)", async () => {
    hoisted.getOperator.mockReturnValue(undefined);

    await expect(
      handleGenerate(
        {
          event: {
            data: { projectId: "p_1", operatorEmail: "stranger@example.com" },
          },
        },
        passthroughStep
      )
    ).rejects.toThrow(/Operator not configured/i);
    expect(hoisted.generateAllImages).not.toHaveBeenCalled();
  });

  it("translates ProjectBusyError into a busy summary instead of throwing — avoids burning an Inngest retry on a benign double-fire", async () => {
    hoisted.getOperator.mockReturnValue(stubOperator);
    hoisted.generateAllImages.mockRejectedValue(new FakeProjectBusyError("p_1"));

    const result = await handleGenerate(
      { event: { data: { projectId: "p_1", operatorEmail: "britok30@gmail.com" } } },
      passthroughStep
    );

    expect(result).toEqual({ skipped: 0, generated: 0, failed: 0, reclaimed: 0, busy: true });
  });

  it("rethrows non-busy errors so Inngest retries the step", async () => {
    hoisted.getOperator.mockReturnValue(stubOperator);
    hoisted.generateAllImages.mockRejectedValue(new Error("DB unreachable"));

    await expect(
      handleGenerate(
        { event: { data: { projectId: "p_1", operatorEmail: "britok30@gmail.com" } } },
        passthroughStep
      )
    ).rejects.toThrow(/DB unreachable/);
  });
});

describe("handleAnimate", () => {
  const plan = {
    projectId: "p_1",
    quality: "standard" as const,
    aspectRatio: "9:16" as const,
    isMorph: false,
    skipped: 0,
    targets: [
      { sceneId: "s_1", order: 1, imageUrl: "u1", referenceImageUrl: null, durationSec: 5, motion: "m1" },
      { sceneId: "s_2", order: 2, imageUrl: "u2", referenceImageUrl: "a", durationSec: 5, motion: "m2" },
    ],
  };

  it("plans, animates each scene in its own step, then finishes — per-scene results roll up", async () => {
    hoisted.getOperator.mockReturnValue(stubOperator);
    hoisted.planAnimate.mockResolvedValue(plan);
    hoisted.animatePlannedScene
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false });

    const result = await handleAnimate(
      { event: { data: { projectId: "p_1", operatorEmail: "britok30@gmail.com", force: false } } },
      passthroughStep
    );

    expect(hoisted.planAnimate).toHaveBeenCalledWith("p_1", { force: false });
    expect(hoisted.animatePlannedScene).toHaveBeenCalledTimes(2);
    expect(hoisted.animatePlannedScene).toHaveBeenCalledWith(plan, plan.targets[0]);
    expect(hoisted.finishAnimate).toHaveBeenCalledWith("p_1");
    expect(result).toEqual({ animated: 1, failed: 1, skipped: 0 });
  });

  it("returns early (no scene steps, no finish) when the plan has no targets", async () => {
    hoisted.getOperator.mockReturnValue(stubOperator);
    hoisted.planAnimate.mockResolvedValue({ ...plan, skipped: 3, targets: [] });

    const result = await handleAnimate(
      { event: { data: { projectId: "p_1", operatorEmail: "britok30@gmail.com" } } },
      passthroughStep
    );

    expect(result).toEqual({ animated: 0, failed: 0, skipped: 3 });
    expect(hoisted.animatePlannedScene).not.toHaveBeenCalled();
    expect(hoisted.finishAnimate).not.toHaveBeenCalled();
  });

  it("throws when operator email isn't configured", async () => {
    hoisted.getOperator.mockReturnValue(undefined);

    await expect(
      handleAnimate(
        { event: { data: { projectId: "p_1", operatorEmail: "stranger@example.com" } } },
        passthroughStep
      )
    ).rejects.toThrow(/Operator not configured/i);
  });

  it("translates ProjectBusyError from planning into a busy summary", async () => {
    hoisted.getOperator.mockReturnValue(stubOperator);
    hoisted.planAnimate.mockRejectedValue(new FakeProjectBusyError("p_1"));

    const result = await handleAnimate(
      { event: { data: { projectId: "p_1", operatorEmail: "britok30@gmail.com" } } },
      passthroughStep
    );

    expect(result).toEqual({ animated: 0, failed: 0, skipped: 0, busy: true });
  });

  it("rethrows non-busy planning errors", async () => {
    hoisted.getOperator.mockReturnValue(stubOperator);
    hoisted.planAnimate.mockRejectedValue(new Error("seedance crashed"));

    await expect(
      handleAnimate(
        { event: { data: { projectId: "p_1", operatorEmail: "britok30@gmail.com" } } },
        passthroughStep
      )
    ).rejects.toThrow(/seedance crashed/);
  });
});

describe("handleStitch", () => {
  it("runs prepare → render → finish in order inside withOperator and returns the result", async () => {
    hoisted.getOperator.mockReturnValue(stubOperator);
    const prep = { projectId: "p_1", format: "style-explorer", segments: [], totalMs: 616000, aspect: "16:9", opts: {} };
    hoisted.prepareStitch.mockResolvedValue(prep);
    hoisted.renderStitch.mockResolvedValue("https://fal/out.mp4");
    hoisted.finishStitch.mockResolvedValue({ finalVideoUrl: "https://blob/final.mp4" });

    const result = await handleStitch(
      {
        event: {
          data: {
            projectId: "p_1",
            operatorEmail: "britok30@gmail.com",
            opts: { perStillSec: 7, targetMinutes: 10 },
          },
        },
      },
      passthroughStep
    );

    expect(hoisted.prepareStitch).toHaveBeenCalledWith("p_1", { perStillSec: 7, targetMinutes: 10 });
    expect(hoisted.renderStitch).toHaveBeenCalledWith(prep);
    expect(hoisted.finishStitch).toHaveBeenCalledWith("p_1", "https://fal/out.mp4");
    expect(result).toEqual({ finalVideoUrl: "https://blob/final.mp4" });
  });

  it("throws when the operator has no configured keys", async () => {
    hoisted.getOperator.mockReturnValue(null);
    await expect(
      handleStitch(
        { event: { data: { projectId: "p_1", operatorEmail: "nobody@x.com" } } },
        passthroughStep
      )
    ).rejects.toThrow(/Operator not configured/);
    expect(hoisted.prepareStitch).not.toHaveBeenCalled();
  });
});
