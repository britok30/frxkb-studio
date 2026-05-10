import { describe, it, expect, vi, beforeEach } from "vitest";

const falMocks = vi.hoisted(() => ({ generateImage: vi.fn() }));
const storageMocks = vi.hoisted(() => ({ storeFromUrl: vi.fn() }));

vi.mock("@/lib/fal", () => ({ generateImage: falMocks.generateImage }));
vi.mock("@/lib/storage", () => ({ storeFromUrl: storageMocks.storeFromUrl }));

import { buildThumbnailPrompt, generateThumbnail, thumbnailAspect } from "./thumbnail";
import type { PromptableConcept } from "./prompts/types";

const concept: PromptableConcept = {
  workingTitle: "Sunlit Brazilian Modernism",
  hook: "Calm afternoons through travertine and palm shadow.",
  vibe: "1960s Brazilian modernist houses, palm-filtered late afternoon light.",
  notes: "Eye-level, never overcast.",
};

beforeEach(() => {
  falMocks.generateImage.mockReset();
  storageMocks.storeFromUrl.mockReset();
});

describe("thumbnailAspect", () => {
  it("maps each format to the correct YT/Reels/IG aspect", () => {
    expect(thumbnailAspect("yt-long")).toBe("16:9");
    expect(thumbnailAspect("reel")).toBe("9:16");
    expect(thumbnailAspect("carousel")).toBe("1:1");
  });
});

describe("buildThumbnailPrompt", () => {
  it("encodes hero-subject + negative-space + no-text constraints", () => {
    const p = buildThumbnailPrompt(concept);
    expect(p).toMatch(/one hero subject/i);
    expect(p).toMatch(/negative space/i);
    expect(p).toMatch(/no on-screen text/i);
    expect(p).toMatch(/no people/i);
  });

  it("embeds the concept's working title and vibe", () => {
    const p = buildThumbnailPrompt(concept);
    expect(p).toContain("Sunlit Brazilian Modernism");
    expect(p).toContain("1960s Brazilian");
  });

  it("includes notes when present, omits the notes line when empty", () => {
    expect(buildThumbnailPrompt(concept)).toMatch(/Locked visual rules/);
    const noNotes = buildThumbnailPrompt({ ...concept, notes: "" });
    expect(noNotes).not.toMatch(/Locked visual rules/);
  });
});

describe("generateThumbnail", () => {
  beforeEach(() => {
    falMocks.generateImage.mockResolvedValue({
      images: [{ url: "https://fal.media/thumb.jpg" }],
      requestId: "req_thumb",
    });
    storageMocks.storeFromUrl.mockResolvedValue({
      url: "https://blob.vercel-storage.com/thumbnails/p_1/thumbnail-abc.jpg",
      pathname: "thumbnails/p_1/thumbnail-abc.jpg",
    });
  });

  it("calls fal with the format's aspect ratio and the thumbnail prompt", async () => {
    await generateThumbnail({ projectId: "p_1", concept, format: "yt-long" });

    const args = falMocks.generateImage.mock.calls[0][0];
    expect(args.aspectRatio).toBe("16:9");
    expect(args.prompt).toMatch(/hero subject/i);
  });

  it("uploads to the thumbnails kind under the project id", async () => {
    await generateThumbnail({ projectId: "p_42", concept, format: "reel" });

    const args = storageMocks.storeFromUrl.mock.calls[0][0];
    expect(args.kind).toBe("thumbnails");
    expect(args.projectId).toBe("p_42");
    expect(args.filename).toMatch(/^thumbnail-[A-Za-z0-9_-]+\.jpg$/);
  });

  it("returns the Blob url + fal request id (no local path field anymore)", async () => {
    const out = await generateThumbnail({ projectId: "p_1", concept, format: "yt-long" });
    expect(out).toEqual({
      imageUrl: "https://blob.vercel-storage.com/thumbnails/p_1/thumbnail-abc.jpg",
      requestId: "req_thumb",
    });
  });

  it("throws when fal returns no url", async () => {
    falMocks.generateImage.mockResolvedValue({ images: [{ url: undefined }], requestId: "r" });

    await expect(
      generateThumbnail({ projectId: "p_1", concept, format: "yt-long" })
    ).rejects.toThrow(/no thumbnail/);

    expect(storageMocks.storeFromUrl).not.toHaveBeenCalled();
  });
});
