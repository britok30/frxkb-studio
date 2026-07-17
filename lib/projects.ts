import { nanoid } from "nanoid";
import { generateBeforeAfterConcept, generateConcept } from "@/lib/prompts/concept";
import { generateScenePrompts } from "@/lib/prompts/scenes";
import { ARCHITECTURE_LOCK, generateStyles } from "@/lib/prompts/styles";
import { applyLookToPrompt, getLook, type LookId } from "@/lib/prompts/looks";
import {
  assembleYouTubeMetadata,
  generateMetadata,
  generateYouTubeMetadata,
  type Metadata,
} from "@/lib/prompts/metadata";
import {
  defaultsForFormat,
  type Format,
  type AspectRatio,
  type PropertyType,
  type WorldType,
} from "@/lib/prompts/types";
import { editImage, generateImage } from "@/lib/fal";
import { generateVideo } from "@/lib/seedance";
import { upscaleVideo } from "@/lib/topaz";
import { generateMotionPrompts } from "@/lib/prompts/motion";
import { storeFromUrl } from "@/lib/storage";
import { runWithConcurrency } from "@/lib/concurrency";
import { currentOperator, pickAppLink } from "@/lib/operators";
import { findSimilarProjects, type DuplicateMatch } from "@/lib/world-dedupe";
import {
  insertProject,
  insertScenes,
  listProjectsRows,
  listProjectsWithCovers,
  markProjectFinalized,
  markSceneAnimated,
  markSceneAnimateFailed,
  markSceneAnimating,
  markSceneApproved,
  markSceneFailed,
  markSceneGenerated,
  markSceneGenerating,
  markSceneRejected,
  recoverAnimateFailedScenes,
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
  /** Visual lane the operator picked at creation time. Drives prompt copy
   *  in suggest-world, concept, scenes, and thumbnail. */
  worldType: WorldType;
  sceneCount?: number;
  sceneDurationSec?: number;
  operatorNotes?: string;
  /** Committed photographic look (lib/prompts/looks.ts). Optional — omitted
   *  means GPT-5.5 chooses the light per concept, the pre-looks behavior. */
  lookId?: LookId;
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
  // Operator scope check: each operator's apps cover specific visual lanes
  // (e.g., InteriorGPT is interior-only). Reject out-of-lane requests early
  // before burning GPT-5.5 tokens.
  const op = currentOperator();
  if (!op.worldTypes.includes(input.worldType)) {
    throw new Error(
      `Operator ${op.email} doesn't cover ${input.worldType} content. Allowed: ${op.worldTypes.join(", ")}.`
    );
  }

  // Resolve + validate the committed look before any LLM spend. A look that
  // doesn't cover the picked lane (e.g. Twilight Hero on an interior) is an
  // operator error, not something to silently drop.
  const look = getLook(input.lookId);
  if (input.lookId && !look) {
    throw new Error(`Unknown look "${input.lookId}".`);
  }
  if (look && !look.worlds.includes(input.worldType)) {
    throw new Error(
      `Look "${look.name}" doesn't cover ${input.worldType} content. Suited lanes: ${look.worlds.join(", ")}.`
    );
  }

  const defaults = defaultsForFormat(input.format);
  const sceneCount = clamp(input.sceneCount ?? defaults.sceneCount, 1, 120);
  // Carousel contract: durationSec=0 means "static slide, no playback duration."
  const sceneDurationSec = clamp(input.sceneDurationSec ?? defaults.sceneDurationSec, 0, 15);
  // GPT-5.5's prompt schema requires durationSec >= 2; pad carousel's 0 up to 4 just for prompt context.
  const promptDuration = sceneDurationSec === 0 ? 4 : sceneDurationSec;
  const aspectRatio = defaults.aspectRatio;
  const targetDurationSec = sceneCount * sceneDurationSec;

  const projectId = nanoid(12);

  // Run BOTH GPT-5.5 calls before any DB writes. If either fails we leave no
  // orphan project row to clean up.
  const concept = await generateConcept({
    niche: input.niche,
    format: input.format,
    worldType: input.worldType,
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
    worldType: input.worldType,
    look,
  });

  // LLM work succeeded — persist.
  const project = await insertProject({
    id: projectId,
    title: concept.workingTitle,
    niche: input.niche,
    format: input.format,
    worldType: input.worldType,
    status: "scripting",
    lookId: look?.id ?? null,
    targetDurationSec: targetDurationSec || null,
    concept: {
      workingTitle: concept.workingTitle,
      hook: concept.hook,
      vibe: concept.vibe,
      notes: concept.notes,
      objectSet: concept.objectSet,
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

/**
 * Before-after project creation. Distinct from createProject because:
 *  - The "before" scene's image is operator-uploaded, not generated.
 *  - Aspect ratio comes from the upload's actual dimensions, not format default.
 *  - Only one image gets generated downstream (the "after"), via /edit
 *    conditioned on the upload as the reference.
 *  - No scene-prompt batch — there are exactly 2 scenes with hardcoded prompts.
 *
 * The GPT-5.5 concept call still runs because finalize needs concept fields
 * (workingTitle/hook/vibe) for metadata + thumbnail.
 */
export type CreateBeforeAfterInput = {
  /** Public URL of the uploaded "before" image (already on Vercel Blob via
   *  /api/upload). Becomes scene 1's imageUrl directly. */
  beforeImageUrl: string;
  /** Operator's transformation prompt — what the AI should do to the before
   *  image. Becomes scene 2's prompt. */
  transformationPrompt: string;
  /** Aspect ratio detected from the uploaded image (snapped to enum by
   *  /api/upload). Persisted on the project so downstream calls inherit it. */
  aspectRatio: AspectRatio;
  worldType: WorldType;
};

export async function createBeforeAfterProject(
  input: CreateBeforeAfterInput
): Promise<ProjectWithScenes> {
  const op = currentOperator();
  if (!op.worldTypes.includes(input.worldType)) {
    throw new Error(
      `Operator ${op.email} doesn't cover ${input.worldType} content. Allowed: ${op.worldTypes.join(", ")}.`
    );
  }

  const projectId = nanoid(12);
  const afterDurationSec = defaultsForFormat("before-after").sceneDurationSec; // 9

  // Slim concept call — generates only the four PromptableConcept fields
  // (workingTitle/hook/vibe/notes). Skips worldSignature + worldKeywords
  // since before-after doesn't dedupe (each upload is unique).
  const concept = await generateBeforeAfterConcept({
    transformationPrompt: input.transformationPrompt,
    worldType: input.worldType,
  });

  const project = await insertProject({
    id: projectId,
    title: concept.workingTitle,
    niche: input.transformationPrompt,
    format: "before-after",
    worldType: input.worldType,
    aspectRatio: input.aspectRatio,
    status: "scripting",
    targetDurationSec: afterDurationSec,
    concept: {
      workingTitle: concept.workingTitle,
      hook: concept.hook,
      vibe: concept.vibe,
      notes: concept.notes,
      objectSet: concept.objectSet,
    },
    // No dedupe for before-after.
    worldSignature: null,
    worldKeywords: null,
  });

  // Scene 1 = the upload itself, persisted as already-generated. No fal call.
  // Scene 2 = the "after" — pending. Its referenceImageUrl pins scene 1's
  // upload so generateAllImages routes it through /edit (legitimate edit
  // of the operator's photo, not a reel/carousel text-to-image).
  // Only the after gets animated; the upload stays static. They still share
  // a durationSec so the operator can cut a paired reel (static before →
  // animated after) cleanly.
  const insertedScenes = await insertScenes([
    {
      id: nanoid(12),
      projectId,
      order: 1,
      prompt: `(uploaded before) ${concept.workingTitle}`,
      durationSec: afterDurationSec, // shared with the after so paired cuts read as matched
      status: "generated",
      imageUrl: input.beforeImageUrl,
      referenceImageUrl: null, // it IS the reference for the after scene
    },
    {
      id: nanoid(12),
      projectId,
      order: 2,
      prompt: input.transformationPrompt,
      durationSec: afterDurationSec,
      status: "pending",
      referenceImageUrl: input.beforeImageUrl,
    },
  ]);

  return { project, scenes: insertedScenes };
}

/**
 * Style-explorer project creation. One described, AI-rendered base image → N
 * styled edits of it, for a YouTube long-form "X styles of this space" video.
 * The base is produced + reviewed via /api/style-base before this runs. Distinct
 * from
 * createProject and createBeforeAfterProject because:
 *  - GPT-5.5 SEES the base (vision) and proposes the styles — no niche/concept
 *    text drives it.
 *  - It fans out: one base becomes N pending scenes, each pinned to the base
 *    via referenceImageUrl so generateAllImages edits each through nano-banana
 *    /edit (the same conditioning before-after uses for its "after").
 *  - Each scene carries title + subtitle card copy (styleName/styleSubtitle)
 *    for the operator's CapCut name cards.
 *  - Static stills only; no animation, no dedupe.
 */
export type CreateStyleExplorerInput = {
  /** Public Blob URL of the operator-approved base — a text-to-image render
   *  produced + reviewed via /api/style-base (we never use someone's photo). */
  baseImageUrl: string;
  /** Aspect ratio of the base (16:9 for YouTube long-form). Persisted on the
   *  project so every styled edit inherits the base's shape. */
  aspectRatio: AspectRatio;
  worldType: WorldType;
  propertyType: PropertyType;
  /** How many styles to propose. Clamped 3–20; defaults to the format default (10). */
  styleCount?: number;
  /** Optional steering — location, tier, or angle for the SEO concept. */
  operatorNotes?: string;
  /** The operator's own description of the space (what they typed to render the
   *  base). Persisted as the project niche + concept vibe so the YouTube
   *  metadata grounds its title/description in the real space, not a generic
   *  "residential interior". */
  baseDescription?: string;
};

export async function createStyleExplorerProject(
  input: CreateStyleExplorerInput
): Promise<ProjectWithScenes> {
  const op = currentOperator();
  if (!op.worldTypes.includes(input.worldType)) {
    throw new Error(
      `Operator ${op.email} doesn't cover ${input.worldType} content. Allowed: ${op.worldTypes.join(", ")}.`
    );
  }
  if (!op.propertyTypes.includes(input.propertyType)) {
    throw new Error(
      `Operator ${op.email} doesn't cover ${input.propertyType} content. Allowed: ${op.propertyTypes.join(", ")}.`
    );
  }

  const styleCount = clamp(
    input.styleCount ?? defaultsForFormat("style-explorer").sceneCount,
    3,
    20
  );
  const projectId = nanoid(12);

  // Vision call: GPT-5.5 sees the uploaded base and proposes the styles before
  // any DB write, so a failure leaves no orphan project row.
  const stylesResp = await generateStyles({
    baseImageUrl: input.baseImageUrl,
    worldType: input.worldType,
    propertyType: input.propertyType,
    count: styleCount,
    operatorNotes: input.operatorNotes,
  });
  if (stylesResp.styles.length === 0) {
    throw new Error("Style generation returned no styles. Try again or adjust the notes.");
  }

  const n = stylesResp.styles.length;
  const workingTitle = `${n} ${capitalize(input.propertyType)} ${capitalize(input.worldType)} Styles`;
  // The space description is the project's subject (niche). Falls back to notes,
  // then a generic label, so the row is always meaningful.
  const niche =
    input.baseDescription?.trim() ||
    input.operatorNotes?.trim() ||
    `${input.propertyType} ${input.worldType} style explorer`;

  const project = await insertProject({
    id: projectId,
    title: workingTitle,
    niche,
    format: "style-explorer",
    worldType: input.worldType,
    propertyType: input.propertyType,
    aspectRatio: input.aspectRatio,
    status: "scripting",
    targetDurationSec: null,
    concept: {
      workingTitle,
      hook: `${n} distinct design styles applied to one ${input.propertyType} ${input.worldType} space.`,
      // vibe carries the space description; notes carries the operator steering.
      // finalizeStyleExplorer reads both back for the YouTube metadata.
      vibe:
        input.baseDescription?.trim() ||
        "One base space, reimagined across a set of recognisable design styles.",
      notes: input.operatorNotes?.trim() ?? "",
      objectSet: [],
    },
    // No dedupe for style-explorer — each upload is unique.
    worldSignature: null,
    worldKeywords: null,
  });

  // Scene 1 = the uploaded base, already "generated" (no fal call) so it shows
  // as the original. Scenes 2..N+1 = one per style, pending, each pinned to the
  // base via referenceImageUrl so generateAllImages routes them through
  // nano-banana /edit. Static stills (durationSec 0) — no animation.
  // Prepend the deterministic camera + architecture lock so every styled edit
  // is forced to the base's exact viewpoint — guards against the per-style
  // angle drift GPT-5.5's own wording occasionally let through. The stored
  // prompt is what feeds nano-banana /edit (and per-scene regen), so the lock
  // rides along on every generation.
  const styleScenes = stylesResp.styles.map((s, i) => ({
    id: nanoid(12),
    projectId,
    order: i + 2,
    prompt: `${ARCHITECTURE_LOCK}${s.editPrompt}`,
    styleName: s.styleName,
    styleSubtitle: s.styleSubtitle,
    durationSec: 0,
    status: "pending" as const,
    referenceImageUrl: input.baseImageUrl,
  }));

  const insertedScenes = await insertScenes([
    {
      id: nanoid(12),
      projectId,
      order: 1,
      prompt: "(base) the original space, before restyling",
      styleName: "Original",
      styleSubtitle: "The space, before restyling",
      durationSec: 0,
      status: "generated",
      imageUrl: input.baseImageUrl,
      referenceImageUrl: null,
    },
    ...styleScenes,
  ]);

  return { project, scenes: insertedScenes };
}

export async function listProjects(): Promise<Project[]> {
  return await listProjectsRows();
}

/** Project list with each project's resolved hero cover URL — used by the
 *  dashboard so cards can show the cover (scene 1 for reel/carousel, the
 *  after scene for before-after). */
export async function listProjectsForDashboard(): Promise<
  Array<Project & { coverUrl: string | null }>
> {
  return await listProjectsWithCovers();
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

  // Project-level aspectRatio (set by before-after from the upload's actual
  // dimensions) wins over the format default. Lets per-call opts override
  // both for ad-hoc generations.
  const aspectRatio =
    opts.aspectRatio ?? project.aspectRatio ?? defaultsForFormat(project.format).aspectRatio;
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

    // Every scene generates independently and in parallel. If a scene has a
    // frozen referenceImageUrl (set by createBeforeAfterProject for the
    // "after" scene), it runs through nano-banana-pro/edit conditioned on
    // that upload. Otherwise it runs through nano-banana-pro text-to-image
    // with a fresh seed — visual cohesion comes from shared GPT-5.5
    // vocabulary in each scene's self-contained prompt, not from pixel
    // anchoring. Trades some style-lock for more variety and removes the
    // "edits collapse toward the anchor" failure mode.
    // Project-level committed look, appended to every prompt (no-op when the
    // project has none — style-explorer and before-after never set one).
    const look = getLook(project.lookId);

    await runWithConcurrency(targets, concurrency, async (scene) => {
      await markSceneGenerating(scene.id);
      try {
        const promptForFal = applyLookToPrompt(lockedScenePrompt(project, scene), look);
        const result = scene.referenceImageUrl
          ? await editImage({
              prompt: promptForFal,
              imageUrls: [scene.referenceImageUrl],
              aspectRatio,
              seed: freshSeed(),
            })
          : await generateImage({
              prompt: promptForFal,
              aspectRatio,
              seed: freshSeed(),
            });
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
          invalidateAnimation: !!scene.imageUrl,
          // Preserve whatever referenceImageUrl was already set. Reel/
          // carousel scenes leave it null; before-after "after" keeps the
          // operator's upload pinned for per-scene regen.
        });
        generated++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown error";
        await markSceneFailed(scene.id, msg);
        failed++;
      }
    });

    await updateProjectStatus(projectId, "ready");

    return { generated, failed, skipped, reclaimed };
  } catch (err) {
    await updateProjectStatus(projectId, "scripting");
    throw err;
  }
}

export type SceneAction = "approve" | "reject" | "regenerate";

/** Optional per-call design direction layered on top of the stored prompt for
 *  a single regeneration. Only meaningful when action === "regenerate".
 *  Capped at 500 chars matching the API zod schema. */
export type SceneActionOptions = {
  designDirection?: string;
  /** Optional look override for ONE regeneration — swaps the project's
   *  committed look (or adds one where the project has none) for this call
   *  only. The stored prompt and the project's lookId are never mutated. */
  lookId?: LookId;
};

export async function applySceneAction(
  projectId: string,
  sceneId: string,
  action: SceneAction,
  options: SceneActionOptions = {},
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
      await regenerateScene(projectId, scene, options);
      break;
  }

  const refreshed = await selectSceneById(sceneId);
  if (!refreshed) throw new Error(`Scene ${sceneId} disappeared mid-update`);
  return refreshed;
}

