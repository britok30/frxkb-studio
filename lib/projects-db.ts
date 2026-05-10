// Thin Drizzle wrappers for the project/scene tables. Pure pass-throughs —
// no conditionals, no parsing, no external calls. Tested implicitly through
// `lib/projects.ts` orchestration tests + manual smoke against Neon.

import { and, asc, desc, eq, lt, ne, or, sql } from "drizzle-orm";
import { getDb, projects, scenes, type NewProject, type NewScene, type Project, type Scene } from "@/lib/db";

/** A run that hasn't heartbeat-ed in this long is considered crashed and reclaimable. */
export const STALE_LOCK_MS = 10 * 60 * 1000;

export async function insertProject(values: NewProject): Promise<Project> {
  const [row] = await getDb().insert(projects).values(values).returning();
  return row;
}

export async function insertScenes(rows: NewScene[]): Promise<Scene[]> {
  if (rows.length === 0) return [];
  return await getDb().insert(scenes).values(rows).returning();
}

export async function listProjectsRows(): Promise<Project[]> {
  return await getDb().select().from(projects).orderBy(desc(projects.createdAt));
}

/** Recent past worlds across the studio — fed to the AI suggester so it can
 *  avoid repeating itself. Skips legacy rows missing the dedupe fields.
 *  Limited to keep the prompt context manageable. */
export async function selectRecentWorlds(limit = 50): Promise<
  { niche: string; worldSignature: string; worldKeywords: string[] }[]
> {
  const rows = await getDb()
    .select({
      niche: projects.niche,
      worldSignature: projects.worldSignature,
      worldKeywords: projects.worldKeywords,
    })
    .from(projects)
    .orderBy(desc(projects.createdAt))
    .limit(limit);
  return rows
    .filter(
      (r): r is { niche: string; worldSignature: string; worldKeywords: string[] } =>
        !!r.worldSignature && Array.isArray(r.worldKeywords)
    )
    .map((r) => ({ niche: r.niche, worldSignature: r.worldSignature, worldKeywords: r.worldKeywords }));
}

/** Cheap candidate query for dedupe: pull projects that either share the
 *  exact world signature or have at least one keyword in common. The fuzzy
 *  scoring happens in lib/world-dedupe.ts so it stays testable. */
export async function selectDedupeCandidates(
  signature: string,
  keywords: string[]
): Promise<Project[]> {
  if (!signature && keywords.length === 0) return [];
  // Postgres jsonb ?| operator: "any of these keys is in the array".
  // We use raw SQL because Drizzle's jsonb helpers don't expose ?| cleanly.
  const rows = await getDb()
    .select()
    .from(projects)
    .where(
      or(
        eq(projects.worldSignature, signature),
        // Keyword overlap — fall back to false if keywords is empty so we
        // never accidentally select every project.
        keywords.length > 0
          ? sql`${projects.worldKeywords} ?| ${keywords}`
          : sql`false`
      )
    )
    .orderBy(desc(projects.createdAt))
    .limit(20);
  return rows;
}

