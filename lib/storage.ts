import { completeMultipartUpload, createMultipartUpload, put, uploadPart } from "@vercel/blob";
import { nanoid } from "nanoid";
import sharp from "sharp";

export type AssetKind = "images" | "videos" | "thumbnails" | "exports" | "uploads";

export type StoredAsset = {
  /** Public CDN URL served from Vercel Blob. */
  url: string;
  /** The Blob pathname (key) we uploaded to — useful for later delete/lookup. */
  pathname: string;
};

const SAFE_SEGMENT = /^[a-zA-Z0-9._-]+$/;

function assertSafeSegment(value: string, label: string): void {
  if (!value) throw new Error(`Invalid ${label}: empty`);
  if (value === "." || value === "..") {
    throw new Error(`Invalid ${label}: relative segment`);
  }
  if (!SAFE_SEGMENT.test(value)) {
    throw new Error(`Invalid ${label}: must match ${SAFE_SEGMENT.source}`);
  }
}

function blobPath(kind: AssetKind, projectId: string, filename: string): string {
  assertSafeSegment(projectId, "projectId");
  assertSafeSegment(filename, "filename");
  return `${kind}/${projectId}/${filename}`;
}

/**
 * Fetch a remote asset (e.g. a fal.ai image URL) and re-upload it to Vercel
 * Blob under our own key. The public URL we hand the frontend lives in our
 * Blob store, so it stays valid after the upstream URL expires.
 */
export async function storeFromUrl(opts: {
  url: string;
  kind: AssetKind;
  projectId: string;
  filename: string;
}): Promise<StoredAsset> {
  const res = await fetch(opts.url);
  if (!res.ok) {
    throw new Error(`Failed to download ${opts.url}: ${res.status} ${res.statusText}`);
  }
  if (!res.body) {
    throw new Error(`Failed to download ${opts.url}: empty response body`);
  }
  // Stream straight into Blob — a stitched long-form runs 400MB+, and
  // buffering it (arrayBuffer) OOM-crashes the serverless function.
  // multipart chunks the upload so memory stays bounded regardless of size.
  const pathname = blobPath(opts.kind, opts.projectId, opts.filename);
  const result = await put(pathname, res.body, {
    access: "public",
    addRandomSuffix: false,
    contentType: res.headers.get("content-type") ?? undefined,
    multipart: true,
  });
  return { url: result.url, pathname: result.pathname };
}

/**
 * Guarantee a still is a PNG, re-hosting a converted copy when it isn't.
 *
 * Why: fal's compose image track silently corrupts the render when keyframe
 * formats are MIXED — a JPEG upload among PNG renders came out as a one-frame
 * video (live-verified 2026-07-23; uniform all-PNG and all-JPEG both render
 * correctly). Generated stills are PNG, so any operator-uploaded base gets
 * normalized to PNG once at project creation.
 */
