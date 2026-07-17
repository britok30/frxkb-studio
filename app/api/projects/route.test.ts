import { describe, it, expect, vi, beforeEach } from "vitest";

const projectsMocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  listProjects: vi.fn(),
}));

vi.mock("@/lib/projects", () => projectsMocks);

// Stub the operator wrapper so route tests don't pull next-auth into the import graph.
vi.mock("@/lib/route-helpers", () => ({
  withSessionOperator: (fn: () => Promise<Response>) => fn(),
}));

import { GET, POST } from "./route";

function postJSON(body: unknown): Request {
  return new Request("http://localhost/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  projectsMocks.createProject.mockReset();
  projectsMocks.listProjects.mockReset();
});

describe("GET /api/projects", () => {
  it("returns the project list", async () => {
    projectsMocks.listProjects.mockResolvedValue([{ id: "p1" }, { id: "p2" }]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projects).toHaveLength(2);
  });

  it("returns 500 when listing fails", async () => {
    projectsMocks.listProjects.mockRejectedValue(new Error("db dead"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await GET();
    expect(res.status).toBe(500);
  });
});

describe("POST /api/projects", () => {
  it("returns 400 on invalid JSON", async () => {
    const res = await POST(postJSON("nope"));
    expect(res.status).toBe(400);
  });

  it("returns 400 when niche is missing", async () => {
    const res = await POST(postJSON({ format: "reel" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 on bad format", async () => {
    const res = await POST(postJSON({ niche: "x", format: "tweet" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when sceneCount is out of range", async () => {
    const res = await POST(postJSON({ niche: "x", format: "reel", sceneCount: 999 }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when worldType is missing", async () => {
    const res = await POST(postJSON({ niche: "x", format: "reel" }));
    expect(res.status).toBe(400);
  });

  it("happy path: 201 with the created project + scenes", async () => {
    projectsMocks.createProject.mockResolvedValue({
      project: { id: "p_new", title: "T" },
      scenes: [{ id: "s_1" }, { id: "s_2" }],
    });

    const res = await POST(
      postJSON({
        niche: "modernist living rooms",
        format: "reel",
        worldType: "interior",
        sceneCount: 2,
      })
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.project.id).toBe("p_new");
    expect(body.scenes).toHaveLength(2);
    expect(projectsMocks.createProject).toHaveBeenCalledWith({
      niche: "modernist living rooms",
      format: "reel",
      worldType: "interior",
      sceneCount: 2,
    });
  });

  it("returns 500 when createProject throws", async () => {
    projectsMocks.createProject.mockRejectedValue(new Error("GPT-5.5 rate limited"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(
      postJSON({ niche: "modernist living rooms", format: "reel", worldType: "interior" })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("GPT-5.5 rate limited");
  });
});
