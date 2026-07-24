// Shotstack render API — the transition-capable stitch backend. Same
// timeline mental model as fal compose (tracks → clips with start/length)
// but with the two things fal's ffmpeg API can't do: crossfades between
// clips and Ken Burns motion on stills.
//
// Keys are PER OPERATOR (operator.shotstackKey / shotstackEnv, sourced from
// SHOTSTACK_KEY_<OPERATOR> env vars in lib/operators.ts) so each operator's
// renders bill to their own Shotstack account — same isolation model as the
// fal and OpenAI keys. An operator without a key falls back to fal compose
// (hard cuts) automatically.

import { currentOperator } from "@/lib/operators";

export type ShotstackClip = {
  asset:
    | { type: "video"; src: string; volume?: number }
    | { type: "image"; src: string }
    | { type: "audio"; src: string; volume?: number };
  /** Start on the output timeline, in SECONDS (Shotstack convention). */
  start: number;
  length: number;
  /** Transition at the clip's boundaries — "fade" on adjacent clips blends
   *  them into a crossfade without changing overall timing. */
  transition?: { in?: string; out?: string };
  /** Motion effect for image assets (Ken Burns): zoomInSlow, zoomOutSlow,
   *  slideLeftSlow, … */
  effect?: string;
  fit?: "crop" | "cover" | "contain";
};

export type ShotstackEdit = {
  timeline: {
    background?: string;
    soundtrack?: { src: string; effect?: string; volume?: number };
    tracks: { clips: ShotstackClip[] }[];
  };
  output: {
    format: "mp4";
    size: { width: number; height: number };
    fps?: number;
    /** Encoder quality preset — "high" lands ~14-17 Mbps at 1080p. */
    quality?: "verylow" | "low" | "medium" | "high" | "veryhigh";
  };
};

export function isShotstackConfigured(): boolean {
  return !!currentOperator().shotstackKey;
}

function apiBase(): string {
  const env = currentOperator().shotstackEnv === "stage" ? "stage" : "v1";
  return `https://api.shotstack.io/${env}`;
}

/** Effective per-minute price for spend bookkeeping (PAYG $0.30/min). */
export const SHOTSTACK_PER_MINUTE = 0.3;

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Submit an edit and poll until the render lands. Returns the hosted MP4
 * URL (ephemeral on Shotstack's CDN — caller re-hosts on Blob, same as the
 * fal path).
 */
export async function renderShotstack(edit: ShotstackEdit): Promise<{ videoUrl: string }> {
  const apiKey = currentOperator().shotstackKey;
  if (!apiKey) throw new Error("No Shotstack key configured for this operator");

  const submit = await fetch(`${apiBase()}/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify(edit),
  });
  if (!submit.ok) {
    const body = await submit.text().catch(() => "");
    throw new Error(`Shotstack submit failed (${submit.status}): ${body.slice(0, 300)}`);
  }
  const submitted = (await submit.json()) as { response?: { id?: string } };
  const id = submitted.response?.id;
  if (!id) throw new Error("Shotstack returned no render id");

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const res = await fetch(`${apiBase()}/render/${id}`, {
      headers: { "x-api-key": apiKey },
    });
    if (!res.ok) continue; // transient poll failure — keep waiting
    const data = (await res.json()) as {
      response?: { status?: string; url?: string; error?: string };
    };
    const status = data.response?.status;
    if (status === "done" && data.response?.url) {
      return { videoUrl: data.response.url };
    }
    if (status === "failed") {
      throw new Error(`Shotstack render failed: ${data.response?.error ?? "unknown error"}`);
    }
  }
  throw new Error("Shotstack render timed out after 5 minutes");
}