/**
 * Guarantee the camera + architecture lock leads a style-explorer style scene's
 * prompt before it hits fal. New projects bake the lock into scene.prompt at
 * creation, but projects made before the lock existed have lock-less prompts —
 * this prepends it at generation/regeneration time so their scenes can be fixed
 * in place (no need to recreate the project). No-op for other formats, for the
 * "Original" scene (no referenceImageUrl), and for prompts that already carry it.
 */
function lockedScenePrompt(project: Project, scene: Scene): string {
  if (
    project.format === "style-explorer" &&
    scene.referenceImageUrl &&
    !scene.prompt.startsWith(ARCHITECTURE_LOCK)
  ) {
    return `${ARCHITECTURE_LOCK}${scene.prompt}`;
  }
  return scene.prompt;
}

/** Layer the operator's design direction on top of the stored scene prompt
 *  for ONE fal call. The stored prompt is never mutated — each regen can
 *  carry a fresh direction. Empty / whitespace-only directions are ignored
 *  (operator hit Regenerate without filling the box → identical to the
 *  pre-dialog blind reroll behavior). */
function augmentPromptWithDirection(prompt: string, direction?: string): string {
  const trimmed = direction?.trim();
  if (!trimmed) return prompt;
  return `${prompt}\n\nAdditional direction from the operator (apply on top of everything above — keep the same materials, lineage, and overall world; the direction only adjusts the named axis): ${trimmed}`;
}

