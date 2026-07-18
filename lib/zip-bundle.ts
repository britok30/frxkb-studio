"use client";

import JSZip from "jszip";
import { saveAs } from "file-saver";
import { MANIFEST_VERSION_CLIENT } from "./manifest-version";
import type { Metadata } from "@/lib/prompts/metadata";

export type SceneAsset = {
  order: number;
  imageUrl: string;
  /** When set, the scene is animated — bundle includes the mp4 alongside (or
   *  instead of) the still. */
  videoUrl?: string | null;
  prompt: string;
  durationSec: number | null;
  /** Style-explorer card copy (title + subtitle for the operator's CapCut cards). */
  styleName?: string | null;
  styleSubtitle?: string | null;
};

export type BundleData = {
  projectId: string;
  title: string;
  niche: string;
  format: string;
  thumbnailUrl: string;
  /** Stitched ready-to-post MP4 (when the operator ran Stitch). Packed as
   *  final.mp4 at the zip root. */
  finalVideoUrl?: string | null;
  scenes: SceneAsset[];
  metadata: Metadata;
};

/**
 * Fetch every Blob URL in the bundle, pack into a zip, and trigger a browser
 * download. Runs entirely client-side — Vercel function size limits don't
 * apply because the response goes to the user's machine, not back through
 * our serverless function.
 */
export async function downloadBundle(
  data: BundleData,
  opts: { onProgress?: (done: number, total: number) => void } = {}
): Promise<void> {
  const zip = new JSZip();
  // Each scene contributes 1 fetch (still OR video — animated scenes still
  // ship the still as a poster fallback though), plus 1 for the thumbnail.
  // We fetch BOTH still and video for animated scenes so the operator has
  // each as a backup.
  const fetchUnits =
    data.scenes.reduce((n, s) => n + 1 + (s.videoUrl ? 1 : 0), 0) +
    1 +
    (data.finalVideoUrl ? 1 : 0);
  let done = 0;

  const tick = () => {
    done++;
    opts.onProgress?.(done, fetchUnits);
  };

  // Fetch all assets in parallel — Blob URLs are CDN-served, so concurrent
  // fetches are fine. Stills go to stills/, videos go to videos/.
  await Promise.all([
    ...data.scenes.flatMap((s) => {
      const padded = String(s.order).padStart(3, "0");
      const tasks: Promise<void>[] = [
        (async () => {
          const blob = await fetchAsBlob(s.imageUrl);
          // For all-stills bundles, drop them at the root for CapCut drag-in.
          // For mixed/animated bundles, prefix into stills/ to keep the videos folder clean.
          const path = data.scenes.some((x) => x.videoUrl)
            ? `stills/scene-${padded}.jpg`
            : `scene-${padded}.jpg`;
          zip.file(path, blob);
          tick();
        })(),
      ];
      if (s.videoUrl) {
        tasks.push(
          (async () => {
            const blob = await fetchAsBlob(s.videoUrl as string);
            zip.file(`videos/scene-${padded}.mp4`, blob);
            tick();
          })()
        );
      }
      return tasks;
    }),
    (async () => {
      const blob = await fetchAsBlob(data.thumbnailUrl);
      zip.file("thumbnail.jpg", blob);
      tick();
    })(),
    ...(data.finalVideoUrl
      ? [
          (async () => {
            const blob = await fetchAsBlob(data.finalVideoUrl as string);
            zip.file("final.mp4", blob);
            tick();
          })(),
        ]
      : []),
  ]);

  const hasAnyVideo = data.scenes.some((s) => s.videoUrl);
  const manifest = {
    version: MANIFEST_VERSION_CLIENT,
    projectId: data.projectId,
    title: data.title,
    niche: data.niche,
    format: data.format,
    generatedAt: new Date().toISOString(),
    thumbnail: "thumbnail.jpg",
    finalVideo: data.finalVideoUrl ? "final.mp4" : null,
    metadata: data.metadata,
    scenes: data.scenes.map((s) => {
      const padded = String(s.order).padStart(3, "0");
      return {
        order: s.order,
        still: hasAnyVideo ? `stills/scene-${padded}.jpg` : `scene-${padded}.jpg`,
        video: s.videoUrl ? `videos/scene-${padded}.mp4` : null,
        prompt: s.prompt,
        durationSec: s.durationSec,
        styleName: s.styleName ?? null,
        styleSubtitle: s.styleSubtitle ?? null,
      };
    }),
  };
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));

  // Also drop a plain README so the user (or their teammate) can paste-ready
  // the metadata without opening the JSON.
  zip.file("metadata.txt", buildPlainTextMetadata(data));

  const blob = await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  saveAs(blob, `${slugify(data.title)}-bundle.zip`);
}

async function fetchAsBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return await res.blob();
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function buildPlainTextMetadata(data: BundleData): string {
  const header = [`# ${data.title}`, `Niche: ${data.niche}`, `Format: ${data.format}`, ""];
  const m = data.metadata;
  switch (m.kind) {
    case "reel":
      return [
        ...header,
        "## TikTok",
        m.tiktokCaption,
        "",
        m.tiktokHashtags.map((h) => `#${h}`).join(" "),
        "",
        "## Instagram Reels",
        m.instagramCaption,
        "",
        m.instagramHashtags.map((h) => `#${h}`).join(" "),
        "",
        "## YouTube Shorts",
        `Title: ${m.shortsTitle}`,
        "",
        m.shortsDescription,
        "",
        m.shortsHashtags.map((h) => `#${h}`).join(" "),
        "",
        "## Pinned comment (reusable across all)",
        m.pinnedComment,
        "",
      ].join("\n");
    case "carousel":
      return [
        ...header,
        "## Instagram carousel",
        m.instagramCaption,
        "",
        m.instagramHashtags.map((h) => `#${h}`).join(" "),
        "",
      ].join("\n");
    case "youtube": {
      const cards = data.scenes
        .filter((s) => !!s.styleName)
        .map((s) => `- ${s.styleName}${s.styleSubtitle ? ` — ${s.styleSubtitle}` : ""}`);
      return [
        ...header,
        "## YouTube",
        `Title: ${m.title}`,
        "",
        `Thumbnail text: ${m.thumbnailText}`,
        "",
        "Description:",
        m.description,
        "",
        `Tags: ${m.tags.join(", ")}`,
        "",
        `Hashtags: ${m.hashtags.map((h) => `#${h}`).join(" ")}`,
        "",
        "## On-screen card copy (per style)",
        ...cards,
        "",
      ].join("\n");
    }
  }
}
