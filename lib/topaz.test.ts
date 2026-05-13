import { describe, it, expect, vi, beforeEach } from "vitest";

const subscribeMock = vi.hoisted(() => vi.fn());
const createFalClientMock = vi.hoisted(() =>
  vi.fn(() => ({ subscribe: subscribeMock, queue: {} as unknown }))
);

vi.mock("@fal-ai/client", () => ({
  createFalClient: createFalClientMock,
}));

import { upscaleVideo, __resetTopazForTests } from "./topaz";
import { withOperator, type Operator } from "./operators";

const britok: Operator = {
  email: "britok30@gmail.com",
  falKey: "fal-key",
  anthropicKey: "ak",
  apps: [{ name: "ArchitectGPT", url: "https://x", handle: "architectgpt" }],
  worldTypes: ["interior", "exterior"],
};

beforeEach(() => {
  subscribeMock.mockReset();
  createFalClientMock.mockClear();
  __resetTopazForTests();
});

const okResponse = {
  data: { video: { url: "https://fal.media/topaz-out.mp4" } },
  requestId: "req_topaz_abc",
};

describe("upscaleVideo", () => {
  it("calls fal-ai/topaz/upscale/video with Proteus + 2× + 60fps interpolation by default", async () => {
    subscribeMock.mockResolvedValue(okResponse);

    await withOperator(britok, () =>
      upscaleVideo({ videoUrl: "https://blob.example/in.mp4" })
    );

    const [endpoint, args] = subscribeMock.mock.calls[0];
    expect(endpoint).toBe("fal-ai/topaz/upscale/video");
    expect(args.input.video_url).toBe("https://blob.example/in.mp4");
    expect(args.input.model).toBe("Proteus");
    expect(args.input.upscale_factor).toBe(2);
    expect(args.input.H264_output).toBe(true);
    // Apollo frame interp: bumps seedance's 24fps output to 60fps so motion
    // doesn't read as janky on smooth pans.
    expect(args.input.target_fps).toBe(60);
    expect(args.logs).toBe(false);
  });

  it("omits target_fps when targetFps=0 (interpolation disabled)", async () => {
    subscribeMock.mockResolvedValue(okResponse);

    await withOperator(britok, () =>
      upscaleVideo({ videoUrl: "https://x", targetFps: 0 })
    );

    expect(subscribeMock.mock.calls[0][1].input.target_fps).toBeUndefined();
  });

  it("forwards a custom targetFps", async () => {
    subscribeMock.mockResolvedValue(okResponse);

    await withOperator(britok, () =>
      upscaleVideo({ videoUrl: "https://x", targetFps: 48 })
    );

    expect(subscribeMock.mock.calls[0][1].input.target_fps).toBe(48);
  });

  it("forwards model + upscaleFactor overrides", async () => {
    subscribeMock.mockResolvedValue(okResponse);

    await withOperator(britok, () =>
      upscaleVideo({
        videoUrl: "https://x",
        model: "Artemis HQ",
        upscaleFactor: 4,
      })
    );

    const args = subscribeMock.mock.calls[0][1];
    expect(args.input.model).toBe("Artemis HQ");
    expect(args.input.upscale_factor).toBe(4);
  });

  it("includes compression + recover_detail only when provided", async () => {
    subscribeMock.mockResolvedValue(okResponse);

    await withOperator(britok, () =>
      upscaleVideo({ videoUrl: "https://x", compression: 0.4, recoverDetail: 0.6 })
    );
    const args = subscribeMock.mock.calls[0][1];
    expect(args.input.compression).toBe(0.4);
    expect(args.input.recover_detail).toBe(0.6);

    subscribeMock.mockClear();
    await withOperator(britok, () => upscaleVideo({ videoUrl: "https://y" }));
    const args2 = subscribeMock.mock.calls[0][1];
    expect(args2.input.compression).toBeUndefined();
    expect(args2.input.recover_detail).toBeUndefined();
  });

  it("returns videoUrl + requestId", async () => {
    subscribeMock.mockResolvedValue(okResponse);
    const out = await withOperator(britok, () => upscaleVideo({ videoUrl: "https://x" }));
    expect(out).toEqual({
      videoUrl: "https://fal.media/topaz-out.mp4",
      requestId: "req_topaz_abc",
    });
  });

  it("throws when topaz returns no video url", async () => {
    subscribeMock.mockResolvedValue({ data: {}, requestId: "r" });
    await expect(
      withOperator(britok, () => upscaleVideo({ videoUrl: "https://x" }))
    ).rejects.toThrow(/no video url/);
  });

  it("throws when called outside an operator scope", async () => {
    await expect(upscaleVideo({ videoUrl: "https://x" })).rejects.toThrow(
      /No operator in current context/
    );
  });
});