async function regenerateScene(
  projectId: string,
  scene: Scene,
  options: SceneActionOptions = {},
): Promise<void> {
  const project = await selectProjectById(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);
  // Project-stored aspect (set per-upload for before-after) wins over the
  // format default — otherwise per-scene regen of an after image would
  // generate at 1:1 even if the upload was 16:9.
  const aspectRatio =
    project.aspectRatio ?? defaultsForFormat(project.format).aspectRatio;
  // Layer order: stored prompt → look block → operator direction. The look
  // override (one call only) beats the project's committed look; the
  // operator's free-text direction comes last so it beats both.
  const look = getLook(options.lookId ?? project.lookId);
  const promptForFal = augmentPromptWithDirection(
    applyLookToPrompt(lockedScenePrompt(project, scene), look),
    options.designDirection
  );

  await markSceneGenerating(scene.id);
  try {
    // Scenes without a stored reference regenerate via text-to-image
    // (reel/carousel). Scenes WITH a reference re-use that frozen upload
    // through /edit (before-after "after" scene stays locked to the
    // operator's before image).
    const useReference = scene.referenceImageUrl;
    const result = useReference
      ? await editImage({
          prompt: promptForFal,
          imageUrls: [useReference],
          aspectRatio,
          seed: freshSeed(),
        })
      : await generateImage({
          prompt: promptForFal,
          aspectRatio,
          seed: freshSeed(),
        });
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
      // Preserve the existing referenceImageUrl — omitted means no change.
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
  // Animation makes sense for reel (every scene → video) and before-after
  // (just the "after" scene → video). Carousel stays static.
  if (project.format !== "reel" && project.format !== "before-after") {
    throw new Error("Animate is only available for reel and before-after projects.");
  }
  if (!project.concept) throw new Error("Project has no concept brief — animate after concept exists.");

  // Reels are always 9:16; before-after inherits from the upload (stored on
  // project.aspectRatio). The seedance call below uses this so the after
  // video matches the source.
  const animateAspect: AspectRatio =
    project.aspectRatio ?? defaultsForFormat(project.format).aspectRatio;
  const concurrency = opts.concurrency ?? 2; // seedance is heavy — keep parallelism low

  const acquired = await tryAcquireGenerationLock(projectId);
  if (!acquired) throw new ProjectBusyError(projectId);

  // Recover scenes stuck "rejected" from a prior animate failure (still good,
  // video pipeline crashed). Operator-rejected scenes are unaffected — the
  // signature query requires motionPrompt to be set, which only animate-
  // attempts set.
  await recoverAnimateFailedScenes(projectId);

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

    // Before-after only animates the AI-generated "after" — the upload stays
    // static (it's a real photo, not Seedance fodder; animating it tends to
    // produce uncanny artifacts). The static before + animated after pair
    // also gives the operator a clean cut for the reel/TikTok edit.
    const animatable =
      project.format === "before-after"
        ? candidates.filter((s) => !!s.referenceImageUrl)
        : candidates;
    const targets = animatable.filter((s) => (opts.force ? true : !s.videoUrl));
    const skipped = candidates.length - targets.length;

    if (targets.length === 0) {
      await updateProjectStatus(projectId, "ready");
      return { animated: 0, failed: 0, skipped };
    }

    // Single GPT-5.5 call for all motion prompts — cheaper than per-scene
    // and gives GPT-5.5 the full sequence so it can vary moves intentionally.
    // Defensive [] fallback for objectSet — pre-2026-05 concepts persisted
    // before the field existed.
    const motionResp = await generateMotionPrompts({
      concept: { ...project.concept, objectSet: project.concept.objectSet ?? [] },
      scenes: targets.map((s) => ({ order: s.order, prompt: s.prompt })),
    });
    const motionByOrder = new Map(motionResp.motions.map((m) => [m.order, m.motion]));

    let animated = 0;
    let failed = 0;

    await runWithConcurrency(targets, concurrency, async (scene) => {
      const motion = motionByOrder.get(scene.order);
      if (!motion) {
        // Animate-pipeline failure — keep status, the still is fine.
        await markSceneAnimateFailed(scene.id, "No motion prompt returned for this scene.");
        failed++;
        return;
      }
      try {
        await markSceneAnimating(scene.id, motion);

        // Seedance: image → video at the project's aspect (9:16 for reels,
        // upload-derived for before-after). Fresh seed per call so the same
        // motion prompt + still doesn't keep landing on the same camera move.
        const seedanceResult = await generateVideo({
          imageUrl: scene.imageUrl as string,
          motionPrompt: motion,
          durationSec: scene.durationSec || 3,
          resolution: "720p",
          aspectRatio: animateAspect,
          seed: freshSeed(),
        });

        // Topaz: 720p → 1440p with Proteus.
        const upscaled = await upscaleVideo({
          videoUrl: seedanceResult.videoUrl,
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
        await markSceneAnimateFailed(scene.id, msg);
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
  metadata: Metadata;
};

/**
 * Finalize a style-explorer project into YouTube long-form metadata. Parallels
 * the social finalize path but: generates SEO-optimised YouTube metadata
 * (title / thumbnail text / description / tags / hashtags), assembles the final
 * description deterministically (chapters from the actual styles, CTA with the
 * operator's real Instagram + website), and persists it. No thumbnail render —
 * the operator brings their own thumbnail and the burned-in text we supply.
 */
async function finalizeStyleExplorer(project: Project, scenes: Scene[]): Promise<FinalizeResult> {
  const renderable = scenes.filter(
    (s) => !!s.imageUrl && (s.status === "generated" || s.status === "approved")
  );
  if (renderable.length === 0) {
    throw new Error("No generated styles to finalize. Generate the styled images first.");
  }
  if (renderable.length < scenes.length) {
    const missing = scenes.length - renderable.length;
    throw new Error(
      `Cannot finalize: ${missing} style${missing === 1 ? "" : "s"} not yet generated. Generate or reject them first.`
    );
  }

  const acquired = await tryAcquireFinalizationLock(project.id);
  if (!acquired) throw new ProjectBusyError(project.id, "finalizing");

  try {
    // Styles in running order, excluding the uploaded "Original" intro scene —
    // these become the chapter list and feed the title/description.
    const styleNames = scenes
      .filter((s) => !!s.styleName && s.styleName !== "Original")
      .sort((a, b) => a.order - b.order)
      .map((s) => s.styleName as string);

    const op = currentOperator();
    // The space description lives on niche (and concept.vibe); operator steering
    // lives on concept.notes. Feed both so the title/description are grounded in
    // the real space the operator described, not a generic "residential interior".
    const draft = await generateYouTubeMetadata({
      spaceDescription: project.concept?.vibe?.trim() || project.niche,
      notes: project.concept?.notes?.trim() || undefined,
      worldType: project.worldType,
      propertyType: project.propertyType,
      styleNames,
    });

    const metadata = assembleYouTubeMetadata({
      draft,
      styleNames,
      appName: op.apps[0]?.name ?? "our app",
      instagram: op.socials.instagram,
      website: op.socials.website,
    });

    await markProjectFinalized(project.id, { metadata });
    return { metadata };
  } catch (err) {
    await updateProjectStatus(project.id, "ready");
    throw err;
  }
}

/**
 * Run the post-generation pipeline:
 *   1. Generate metadata via GPT-5.5.
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

  // Style-explorer finalizes to YouTube long-form metadata instead of the
  // IG/TikTok social package — different shape, different generator.
  if (project.format === "style-explorer") {
    return await finalizeStyleExplorer(project, scenes);
  }

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

    // Pull the operator's live apps so the metadata prompt only mentions
    // apps actually configured (no more telling GPT-5.5 about CasaGPT when
    // it's been pulled from rotation).
    const op = currentOperator();
    const rawMetadata = await generateMetadata({
      concept: { ...project.concept, objectSet: project.concept.objectSet ?? [] },
      niche: project.niche,
      format: project.format,
      worldType: project.worldType,
      sceneCount: renderable.length,
      totalDurationSec,
      appNames: op.apps.map((a) => a.name),
    });
    // Two-step post-process:
    //   1. substituteAppLink: replace {APP_LINK} placeholders with the
    //      niche-routed app URL.
    //   2. applyMetadataPolicies: enforce locked hashtags per worldType +
    //      append the operator's @handle to each platform caption.
    const handle = op.apps[0]?.handle ?? "";
    const metadata = applyMetadataPolicies(
      substituteAppLink(rawMetadata, project.niche),
      project.worldType,
      handle
    );

    // Thumbnail generation was deprecated 2026-05-10 — covers now derive
    // live from scenes (scene 1 for reel/carousel, the after scene for
    // before-after). See listProjectsWithCovers + buildExportData. Saves the
    // fal call entirely + removes a class of "wrong thumbnail" bugs.
    await markProjectFinalized(projectId, { metadata });

    return { metadata };
  } catch (err) {
    await updateProjectStatus(projectId, "ready");
    throw err;
  }
}

/**
 * Replace the {APP_LINK} placeholder in GPT-5.5's metadata with the current
 * operator's most niche-relevant app URL. Routing logic + URL config live in
 * lib/operators.ts. If the resolved URL is empty, leave the placeholder intact
 * so the operator notices and pastes a link manually.
 */
function substituteAppLink(metadata: Metadata, niche: string): Metadata {
  const op = currentOperator();
  const link = pickAppLink(op, niche);
  if (!link) return metadata;
  const sub = (s: string) => s.split("{APP_LINK}").join(link);
  switch (metadata.kind) {
    case "reel":
      return {
        ...metadata,
        // App CTA only lives in the long-form fields (Shorts description +
        // pinned comment). Captions stay clean — that was the rule in the
        // system prompt and we enforce it here too.
        shortsDescription: sub(metadata.shortsDescription),
        pinnedComment: sub(metadata.pinnedComment),
      };
    case "carousel":
      // Carousel + before-after share this branch (both use the carousel
      // metadata schema — single instagramCaption surface). Pure carousel
      // briefs are told to keep the caption app-free, but before-after is
      // told to close with a soft CTA. Either way, defensively substitute
      // any {APP_LINK} that lands in the caption — leaving the literal
      // placeholder in published copy is the worst outcome.
      return {
        ...metadata,
        instagramCaption: sub(metadata.instagramCaption),
      };
    case "youtube":
      // YouTube long-form assembles its CTA + real links in
      // finalizeStyleExplorer — there's no {APP_LINK} placeholder to swap.
      return metadata;
  }
}

/**
 * Locked anchor hashtags per visual lane. Server-side enforcement of the rule
 * GPT-5.5 is told about in the metadata system prompt — even if GPT-5.5 forgets
 * (or duplicates), we make sure the locks are present and the array is
 * trimmed to 5 total. Mirrors LOCKED_HASHTAGS_BY_WORLD in lib/prompts/metadata.ts.
 */
const LOCKED_HASHTAGS: Record<WorldType, string[]> = {
  interior: ["interiordesign", "interiors"],
  exterior: ["architecture", "architect", "architectura"],
};

const HASHTAG_TARGET_TOTAL = 5;

/** Prepend the locked anchors to a hashtag array, dedup against case-insensitive
 *  matches, trim to 5 total. */
function applyHashtagLocks(claudeTags: string[], worldType: WorldType): string[] {
  const locked = LOCKED_HASHTAGS[worldType];
  const lockedLower = new Set(locked.map((t) => t.toLowerCase()));
  const claudeFiltered = claudeTags.filter(
    (t) => !lockedLower.has(t.toLowerCase())
  );
  return [...locked, ...claudeFiltered].slice(0, HASHTAG_TARGET_TOTAL);
}

/**
 * Append the operator's @handle to a caption as a promo line. No-op when
 * the operator has no handle configured.
 */
function appendHandle(caption: string, handle: string): string {
  if (!handle) return caption;
  return `${caption}\n\n@${handle}`;
}

/**
 * Post-process GPT-5.5's raw metadata: enforce hashtag locks per worldType
 * and append the operator's @handle to captions. The lock enforcement is
 * defensive — GPT-5.5 is told the rule in the system prompt but might forget
 * or near-duplicate; this guarantees the anchor tags are always present.
 */
function applyMetadataPolicies(
  metadata: Metadata,
  worldType: WorldType,
  handle: string
): Metadata {
  switch (metadata.kind) {
    case "reel":
      return {
        ...metadata,
        tiktokCaption: appendHandle(metadata.tiktokCaption, handle),
        tiktokHashtags: applyHashtagLocks(metadata.tiktokHashtags, worldType),
        instagramCaption: appendHandle(metadata.instagramCaption, handle),
        instagramHashtags: applyHashtagLocks(metadata.instagramHashtags, worldType),
        // shortsDescription gets the handle suffix; {APP_LINK} substitution
        // happens in substituteAppLink, both compose cleanly. shortsHashtags
        // stay free — only 1-3 slots, too tight to enforce a multi-tag lock.
        shortsDescription: appendHandle(metadata.shortsDescription, handle),
      };
    case "carousel":
      return {
        ...metadata,
        instagramCaption: appendHandle(metadata.instagramCaption, handle),
        instagramHashtags: applyHashtagLocks(metadata.instagramHashtags, worldType),
      };
    case "youtube":
      // Hashtag locks + @handle suffix are IG/TikTok policies. YouTube metadata
      // carries its own CTA and hashtags; pass through unchanged.
      return metadata;
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Fresh random seed for image/video gen calls. nano-banana-pro and seedance
 * both have strong stylistic priors — same prompt + same seed lands on the
 * same composition. Passing a fresh seed per call is a documented lever for
 * breaking out of mode-collapse defaults (Google's own Nano Banana prompting
 * guide, ByteDance's seedance docs). Range stays inside int32 since both
 * APIs accept JSON-safe integers.
 */
function freshSeed(): number {
  return Math.floor(Math.random() * 2_147_483_647);
}
