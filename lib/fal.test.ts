import { describe, it, expect, vi, beforeEach } from "vitest";

const subscribeMock = vi.hoisted(() => vi.fn());
const createFalClientMock = vi.hoisted(() =>
  vi.fn(() => ({
    subscribe: subscribeMock,
    queue: {} as unknown,
  }))
);

vi.mock("@fal-ai/client", () => ({
  createFalClient: createFalClientMock,
}));

import { editImage, generateImage, __resetFalForTests } from "./fal";
import { withOperator, type Operator } from "./operators";

const britok: Operator = {
  email: "britok30@gmail.com",
  falKey: "fal-britok-key",
  openaiKey: "ak",
  apps: [{ name: "ArchitectGPT", url: "https://x", handle: "architectgpt" }],
  worldTypes: ["interior", "exterior"],
  propertyTypes: ["residential", "commercial"],
  socials: { instagram: "architectgpt", website: "https://www.architectgpt.io" },
};

const fremy: Operator = {
  email: "fremyrosso1@gmail.com",
  falKey: "fal-fremy-key",
  openaiKey: "ak",
  apps: [{ name: "InteriorGPT", url: "https://x", handle: "interiorgpt" }],
  worldTypes: ["interior"],
  propertyTypes: ["residential"],
  socials: { instagram: "interiordesigngpt", website: "https://www.aiinterior.design" },
};

beforeEach(() => {
  subscribeMock.mockReset();
  createFalClientMock.mockClear();
  __resetFalForTests();
});

function fakeResponse(
  overrides: Partial<{
    images: { url: string; content_type?: string }[];
    description: string;
    requestId: string;
  }> = {}
) {
  return {
    data: {
      images: overrides.images ?? [{ url: "https://fal.media/x.jpg", content_type: "image/jpeg" }],
      description: overrides.description ?? "A modernist living room.",
    },
    requestId: overrides.requestId ?? "req_abc123",
  };
}

describe("generateImage (operator-scoped)", () => {
  it("creates a FalClient with the current operator's key on first call", async () => {
    subscribeMock.mockResolvedValue(fakeResponse());

    await withOperator(britok, () => generateImage({ prompt: "a kitchen" }));

    expect(createFalClientMock).toHaveBeenCalledExactlyOnceWith({
      credentials: "fal-britok-key",
    });
  });

  it("calls fal-ai/nano-banana-pro with default params (2K, png, 1:1)", async () => {
    subscribeMock.mockResolvedValue(fakeResponse());

    await withOperator(britok, () => generateImage({ prompt: "a kitchen" }));

    expect(subscribeMock).toHaveBeenCalledTimes(1);
    const [endpoint, args] = subscribeMock.mock.calls[0];
    expect(endpoint).toBe("fal-ai/nano-banana-pro");
    expect(args.input.prompt).toBe("a kitchen");
    expect(args.input.num_images).toBe(1);
    expect(args.input.output_format).toBe("png");
    expect(args.input.aspect_ratio).toBe("1:1");
    expect(args.input.resolution).toBe("2K");
    expect(args.logs).toBe(false);
  });

  it("passes aspect_ratio as a native API param (Pro accepts it directly)", async () => {
    subscribeMock.mockResolvedValue(fakeResponse());

    await withOperator(britok, () =>
      generateImage({ prompt: "a kitchen", aspectRatio: "16:9" })
    );

    const args = subscribeMock.mock.calls[0][1];
    // Prompt is sent as-is — no more "[Aspect ratio: ...]" injection.
    expect(args.input.prompt).toBe("a kitchen");
    expect(args.input.aspect_ratio).toBe("16:9");
  });

  it("forwards numImages, outputFormat, and resolution overrides", async () => {
    subscribeMock.mockResolvedValue(fakeResponse());

    await withOperator(britok, () =>
      generateImage({ prompt: "x", numImages: 3, outputFormat: "jpeg", resolution: "2K" })
    );

    const args = subscribeMock.mock.calls[0][1];
    expect(args.input.num_images).toBe(3);
    expect(args.input.output_format).toBe("jpeg");
    expect(args.input.resolution).toBe("2K");
  });

  it("normalizes images, description, and requestId in the response", async () => {
    subscribeMock.mockResolvedValue(
      fakeResponse({
        images: [
          { url: "https://fal.media/a.jpg", content_type: "image/jpeg" },
          { url: "https://fal.media/b.png", content_type: "image/png" },
        ],
        description: "Two scenes.",
        requestId: "req_xyz",
      })
    );

    const out = await withOperator(britok, () =>
      generateImage({ prompt: "x", numImages: 2 })
    );

    expect(out).toEqual({
      images: [
        { url: "https://fal.media/a.jpg", contentType: "image/jpeg" },
        { url: "https://fal.media/b.png", contentType: "image/png" },
      ],
      description: "Two scenes.",
      requestId: "req_xyz",
    });
  });

  it("propagates errors from fal", async () => {
    subscribeMock.mockRejectedValue(new Error("fal exploded"));

    await expect(
      withOperator(britok, () => generateImage({ prompt: "x" }))
    ).rejects.toThrow("fal exploded");
  });

  it("throws when called outside any operator scope", async () => {
    await expect(generateImage({ prompt: "x" })).rejects.toThrow(/No operator in current context/);
    expect(createFalClientMock).not.toHaveBeenCalled();
  });

  it("caches one FalClient per operator and reuses it across calls", async () => {
    subscribeMock.mockResolvedValue(fakeResponse());

    await withOperator(britok, async () => {
      await generateImage({ prompt: "a" });
      await generateImage({ prompt: "b" });
      await generateImage({ prompt: "c" });
    });

    // Three subscribe calls, but only one client construction.
    expect(subscribeMock).toHaveBeenCalledTimes(3);
    expect(createFalClientMock).toHaveBeenCalledExactlyOnceWith({
      credentials: "fal-britok-key",
    });
  });

  it("creates a separate client for a different operator", async () => {
    subscribeMock.mockResolvedValue(fakeResponse());

    await withOperator(britok, () => generateImage({ prompt: "x" }));
    await withOperator(fremy, () => generateImage({ prompt: "x" }));

    expect(createFalClientMock).toHaveBeenCalledTimes(2);
    expect(createFalClientMock).toHaveBeenNthCalledWith(1, { credentials: "fal-britok-key" });
    expect(createFalClientMock).toHaveBeenNthCalledWith(2, { credentials: "fal-fremy-key" });
  });
});

