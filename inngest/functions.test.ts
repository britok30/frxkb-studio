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
    startSceneVideo: vi.fn(),
    pollSceneRequest: vi.fn(),
    startSceneUpscale: vi.fn(),
    finishSceneAnimation: vi.fn(),
    failSceneAnimation: vi.fn(),
    finishAnimate: vi.fn(),
    prepareStitch: vi.fn(),
    planStitchRehost: vi.fn(),
    transferStitchRehostParts: vi.fn(),
    completeStitchRehost: vi.fn(),
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
  startSceneVideo: hoisted.startSceneVideo,
  pollSceneRequest: hoisted.pollSceneRequest,
  startSceneUpscale: hoisted.startSceneUpscale,
  finishSceneAnimation: hoisted.finishSceneAnimation,
  failSceneAnimation: hoisted.failSceneAnimation,
  finishAnimate: hoisted.finishAnimate,
  prepareStitch: hoisted.prepareStitch,
  planStitchRehost: hoisted.planStitchRehost,
  transferStitchRehostParts: hoisted.transferStitchRehostParts,
  completeStitchRehost: hoisted.completeStitchRehost,
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

// Minimal step that just invokes the inner fn — Inngest's real step.run
// also memoizes for retries, but we don't exercise that path in unit tests.
// sleep resolves immediately (real Inngest parks the run durably).
const passthroughStep = {
  run: <T>(_name: string, fn: () => Promise<T>) => fn(),
  sleep: (_name: string, _duration: string | number) => Promise.resolve(),
};

