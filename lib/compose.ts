import { createFalClient, type FalClient } from "@fal-ai/client";
import { currentOperator } from "@/lib/operators";

// ── fal ffmpeg-api/compose ───────────────────────────────────────────────────
//
// Timeline-based server-side stitching: tracks (video | audio | image) made of
// keyframes { timestamp, duration, url } in milliseconds. Semantics verified
// live 2026-07-17:
//   - ONE video track only ("Multiple video tracks are not supported") — but
//     image URLs are valid keyframes INSIDE a video track (still → clip works).
//   - Per-clip embedded audio concatenates through when no audio track is set.
//   - An audio track REPLACES the clips' embedded audio outright (no mixing).
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

export async function composeVideo(tracks: ComposeTrack[]): Promise<ComposeOutput> {
  const client = clientForOperator();
  const result = await client.subscribe("fal-ai/ffmpeg-api/compose", {
    input: { tracks },
    logs: false,
  });
  const data = result.data as { video_url?: string; thumbnail_url?: string };
  if (!data?.video_url) throw new Error("compose returned no video url");
  return {
    videoUrl: data.video_url,
    thumbnailUrl: data.thumbnail_url ?? null,
    requestId: result.requestId,
  };
}
