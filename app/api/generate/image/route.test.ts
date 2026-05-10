import { describe, it, expect, vi, beforeEach } from "vitest";

const generateImageMock = vi.hoisted(() => vi.fn());
const storeFromUrlMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/fal", () => ({
  generateImage: generateImageMock,
}));

vi.mock("@/lib/storage", () => ({
  storeFromUrl: storeFromUrlMock,
}));

vi.mock("@/lib/route-helpers", () => ({
  withSessionOperator: (fn: () => Promise<Response>) => fn(),
}));

import { POST } from "./route";

function postJSON(body: unknown): Request {
  return new Request("http://localhost/api/generate/image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  generateImageMock.mockReset();
  storeFromUrlMock.mockReset();
});

describe("POST /api/generate/image", () => {
  it("returns 400 on invalid JSON", async () => {
    const res = await POST(postJSON("not json{"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid json/i);
  });

  it("returns 400 when prompt is too short", async () => {
    const res = await POST(postJSON({ prompt: "x" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid input");
    expect(body.issues).toBeDefined();
  });

  it("returns 400 on bad aspect ratio enum", async () => {
    const res = await POST(postJSON({ prompt: "a real prompt", aspectRatio: "21:9" }));
    expect(res.status).toBe(400);
  });

  it.each([
    "../etc",
    "..",
    "/abs",
    "with space",
    "with/slash",
    "with\\back",
    "",
  ])("rejects path-traversal projectId %j", async (projectId) => {
    const res = await POST(postJSON({ prompt: "valid prompt here", projectId }));
    expect(res.status).toBe(400);
    expect(generateImageMock).not.toHaveBeenCalled();
  });

  it("happy path: calls fal, saves the image, returns the public url", async () => {
    generateImageMock.mockResolvedValue({
      images: [{ url: "https://fal.media/abc.jpg", contentType: "image/jpeg" }],
      description: "A modernist room.",
      requestId: "req_abc",
    });
    storeFromUrlMock.mockResolvedValue({
      url: "https://blob.vercel-storage.com/images/scratch/foo.jpg",
      pathname: "images/scratch/foo.jpg",
    });

    const res = await POST(
      postJSON({ prompt: "modernist living room", aspectRatio: "16:9" })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      url: "https://blob.vercel-storage.com/images/scratch/foo.jpg",
      requestId: "req_abc",
      description: "A modernist room.",
    });

    expect(generateImageMock).toHaveBeenCalledWith({
      prompt: "modernist living room",
      aspectRatio: "16:9",
      outputFormat: "jpeg",
    });
    expect(storeFromUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://fal.media/abc.jpg",
        kind: "images",
        projectId: "scratch",
      })
    );
  });

  it("uses provided projectId when present", async () => {
    generateImageMock.mockResolvedValue({
      images: [{ url: "https://fal.media/x.jpg" }],
      requestId: "r",
    });
    storeFromUrlMock.mockResolvedValue({ url: "https://blob.example/p", pathname: "p" });

    await POST(postJSON({ prompt: "valid prompt here", projectId: "proj-42" }));

    expect(storeFromUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj-42" })
    );
  });

  it("png output produces a .png filename", async () => {
    generateImageMock.mockResolvedValue({
      images: [{ url: "https://fal.media/x.png" }],
      requestId: "r",
    });
    storeFromUrlMock.mockResolvedValue({ url: "https://blob.example/p", pathname: "p" });

    await POST(postJSON({ prompt: "valid prompt here", outputFormat: "png" }));

    const call = storeFromUrlMock.mock.calls[0][0];
    expect(call.filename).toMatch(/\.png$/);
  });

  it("returns 502 when fal returns no images", async () => {
    generateImageMock.mockResolvedValue({ images: [], requestId: "r" });
    // suppress noisy console.error from the route
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(postJSON({ prompt: "valid prompt here" }));

    expect(res.status).toBe(502);
    expect(storeFromUrlMock).not.toHaveBeenCalled();
  });

  it("returns 502 when fal returns an image entry with no url", async () => {
    generateImageMock.mockResolvedValue({
      images: [{ url: undefined as unknown as string }],
      requestId: "r",
    });

    const res = await POST(postJSON({ prompt: "valid prompt here" }));

    expect(res.status).toBe(502);
    expect(storeFromUrlMock).not.toHaveBeenCalled();
  });

  it("omits description from the response when fal didn't provide one", async () => {
    generateImageMock.mockResolvedValue({
      images: [{ url: "https://fal.media/x.jpg" }],
      requestId: "r",
      // no description
    });
    storeFromUrlMock.mockResolvedValue({
      url: "https://blob.vercel-storage.com/images/scratch/x.jpg",
      pathname: "images/scratch/x.jpg",
    });

    const res = await POST(postJSON({ prompt: "valid prompt here" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      url: "https://blob.vercel-storage.com/images/scratch/x.jpg",
      requestId: "r",
    });
    expect(body).not.toHaveProperty("description");
  });

  it("returns 500 when fal throws", async () => {
    generateImageMock.mockRejectedValue(new Error("fal exploded"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(postJSON({ prompt: "valid prompt here" }));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("fal exploded");
  });
});
