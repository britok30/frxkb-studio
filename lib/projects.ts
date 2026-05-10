import { nanoid } from "nanoid";
import { generateConcept } from "@/lib/prompts/concept";
import { generateScenePrompts } from "@/lib/prompts/scenes";
import { generateMetadata, type Metadata } from "@/lib/prompts/metadata";
import { defaultsForFormat, type Format, type AspectRatio } from "@/lib/prompts/types";
import { generateImage } from "@/lib/fal";
import { generateVideo } from "@/lib/seedance";
import { upscaleVideo } from "@/lib/topaz";
import { generateMotionPrompts } from "@/lib/prompts/motion";
import { storeFromUrl } from "@/lib/storage";
import { runWithConcurrency } from "@/lib/concurrency";
import { generateThumbnail } from "@/lib/thumbnail";
import { currentOperator, pickAppLink } from "@/lib/operators";
import { findSimilarProjects, type DuplicateMatch } from "@/lib/world-dedupe";
import {
  insertProject,
  insertScenes,
  listProjectsRows,
  markProjectFinalized,
  markSceneAnimated,
  markSceneAnimating,
  markSceneApproved,
  markSceneFailed,
  markSceneGenerated,
  markSceneGenerating,
  markSceneRejected,
  resetOrphanedScenes,
  selectProjectById,
  selectSceneById,
  selectScenesByProject,
  tryAcquireFinalizationLock,
  tryAcquireGenerationLock,
  updateProjectStatus,
} from "@/lib/projects-db";
import type { Project, Scene } from "@/lib/db";

export type CreateProjectInput = {
  niche: string;
  format: Format;
  sceneCount?: number;
  sceneDurationSec?: number;
  operatorNotes?: string;
};

export type ProjectWithScenes = { project: Project; scenes: Scene[] };

export type CreateProjectResult = ProjectWithScenes & {
  /** Existing projects whose world looks similar. Empty if no match.
   *  Always populated, never throws — UI decides whether to surface. */
  similarProjects: DuplicateMatch[];
};

/** Thrown when a long-running operation is invoked while another one for the same project is in flight. */
export class ProjectBusyError extends Error {
  readonly code = "PROJECT_BUSY";
  constructor(
    projectId: string,
    public readonly operation: "generating" | "finalizing" = "generating"
  ) {
    super(
      `Project ${projectId} is already ${operation}. Wait for the in-flight ${operation === "generating" ? "batch" : "render"} to finish, or retry in 10 minutes if it crashed.`
    );
    this.name = "ProjectBusyError";
  }
}

export async function createProject(input: CreateProjectInput): Promise<CreateProjectResult> {
  const defaults = defaultsForFormat(input.format);
  const sceneCount = clamp(input.sceneCount ?? defaults.sceneCount, 1, 120);
  // Carousel contract: durationSec=0 means "static slide, no playback duration."
  const sceneDurationSec = clamp(input.sceneDurationSec ?? defaults.sceneDurationSec, 0, 15);
  // Claude's prompt schema requires durationSec >= 2; pad carousel's 0 up to 4 just for prompt context.
  const promptDuration = sceneDurationSec === 0 ? 4 : sceneDurationSec;
  const aspectRatio = defaults.aspectRatio;
  const targetDurationSec = sceneCount * sceneDurationSec;

  const projectId = nanoid(12);

  // Run BOTH Claude calls before any DB writes. If either fails we leave no
  // orphan project row to clean up.
  const concept = await generateConcept({
    niche: input.niche,
    format: input.format,
    targetDurationSec: targetDurationSec || undefined,
    operatorNotes: input.operatorNotes,
  });

  // Soft-fail dedupe: if it errors for any reason, skip and create the project
  // anyway. The world is viable without a similarity check.
  let similarProjects: DuplicateMatch[] = [];
  try {
    const dedupe = await findSimilarProjects({
      signature: concept.worldSignature,
      keywords: concept.worldKeywords,
    });
    similarProjects = dedupe.matches;
  } catch (err) {
    console.warn("[dedupe] check failed; continuing anyway:", err);
  }

  const scenesResp = await generateScenePrompts({
    concept,
    aspectRatio,
    sceneCount,
    sceneDurationSec: promptDuration,
  });

  // LLM work succeeded — persist.
  const project = await insertProject({
    id: projectId,
    title: concept.workingTitle,
    niche: input.niche,
    format: input.format,
    status: "scripting",
    targetDurationSec: targetDurationSec || null,
    concept: {
      workingTitle: concept.workingTitle,
      hook: concept.hook,
      vibe: concept.vibe,
      notes: concept.notes,
    },
    worldSignature: concept.worldSignature,
    worldKeywords: concept.worldKeywords,
  });

  const sceneRows = scenesResp.scenes.map((s) => ({
    id: nanoid(12),
    projectId,
    order: s.order,
    prompt: s.prompt,
    durationSec: sceneDurationSec === 0 ? 0 : s.durationSec,
    status: "pending" as const,
  }));

  const insertedScenes = await insertScenes(sceneRows);

  return { project, scenes: insertedScenes, similarProjects };
}

