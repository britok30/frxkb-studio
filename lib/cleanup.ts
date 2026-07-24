// Weekly hygiene: delete operator-uploaded blobs that never became part of
// anything. Uploads happen client-direct BEFORE project creation, so an
// abandoned flow (or a failed GPT call) strands the file on Blob storage.
// We deliberately do NOT delete on creation failure — the /new page still
// holds the URL for retry — so a scheduled sweep is the right shape.
//
// Scope is limited to the pre-project prefixes (uploads/, thumbnail-src/,
// music/); generated assets under images/ / videos/ / thumbnails/ are always
// project-owned and never swept.

import { del, list } from "@vercel/blob";
import { isNotNull } from "drizzle-orm";
import { getDb, projects, scenes, thumbnails } from "@/lib/db";

const SWEEP_PREFIXES = ["uploads/", "thumbnail-src/", "music/"];
/** Only blobs at least this old are candidates — anything younger may belong
 *  to an in-flight creation the DB hasn't recorded yet. */
const MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Every blob URL the studio still references. */
async function collectReferencedUrls(): Promise<Set<string>> {
  const db = getDb();
  const referenced = new Set<string>();
  const add = (u: string | null | undefined) => {
    if (u) referenced.add(u);
  };

  const projectRows = await db
    .select({
      referenceImageUrls: projects.referenceImageUrls,
      thumbnailUrl: projects.thumbnailUrl,
      finalVideoUrl: projects.finalVideoUrl,
      previousFinalVideoUrl: projects.previousFinalVideoUrl,
      lastMusicUrl: projects.lastMusicUrl,
    })
    .from(projects);
  for (const p of projectRows) {
    (p.referenceImageUrls ?? []).forEach(add);
    add(p.thumbnailUrl);
    add(p.finalVideoUrl);
    add(p.previousFinalVideoUrl);
    add(p.lastMusicUrl);
  }

  const sceneRows = await db
    .select({
      imageUrl: scenes.imageUrl,
      referenceImageUrl: scenes.referenceImageUrl,
      videoUrl: scenes.videoUrl,
      previousVideoUrl: scenes.previousVideoUrl,
    })
    .from(scenes);
  for (const s of sceneRows) {
    add(s.imageUrl);
    add(s.referenceImageUrl);
    add(s.videoUrl);
    add(s.previousVideoUrl);
  }

  const thumbRows = await db
    .select({ url: thumbnails.url, sourceImageUrl: thumbnails.sourceImageUrl })
    .from(thumbnails)
    .where(isNotNull(thumbnails.url));
  for (const t of thumbRows) {
    add(t.url);
    add(t.sourceImageUrl);
  }

  return referenced;
}

export type CleanupResult = {
  scanned: number;
  deleted: number;
};

/** One sweep pass. Deletes in small batches; a failure mid-run just leaves
 *  the remainder for next week. */
export async function cleanupOrphanedUploads(): Promise<CleanupResult> {
  const referenced = await collectReferencedUrls();
  const cutoff = Date.now() - MIN_AGE_MS;

  let scanned = 0;
  const orphans: string[] = [];
  for (const prefix of SWEEP_PREFIXES) {
    let cursor: string | undefined;
    do {
      const page = await list({ prefix, cursor, limit: 1000 });
      for (const blob of page.blobs) {
        scanned++;
        if (new Date(blob.uploadedAt).getTime() > cutoff) continue;
        if (referenced.has(blob.url)) continue;
        orphans.push(blob.url);
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  }

  for (let i = 0; i < orphans.length; i += 50) {
    await del(orphans.slice(i, i + 50));
  }

  return { scanned, deleted: orphans.length };
}
