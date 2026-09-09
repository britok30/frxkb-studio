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
  /** Generated YouTube thumbnail (1280×720). Packed at the zip root as
   *  youtube-thumbnail-1280x720.jpg. */
  youtubeThumbnailUrl?: string | null;
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
  if (data.format === "staging") {
    await downloadStagingBundle(data, opts);
    return;
  }
  // The final.mp4 deliberately does NOT ship in the zip: full-quality
  // long-forms run gigabytes, which browser-side zipping can't survive.
  // The export panel pairs this bundle with a dedicated "Download video"
  // action instead — two distinguishable deliverables.
  const zip = new JSZip();
  // Each scene contributes 1 fetch (still OR video — animated scenes still
  // ship the still as a poster fallback though), plus 1 for the thumbnail.
  // We fetch BOTH still and video for animated scenes so the operator has
  // each as a backup.
  const fetchUnits =
    data.scenes.reduce((n, s) => n + 1 + (s.videoUrl ? 1 : 0), 0) +
    1 +
    (data.youtubeThumbnailUrl ? 1 : 0);
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
          zip.file(path, blob, { compression: "STORE" });
          tick();
        })(),
      ];
      if (s.videoUrl) {
        tasks.push(
          (async () => {
            const blob = await fetchAsBlob(s.videoUrl as string);
            zip.file(`videos/scene-${padded}.mp4`, blob, { compression: "STORE" });
            tick();
          })()
        );
      }
      return tasks;
    }),
    (async () => {
      const blob = await fetchAsBlob(data.thumbnailUrl);
      zip.file("thumbnail.jpg", blob, { compression: "STORE" });
      tick();
    })(),
    ...(data.youtubeThumbnailUrl
      ? [
          (async () => {
            const blob = await fetchAsBlob(data.youtubeThumbnailUrl as string);
            zip.file("youtube-thumbnail-1280x720.jpg", blob, { compression: "STORE" });
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
    finalVideo: null,
    finalVideoNote: "final.mp4 ships separately — use the Download video button in the export panel.",
    youtubeThumbnail: data.youtubeThumbnailUrl ? "youtube-thumbnail-1280x720.jpg" : null,
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

/**
 * Staging package: exactly two photos plus the copy. Named for the listing
 * (not scene-001/002) so the agent can attach them as-is, plus a side-by-side
 * composite built in the browser for the social reveal.
 */
async function downloadStagingBundle(
  data: BundleData,
  opts: { onProgress?: (done: number, total: number) => void } = {}
): Promise<void> {
  const ordered = [...data.scenes].sort((a, b) => a.order - b.order);
  const before = ordered[0];
  const after = ordered[ordered.length - 1];
  // Unfurnish projects carry the cleared room between them.
  const cleared = ordered.length >= 3 ? ordered[1] : null;
  if (!before || !after || before === after) {
    throw new Error("Staging bundle needs both the before and the staged after.");
  }
  const total = 3 + (cleared ? 1 : 0);
  let done = 0;
  const tick = () => {
    done++;
    opts.onProgress?.(done, total);
  };

  const [beforeBlob, afterBlob, clearedBlob] = await Promise.all([
    fetchAsBlob(before.imageUrl).then((b) => (tick(), b)),
    fetchAsBlob(after.imageUrl).then((b) => (tick(), b)),
    cleared ? fetchAsBlob(cleared.imageUrl).then((b) => (tick(), b)) : Promise.resolve(null),
  ]);

  const base = slugify(data.title) || "room";
  const beforeName = `${base}-before.jpg`;
  const clearedName = `${base}-cleared-unfurnished.jpg`;
  const afterName = `${base}-after-virtually-staged.jpg`;
  const sideBySideName = `${base}-before-after.jpg`;

  const zip = new JSZip();
  zip.file(beforeName, beforeBlob, { compression: "STORE" });
  if (clearedBlob) zip.file(clearedName, clearedBlob, { compression: "STORE" });
  zip.file(afterName, afterBlob, { compression: "STORE" });

  // Side-by-side reveal — best effort (needs canvas; skipped where absent).
  let sideBySide: string | null = null;
  try {
    const composite = await composeSideBySide(beforeBlob, afterBlob);
    if (composite) {
      zip.file(sideBySideName, composite, { compression: "STORE" });
      sideBySide = sideBySideName;
    }
  } catch {
    sideBySide = null;
  }
  tick();

  const manifest = {
    version: MANIFEST_VERSION_CLIENT,
    projectId: data.projectId,
    title: data.title,
    niche: data.niche,
    format: data.format,
    generatedAt: new Date().toISOString(),
    before: beforeName,
    cleared: clearedBlob ? clearedName : null,
    after: afterName,
    sideBySide,
    metadata: data.metadata,
    stagingPlan: after.prompt,
    styleName: after.styleName ?? null,
    styleSubtitle: after.styleSubtitle ?? null,
  };
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  zip.file("copy.txt", buildPlainTextMetadata(data));

  const blob = await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  saveAs(blob, `${base}-virtual-staging.zip`);
}

/** Before | after on one canvas, matched heights, thin gutter, JPEG. */
async function composeSideBySide(beforeBlob: Blob, afterBlob: Blob): Promise<Blob | null> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;
  const [a, b] = await Promise.all([createImageBitmap(beforeBlob), createImageBitmap(afterBlob)]);
  const height = Math.min(a.height, b.height, 1600);
  const aw = Math.round((a.width / a.height) * height);
  const bw = Math.round((b.width / b.height) * height);
  const gutter = Math.round(height * 0.01);
  const canvas = document.createElement("canvas");
  canvas.width = aw + gutter + bw;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(a, 0, 0, aw, height);
  ctx.drawImage(b, aw + gutter, 0, bw, height);
  a.close?.();
  b.close?.();
  return await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((out) => resolve(out), "image/jpeg", 0.92)
  );
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
    case "staging":
      return [
        ...header,
        "## Instagram",
        m.instagramCaption,
        "",
        m.instagramHashtags.map((h) => `#${h}`).join(" "),
        "",
        "## TikTok",
        m.tiktokCaption,
        "",
        m.tiktokHashtags.map((h) => `#${h}`).join(" "),
        "",
        "## Listing remarks (MLS)",
        m.listingBlurb,
        "",
        "## Note to the agent / homeowner",
        m.clientNote,
        "",
        "## Alt text (after image)",
        m.altText,
        "",
        "## Required disclosure",
        m.disclosure,
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
