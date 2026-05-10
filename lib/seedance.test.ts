import { describe, it, expect, vi, beforeEach } from "vitest";

const subscribeMock = vi.hoisted(() => vi.fn());
const createFalClientMock = vi.hoisted(() =>
  vi.fn(() => ({ subscribe: subscribeMock, queue: {} as unknown }))
);

vi.mock("@fal-ai/client", () => ({
  createFalClient: createFalClientMock,
}));

import { generateVideo, __resetSeedanceForTests } from "./seedance";
import { withOperator, type Operator } from "./operators";

const britok: Operator = {
  email: "britok30@gmail.com",
  falKey: "fal-key",
  anthropicKey: "ak",
  apps: [{ name: "ArchitectGPT", url: "https://x" }],
};

beforeEach(() => {
  subscribeMock.mockReset();
  createFalClientMock.mockClear();
  __resetSeedanceForTests();
});

const okResponse = {
  data: { video: { url: "https://fal.media/seedance-out.mp4" } },
  requestId: "req_seed_abc",
};

describe("generateVideo", () => {
  it("calls bytedance/seedance-2.0/fast/image-to-video with required params", async () => {
    subscribeMock.mockResolvedValue(okResponse);

    await withOperator(britok, () =>
      generateVideo({
        imageUrl: "https://blob.example/in.jpg",
        motionPrompt: "Slow dolly-in toward the back of the room.",
      })
    );

    const [endpoint, args] = subscribeMock.mock.calls[0];
    expect(endpoint).toBe("bytedance/seedance-2.0/fast/image-to-video");
    expect(args.input.prompt).toBe("Slow dolly-in toward the back of the room.");
    expect(args.input.image_url).toBe("https://blob.example/in.jpg");
    expect(args.logs).toBe(false);
  });

  it("defaults: duration=4, resolution=720p, aspect=9:16", async () => {
    subscribeMock.mockResolvedValue(okResponse);

    await withOperator(britok, () =>
      generateVideo({ imageUrl: "https://x", motionPrompt: "p" })
    );

    const args = subscribeMock.mock.calls[0][1];
    expect(args.input.duration).toBe("4");
    expect(args.input.resolution).toBe("720p");
    expect(args.input.aspect_ratio).toBe("9:16");
  });

  it("forwards overrides for duration, resolution, aspect, seed", async () => {
    subscribeMock.mockResolvedValue(okResponse);

    await withOperator(britok, () =>
      generateVideo({
        imageUrl: "https://x",
        motionPrompt: "p",
        durationSec: 6,
        resolution: "1080p",
        aspectRatio: "16:9",
        seed: 12345,
      })
    );

    const args = subscribeMock.mock.calls[0][1];
    expect(args.input.duration).toBe("6");
    expect(args.input.resolution).toBe("1080p");
    expect(args.input.aspect_ratio).toBe("16:9");
    expect(args.input.seed).toBe(12345);
  });

  it("omits seed when not provided", async () => {
    subscribeMock.mockResolvedValue(okResponse);
    await withOperator(britok, () =>
      generateVideo({ imageUrl: "https://x", motionPrompt: "p" })
    );
    const args = subscribeMock.mock.calls[0][1];
    expect(args.input.seed).toBeUndefined();
  });

  it("returns videoUrl + requestId", async () => {
    subscribeMock.mockResolvedValue(okResponse);
    const out = await withOperator(britok, () =>
      generateVideo({ imageUrl: "https://x", motionPrompt: "p" })
    );
    expect(out).toEqual({
      videoUrl: "https://fal.media/seedance-out.mp4",
      requestId: "req_seed_abc",
    });
  });

  it("throws when seedance returns no video url", async () => {
    subscribeMock.mockResolvedValue({ data: { video: { url: undefined } }, requestId: "r" });
    await expect(
      withOperator(britok, () => generateVideo({ imageUrl: "https://x", motionPrompt: "p" }))
    ).rejects.toThrow(/no video url/);
  });

  it("uses the per-operator fal client", async () => {
    subscribeMock.mockResolvedValue(okResponse);
    await withOperator(britok, () =>
      generateVideo({ imageUrl: "https://x", motionPrompt: "p" })
    );
    expect(createFalClientMock).toHaveBeenCalledExactlyOnceWith({
      credentials: "fal-key",
    });
  });

  it("throws when called outside any operator scope", async () => {
    await expect(
      generateVideo({ imageUrl: "https://x", motionPrompt: "p" })
    ).rejects.toThrow(/No operator in current context/);
  });
});
