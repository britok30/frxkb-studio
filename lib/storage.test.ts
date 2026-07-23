import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  put: vi.fn(),
}));

vi.mock("@vercel/blob", () => ({
  put: mocks.put,
}));

import { storeBuffer, storeFromUrl } from "./storage";

beforeEach(() => {
  mocks.put.mockReset();
});

describe("storeBuffer", () => {
  it("uploads to the namespaced path and returns the Blob url + pathname", async () => {
    mocks.put.mockResolvedValue({
      url: "https://blob.vercel-storage.com/images/proj-1/scene-01.jpg",
      pathname: "images/proj-1/scene-01.jpg",
    });

    const out = await storeBuffer({
      buffer: Buffer.from("hello"),
      kind: "images",
      projectId: "proj-1",
      filename: "scene-01.jpg",
    });

    expect(mocks.put).toHaveBeenCalledExactlyOnceWith(
      "images/proj-1/scene-01.jpg",
      expect.any(Buffer),
      expect.objectContaining({ access: "public", addRandomSuffix: false })
    );
    expect(out).toEqual({
      url: "https://blob.vercel-storage.com/images/proj-1/scene-01.jpg",
      pathname: "images/proj-1/scene-01.jpg",
    });
  });

  it("forwards contentType to put() when provided", async () => {
    mocks.put.mockResolvedValue({ url: "u", pathname: "p" });

    await storeBuffer({
      buffer: Buffer.from("x"),
      kind: "thumbnails",
      projectId: "p",
      filename: "thumb.jpg",
      contentType: "image/jpeg",
    });

    expect(mocks.put.mock.calls[0][2]).toEqual(
      expect.objectContaining({ contentType: "image/jpeg" })
    );
  });

  it("routes by AssetKind into separate prefixes", async () => {
    mocks.put.mockResolvedValue({ url: "u", pathname: "p" });

    await storeBuffer({
      buffer: Buffer.from("x"),
      kind: "thumbnails",
      projectId: "p",
      filename: "thumb.jpg",
    });
    expect(mocks.put.mock.calls[0][0]).toBe("thumbnails/p/thumb.jpg");

    await storeBuffer({
      buffer: Buffer.from("x"),
      kind: "videos",
      projectId: "p",
      filename: "final.mp4",
    });
    expect(mocks.put.mock.calls[1][0]).toBe("videos/p/final.mp4");
  });
});

describe("storeFromUrl", () => {
  it("streams the upstream body + content-type to Blob (multipart)", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("imgdata"));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        body,
        headers: new Headers({ "content-type": "image/jpeg" }),
      })
    );
    mocks.put.mockResolvedValue({
      url: "https://blob.vercel-storage.com/images/p/out.jpg",
      pathname: "images/p/out.jpg",
    });

    const out = await storeFromUrl({
      url: "https://fal.media/files/foo.jpg",
      kind: "images",
      projectId: "p",
      filename: "out.jpg",
    });

    expect(mocks.put).toHaveBeenCalledOnce();
    expect(mocks.put.mock.calls[0][0]).toBe("images/p/out.jpg");
    // The response body must be passed through as a stream — buffering the
    // whole file OOM-crashes on 400MB+ stitched long-forms.
    expect(mocks.put.mock.calls[0][1]).toBe(body);
    expect(mocks.put.mock.calls[0][2]).toEqual(
      expect.objectContaining({ contentType: "image/jpeg", multipart: true })
    );
    expect(out.url).toBe("https://blob.vercel-storage.com/images/p/out.jpg");
  });

  it("throws on non-2xx upstream fetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" })
    );

    await expect(
      storeFromUrl({
        url: "https://fal.media/missing.jpg",
        kind: "images",
        projectId: "p",
        filename: "out.jpg",
      })
    ).rejects.toThrow(/Failed to download.*404 Not Found/);

    expect(mocks.put).not.toHaveBeenCalled();
  });
});

describe("input validation", () => {
  beforeEach(() => {
    mocks.put.mockResolvedValue({ url: "u", pathname: "p" });
  });

  const traversalCases: { label: string; projectId: string; filename: string }[] = [
    { label: "projectId .. literal", projectId: "..", filename: "x.jpg" },
    { label: "projectId with slash", projectId: "../etc", filename: "x.jpg" },
    { label: "projectId with backslash", projectId: "..\\etc", filename: "x.jpg" },
    { label: "projectId empty", projectId: "", filename: "x.jpg" },
    { label: "projectId with null byte", projectId: "p\0", filename: "x.jpg" },
    { label: "filename with slash", projectId: "p", filename: "../etc/passwd" },
    { label: "filename .. literal", projectId: "p", filename: ".." },
    { label: "filename with space", projectId: "p", filename: "a b.jpg" },
  ];

  it.each(traversalCases)("rejects $label", async ({ projectId, filename }) => {
    await expect(
      storeBuffer({ buffer: Buffer.from("x"), kind: "images", projectId, filename })
    ).rejects.toThrow();
    expect(mocks.put).not.toHaveBeenCalled();
  });
});
