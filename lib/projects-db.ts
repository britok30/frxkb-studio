// Thin Drizzle wrappers for the project/scene tables. Pure pass-throughs —
// no conditionals, no parsing, no external calls. Tested implicitly through
// `lib/projects.ts` orchestration tests + manual smoke against Neon.

import { and, asc, desc, eq, inArray, lt, ne, or, sql } from "drizzle-orm";
import {
  getDb,
  projects,
  scenes,
  sceneVersions,
  type NewProject,
  type NewScene,
  type NewSceneVersion,
  type Project,
  type Scene,
  type SceneVersion,
} from "@/lib/db";

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

/**
 * Project rows joined with each project's resolved cover image URL. The
 * cover prefers (in order):
 *   1. project.thumbnailUrl (set after finalize — for before-after this is
 *      already the after image's URL).
 *   2. For non-finalized before-after projects: the highest-order scene's
 *      imageUrl (the "after" — more interesting than the uploaded before).
 *   3. For non-finalized other projects: the lowest-order scene with an
 *      imageUrl (the anchor / first generated still).
 *   4. null when no scene has been generated yet.
 *
 * Single batched scenes query — no N+1.
 */
export async function listProjectsWithCovers(): Promise<
  Array<Project & { coverUrl: string | null }>
> {
  const projectRows = await listProjectsRows();
  if (projectRows.length === 0) return [];

  // Pull every scene for the listed projects in one round-trip. Order by
  // (projectId, order) so we can group + index without a sort pass.
  const sceneRows = await getDb()
    .select({
      projectId: scenes.projectId,
      order: scenes.order,
      imageUrl: scenes.imageUrl,
    })
    .from(scenes)
    .where(inArray(scenes.projectId, projectRows.map((p) => p.id)))
    .orderBy(asc(scenes.projectId), asc(scenes.order));

  const byProjectId = new Map<string, typeof sceneRows>();
  for (const s of sceneRows) {
    const arr = byProjectId.get(s.projectId);
    if (arr) arr.push(s);
    else byProjectId.set(s.projectId, [s]);
  }

  return projectRows.map((p) => {
    const projScenes = byProjectId.get(p.id) ?? [];
    if (projScenes.length === 0) return { ...p, coverUrl: null };

    // Cover is ALWAYS derived live from scenes (thumbnail generation was
    // deprecated — see lib/projects.ts finalizeProject). Single source of
    // truth: the scenes themselves.
    if (p.format === "before-after") {
      // The after (highest-order scene with an image) is the visual payoff.
      for (let i = projScenes.length - 1; i >= 0; i--) {
        if (projScenes[i].imageUrl) return { ...p, coverUrl: projScenes[i].imageUrl };
      }
      return { ...p, coverUrl: null };
    }
    // Reel/carousel: anchor scene (lowest-order with an imageUrl).
    const firstWithImage = projScenes.find((s) => !!s.imageUrl);
    return { ...p, coverUrl: firstWithImage?.imageUrl ?? null };
  });
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
  // The right-hand side MUST be text[] — passing a JS array via `${keywords}`
  // makes Drizzle splat into $2,$3,... which Postgres reads as a record and
  // rejects with "operator does not exist: jsonb ?| record". Wrapping in
  // ARRAY[...]::text[] keeps each keyword as its own bound param (safe from
  // injection) while giving the operator the array type it expects.
  const rows = await getDb()
    .select()
    .from(projects)
    .where(
      or(
        eq(projects.worldSignature, signature),
        // Keyword overlap — fall back to false if keywords is empty so we
        // never accidentally select every project.
        keywords.length > 0
          ? sql`${projects.worldKeywords} ?| ARRAY[${sql.join(
              keywords.map((k) => sql`${k}`),
              sql`, `
            )}]::text[]`
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

/** Batch-approve every "generated" scene in a project (the "Approve all
 *  ready" action). Approved/rejected/pending scenes are untouched. Returns
 *  the number of scenes flipped. */
export async function approveAllGeneratedScenes(projectId: string): Promise<number> {
  const rows = await getDb()
    .update(scenes)
    .set({ status: "approved", updatedAt: new Date() })
    .where(and(eq(scenes.projectId, projectId), eq(scenes.status, "generated")))
    .returning();
  return rows.length;
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
    /** The seed the render actually used — persisted for reproducibility and
     *  so regens/consistency work can reason about it. Omit to preserve. */
    seed?: number;
    /** When true, also nulls videoUrl + motionPrompt — used during regenerate
     *  flows so a refreshed still doesn't keep its now-stale video preview.
     *  Operator will need to re-run Animate to get a video that matches. */
    invalidateAnimation?: boolean;
    /** URL of the anchor image this scene was conditioned on (null for the
     *  anchor itself, which is text-to-image). Stored so per-scene regen can
     *  re-pass the same reference and stay visually consistent with the rest
     *  of the sequence. Pass `null` explicitly to clear; omit to preserve. */
    referenceImageUrl?: string | null;
  }
): Promise<void> {
  const set: Partial<Scene> = {
    status: "generated",
    imageUrl: values.imageUrl,
    falRequestId: values.falRequestId,
    error: null,
    updatedAt: new Date(),
  };
  if (values.seed !== undefined) {
    set.seed = values.seed;
  }
  if (values.invalidateAnimation) {
    set.videoUrl = null;
    set.motionPrompt = null;
  }
  if (values.referenceImageUrl !== undefined) {
    set.referenceImageUrl = values.referenceImageUrl;
  }
  await getDb().update(scenes).set(set).where(eq(scenes.id, id));
}

/** Snapshot a scene's outgoing render into the variant history right before a
 *  regen overwrites it. No-ops when the scene has no image yet. */
export async function insertSceneVersion(values: NewSceneVersion): Promise<void> {
  await getDb().insert(sceneVersions).values(values);
}

/** All non-active takes for a scene, newest first. */
export async function selectSceneVersions(sceneId: string): Promise<SceneVersion[]> {
  return await getDb()
    .select()
    .from(sceneVersions)
    .where(eq(sceneVersions.sceneId, sceneId))
    .orderBy(desc(sceneVersions.createdAt));
}

export async function selectSceneVersionById(id: string): Promise<SceneVersion | null> {
  const rows = await getDb()
    .select()
    .from(sceneVersions)
    .where(eq(sceneVersions.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function deleteSceneVersion(id: string): Promise<void> {
  await getDb().delete(sceneVersions).where(eq(sceneVersions.id, id));
}

/** Restore a historical take as a scene's active image. Any existing video
 *  is invalidated — it was animated from the outgoing image. */
export async function setSceneActiveImage(
  id: string,
  values: { imageUrl: string; seed?: number | null }
): Promise<void> {
  await getDb()
    .update(scenes)
    .set({
      imageUrl: values.imageUrl,
      ...(values.seed !== undefined ? { seed: values.seed } : {}),
      status: "generated",
      videoUrl: null,
      motionPrompt: null,
      error: null,
      updatedAt: new Date(),
    })
    .where(eq(scenes.id, id));
}

/** Freeze the anchor render as the reference for every OTHER scene in a
 *  reel/carousel project that doesn't already carry one. Called right after
 *  the anchor scene generates so scenes 2+ chain off it via /edit. */
export async function setProjectSceneReferences(
  projectId: string,
  anchorSceneId: string,
  referenceImageUrl: string
): Promise<void> {
  await getDb()
    .update(scenes)
    .set({ referenceImageUrl, updatedAt: new Date() })
    .where(
      and(
        eq(scenes.projectId, projectId),
        ne(scenes.id, anchorSceneId),
        sql`${scenes.referenceImageUrl} IS NULL`
      )
    );
}

/** Persist the stitched final video URL. Re-stitching overwrites. */
export async function markProjectFinalVideo(
  id: string,
  finalVideoUrl: string
): Promise<void> {
  await getDb()
    .update(projects)
    .set({ finalVideoUrl, updatedAt: new Date() })
    .where(eq(projects.id, id));
}

export async function markProjectFinalized(
  id: string,
  values: {
    metadata: NonNullable<Project["metadata"]>;
  }
): Promise<void> {
  // thumbnailUrl is no longer written — the cover derives live from scenes
  // (anchor for reel/carousel, after for before-after). Column kept nullable
  // for legacy rows.
  await getDb()
    .update(projects)
    .set({
      status: "exported",
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

/**
 * Record an animate-pipeline failure for a scene WITHOUT flipping its status.
 * The still itself is still good — only the video pipeline (motion prompt,
 * seedance, or topaz) failed. Status stays "generated"/"approved" so the
 * scene remains a valid animate candidate on the next click. motionPrompt is
 * cleared so a retry asks GPT-5.5 for a fresh direction.
 */
export async function markSceneAnimateFailed(id: string, error: string): Promise<void> {
  await getDb()
    .update(scenes)
    .set({ error, motionPrompt: null, updatedAt: new Date() })
    .where(eq(scenes.id, id));
}

/**
 * Recovery sweep for scenes stuck in "rejected" status because of a prior
 * animate failure (before markSceneAnimateFailed existed, animate failures
 * called markSceneFailed which clobbered status). The signature of an
 * animate-failure scene is: status=rejected + imageUrl set + videoUrl null +
 * motionPrompt set + error not null. Operator-rejected scenes don't have
 * motionPrompt set, so the signal is unambiguous.
 *
 * Returns the count of scenes reset.
 */
export async function recoverAnimateFailedScenes(projectId: string): Promise<number> {
  const rows = await getDb()
    .update(scenes)
    .set({ status: "generated", error: null, motionPrompt: null, updatedAt: new Date() })
    .where(
      and(
        eq(scenes.projectId, projectId),
        eq(scenes.status, "rejected"),
        sql`${scenes.imageUrl} IS NOT NULL`,
        sql`${scenes.videoUrl} IS NULL`,
        sql`${scenes.motionPrompt} IS NOT NULL`
      )
    )
    .returning();
  return rows.length;
}

/** Lock (or clear) the operator-picked camera move for a scene. Cleared by
 *  passing null. Also clears any stale motionPrompt so the next animate
 *  writes a fresh direction that honors the lock. */
export async function setSceneMotionPreset(
  id: string,
  motionPreset: string | null
): Promise<void> {
  await getDb()
    .update(scenes)
    .set({ motionPreset, motionPrompt: null, updatedAt: new Date() })
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

