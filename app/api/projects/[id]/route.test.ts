import { describe, it, expect, vi, beforeEach } from "vitest";

const projectsMocks = vi.hoisted(() => ({
  getProjectWithScenes: vi.fn(),
}));

vi.mock("@/lib/projects", () => projectsMocks);

import { GET } from "./route";

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  projectsMocks.getProjectWithScenes.mockReset();
});

describe("GET /api/projects/[id]", () => {
  it("returns the project with scenes", async () => {
    projectsMocks.getProjectWithScenes.mockResolvedValue({
      project: { id: "p1", title: "T" },
      scenes: [{ id: "s1" }],
    });

    const res = await GET(new Request("http://localhost/api/projects/p1"), ctx("p1"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.project.id).toBe("p1");
    expect(body.scenes).toHaveLength(1);
  });

  it("returns 404 when not found", async () => {
    projectsMocks.getProjectWithScenes.mockResolvedValue(null);

    const res = await GET(new Request("http://localhost/api/projects/missing"), ctx("missing"));

    expect(res.status).toBe(404);
  });

  it("returns 500 on unexpected error", async () => {
    projectsMocks.getProjectWithScenes.mockRejectedValue(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await GET(new Request("http://localhost/api/projects/p1"), ctx("p1"));

    expect(res.status).toBe(500);
  });
});