export async function listProjects(): Promise<Project[]> {
  return await listProjectsRows();
}

export async function getProjectWithScenes(id: string): Promise<ProjectWithScenes | null> {
  const project = await selectProjectById(id);
  if (!project) return null;
  const scenes = await selectScenesByProject(id);
  return { project, scenes };
}

export type GenerateAllImagesResult = {
  generated: number;
  failed: number;
  skipped: number;
  /** Number of orphaned scenes reclaimed from a previous crashed run. */
  reclaimed: number;
};

export async function generateAllImages(
  projectId: string,
  opts: { aspectRatio?: AspectRatio; concurrency?: number; force?: boolean } = {}
): Promise<GenerateAllImagesResult> {
  const project = await selectProjectById(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);

  const aspectRatio = opts.aspectRatio ?? defaultsForFormat(project.format).aspectRatio;
  const concurrency = opts.concurrency ?? 4;

  const acquired = await tryAcquireGenerationLock(projectId);
  if (!acquired) throw new ProjectBusyError(projectId);

  const reclaimed = await resetOrphanedScenes(projectId);

  try {
    const allScenes = await selectScenesByProject(projectId);
    const targets = allScenes.filter((s) =>
      opts.force ? true : s.status === "pending" || s.status === "rejected"
    );

    let generated = 0;
    let failed = 0;
    const skipped = allScenes.length - targets.length;

    await runWithConcurrency(targets, concurrency, async (scene) => {
      await markSceneGenerating(scene.id);
      try {
        const result = await generateImage({ prompt: scene.prompt, aspectRatio });
        const first = result.images[0];
        if (!first?.url) throw new Error("fal returned no image url");

        const filename = `scene-${String(scene.order).padStart(3, "0")}-${nanoid(6)}.jpg`;
        const stored = await storeFromUrl({
          url: first.url,
          kind: "images",
          projectId,
          filename,
        });

        await markSceneGenerated(scene.id, {
          imageUrl: stored.url,
          falRequestId: result.requestId,
          // If the scene already had an image, this is a regeneration —
          // null out any existing video so the operator doesn't ship a video
          // animated from a now-replaced still. Re-Animate will pick it up.
          invalidateAnimation: !!scene.imageUrl,
        });
        generated++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown error";
        await markSceneFailed(scene.id, msg);
        failed++;
      }
    });

    // Always release to 'ready'. Per-scene failures surface via scene counts.
    await updateProjectStatus(projectId, "ready");

    return { generated, failed, skipped, reclaimed };
  } catch (err) {
    await updateProjectStatus(projectId, "scripting");
    throw err;
  }
}

export type SceneAction = "approve" | "reject" | "regenerate";

export async function applySceneAction(
  projectId: string,
  sceneId: string,
  action: SceneAction
): Promise<Scene> {
  const scene = await selectSceneById(sceneId);
  if (!scene) throw new Error(`Scene ${sceneId} not found`);
  if (scene.projectId !== projectId) {
    throw new Error(`Scene ${sceneId} does not belong to project ${projectId}`);
  }

  switch (action) {
    case "approve":
      await markSceneApproved(sceneId);
      break;
    case "reject":
      await markSceneRejected(sceneId);
      break;
    case "regenerate":
      await regenerateScene(projectId, scene);
      break;
  }

  const refreshed = await selectSceneById(sceneId);
  if (!refreshed) throw new Error(`Scene ${sceneId} disappeared mid-update`);
  return refreshed;
}

