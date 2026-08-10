import { describe, it, expect, vi, beforeEach } from "vitest";

const subscribeMock = vi.hoisted(() => vi.fn());
const createFalClientMock = vi.hoisted(() =>
  vi.fn(() => ({ subscribe: subscribeMock, queue: {} as unknown }))
);

vi.mock("@fal-ai/client", () => ({
  createFalClient: createFalClientMock,
}));

import { upscaleVideoSeedVR, __resetSeedVRForTests } from "./seedvr";
import { withOperator, type Operator } from "./operators";

const britok: Operator = {
  email: "britok30@gmail.com",
  falKey: "fal-key",
  openaiKey: "ak",
  apps: [{ name: "ArchitectGPT", url: "https://x", handle: "architectgpt" }],
  worldTypes: ["interior", "exterior"],
  propertyTypes: ["residential", "commercial"],
  socials: { instagram: "architectgpt", website: "https://www.architectgpt.io" },
};

beforeEach(() => {
  subscribeMock.mockReset();
  createFalClientMock.mockClear();
  __resetSeedVRForTests();
});

const okResponse = {
  data: { video: { url: "https://fal.media/seedvr-out.mp4" } },
  requestId: "req_seedvr_abc",
};

describe("upscaleVideoSeedVR", () => {
  it("targets 2160p mp4 at high quality by default — the crisp pipeline's 4K supersample", async () => {
    subscribeMock.mockResolvedValue(okResponse);

    const out = await withOperator(britok, () =>
      upscaleVideoSeedVR({ videoUrl: "https://blob.example/in.mp4" })
    );

    const [endpoint, args] = subscribeMock.mock.calls[0];
    expect(endpoint).toBe("fal-ai/seedvr/upscale/video");
    expect(args.input.video_url).toBe("https://blob.example/in.mp4");
    expect(args.input.upscale_mode).toBe("target");
    expect(args.input.target_resolution).toBe("2160p");
    expect(args.input.output_format).toBe("X264 (.mp4)");
    expect(args.input.output_quality).toBe("high");
    expect(out).toEqual({
      videoUrl: "https://fal.media/seedvr-out.mp4",
      requestId: "req_seedvr_abc",
    });
  });

  it("forwards a resolution override + seed, and throws when fal returns no url", async () => {
    subscribeMock.mockResolvedValue(okResponse);
    await withOperator(britok, () =>
      upscaleVideoSeedVR({
        videoUrl: "https://x",
        targetResolution: "1440p",
        seed: 7,
      })
    );
    expect(subscribeMock.mock.calls[0][1].input.target_resolution).toBe("1440p");
    expect(subscribeMock.mock.calls[0][1].input.seed).toBe(7);

    subscribeMock.mockResolvedValue({ data: {}, requestId: "r" });
    await withOperator(britok, async () => {
      await expect(upscaleVideoSeedVR({ videoUrl: "https://x" })).rejects.toThrow(
        /no video url/
      );
    });
  });
});