export async function ensurePngStill(opts: {
  url: string;
  projectId: string;
  filename: string;
}): Promise<string> {
  const res = await fetch(opts.url);
  if (!res.ok) {
    throw new Error(`Failed to download ${opts.url}: ${res.status} ${res.statusText}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const isPng =
    buffer.length > 4 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47;
  if (isPng) return opts.url;
  const png = await sharp(buffer).png().toBuffer();
  const stored = await storeBuffer({
    buffer: png,
    kind: "images",
    projectId: opts.projectId,
    filename: opts.filename,
    contentType: "image/png",
  });
  return stored.url;
}

export async function storeBuffer(opts: {
  buffer: Buffer;
  kind: AssetKind;
  projectId: string;
  filename: string;
  contentType?: string;
}): Promise<StoredAsset> {
  const pathname = blobPath(opts.kind, opts.projectId, opts.filename);
  const result = await put(pathname, opts.buffer, {
    access: "public",
    addRandomSuffix: false,
    contentType: opts.contentType,
  });
  return { url: result.url, pathname: result.pathname };
}

/**
 * Store an operator-uploaded file (e.g. the "before" image for a before-after
 * project). Lives under uploads/{operator-suffix}/{nanoid}.{ext} — no
 * projectId because uploads happen BEFORE project creation. The returned URL
 * is later persisted as the before scene's imageUrl.
 */
export async function storeOperatorUpload(opts: {
  operatorEmail: string;
  buffer: Buffer;
  ext: string;
  contentType: string;
}): Promise<StoredAsset> {
  const suffix = opts.operatorEmail.split("@")[0].toLowerCase().replace(/[^a-z0-9]/g, "");
  assertSafeSegment(suffix, "operator suffix");
  const filename = `${nanoid(12)}.${opts.ext}`;
  assertSafeSegment(filename, "filename");
  const pathname = `uploads/${suffix}/${filename}`;
  const result = await put(pathname, opts.buffer, {
    access: "public",
    addRandomSuffix: false,
    contentType: opts.contentType,
  });
  return { url: result.url, pathname: result.pathname };
}

// ── Large-file rehost (chunked multipart) ───────────────────────────────────
//
// A full-quality 16-min long-form is ~1.5-2GB. Moving that through ONE
// serverless invocation dies on the execution ceiling (observed 2026-07-24:
// "server returned HTTP 500 before the SDK responded" on the finish step
// after a successful Shotstack render). These helpers split the transfer
// into serializable steps the Inngest orchestrator can spread across
// invocations: plan → N part-batches → complete. Each part is a bounded
// Range download + uploadPart, so memory stays flat too.

export type RehostPart = { etag: string; partNumber: number };

export type RehostPlan =
  | { mode: "simple" }
  | {
      mode: "multipart";
      pathname: string;
      key: string;
      uploadId: string;
      contentType: string;
      sizeBytes: number;
      partSizeBytes: number;
      partCount: number;
    };

/** Files at or under this stream in one step (storeFromUrl). */
const REHOST_SIMPLE_MAX_BYTES = 256 * 1024 * 1024;
/** 64MB parts (Blob multipart minimum is 5MB). */
const REHOST_PART_BYTES = 64 * 1024 * 1024;
/** Parts per orchestrator step — ~192MB of transfer per invocation. */
export const REHOST_PARTS_PER_STEP = 3;

/** Probe the source and decide: single-step stream vs chunked multipart.
 *  Falls back to simple when the size is unknown or Range isn't supported
 *  (the simple path then bears the risk it always had). */
export async function planLargeRehost(opts: {
  url: string;
  kind: AssetKind;
  projectId: string;
  filename: string;
}): Promise<RehostPlan> {
  const head = await fetch(opts.url, { method: "HEAD" });
  const sizeBytes = Number(head.headers.get("content-length") ?? 0);
  const acceptRanges = (head.headers.get("accept-ranges") ?? "").toLowerCase().includes("bytes");
  if (!head.ok || !sizeBytes || sizeBytes <= REHOST_SIMPLE_MAX_BYTES || !acceptRanges) {
    return { mode: "simple" };
  }
  const contentType = head.headers.get("content-type") ?? "video/mp4";
  const pathname = blobPath(opts.kind, opts.projectId, opts.filename);
  const { key, uploadId } = await createMultipartUpload(pathname, {
    access: "public",
    contentType,
  });
  return {
    mode: "multipart",
    pathname,
    key,
    uploadId,
    contentType,
    sizeBytes,
    partSizeBytes: REHOST_PART_BYTES,
    partCount: Math.ceil(sizeBytes / REHOST_PART_BYTES),
  };
}

/** Transfer parts [fromPart..toPart] (1-based, inclusive): Range-download
 *  each and uploadPart it. Sequential — one 64MB part in memory at a time. */
export async function transferRehostParts(
  url: string,
  plan: Extract<RehostPlan, { mode: "multipart" }>,
  fromPart: number,
  toPart: number
): Promise<RehostPart[]> {
  const parts: RehostPart[] = [];
  for (let partNumber = fromPart; partNumber <= toPart; partNumber++) {
    const start = (partNumber - 1) * plan.partSizeBytes;
    const end = Math.min(start + plan.partSizeBytes, plan.sizeBytes) - 1;
    const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
    if (res.status !== 206) {
      throw new Error(`Range download failed for part ${partNumber}: HTTP ${res.status}`);
    }
    const body = Buffer.from(await res.arrayBuffer());
    const uploaded = await uploadPart(plan.pathname, body, {
      access: "public",
      uploadId: plan.uploadId,
      key: plan.key,
      partNumber,
      contentType: plan.contentType,
    });
    parts.push({ etag: uploaded.etag, partNumber: uploaded.partNumber });
  }
  return parts;
}

/** Stitch the uploaded parts into the final blob. */
export async function completeLargeRehost(
  plan: Extract<RehostPlan, { mode: "multipart" }>,
  parts: RehostPart[]
): Promise<StoredAsset> {
  const result = await completeMultipartUpload(
    plan.pathname,
    [...parts].sort((a, b) => a.partNumber - b.partNumber),
    {
      access: "public",
      uploadId: plan.uploadId,
      key: plan.key,
      contentType: plan.contentType,
    }
  );
  return { url: result.url, pathname: result.pathname };
}