async function regenerateScene(projectId: string, scene: Scene): Promise<void> {
  const project = await selectProjectById(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);
  const aspectRatio = defaultsForFormat(project.format).aspectRatio;

  await markSceneGenerating(scene.id);
  try {
    const result = await generateImage({ prompt: scene.prompt, aspectRatio });
    const first = result.images[0];
    if (!first?.url) throw new Error("fal returned no image url");

    const filename = `scene-${String(scene.order).padStart(3, "0")}-${nanoid(6)}.jpg`;
    const stored = await storeFromUrl({
      url: first.url,
      kind: "images",
      projectId,
      filename,
    });

    await markSceneGenerated(scene.id, {
      imageUrl: stored.url,
      falRequestId: result.requestId,
      // Per-scene regen always invalidates animation — the operator clicked
      // ↻ to get a different image, so the existing video (animated from the
      // old image) shouldn't ship in the bundle.
      invalidateAnimation: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    await markSceneFailed(scene.id, msg);
    throw err;
  }
}

// ── Animate (reel-only): seedance + Topaz upscale ───────────────────────────

export type AnimateAllResult = {
  animated: number;
  failed: number;
  /** Scenes skipped because they were already animated (videoUrl present). */
  skipped: number;
};

/**
 * Reel-only. After all stills are generated/approved, this turns each one
 * into a short upscaled mp4: motion prompt → seedance image-to-video → Topaz
 * Proteus 2× upscale → store on Blob → persist videoUrl.
 *
 * Reuses the generation lock pattern (atomic CAS, stale-recovery) so a
 * double-click can't pile up duplicate $5 spends.
 */
export async function animateAllScenes(
  projectId: string,
  opts: { concurrency?: number; force?: boolean } = {}
): Promise<AnimateAllResult> {
  const project = await selectProjectById(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);
  if (project.format !== "reel") {
    throw new Error("Animate is only available for reel-format projects.");
  }
  if (!project.concept) throw new Error("Project has no concept brief — animate after concept exists.");

  const concurrency = opts.concurrency ?? 2; // seedance is heavy — keep parallelism low

  const acquired = await tryAcquireGenerationLock(projectId);
  if (!acquired) throw new ProjectBusyError(projectId);

  try {
    const allScenes = await selectScenesByProject(projectId);
    const candidates = allScenes.filter(
      (s) => !!s.imageUrl && (s.status === "generated" || s.status === "approved")
    );
    if (candidates.length === 0) {
      throw new Error("No generated scenes to animate. Generate stills first.");
    }
    if (candidates.length < allScenes.length) {
      const missing = allScenes.length - candidates.length;
      throw new Error(
        `Cannot animate: ${missing} scene${missing === 1 ? "" : "s"} not yet generated. Generate or reject them first.`
      );
    }

    const targets = candidates.filter((s) => (opts.force ? true : !s.videoUrl));
    const skipped = candidates.length - targets.length;

    if (targets.length === 0) {
      await updateProjectStatus(projectId, "ready");
      return { animated: 0, failed: 0, skipped };
    }

    // Single Claude call for all motion prompts — cheaper than per-scene
    // and gives Claude the full sequence so it can vary moves intentionally.
    const motionResp = await generateMotionPrompts({
      concept: project.concept,
      scenes: targets.map((s) => ({ order: s.order, prompt: s.prompt })),
    });
    const motionByOrder = new Map(motionResp.motions.map((m) => [m.order, m.motion]));

    let animated = 0;
    let failed = 0;

    await runWithConcurrency(targets, concurrency, async (scene) => {
      const motion = motionByOrder.get(scene.order);
      if (!motion) {
        await markSceneFailed(scene.id, "No motion prompt returned for this scene.");
        failed++;
        return;
      }
      try {
        await markSceneAnimating(scene.id, motion);

        // Seedance: image → video (720p, 9:16, scene durationSec).
        const seed = await generateVideo({
          imageUrl: scene.imageUrl as string,
          motionPrompt: motion,
          durationSec: scene.durationSec || 3,
          resolution: "720p",
          aspectRatio: "9:16",
        });

        // Topaz: 720p → 1440p with Proteus.
        const upscaled = await upscaleVideo({
          videoUrl: seed.videoUrl,
          model: "Proteus",
          upscaleFactor: 2,
        });

        // Re-host on our own Blob so the URL is stable + downloadable.
        const filename = `scene-${String(scene.order).padStart(3, "0")}-${nanoid(6)}.mp4`;
        const stored = await storeFromUrl({
          url: upscaled.videoUrl,
          kind: "videos",
          projectId,
          filename,
        });

        await markSceneAnimated(scene.id, { videoUrl: stored.url });
        animated++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown error";
        await markSceneFailed(scene.id, msg);
        failed++;
      }
    });

    await updateProjectStatus(projectId, "ready");
    return { animated, failed, skipped };
  } catch (err) {
    await updateProjectStatus(projectId, "ready");
    throw err;
  }
}

/** Bumped when the bundle/manifest shape changes incompatibly. */
export const MANIFEST_VERSION = 2;

export type FinalizeResult = {
  thumbnailUrl: string;
  metadata: Metadata;
};

/**
 * Run the post-generation pipeline:
 *   1. Generate metadata via Claude.
 *   2. Generate a thumbnail image via fal (uploaded to Blob).
 *   3. Persist metadata + thumbnailUrl to the project row.
 *   4. Mark project status 'exported'.
 *
 * The slideshow mp4 render was intentionally removed — assemble in CapCut where
 * music and per-clip Ken Burns are easier than fixed ffmpeg transitions.
 */
export async function finalizeProject(projectId: string): Promise<FinalizeResult> {
  const found = await getProjectWithScenes(projectId);
  if (!found) throw new Error(`Project ${projectId} not found`);
  const { project, scenes } = found;

  if (!project.concept) throw new Error("Project has no concept brief");

  const renderable = scenes.filter(
    (s) => !!s.imageUrl && (s.status === "generated" || s.status === "approved")
  );
  if (renderable.length === 0) {
    throw new Error("No generated scenes to finalize. Generate images first.");
  }
  if (renderable.length < scenes.length) {
    const missing = scenes.length - renderable.length;
    throw new Error(
      `Cannot finalize: ${missing} scene${missing === 1 ? "" : "s"} not yet generated. Generate or reject them first.`
    );
  }

  const acquired = await tryAcquireFinalizationLock(projectId);
  if (!acquired) throw new ProjectBusyError(projectId, "finalizing");

  try {
    const totalDurationSec = renderable.reduce((acc, s) => acc + (s.durationSec || 0), 0);

    const rawMetadata = await generateMetadata({
      concept: project.concept,
      niche: project.niche,
      format: project.format,
      sceneCount: renderable.length,
      totalDurationSec,
    });
    const metadata = substituteAppLink(rawMetadata, project.niche);

    const thumb = await generateThumbnail({
      projectId,
      concept: project.concept,
      format: project.format,
    });

    // Persist + mark exported (releases the lock).
    await markProjectFinalized(projectId, {
      thumbnailUrl: thumb.imageUrl,
      metadata,
    });

    return {
      thumbnailUrl: thumb.imageUrl,
      metadata,
    };
  } catch (err) {
    await updateProjectStatus(projectId, "ready");
    throw err;
  }
}

/**
 * Replace the {APP_LINK} placeholder in Claude's metadata with the current
 * operator's most niche-relevant app URL. Routing logic + URL config live in
 * lib/operators.ts. If the resolved URL is empty, leave the placeholder intact
 * so the operator notices and pastes a link manually.
 */
function substituteAppLink<
  T extends { youtubeDescription: string; pinnedComment: string }
>(metadata: T, niche: string): T {
  const op = currentOperator();
  const link = pickAppLink(op, niche);
  if (!link) return metadata;
  return {
    ...metadata,
    youtubeDescription: metadata.youtubeDescription.split("{APP_LINK}").join(link),
    pinnedComment: metadata.pinnedComment.split("{APP_LINK}").join(link),
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
