import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  class FakeProjectBusyError extends Error {
    readonly code = "PROJECT_BUSY";
    constructor(id: string, public operation: "generating" | "finalizing" = "finalizing") {
      super(`Project ${id} is already ${operation}.`);
      this.name = "ProjectBusyError";
    }
  }
  return {
    finalizeProject: vi.fn(),
    ProjectBusyError: FakeProjectBusyError,
  };
});

const projectsMocks = { finalizeProject: hoisted.finalizeProject };
const FakeProjectBusyError = hoisted.ProjectBusyError;

vi.mock("@/lib/projects", () => hoisted);

const ownershipMock = vi.hoisted(() => ({
  requireProjectOwnership: vi.fn(async (): Promise<Response | null> => null),
}));

vi.mock("@/lib/route-helpers", () => ({
  withSessionOperator: (fn: () => Promise<Response>) => fn(),
  requireProjectOwnership: ownershipMock.requireProjectOwnership,
}));

import { POST } from "./route";

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function postReq(id: string): Request {
  return new Request(`http://localhost/api/projects/${id}/finalize`, { method: "POST" });
}

beforeEach(() => {
  projectsMocks.finalizeProject.mockReset();
  ownershipMock.requireProjectOwnership.mockReset();
  ownershipMock.requireProjectOwnership.mockResolvedValue(null);
});

describe("POST /api/projects/[id]/finalize", () => {
  it("happy path: returns the finalize result (thumbnail + metadata, no video)", async () => {
    projectsMocks.finalizeProject.mockResolvedValue({
      thumbnailUrl: "https://blob.vercel-storage.com/thumbnails/p_1/thumb.jpg",
      metadata: { youtubeTitle: "T" },
    });

    const res = await POST(postReq("p_1"), ctx("p_1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.thumbnailUrl).toBe("https://blob.vercel-storage.com/thumbnails/p_1/thumb.jpg");
    expect(body).not.toHaveProperty("videoUrl");
    expect(projectsMocks.finalizeProject).toHaveBeenCalledWith("p_1");
  });

  it("returns the ownership denial without finalizing", async () => {
    ownershipMock.requireProjectOwnership.mockResolvedValue(
      new Response(JSON.stringify({ error: "Only the project owner can do this." }), {
        status: 403,
      })
    );

    const res = await POST(postReq("p_1"), ctx("p_1"));
    expect(res.status).toBe(403);
    expect(projectsMocks.finalizeProject).not.toHaveBeenCalled();
  });

  it("returns 404 when project not found", async () => {
    projectsMocks.finalizeProject.mockRejectedValue(new Error("Project p_1 not found"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(postReq("p_1"), ctx("p_1"));
    expect(res.status).toBe(404);
  });

  it("returns 409 when scenes are not yet generated", async () => {
    projectsMocks.finalizeProject.mockRejectedValue(
      new Error("Cannot finalize: 3 scenes not yet generated. Generate or reject them first.")
    );

    const res = await POST(postReq("p_1"), ctx("p_1"));
    expect(res.status).toBe(409);
  });

  it("returns 409 when there are no generated scenes at all", async () => {
    projectsMocks.finalizeProject.mockRejectedValue(
      new Error("No generated scenes to finalize. Generate images first.")
    );

    const res = await POST(postReq("p_1"), ctx("p_1"));
    expect(res.status).toBe(409);
  });

  it("returns 409 when project has no concept", async () => {
    projectsMocks.finalizeProject.mockRejectedValue(new Error("Project has no concept brief"));

    const res = await POST(postReq("p_1"), ctx("p_1"));
    expect(res.status).toBe(409);
  });

  it("returns 409 with PROJECT_BUSY code when finalize is already in flight", async () => {
    projectsMocks.finalizeProject.mockRejectedValue(new FakeProjectBusyError("p_1", "finalizing"));

    const res = await POST(postReq("p_1"), ctx("p_1"));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("PROJECT_BUSY");
    expect(body.error).toMatch(/already finalizing/i);
  });

  it("returns 500 on other errors", async () => {
    projectsMocks.finalizeProject.mockRejectedValue(new Error("ffmpeg crashed"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(postReq("p_1"), ctx("p_1"));
    expect(res.status).toBe(500);
  });
});
