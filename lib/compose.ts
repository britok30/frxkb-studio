import { createFalClient, type FalClient } from "@fal-ai/client";
import { currentOperator } from "@/lib/operators";

// ── fal ffmpeg-api/compose ───────────────────────────────────────────────────
//
// Timeline-based server-side stitching: tracks (video | audio | image) made of
// keyframes { timestamp, duration, url } in milliseconds. Semantics verified
// live 2026-07-17, corrected 2026-07-23:
//   - ONE video track only ("Multiple video tracks are not supported") — and
//     an image track COUNTS as a video track for this rule.
//   - An image URL inside a `video` track renders ~1 FRAME regardless of its
//     keyframe duration (NOT a held still). Stills belong on a `type:"image"`
//     track, which honors durations (with 2+ keyframes; a single-keyframe
//     image track collapses to one frame).
//   - Per-clip embedded audio concatenates through when no audio track is set.
//   - An audio track REPLACES the clips' embedded audio outright (no mixing),
//     and audio keyframes are never trimmed to their stated duration.
// Billed $0.0002 per second of output — rounding error next to seedance.

export type ComposeKeyframe = {
  /** Start position on the output timeline, in ms. */
  timestamp: number;
  /** How long this keyframe plays, in ms. */
  duration: number;
  /** Media URL — video clip or still image for the video track, audio file
   *  for an audio track. */
  url: string;
};

export type ComposeTrack = {
  id: string;
  type: "video" | "audio" | "image";
  keyframes: ComposeKeyframe[];
};

export type ComposeOutput = {
  videoUrl: string;
  thumbnailUrl: string | null;
  requestId: string;
};

// One client per operator, same pattern as lib/fal.ts / lib/seedance.ts.
const clientCache = new Map<string, FalClient>();

function clientForOperator(): FalClient {
  const op = currentOperator();
  let client = clientCache.get(op.email);
  if (!client) {
    client = createFalClient({ credentials: op.falKey });
    clientCache.set(op.email, client);
  }
  return client;
}

/** Test-only: clear the cache. */
export function __resetComposeForTests(): void {
  clientCache.clear();
}

function composeError(err: unknown): Error {
  // fal's ValidationError message is a bare "Unprocessable Entity" — the
  // actionable part (e.g. "Could not download <url>") hides in body.detail.
  const detail = (err as { body?: { detail?: unknown } })?.body?.detail;
  if (detail) {
    const msg = err instanceof Error ? err.message : "compose failed";
    return new Error(`${msg}: ${JSON.stringify(detail).slice(0, 500)}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

function isDownloadFailure(err: unknown): boolean {
  const detail = (err as { body?: { detail?: unknown } })?.body?.detail;
  return JSON.stringify(detail ?? "").includes("Could not download");
}

/**
 * Mirror every distinct non-fal media URL in the tracks onto fal's own
 * storage and return rewritten tracks. Used as a retry path: fal's fetcher
 * intermittently fails against Vercel Blob URLs (observed wholesale on
 * 2026-07-21 while Shotstack read the same files fine) — but it can always
 * read its own storage.
 */
async function mirrorTracksToFalStorage(
  client: FalClient,
  tracks: ComposeTrack[]
): Promise<ComposeTrack[]> {
  const urls = new Set<string>();
  for (const t of tracks) {
    for (const k of t.keyframes) {
      if (!/(^https?:\/\/)([^/]*\.)?fal\.(media|ai)\//.test(k.url)) urls.add(k.url);
    }
  }
  const mirrored = new Map<string, string>();
  // Sequential on purpose — the biggest input (a rendered cycle video) can
  // run tens of MB and we'd rather not hold several in memory at once.
  for (const url of urls) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Mirror download failed (${res.status}): ${url}`);
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const name = new URL(url).pathname.split("/").pop() || "asset";
    const file = new File([await res.arrayBuffer()], name, { type: contentType });
    mirrored.set(url, await client.storage.upload(file));
  }
  return tracks.map((t) => ({
    ...t,
    keyframes: t.keyframes.map((k) => ({ ...k, url: mirrored.get(k.url) ?? k.url })),
  }));
}

export async function composeVideo(tracks: ComposeTrack[]): Promise<ComposeOutput> {
  const client = clientForOperator();
  let result;
  try {
    result = await client.subscribe("fal-ai/ffmpeg-api/compose", {
      input: { tracks },
      logs: false,
    });
  } catch (err) {
    if (!isDownloadFailure(err)) throw composeError(err);
    // fal couldn't fetch an input (its Blob fetcher is flaky even on URLs
    // that curl fine). Re-serve everything from fal's own storage and retry
    // once — the happy path never pays this transfer.
    console.warn("[compose] fal could not download an input; retrying via fal storage:", composeError(err).message);
    const rehosted = await mirrorTracksToFalStorage(client, tracks);
    try {
      result = await client.subscribe("fal-ai/ffmpeg-api/compose", {
        input: { tracks: rehosted },
        logs: false,
      });
    } catch (retryErr) {
      throw composeError(retryErr);
    }
  }
  const data = result.data as { video_url?: string; thumbnail_url?: string };
  if (!data?.video_url) throw new Error("compose returned no video url");
  return {
    videoUrl: data.video_url,
    thumbnailUrl: data.thumbnail_url ?? null,
    requestId: result.requestId,
  };
}
