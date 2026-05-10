import { describe, it, expect, vi, beforeEach } from "vitest";

const suggestMock = vi.hoisted(() => vi.fn());
const dbMocks = vi.hoisted(() => ({ selectRecentWorlds: vi.fn() }));

vi.mock("@/lib/prompts/suggest-world", () => ({
  suggestWorld: suggestMock,
}));

vi.mock("@/lib/projects-db", () => dbMocks);

vi.mock("@/lib/route-helpers", () => ({
  withSessionOperator: (fn: () => Promise<Response>) => fn(),
}));

import { POST } from "./route";

function postJSON(body: unknown): Request {
  return new Request("http://localhost/api/concepts/suggest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  suggestMock.mockReset();
  dbMocks.selectRecentWorlds.mockReset().mockResolvedValue([]);
});

describe("POST /api/concepts/suggest", () => {
  it("happy path: pulls history, calls suggestWorld, returns the suggestion", async () => {
    dbMocks.selectRecentWorlds.mockResolvedValue([
      {
        niche: "Tuscan farmhouse interiors",
        worldSignature: "tuscan-farmhouse-terracotta",
        worldKeywords: ["tuscan", "farmhouse", "terracotta"],
      },
    ]);
    suggestMock.mockResolvedValue({
      niche: "1965 Nordic country houses with pine boards and snow-light",
      rationale: "Your library skews Mediterranean — adding cold northern light fills a gap.",
    });

    const res = await POST(postJSON({ format: "yt-long" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.niche).toMatch(/Nordic/);
    expect(body.rationale).toMatch(/Mediterranean/);

    expect(dbMocks.selectRecentWorlds).toHaveBeenCalledWith(50);
    expect(suggestMock).toHaveBeenCalledExactlyOnceWith({
      format: "yt-long",
      history: [
        {
          niche: "Tuscan farmhouse interiors",
          worldSignature: "tuscan-farmhouse-terracotta",
          worldKeywords: ["tuscan", "farmhouse", "terracotta"],
        },
      ],
    });
  });

  it("returns 400 on invalid JSON", async () => {
    const res = await POST(postJSON("nope"));
    expect(res.status).toBe(400);
    expect(suggestMock).not.toHaveBeenCalled();
  });

  it("returns 400 on missing format", async () => {
    const res = await POST(postJSON({}));
    expect(res.status).toBe(400);
  });

  it("returns 400 on bad format value", async () => {
    const res = await POST(postJSON({ format: "tweet" }));
    expect(res.status).toBe(400);
  });

  it("returns 500 when suggest throws", async () => {
    suggestMock.mockRejectedValue(new Error("Claude rate limited"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(postJSON({ format: "yt-long" }));
    expect(res.status).toBe(500);
  });

  it("forwards recentlyShown to suggestWorld so Claude avoids re-proposing them", async () => {
    suggestMock.mockResolvedValue({
      niche: "Some other world",
      rationale: "Different from what was just shown.",
    });

    await POST(
      postJSON({
        format: "yt-long",
        recentlyShown: [
          "1970s Japanese ryokan interiors at dusk",
          "Kyoto tea house in autumn",
        ],
      })
    );

    expect(suggestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        recentlyShown: [
          "1970s Japanese ryokan interiors at dusk",
          "Kyoto tea house in autumn",
        ],
      })
    );
  });

  it("works fine with empty history (first project)", async () => {
    dbMocks.selectRecentWorlds.mockResolvedValue([]);
    suggestMock.mockResolvedValue({
      niche: "Sun-bleached Mediterranean villas at golden hour",
      rationale: "Strong identity, instantly visualizable.",
    });

    const res = await POST(postJSON({ format: "yt-long" }));
    expect(res.status).toBe(200);
    expect(suggestMock).toHaveBeenCalledWith(
      expect.objectContaining({ history: [] })
    );
  });
});
