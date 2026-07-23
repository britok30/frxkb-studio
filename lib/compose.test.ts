import { describe, it, expect, vi, beforeEach } from "vitest";

const falMocks = vi.hoisted(() => ({
  subscribe: vi.fn(),
  upload: vi.fn(),
}));

vi.mock("@fal-ai/client", () => ({
  createFalClient: () => ({
    subscribe: falMocks.subscribe,
    storage: { upload: falMocks.upload },
  }),
}));

vi.mock("@/lib/operators", () => ({
  currentOperator: () => ({ email: "op@test.dev", falKey: "key" }),
}));

import { composeVideo, __resetComposeForTests, type ComposeTrack } from "./compose";

function downloadError(url: string) {
  const err = new Error("Unprocessable Entity");
  (err as unknown as { body: unknown }).body = {
    detail: [
      { loc: ["body", "url"], msg: `Could not download ${url}, please provide a valid url`, type: "value_error" },
    ],
  };
  return err;
}

const TRACKS: ComposeTrack[] = [
  {
    id: "video",
    type: "video",
    keyframes: [
      { timestamp: 0, duration: 5000, url: "https://blob.vercel-storage.com/a.jpg" },
      { timestamp: 5000, duration: 5000, url: "https://blob.vercel-storage.com/a.jpg" },
      { timestamp: 10000, duration: 5000, url: "https://fal.media/files/native.mp4" },
    ],
  },
  {
    id: "music",
    type: "audio",
    keyframes: [{ timestamp: 0, duration: 15000, url: "https://blob.vercel-storage.com/song.mp3" }],
  },
];

beforeEach(() => {
  __resetComposeForTests();
  falMocks.subscribe.mockReset();
  falMocks.upload.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(4),
      headers: new Headers({ "content-type": "application/octet-stream" }),
    })
  );
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("composeVideo download-failure retry", () => {
  it("mirrors non-fal URLs to fal storage and retries once when fal can't download an input", async () => {
    falMocks.subscribe
      .mockRejectedValueOnce(downloadError("https://blob.vercel-storage.com/a.jpg"))
      .mockResolvedValueOnce({ data: { video_url: "https://fal.media/out.mp4" }, requestId: "r2" });
    falMocks.upload
      .mockResolvedValueOnce("https://fal.media/storage/a.jpg")
      .mockResolvedValueOnce("https://fal.media/storage/song.mp3");

    const out = await composeVideo(TRACKS);

    expect(out.videoUrl).toBe("https://fal.media/out.mp4");
    // Two distinct non-fal URLs mirrored (the repeated keyframe dedupes).
    expect(falMocks.upload).toHaveBeenCalledTimes(2);
    const retryTracks = falMocks.subscribe.mock.calls[1][1].input.tracks;
    expect(retryTracks[0].keyframes[0].url).toBe("https://fal.media/storage/a.jpg");
    expect(retryTracks[0].keyframes[1].url).toBe("https://fal.media/storage/a.jpg");
    // Already-fal URLs are left alone.
    expect(retryTracks[0].keyframes[2].url).toBe("https://fal.media/files/native.mp4");
    expect(retryTracks[1].keyframes[0].url).toBe("https://fal.media/storage/song.mp3");
  });

  it("does NOT retry on non-download validation errors — surfaces the detail", async () => {
    const err = new Error("Unprocessable Entity");
    (err as unknown as { body: unknown }).body = {
      detail: [{ msg: "tracks must not be empty", type: "value_error" }],
    };
    falMocks.subscribe.mockRejectedValue(err);

    await expect(composeVideo(TRACKS)).rejects.toThrow(/tracks must not be empty/);
    expect(falMocks.upload).not.toHaveBeenCalled();
    expect(falMocks.subscribe).toHaveBeenCalledTimes(1);
  });

  it("surfaces the detail when the retry also fails", async () => {
    falMocks.subscribe.mockRejectedValue(downloadError("https://blob.vercel-storage.com/a.jpg"));
    falMocks.upload.mockResolvedValue("https://fal.media/storage/x");

    await expect(composeVideo(TRACKS)).rejects.toThrow(/Could not download/);
    expect(falMocks.subscribe).toHaveBeenCalledTimes(2);
  });
});
