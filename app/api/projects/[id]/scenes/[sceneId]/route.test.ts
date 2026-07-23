import { describe, it, expect, vi, beforeEach } from "vitest";

const projectsMocks = vi.hoisted(() => ({
  applySceneAction: vi.fn(),
}));

vi.mock("@/lib/projects", () => projectsMocks);

vi.mock("@/lib/route-helpers", () => ({
  withSessionOperator: (fn: () => Promise<Response>) => fn(),
  requireProjectOwnership: async () => null,
}));

import { PATCH } from "./route";

function patchJSON(id: string, sceneId: string, body?: unknown): Request {
  return new Request(`http://localhost/api/projects/${id}/scenes/${sceneId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body ?? {}),
  });
}

function ctx(id: string, sceneId: string) {
  return { params: Promise.resolve({ id, sceneId }) };
}

beforeEach(() => {
  projectsMocks.applySceneAction.mockReset();
});

describe("PATCH /api/projects/[id]/scenes/[sceneId]", () => {
  it("happy path: returns the updated scene", async () => {
    projectsMocks.applySceneAction.mockResolvedValue({ id: "s_1", status: "approved" });

    const res = await PATCH(patchJSON("p_1", "s_1", { action: "approve" }), ctx("p_1", "s_1"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scene.status).toBe("approved");
    expect(projectsMocks.applySceneAction).toHaveBeenCalledWith("p_1", "s_1", "approve", {
      designDirection: undefined,
    });
  });

  it("passes designDirection through to applySceneAction for regenerate", async () => {
    projectsMocks.applySceneAction.mockResolvedValue({ id: "s_1", status: "generated" });

    await PATCH(
      patchJSON("p_1", "s_1", {
        action: "regenerate",
        designDirection: "tighter on the kitchen counter, shift to morning light",
      }),
      ctx("p_1", "s_1"),
    );

    expect(projectsMocks.applySceneAction).toHaveBeenCalledWith("p_1", "s_1", "regenerate", {
      designDirection: "tighter on the kitchen counter, shift to morning light",
    });
  });

  it("rejects a designDirection longer than 500 chars", async () => {
    const tooLong = "x".repeat(501);
    const res = await PATCH(
      patchJSON("p_1", "s_1", { action: "regenerate", designDirection: tooLong }),
      ctx("p_1", "s_1"),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 on invalid JSON", async () => {
    const res = await PATCH(patchJSON("p_1", "s_1", "nope"), ctx("p_1", "s_1"));
    expect(res.status).toBe(400);
  });

  it("returns 400 on bad action", async () => {
    const res = await PATCH(patchJSON("p_1", "s_1", { action: "delete" }), ctx("p_1", "s_1"));
    expect(res.status).toBe(400);
  });

  it("returns 404 when scene not found", async () => {
    projectsMocks.applySceneAction.mockRejectedValue(new Error("Scene s_1 not found"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await PATCH(patchJSON("p_1", "s_1", { action: "approve" }), ctx("p_1", "s_1"));

    expect(res.status).toBe(404);
  });

  it("returns 400 when scene belongs to a different project", async () => {
    projectsMocks.applySceneAction.mockRejectedValue(
      new Error("Scene s_1 does not belong to project p_1")
    );

    const res = await PATCH(patchJSON("p_1", "s_1", { action: "approve" }), ctx("p_1", "s_1"));

    expect(res.status).toBe(400);
  });

  it("returns 500 on other errors", async () => {
    projectsMocks.applySceneAction.mockRejectedValue(new Error("fal exploded"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await PATCH(patchJSON("p_1", "s_1", { action: "regenerate" }), ctx("p_1", "s_1"));

    expect(res.status).toBe(500);
  });

  it("each action enum value passes validation", async () => {
    projectsMocks.applySceneAction.mockResolvedValue({ id: "s_1" });

    for (const action of ["approve", "reject", "regenerate"] as const) {
      const res = await PATCH(patchJSON("p_1", "s_1", { action }), ctx("p_1", "s_1"));
      expect(res.status).toBe(200);
    }
    expect(projectsMocks.applySceneAction).toHaveBeenCalledTimes(3);
  });
});
