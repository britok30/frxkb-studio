import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const editMock = vi.hoisted(() => vi.fn());
const OpenAIMock = vi.hoisted(() =>
  vi.fn(function () {
    return { images: { edit: editMock } };
  })
);
vi.mock("openai", () => ({
  default: OpenAIMock,
  toFile: vi.fn(async (buf: Buffer, name: string, opts: { type: string }) => ({
    name,
    type: opts.type,
    size: buf.length,
  })),
}));

import { stageImage, stagingSizeFor, STAGING_IMAGE_MODEL, __resetOpenAIImageForTests } from "./openai-image";
import { withOperator, type Operator } from "./operators";

const op: Operator = {
  email: "britok30@gmail.com",
  falKey: "fal",
  openaiKey: "ok-britok",
  apps: [{ name: "ArchitectGPT", url: "https://x", handle: "architectgpt" }],
  worldTypes: ["interior", "exterior"],
  propertyTypes: ["residential", "commercial"],
  socials: { instagram: "architectgpt", website: "https://www.architectgpt.io" },
};

const realFetch = globalThis.fetch;

beforeEach(() => {
  editMock.mockReset();
  OpenAIMock.mockClear();
  __resetOpenAIImageForTests();
  globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    return new Response(Buffer.from(`bytes-of-${u}`), {
      status: 200,
      headers: { "content-type": u.endsWith(".png") ? "image/png" : "image/jpeg" },
    });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("stagingSizeFor", () => {
  it("matches the upload's aspect with a 16-divisible ~2K canvas", () => {
    expect(stagingSizeFor("4:3")).toBe("2048x1536");
    expect(stagingSizeFor("16:9")).toBe("2048x1152");
    expect(stagingSizeFor("9:16")).toBe("1152x2048");
    expect(stagingSizeFor("1:1")).toBe("1536x1536");
    for (const a of ["4:3", "3:4", "16:9", "9:16", "1:1"] as const) {
      const [w, h] = stagingSizeFor(a).split("x").map(Number);
      expect(w % 16).toBe(0);
      expect(h % 16).toBe(0);
    }
  });
});

describe("stageImage", () => {
  it("edits with gpt-image-2.5-sunburst: room photo first, furniture refs after, high input fidelity", async () => {
    editMock.mockResolvedValue({ data: [{ b64_json: Buffer.from("jpeg!").toString("base64") }] });

    const out = await withOperator(op, () =>
      stageImage({
        beforeUrl: "https://blob.example/room.jpg",
        furnitureReferenceUrls: ["https://blob.example/sofa.png", "https://blob.example/lamp.jpg"],
        prompt: "Furnish this living room…",
        aspectRatio: "4:3",
      })
    );

    expect(out.buffer.toString()).toBe("jpeg!");
    expect(out.contentType).toBe("image/jpeg");
    expect(out.model).toBe(STAGING_IMAGE_MODEL);
    expect(OpenAIMock).toHaveBeenCalledWith({ apiKey: "ok-britok" });
    const args = editMock.mock.calls[0][0];
    expect(args.model).toBe("gpt-image-2.5-sunburst");
    expect(args.input_fidelity).toBe("high");
    expect(args.quality).toBe("high");
    expect(args.size).toBe("2048x1536");
    expect(args.output_format).toBe("jpeg");
    expect(args.image.map((f: { name: string }) => f.name)).toEqual([
      "room.jpg",
      "furniture-1.png",
      "furniture-2.jpg",
    ]);
  });

  it("throws a re-upload hint when the room photo can't be fetched", async () => {
    globalThis.fetch = vi.fn(async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    await expect(
      withOperator(op, () =>
        stageImage({ beforeUrl: "https://blob.example/gone.jpg", prompt: "x", aspectRatio: "1:1" })
      )
    ).rejects.toThrow(/Couldn't download room \(404\)/);
    expect(editMock).not.toHaveBeenCalled();
  });

  it("throws when the model returns no image", async () => {
    editMock.mockResolvedValue({ data: [] });
    await expect(
      withOperator(op, () =>
        stageImage({ beforeUrl: "https://blob.example/room.jpg", prompt: "x", aspectRatio: "1:1" })
      )
    ).rejects.toThrow(/returned no image/);
  });
});
