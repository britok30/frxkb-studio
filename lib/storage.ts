import { put } from "@vercel/blob";

export type AssetKind = "images" | "videos" | "thumbnails" | "exports";

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
  const buffer = Buffer.from(await res.arrayBuffer());
  return storeBuffer({
    buffer,
    kind: opts.kind,
    projectId: opts.projectId,
    filename: opts.filename,
    contentType: res.headers.get("content-type") ?? undefined,
  });
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