export async function selectProjectById(id: string): Promise<Project | null> {
  const rows = await getDb().select().from(projects).where(eq(projects.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function selectScenesByProject(projectId: string): Promise<Scene[]> {
  return await getDb()
    .select()
    .from(scenes)
    .where(eq(scenes.projectId, projectId))
    .orderBy(asc(scenes.order));
}

export async function selectSceneById(id: string): Promise<Scene | null> {
  const rows = await getDb().select().from(scenes).where(eq(scenes.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function markSceneApproved(id: string): Promise<void> {
  await getDb()
    .update(scenes)
    .set({ status: "approved", updatedAt: new Date() })
    .where(eq(scenes.id, id));
}

export async function markSceneRejected(id: string, error?: string): Promise<void> {
  await getDb()
    .update(scenes)
    .set({ status: "rejected", error: error ?? null, updatedAt: new Date() })
    .where(eq(scenes.id, id));
}

export async function updateProjectStatus(
  id: string,
  status: Project["status"]
): Promise<void> {
  await getDb()
    .update(projects)
    .set({ status, updatedAt: new Date() })
    .where(eq(projects.id, id));
}

export async function markSceneGenerating(id: string): Promise<void> {
  await getDb()
    .update(scenes)
    .set({ status: "generating", error: null, updatedAt: new Date() })
    .where(eq(scenes.id, id));
}

export async function markSceneGenerated(
  id: string,
  values: {
    imageUrl: string;
    falRequestId: string;
    /** When true, also nulls videoUrl + motionPrompt — used during regenerate
     *  flows so a refreshed still doesn't keep its now-stale video preview.
     *  Operator will need to re-run Animate to get a video that matches. */
    invalidateAnimation?: boolean;
  }
): Promise<void> {
  const set: Partial<Scene> = {
    status: "generated",
    imageUrl: values.imageUrl,
    falRequestId: values.falRequestId,
    error: null,
    updatedAt: new Date(),
  };
  if (values.invalidateAnimation) {
    set.videoUrl = null;
    set.motionPrompt = null;
  }
  await getDb().update(scenes).set(set).where(eq(scenes.id, id));
}

export async function markProjectFinalized(
  id: string,
  values: {
    thumbnailUrl: string;
    metadata: NonNullable<Project["metadata"]>;
  }
): Promise<void> {
  await getDb()
    .update(projects)
    .set({
      status: "exported",
      thumbnailUrl: values.thumbnailUrl,
      metadata: values.metadata,
      updatedAt: new Date(),
    })
    .where(eq(projects.id, id));
}

export async function markSceneFailed(id: string, error: string): Promise<void> {
  await getDb()
    .update(scenes)
    .set({ status: "rejected", error, updatedAt: new Date() })
    .where(eq(scenes.id, id));
}

/** Mark a scene's video pipeline as in flight. Status stays "approved"/"generated"
 *  — videoUrl being null vs set is the source of truth for "is animated yet." */
export async function markSceneAnimating(id: string, motionPrompt: string): Promise<void> {
  await getDb()
    .update(scenes)
    .set({ motionPrompt, error: null, updatedAt: new Date() })
    .where(eq(scenes.id, id));
}

export async function markSceneAnimated(
  id: string,
  values: { videoUrl: string }
): Promise<void> {
  await getDb()
    .update(scenes)
    .set({
      videoUrl: values.videoUrl,
      error: null,
      updatedAt: new Date(),
    })
    .where(eq(scenes.id, id));
}

/**
 * Atomic CAS to claim the "generating" status for a project. Returns true if
 * we got the lock, false if another run is already in progress and fresh.
 *
 * A run is considered fresh if its updatedAt is within STALE_LOCK_MS — older
 * runs are assumed to have crashed and are reclaimable. The check + flip
 * happen in a single UPDATE so two simultaneous requests can't both win.
 */
export async function tryAcquireGenerationLock(id: string): Promise<boolean> {
  const staleThreshold = new Date(Date.now() - STALE_LOCK_MS);
  const rows = await getDb()
    .update(projects)
    .set({ status: "generating", updatedAt: new Date() })
    .where(
      and(
        eq(projects.id, id),
        or(ne(projects.status, "generating"), lt(projects.updatedAt, staleThreshold))
      )
    )
    .returning();
  return rows.length > 0;
}

/**
 * Atomic CAS to claim the "finalizing" status for a project. Same pattern as
 * the generation lock but flips into a different status so the two locks are
 * mutually exclusive — you can't finalize while images are still being
 * generated, and you can't generate while a finalize is in flight.
 */
export async function tryAcquireFinalizationLock(id: string): Promise<boolean> {
  const staleThreshold = new Date(Date.now() - STALE_LOCK_MS);
  const rows = await getDb()
    .update(projects)
    .set({ status: "finalizing", updatedAt: new Date() })
    .where(
      and(
        eq(projects.id, id),
        // Reject only if image gen is *fresh*. Stale generating means a previous
        // batch crashed and we can take over.
        or(ne(projects.status, "generating"), lt(projects.updatedAt, staleThreshold)),
        // Same logic for the finalize lock itself.
        or(ne(projects.status, "finalizing"), lt(projects.updatedAt, staleThreshold))
      )
    )
    .returning();
  return rows.length > 0;
}

/**
 * Refresh updatedAt while a long-running batch is in progress, so the lock
 * is not reclaimed mid-run. Call periodically.
 */
export async function heartbeatGenerationLock(id: string): Promise<void> {
  await getDb()
    .update(projects)
    .set({ updatedAt: new Date() })
    .where(and(eq(projects.id, id), eq(projects.status, "generating")));
}

/**
 * Reset any scene rows for this project that are stuck in 'generating' from
 * a crashed previous run. Safe to call after acquiring the lock — by then
 * we know no one else is generating.
 */
export async function resetOrphanedScenes(projectId: string): Promise<number> {
  const rows = await getDb()
    .update(scenes)
    .set({ status: "pending", error: null, updatedAt: new Date() })
    .where(and(eq(scenes.projectId, projectId), eq(scenes.status, "generating")))
    .returning();
  return rows.length;
}

