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
    ProjectBusyError: FakeProjectBusyError,
    getOperator: vi.fn(),
    withOperator: vi.fn(),
  };
});

vi.mock("@/lib/projects", () => ({
  generateAllImages: hoisted.generateAllImages,
  animateAllScenes: hoisted.animateAllScenes,
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

import { handleGenerate, handleAnimate } from "./functions";

const FakeProjectBusyError = hoisted.ProjectBusyError;

const stubOperator = {
  email: "britok30@gmail.com",
  envSuffix: "BRITOK30",
  falKey: "fal-key",
  anthropicKey: "ant-key",
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
  it("runs animateAllScenes inside withOperator", async () => {
    hoisted.getOperator.mockReturnValue(stubOperator);
    hoisted.animateAllScenes.mockResolvedValue({ animated: 5, failed: 0, skipped: 0 });

    const result = await handleAnimate(
      {
        event: {
          data: {
            projectId: "p_1",
            operatorEmail: "britok30@gmail.com",
            force: false,
            concurrency: 2,
          },
        },
      },
      passthroughStep
    );

    expect(hoisted.withOperator).toHaveBeenCalledWith(stubOperator, expect.any(Function));
    expect(hoisted.animateAllScenes).toHaveBeenCalledWith("p_1", {
      force: false,
      concurrency: 2,
    });
    expect(result).toEqual({ animated: 5, failed: 0, skipped: 0 });
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

  it("translates ProjectBusyError into a busy summary", async () => {
    hoisted.getOperator.mockReturnValue(stubOperator);
    hoisted.animateAllScenes.mockRejectedValue(new FakeProjectBusyError("p_1"));

    const result = await handleAnimate(
      { event: { data: { projectId: "p_1", operatorEmail: "britok30@gmail.com" } } },
      passthroughStep
    );

    expect(result).toEqual({ animated: 0, failed: 0, skipped: 0, busy: true });
  });

  it("rethrows non-busy errors", async () => {
    hoisted.getOperator.mockReturnValue(stubOperator);
    hoisted.animateAllScenes.mockRejectedValue(new Error("seedance crashed"));

    await expect(
      handleAnimate(
        { event: { data: { projectId: "p_1", operatorEmail: "britok30@gmail.com" } } },
        passthroughStep
      )
    ).rejects.toThrow(/seedance crashed/);
  });
});
