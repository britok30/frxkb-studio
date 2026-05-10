import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  send: vi.fn(),
  currentOperator: vi.fn(() => ({ email: "britok30@gmail.com" })),
}));

vi.mock("@/inngest/client", () => ({
  inngest: { send: hoisted.send },
}));

vi.mock("@/lib/operators", () => ({
  currentOperator: hoisted.currentOperator,
}));

vi.mock("@/lib/route-helpers", () => ({
  withSessionOperator: (fn: () => Promise<Response>) => fn(),
}));

import { POST } from "./route";

function postJSON(id: string, body?: unknown): Request {
  return new Request(`http://localhost/api/projects/${id}/animate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body),
  });
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  hoisted.send.mockReset();
  hoisted.send.mockResolvedValue({ ids: ["evt_1"] });
  hoisted.currentOperator.mockReturnValue({ email: "britok30@gmail.com" });
});

describe("POST /api/projects/[id]/animate", () => {
  it("enqueues the animate event and returns 202", async () => {
    const res = await POST(postJSON("p_1"), ctx("p_1"));

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ enqueued: true });
    expect(hoisted.send).toHaveBeenCalledWith({
      name: "project/animate.requested",
      data: { projectId: "p_1", operatorEmail: "britok30@gmail.com" },
    });
  });

  it("forwards body options into the event payload", async () => {
    await POST(postJSON("p_1", { force: true, concurrency: 1 }), ctx("p_1"));

    expect(hoisted.send).toHaveBeenCalledWith({
      name: "project/animate.requested",
      data: {
        projectId: "p_1",
        operatorEmail: "britok30@gmail.com",
        force: true,
        concurrency: 1,
      },
    });
  });

  it("returns 400 on bad concurrency value without enqueueing", async () => {
    const res = await POST(postJSON("p_1", { concurrency: 99 }), ctx("p_1"));
    expect(res.status).toBe(400);
    expect(hoisted.send).not.toHaveBeenCalled();
  });

  it("returns 500 if inngest.send rejects", async () => {
    hoisted.send.mockRejectedValue(new Error("inngest unreachable"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(postJSON("p_1"), ctx("p_1"));

    expect(res.status).toBe(500);
  });
});
