import { put } from "@vercel/blob";
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