beforeEach(() => {
  hoisted.generateAllImages.mockReset();
  hoisted.animateAllScenes.mockReset();
  hoisted.planAnimate.mockReset();
  hoisted.startSceneVideo.mockReset();
  hoisted.pollSceneRequest.mockReset().mockResolvedValue(true);
  hoisted.startSceneUpscale.mockReset();
  hoisted.finishSceneAnimation.mockReset();
  hoisted.failSceneAnimation.mockReset().mockResolvedValue({ ok: false });
  hoisted.finishAnimate.mockReset().mockResolvedValue(undefined);
  hoisted.prepareStitch.mockReset();
  hoisted.planStitchRehost.mockReset();
  hoisted.planStitchRehost.mockResolvedValue({ mode: "simple" });
  hoisted.transferStitchRehostParts.mockReset();
  hoisted.completeStitchRehost.mockReset();
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

  const videoReq = { endpoint: "bytedance/seedance-2.5/image-to-video", requestId: "req_v" };
  const upscaleReq = { endpoint: "fal-ai/topaz/upscale/video", requestId: "req_u" };

  it("plans, runs each scene as submit → poll → upscale → poll → store, then finishes — per-scene results roll up", async () => {
    hoisted.getOperator.mockReturnValue(stubOperator);
    hoisted.planAnimate.mockResolvedValue(plan);
    hoisted.startSceneVideo.mockResolvedValue(videoReq);
    hoisted.startSceneUpscale.mockResolvedValue(upscaleReq);
    hoisted.finishSceneAnimation
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("blob write failed"));

    const result = await handleAnimate(
      { event: { data: { projectId: "p_1", operatorEmail: "britok30@gmail.com", force: false } } },
      passthroughStep
    );

    expect(hoisted.planAnimate).toHaveBeenCalledWith("p_1", { force: false });
    expect(hoisted.startSceneVideo).toHaveBeenCalledTimes(2);
    expect(hoisted.startSceneVideo).toHaveBeenCalledWith(plan, plan.targets[0]);
    // One completed poll per stage per scene (mock reports done immediately).
    expect(hoisted.pollSceneRequest).toHaveBeenCalledWith("p_1", videoReq);
    expect(hoisted.pollSceneRequest).toHaveBeenCalledWith("p_1", upscaleReq);
    expect(hoisted.startSceneUpscale).toHaveBeenCalledWith(plan, plan.targets[0], videoReq);
    expect(hoisted.finishSceneAnimation).toHaveBeenCalledTimes(2);
    // The scene whose store step failed is marked failed, not thrown.
    expect(hoisted.failSceneAnimation).toHaveBeenCalledTimes(1);
    expect(hoisted.failSceneAnimation).toHaveBeenCalledWith(expect.any(String), "blob write failed");
    expect(hoisted.finishAnimate).toHaveBeenCalledWith("p_1");
    expect(result).toEqual({ animated: 1, failed: 1, skipped: 0 });
  });

  it("keeps polling a stage until fal reports COMPLETED", async () => {
    hoisted.getOperator.mockReturnValue(stubOperator);
    hoisted.planAnimate.mockResolvedValue({ ...plan, targets: [plan.targets[0]] });
    hoisted.startSceneVideo.mockResolvedValue(videoReq);
    hoisted.startSceneUpscale.mockResolvedValue(upscaleReq);
    hoisted.finishSceneAnimation.mockResolvedValue({ ok: true });
    hoisted.pollSceneRequest
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);

    const result = await handleAnimate(
      { event: { data: { projectId: "p_1", operatorEmail: "britok30@gmail.com" } } },
      passthroughStep
    );

    // 3 polls for the video stage (false, false, true) + 1 for the upscale.
    expect(hoisted.pollSceneRequest).toHaveBeenCalledTimes(4);
    expect(result).toEqual({ animated: 1, failed: 0, skipped: 0 });
  });

  it("gives up on a scene (marks it failed) when a stage never completes", async () => {
    hoisted.getOperator.mockReturnValue(stubOperator);
    hoisted.planAnimate.mockResolvedValue({ ...plan, targets: [plan.targets[0]] });
    hoisted.startSceneVideo.mockResolvedValue(videoReq);
    hoisted.pollSceneRequest.mockResolvedValue(false);

    const result = await handleAnimate(
      { event: { data: { projectId: "p_1", operatorEmail: "britok30@gmail.com" } } },
      passthroughStep
    );

    expect(hoisted.startSceneUpscale).not.toHaveBeenCalled();
    expect(hoisted.failSceneAnimation).toHaveBeenCalledWith("s_1", expect.stringMatching(/still not done/));
    expect(result).toEqual({ animated: 0, failed: 1, skipped: 0 });
  });

  it("forwards sceneId so a single clip can be re-animated", async () => {
    hoisted.getOperator.mockReturnValue(stubOperator);
    hoisted.planAnimate.mockResolvedValue({ ...plan, targets: [plan.targets[1]] });
    hoisted.startSceneVideo.mockResolvedValue(videoReq);
    hoisted.startSceneUpscale.mockResolvedValue(upscaleReq);
    hoisted.finishSceneAnimation.mockResolvedValue({ ok: true });

    const result = await handleAnimate(
      { event: { data: { projectId: "p_1", operatorEmail: "britok30@gmail.com", sceneId: "s_2" } } },
      passthroughStep
    );

    expect(hoisted.planAnimate).toHaveBeenCalledWith("p_1", { force: undefined, sceneId: "s_2" });
    expect(hoisted.startSceneVideo).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ animated: 1, failed: 0, skipped: 0 });
  });

  it("returns early (no scene steps, no finish) when the plan has no targets", async () => {
    hoisted.getOperator.mockReturnValue(stubOperator);
    hoisted.planAnimate.mockResolvedValue({ ...plan, skipped: 3, targets: [] });

    const result = await handleAnimate(
      { event: { data: { projectId: "p_1", operatorEmail: "britok30@gmail.com" } } },
      passthroughStep
    );

    expect(result).toEqual({ animated: 0, failed: 0, skipped: 3 });
    expect(hoisted.startSceneVideo).not.toHaveBeenCalled();
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
    hoisted.renderStitch.mockResolvedValue({ videoUrl: "https://fal/out.mp4" });
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
    expect(hoisted.finishStitch).toHaveBeenCalledWith("p_1", "https://fal/out.mp4", undefined);
    expect(result).toEqual({ finalVideoUrl: "https://blob/final.mp4" });
  });

  it("large finals: chunked rehost — part batches in their own steps, then complete (no single-step finish)", async () => {
    hoisted.getOperator.mockReturnValue(stubOperator);
    hoisted.prepareStitch.mockResolvedValue({ projectId: "p_1", format: "style-explorer", segments: [], totalMs: 960000, aspect: "16:9", opts: {} });
    hoisted.renderStitch.mockResolvedValue({ videoUrl: "https://shotstack/full.mp4" });
    const plan = {
      mode: "multipart" as const,
      pathname: "videos/p_1/final-x.mp4",
      key: "k",
      uploadId: "u",
      contentType: "video/mp4",
      sizeBytes: 7 * 64 * 1024 * 1024,
      partSizeBytes: 64 * 1024 * 1024,
      partCount: 7,
    };
    hoisted.planStitchRehost.mockResolvedValue(plan);
    hoisted.transferStitchRehostParts.mockImplementation(async (_url: string, _p: unknown, from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => ({ etag: `e${from + i}`, partNumber: from + i }))
    );
    hoisted.completeStitchRehost.mockResolvedValue({ finalVideoUrl: "https://blob/final-big.mp4" });

    const result = await handleStitch(
      { event: { data: { projectId: "p_1", operatorEmail: "britok30@gmail.com", opts: {} } } },
      passthroughStep
    );

    // 7 parts at 3/step → batches [1-3], [4-6], [7-7].
    expect(hoisted.transferStitchRehostParts).toHaveBeenCalledTimes(3);
    expect(hoisted.transferStitchRehostParts).toHaveBeenNthCalledWith(1, "https://shotstack/full.mp4", plan, 1, 3);
    expect(hoisted.transferStitchRehostParts).toHaveBeenNthCalledWith(3, "https://shotstack/full.mp4", plan, 7, 7);
    expect(hoisted.finishStitch).not.toHaveBeenCalled();
    const parts = hoisted.completeStitchRehost.mock.calls[0][2];
    expect(hoisted.completeStitchRehost.mock.calls[0][3]).toBeUndefined();
    expect(parts).toHaveLength(7);
    expect(parts[6]).toEqual({ etag: "e7", partNumber: 7 });
    expect(result).toEqual({ finalVideoUrl: "https://blob/final-big.mp4" });
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
