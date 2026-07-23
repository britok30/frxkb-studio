import { put } from "@vercel/blob";
import { nanoid } from "nanoid";

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