describe("editImage", () => {
  it("calls fal-ai/nano-banana-pro/edit with image_urls + prompt", async () => {
    subscribeMock.mockResolvedValue(fakeResponse());

    await withOperator(britok, () =>
      editImage({
        prompt: "wide shot of an adjacent room",
        imageUrls: ["https://blob.example/anchor.jpg"],
        aspectRatio: "9:16",
      })
    );

    expect(subscribeMock).toHaveBeenCalledTimes(1);
    const [endpoint, args] = subscribeMock.mock.calls[0];
    expect(endpoint).toBe("fal-ai/nano-banana-pro/edit");
    expect(args.input.prompt).toBe("wide shot of an adjacent room");
    expect(args.input.image_urls).toEqual(["https://blob.example/anchor.jpg"]);
    expect(args.input.aspect_ratio).toBe("9:16");
    expect(args.input.resolution).toBe("2K");
    expect(args.logs).toBe(false);
  });

  it("accepts up to 14 reference images and forwards them all", async () => {
    subscribeMock.mockResolvedValue(fakeResponse());
    const urls = Array.from({ length: 14 }, (_, i) => `https://blob.example/${i}.jpg`);

    await withOperator(britok, () =>
      editImage({ prompt: "x", imageUrls: urls, aspectRatio: "1:1" })
    );

    expect(subscribeMock.mock.calls[0][1].input.image_urls).toEqual(urls);
  });

  it("rejects 0 reference images at the call site (not the API's job to validate)", async () => {
    await expect(
      withOperator(britok, () => editImage({ prompt: "x", imageUrls: [] }))
    ).rejects.toThrow(/at least one reference/i);
    expect(subscribeMock).not.toHaveBeenCalled();
  });

  it("rejects more than 14 reference images at the call site", async () => {
    const urls = Array.from({ length: 15 }, (_, i) => `https://blob.example/${i}.jpg`);
    await expect(
      withOperator(britok, () => editImage({ prompt: "x", imageUrls: urls }))
    ).rejects.toThrow(/up to 14/i);
    expect(subscribeMock).not.toHaveBeenCalled();
  });
});
