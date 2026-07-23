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
import { editImage, generateImage, type Resolution } from "@/lib/fal";
import { composeVideo, type ComposeKeyframe, type ComposeTrack } from "@/lib/compose";
import {
  isShotstackConfigured,
  renderShotstack,
  SHOTSTACK_PER_MINUTE,
  type ShotstackClip,
  type ShotstackEdit,
} from "@/lib/shotstack";
import { generateVideo } from "@/lib/seedance";
import { upscaleVideo } from "@/lib/topaz";
import { generateMotionPrompts, getCameraMove } from "@/lib/prompts/motion";
import { storeFromUrl } from "@/lib/storage";
import { runWithConcurrency } from "@/lib/concurrency";
import { assertWithinDailyBudget, recordSpend } from "@/lib/spend";
import {
  estimateAnimateBatch,
  estimateConceptGen,
  estimateImageBatch,
  estimateMetadataGen,
  estimateSceneGen,
  estimateTopazUpscale,
  FAL_COMPOSE_PER_SECOND,
  FAL_NANO_BANANA_EDIT_PER_IMAGE,
  FAL_NANO_BANANA_PER_IMAGE,
  FAL_NANO_BANANA_PER_IMAGE_4K,
  FAL_SEEDANCE_PER_SECOND,
} from "@/lib/pricing";
import { currentOperator, pickAppLink } from "@/lib/operators";
import { findSimilarProjects, type DuplicateMatch } from "@/lib/world-dedupe";
import {
  deleteSceneVersion,
  heartbeatGenerationLock,
  insertProject,
  insertScenes,
  insertSceneVersion,
  selectSceneVersionById,
  selectSceneVersions,
  setSceneActiveImage,
  listProjectsRows,
  listProjectsWithCovers,
  markProjectFinalized,
  markProjectFinalVideo,
  updateStitchState,
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
  setProjectSceneReferences,
  setSceneMotionPreset,
  tryAcquireFinalizationLock,
  tryAcquireGenerationLock,
  updateProjectStatus,
} from "@/lib/projects-db";
import type { Project, Scene, SceneVersion } from "@/lib/db";

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
  /** Render-quality tier. standard (default) = 2K stills + native 1080p
   *  video. hero = 4K stills + Topaz 4K60 video pass. */
  quality?: "standard" | "hero";
  /** Moodboard / photo references (public Blob URLs, ≤5). When present:
   *  GPT-5.5 sees them while writing the brief, and every scene renders via
   *  /edit conditioned on them so materials, palette, and mood match the
   *  refs while the prompt supplies the room. */
  referenceImageUrls?: string[];
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
  // Cap refs at nano-banana's practical conditioning sweet spot. 14 is the
  // hard API limit but each chained scene also passes the anchor, and past
  // ~5 refs the per-ref influence dilutes anyway.
  const referenceImageUrls = (input.referenceImageUrls ?? []).slice(0, 5);

  // Run BOTH GPT-5.5 calls before any DB writes. If either fails we leave no
  // orphan project row to clean up.
  const concept = await generateConcept({
    niche: input.niche,
    format: input.format,
    worldType: input.worldType,
    targetDurationSec: targetDurationSec || undefined,
    operatorNotes: input.operatorNotes,
    referenceImageUrls: referenceImageUrls.length > 0 ? referenceImageUrls : undefined,
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
    operatorEmail: op.email,
    quality: input.quality ?? "standard",
    referenceImageUrls: referenceImageUrls.length > 0 ? referenceImageUrls : null,
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

  // LLM spend for scripting (concept + scene prompts) — estimate-based, the
  // closest bookkeeping we have for token billing.
  await recordSpend({
    projectId,
    kind: "llm",
    amountUsd: estimateConceptGen() + estimateSceneGen(sceneCount),
    meta: { stage: "scripting", sceneCount },
  });

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
    operatorEmail: op.email,
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
    operatorEmail: op.email,
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

  // Keep the generation lock fresh for the whole batch — a 120-scene run
  // outlives STALE_LOCK_MS, and without the heartbeat a second event could
  // reclaim the lock mid-run and double-spend.
  const heartbeat = setInterval(() => {
    heartbeatGenerationLock(projectId).catch(() => {});
  }, 60_000);

  try {
    const allScenes = await selectScenesByProject(projectId);
    const targets = allScenes.filter((s) =>
      opts.force ? true : s.status === "pending" || s.status === "rejected"
    );

    // Budget gate BEFORE any fal spend — a 120-scene batch at hero quality
    // is real money, and the lock alone only prevents duplicates, not size.
    await assertWithinDailyBudget(estimateImageBatch(targets.length, project.quality));

    let generated = 0;
    let failed = 0;
    const skipped = allScenes.length - targets.length;

    // Project-level committed look, appended to every prompt (no-op when the
    // project has none — style-explorer and before-after never set one).
    const look = getLook(project.lookId);
    const resolution: Resolution = project.quality === "hero" ? "4K" : "2K";
    // Operator moodboard/photo refs (reel/carousel). Every render is
    // conditioned on them; the deterministic suffix tells nano the refs are
    // material/palette/mood guidance while the prompt supplies the room.
    const moodboardRefs = project.referenceImageUrls ?? [];

    const renderScene = async (scene: Scene, referenceUrl: string | null) => {
      await markSceneGenerating(scene.id);
      // Ref order matters — nano weights earlier images more, so the anchor
      // (world lock) leads and the moodboard follows.
      const conditioningUrls = [
        ...(referenceUrl ? [referenceUrl] : []),
        ...moodboardRefs,
      ].slice(0, 14);
      const promptForFal = applyMoodboardGuidance(
        applyLookToPrompt(lockedScenePrompt(project, scene), look),
        moodboardRefs.length,
        !!referenceUrl
      );
      const seed = freshSeed();
      const result = conditioningUrls.length > 0
        ? await editImage({
            prompt: promptForFal,
            imageUrls: conditioningUrls,
            aspectRatio,
            resolution,
            seed,
          })
        : await generateImage({
            prompt: promptForFal,
            aspectRatio,
            resolution,
            seed,
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

      // Non-destructive overwrite: snapshot the outgoing render (force /
      // regenerate-all paths) into the variant history first.
      if (scene.imageUrl) {
        await insertSceneVersion({
          id: nanoid(12),
          sceneId: scene.id,
          imageUrl: scene.imageUrl,
          prompt: scene.prompt,
          seed: scene.seed,
        });
      }

      await markSceneGenerated(scene.id, {
        imageUrl: stored.url,
        falRequestId: result.requestId,
        seed,
        invalidateAnimation: !!scene.imageUrl,
        // referenceImageUrl for chained scenes is frozen separately via
        // setProjectSceneReferences; omitted here means "preserve".
      });
      await recordSpend({
        projectId,
        kind: conditioningUrls.length > 0 ? "image-edit" : "image",
        amountUsd: imageSpendUsd(conditioningUrls.length > 0, project.quality),
        meta: { sceneOrder: scene.order, resolution, refs: conditioningUrls.length },
      });
      return stored.url;
    };

    // ── Anchor chaining (reel/carousel) ────────────────────────────────────
    // The lowest-order scene is the ANCHOR: it renders via text-to-image and
    // defines the home. Every other scene renders via /edit conditioned on
    // the anchor so scene 5 is unmistakably the same house as scene 1 —
    // shared prompt vocabulary alone does not hold materials, furniture, or
    // architecture stable. The anchor URL is frozen onto each scene's
    // referenceImageUrl so later per-scene regens stay in the same world
    // even if the anchor is regenerated afterwards.
    const chained = project.format === "reel" || project.format === "carousel";
    let pending = targets;
    let anchorUrl: string | null = null;

    if (chained && allScenes.length > 1) {
      const anchor = allScenes.reduce((a, b) => (a.order <= b.order ? a : b));
      const anchorTarget = pending.find((s) => s.id === anchor.id);
      if (anchorTarget) {
        // Anchor renders first, alone — everything else chains off it.
        try {
          anchorUrl = await renderScene(anchorTarget, anchorTarget.referenceImageUrl);
          generated++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : "unknown error";
          await markSceneFailed(anchorTarget.id, msg);
          failed++;
        }
        pending = pending.filter((s) => s.id !== anchor.id);
      } else {
        anchorUrl = anchor.imageUrl ?? null;
      }
      if (anchorUrl) {
        await setProjectSceneReferences(projectId, anchor.id, anchorUrl);
      }
    }

    const failedScenes: Scene[] = [];
    const referenceFor = (scene: Scene): string | null =>
      scene.referenceImageUrl ?? (chained ? anchorUrl : null);

    await runWithConcurrency(pending, concurrency, async (scene) => {
      try {
        await renderScene(scene, referenceFor(scene));
        generated++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown error";
        await markSceneFailed(scene.id, msg);
        failedScenes.push(scene);
        failed++;
      }
    });

    // One automatic retry pass over the failed subset — fal hiccups are
    // usually transient, and a single retry beats making the operator click
    // through rejected scenes by hand.
    if (failedScenes.length > 0) {
      await runWithConcurrency(failedScenes, concurrency, async (scene) => {
        try {
          await renderScene(scene, referenceFor(scene));
          generated++;
          failed--;
        } catch (err) {
          // Re-mark the failure: renderScene's markSceneGenerating flipped
          // the scene back to "generating" and cleared the error, so doing
          // nothing here strands it as an orphan. Marking failed restores
          // the rejected status + visible error.
          const msg = err instanceof Error ? err.message : "unknown error";
          await markSceneFailed(scene.id, msg);
        }
      });
    }

    await updateProjectStatus(projectId, "ready");

    return { generated, failed, skipped, reclaimed };
  } catch (err) {
    await updateProjectStatus(projectId, "scripting");
    throw err;
  } finally {
    clearInterval(heartbeat);
  }
}

export type SceneAction = "approve" | "reject" | "regenerate" | "set-motion";

/** Optional per-call design direction layered on top of the stored prompt for
 *  a single regeneration. Only meaningful when action === "regenerate".
 *  Capped at 500 chars matching the API zod schema. */
export type SceneActionOptions = {
  designDirection?: string;
  /** Optional look override for ONE regeneration — swaps the project's
   *  committed look (or adds one where the project has none) for this call
   *  only. The stored prompt and the project's lookId are never mutated. */
  lookId?: LookId;
  /** set-motion only: a CAMERA_MOVES id to lock for this scene, or null to
   *  clear the lock (GPT picks again). */
  motionPreset?: string | null;
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
    case "set-motion": {
      const preset = options.motionPreset ?? null;
      if (preset && !getCameraMove(preset)) {
        throw new Error(`Unknown camera move "${preset}".`);
      }
      await setSceneMotionPreset(sceneId, preset);
      break;
    }
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

/**
 * Deterministic guidance appended when a render is conditioned on operator
 * moodboard refs — nano needs to be told the refs are a STYLE guide, not the
 * room to reproduce, or it drifts toward copying a reference's layout.
 * When an anchor image also rides along (chained scenes), it's named first
 * so the world lock and the moodboard don't fight.
 */
function applyMoodboardGuidance(
  prompt: string,
  moodboardCount: number,
  hasAnchor: boolean
): string {
  if (moodboardCount === 0) return prompt;
  const refsNoun = moodboardCount === 1 ? "reference image" : "reference images";
  if (hasAnchor) {
    return `${prompt}\n\nThe first attached image is the anchor — the same home this scene lives in; keep its architecture, materials, and palette. The remaining ${refsNoun} are the operator's moodboard: draw material finishes, color story, and mood from them. The room and composition come from the text above.`;
  }
  return `${prompt}\n\nThe attached ${refsNoun} are the operator's moodboard: draw the material palette, color story, textures, and mood from them. The room, layout, and composition come from the text above — build that room in this moodboard's world.`;
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
  // Layer order: stored prompt → look block → moodboard guidance → operator
  // direction. The look override (one call only) beats the project's
  // committed look; the operator's free-text direction comes last so it
  // beats everything.
  const look = getLook(options.lookId ?? project.lookId);
  const moodboardRefs = project.referenceImageUrls ?? [];
  const promptForFal = augmentPromptWithDirection(
    applyMoodboardGuidance(
      applyLookToPrompt(lockedScenePrompt(project, scene), look),
      moodboardRefs.length,
      !!scene.referenceImageUrl
    ),
    options.designDirection
  );

  await markSceneGenerating(scene.id);
  try {
    // Conditioning order mirrors generateAllImages: the frozen reference
    // (anchor / upload / base) leads, the moodboard refs follow. A scene
    // with neither regenerates via text-to-image.
    const resolution: Resolution = project.quality === "hero" ? "4K" : "2K";
    const seed = freshSeed();
    const conditioningUrls = [
      ...(scene.referenceImageUrl ? [scene.referenceImageUrl] : []),
      ...moodboardRefs,
    ].slice(0, 14);
    const useReference = conditioningUrls.length > 0;
    const result = useReference
      ? await editImage({
          prompt: promptForFal,
          imageUrls: conditioningUrls,
          aspectRatio,
          resolution,
          seed,
        })
      : await generateImage({
          prompt: promptForFal,
          aspectRatio,
          resolution,
          seed,
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

    // Non-destructive reroll: the outgoing render goes into the variant
    // history so the operator can restore it if this take is worse. The
    // archived row carries the stored prompt + the seed that render used;
    // direction/look overrides of PAST takes weren't recorded on the scene,
    // so they stay null.
    if (scene.imageUrl) {
      await insertSceneVersion({
        id: nanoid(12),
        sceneId: scene.id,
        imageUrl: scene.imageUrl,
        prompt: scene.prompt,
        seed: scene.seed,
      });
    }

    await markSceneGenerated(scene.id, {
      imageUrl: stored.url,
      falRequestId: result.requestId,
      seed,
      // Per-scene regen always invalidates animation — the operator clicked
      // ↻ to get a different image, so the existing video (animated from the
      // old image) shouldn't ship in the bundle.
      invalidateAnimation: true,
      // Preserve the existing referenceImageUrl — omitted means no change.
    });
    await recordSpend({
      projectId,
      kind: useReference ? "image-edit" : "image",
      amountUsd: imageSpendUsd(!!useReference, project.quality),
      meta: { sceneOrder: scene.order, regen: true },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    await markSceneFailed(scene.id, msg);
    throw err;
  }
}

// ── Variant history ─────────────────────────────────────────────────────────

/** All archived takes for a scene, newest first. */
export async function listSceneVersions(
  projectId: string,
  sceneId: string
): Promise<SceneVersion[]> {
  const scene = await selectSceneById(sceneId);
  if (!scene) throw new Error(`Scene ${sceneId} not found`);
  if (scene.projectId !== projectId) {
    throw new Error(`Scene ${sceneId} does not belong to project ${projectId}`);
  }
  return await selectSceneVersions(sceneId);
}

/**
 * Restore an archived take as the scene's active image. The takes SWAP: the
 * currently-active render goes into the history (so nothing is ever lost) and
 * the restored version's row is removed. Any existing video is invalidated —
 * it was animated from the outgoing image.
 */
export async function restoreSceneVersion(
  projectId: string,
  sceneId: string,
  versionId: string
): Promise<Scene> {
  const scene = await selectSceneById(sceneId);
  if (!scene) throw new Error(`Scene ${sceneId} not found`);
  if (scene.projectId !== projectId) {
    throw new Error(`Scene ${sceneId} does not belong to project ${projectId}`);
  }
  const version = await selectSceneVersionById(versionId);
  if (!version || version.sceneId !== sceneId) {
    throw new Error(`Version ${versionId} not found for scene ${sceneId}`);
  }

  if (scene.imageUrl && scene.imageUrl !== version.imageUrl) {
    await insertSceneVersion({
      id: nanoid(12),
      sceneId,
      imageUrl: scene.imageUrl,
      prompt: scene.prompt,
      seed: scene.seed,
    });
  }
  await setSceneActiveImage(sceneId, { imageUrl: version.imageUrl, seed: version.seed });
  await deleteSceneVersion(versionId);

  const refreshed = await selectSceneById(sceneId);
  if (!refreshed) throw new Error(`Scene ${sceneId} disappeared mid-restore`);
  return refreshed;
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
  // Also surface scenes orphaned in "generating" by a crashed IMAGE run —
  // resetting them to pending makes the "not yet generated" error below name
  // the real problem instead of silently blocking animate forever.
  await resetOrphanedScenes(projectId);

  // Seedance runs are minutes-long; keep the lock fresh so a second animate
  // click can't reclaim it mid-run and double-spend.
  const heartbeat = setInterval(() => {
    heartbeatGenerationLock(projectId).catch(() => {});
  }, 60_000);

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

    // Budget gate BEFORE the motion GPT call and any seedance spend — the
    // animate batch is the most expensive step in the studio.
    await assertWithinDailyBudget(
      estimateAnimateBatch(
        targets.length,
        targets[0]?.durationSec || 5,
        project.quality === "hero" ? "hero" : "standard"
      )
    );

    // Before-after renders a true first→last morph (before frame → after
    // frame via seedance's end_image_url), so the motion direction is a
    // fixed transformation prompt — no GPT call needed. Every other format
    // gets one GPT-5.5 call for all motion prompts — cheaper than per-scene
    // and gives GPT-5.5 the full sequence so it can vary moves intentionally.
    // Defensive [] fallback for objectSet — pre-2026-05 concepts persisted
    // before the field existed.
    const isMorph = project.format === "before-after";
    const motionByOrder = isMorph
      ? new Map(targets.map((s) => [s.order, BEFORE_AFTER_MORPH_MOTION]))
      : new Map(
          (
            await generateMotionPrompts({
              concept: { ...project.concept, objectSet: project.concept.objectSet ?? [] },
              scenes: targets.map((s) => ({
                order: s.order,
                prompt: s.prompt,
                motionPreset: s.motionPreset,
              })),
            })
          ).motions.map((m) => [m.order, m.motion])
        );

    let animated = 0;
    let failed = 0;
    const failedScenes: Scene[] = [];

    const animateOne = async (scene: Scene, motion: string) => {
      await markSceneAnimating(scene.id, motion);

        // Seedance: image → video at the project's aspect (9:16 for reels,
        // upload-derived for before-after) at native 1080p — the Reels
        // delivery ceiling; native detail beats upscaled 720p. Fresh seed
        // per call so the same motion prompt + still doesn't keep landing
        // on the same camera move.
        //
        // Before-after is a true morph: the operator's BEFORE photo is the
        // first frame and the generated AFTER render is the last frame, so
        // the clip shows the room actually transforming instead of ambient
        // motion on the after still.
        // Reels render one extra second of footage per clip: the stitch's
        // 1s crossfades consume overlap, and without the pad a 3×5s reel
        // lands at 13s instead of 15s. Morphs don't crossfade — no pad.
        const seedanceResult = await generateVideo({
          imageUrl: isMorph ? (scene.referenceImageUrl as string) : (scene.imageUrl as string),
          endImageUrl: isMorph ? (scene.imageUrl as string) : undefined,
          motionPrompt: motion,
          durationSec: (scene.durationSec || 5) + (isMorph ? 0 : XFADE_SEC),
          resolution: "1080p",
          aspectRatio: animateAspect,
          seed: freshSeed(),
        });

        // Topaz 2× → 4K60 is a hero-quality pass only. At standard quality
        // native 1080p ships as-is — Instagram recompresses to 1080p anyway,
        // so upscaling past it for Reels is money burned.
        const finalVideoUrl =
          project.quality === "hero"
            ? (
                await upscaleVideo({
                  videoUrl: seedanceResult.videoUrl,
                  model: "Proteus",
                  upscaleFactor: 2,
                })
              ).videoUrl
            : seedanceResult.videoUrl;

      // Re-host on our own Blob so the URL is stable + downloadable.
      const filename = `scene-${String(scene.order).padStart(3, "0")}-${nanoid(6)}.mp4`;
      const stored = await storeFromUrl({
        url: finalVideoUrl,
        kind: "videos",
        projectId,
        filename,
      });

      await markSceneAnimated(scene.id, { videoUrl: stored.url });
      // Ledger: seedance bills the clamped 4-15s duration at 1080p; hero
      // quality adds the Topaz 4K60 pass on top.
      const billedSec = Math.min(15, Math.max(4, scene.durationSec || 5));
      await recordSpend({
        projectId,
        kind: "video",
        amountUsd: billedSec * FAL_SEEDANCE_PER_SECOND["1080p"],
        meta: { sceneOrder: scene.order, durationSec: billedSec },
      });
      if (project.quality === "hero") {
        await recordSpend({
          projectId,
          kind: "upscale",
          amountUsd: estimateTopazUpscale(billedSec, "gt-1080p"),
          meta: { sceneOrder: scene.order },
        });
      }
    };

    await runWithConcurrency(targets, concurrency, async (scene) => {
      const motion = motionByOrder.get(scene.order);
      if (!motion) {
        // Animate-pipeline failure — keep status, the still is fine.
        await markSceneAnimateFailed(scene.id, "No motion prompt returned for this scene.");
        failed++;
        return;
      }
      try {
        await animateOne(scene, motion);
        animated++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown error";
        await markSceneAnimateFailed(scene.id, msg);
        failedScenes.push(scene);
        failed++;
      }
    });

    // One automatic retry pass over the failed subset. Observed in prod
    // smoke: animate can race the just-stored still on Blob and seedance
    // 422s on a URL that's readable moments later — a single retry absorbs
    // that class of transient without operator intervention.
    if (failedScenes.length > 0) {
      await runWithConcurrency(failedScenes, concurrency, async (scene) => {
        const motion = motionByOrder.get(scene.order);
        if (!motion) return;
        try {
          await animateOne(scene, motion);
          animated++;
          failed--;
        } catch (err) {
          // Re-mark the failure: animateOne's markSceneAnimating cleared the
          // first pass's error and re-set motionPrompt, so doing nothing here
          // leaves a zombie scene that looks in-flight with no error. Marking
          // failed again restores the visible error + the recover path.
          const msg = err instanceof Error ? err.message : "unknown error";
          await markSceneAnimateFailed(scene.id, msg);
        }
      });
    }

    await updateProjectStatus(projectId, "ready");
    return { animated, failed, skipped };
  } catch (err) {
    await updateProjectStatus(projectId, "ready");
    throw err;
  } finally {
    clearInterval(heartbeat);
  }
}

// ── Stepwise animate (Inngest per-scene steps) ──────────────────────────────
//
// animateAllScenes runs the whole batch in ONE process — fine locally and in
// tests, fatal on Vercel where the invocation dies at maxDuration (observed
// in prod 2026-07-19: scene 1 rendered, 2-3 stranded mid-flight). The
// stepwise trio below is the same pipeline sliced so Inngest can run each
// scene as its own bounded, memoized step: plan → scene × N → finish.

export type AnimatePlanTarget = {
  sceneId: string;
  order: number;
  imageUrl: string;
  referenceImageUrl: string | null;
  durationSec: number;
  motion: string;
};

export type AnimatePlan = {
  projectId: string;
  quality: "standard" | "hero";
  aspectRatio: AspectRatio;
  isMorph: boolean;
  skipped: number;
  targets: AnimatePlanTarget[];
};

/**
 * Step 1: acquire the lock, recover strays, validate, budget-gate, and
 * write the motion prompts. Returns a fully serializable plan; throws
 * ProjectBusyError (caller maps to a benign busy result) or validation
 * errors (status restored to ready first).
 */
export async function planAnimate(
  projectId: string,
  opts: { force?: boolean } = {}
): Promise<AnimatePlan> {
  const project = await selectProjectById(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);
  if (project.format !== "reel" && project.format !== "before-after") {
    throw new Error("Animate is only available for reel and before-after projects.");
  }
  if (!project.concept) throw new Error("Project has no concept brief — animate after concept exists.");

  const aspectRatio: AspectRatio =
    project.aspectRatio ?? defaultsForFormat(project.format).aspectRatio;

  const acquired = await tryAcquireGenerationLock(projectId);
  if (!acquired) throw new ProjectBusyError(projectId);

  await recoverAnimateFailedScenes(projectId);
  await resetOrphanedScenes(projectId);

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

    const animatable =
      project.format === "before-after"
        ? candidates.filter((s) => !!s.referenceImageUrl)
        : candidates;
    const targetsRaw = animatable.filter((s) => (opts.force ? true : !s.videoUrl));
    const skipped = candidates.length - targetsRaw.length;
    const quality: "standard" | "hero" = project.quality === "hero" ? "hero" : "standard";
    const isMorph = project.format === "before-after";

    if (targetsRaw.length === 0) {
      await updateProjectStatus(projectId, "ready");
      return { projectId, quality, aspectRatio, isMorph, skipped, targets: [] };
    }

    await assertWithinDailyBudget(
      estimateAnimateBatch(targetsRaw.length, targetsRaw[0]?.durationSec || 5, quality)
    );

    const motionByOrder = isMorph
      ? new Map(targetsRaw.map((s) => [s.order, BEFORE_AFTER_MORPH_MOTION]))
      : new Map(
          (
            await generateMotionPrompts({
              concept: { ...project.concept, objectSet: project.concept.objectSet ?? [] },
              scenes: targetsRaw.map((s) => ({
                order: s.order,
                prompt: s.prompt,
                motionPreset: s.motionPreset,
              })),
            })
          ).motions.map((m) => [m.order, m.motion])
        );

    const targets: AnimatePlanTarget[] = targetsRaw
      .filter((s) => motionByOrder.has(s.order))
      .map((s) => ({
        sceneId: s.id,
        order: s.order,
        imageUrl: s.imageUrl as string,
        referenceImageUrl: s.referenceImageUrl,
        durationSec: s.durationSec || 5,
        motion: motionByOrder.get(s.order) as string,
      }));

    return { projectId, quality, aspectRatio, isMorph, skipped, targets };
  } catch (err) {
    await updateProjectStatus(projectId, "ready");
    throw err;
  }
}

/**
 * Step 2 (× N, parallel): animate ONE planned scene. Two attempts inside
 * (transient seedance 422s from Blob propagation are real); a final failure
 * marks the scene and returns ok:false rather than throwing, so the step
 * completes and the batch keeps its per-scene independence.
 */
export async function animatePlannedScene(
  plan: Pick<AnimatePlan, "projectId" | "quality" | "aspectRatio" | "isMorph">,
  target: AnimatePlanTarget
): Promise<{ ok: boolean }> {
  const attempt = async () => {
    await heartbeatGenerationLock(plan.projectId);
    await markSceneAnimating(target.sceneId, target.motion);
    // Crossfade pad — see animateAllScenes: reels render +XFADE_SEC of
    // footage so the stitched final keeps its full nominal length.
    const seedanceResult = await generateVideo({
      imageUrl: plan.isMorph ? (target.referenceImageUrl as string) : target.imageUrl,
      endImageUrl: plan.isMorph ? target.imageUrl : undefined,
      motionPrompt: target.motion,
      durationSec: target.durationSec + (plan.isMorph ? 0 : XFADE_SEC),
      resolution: "1080p",
      aspectRatio: plan.aspectRatio,
      seed: freshSeed(),
    });
    const finalVideoUrl =
      plan.quality === "hero"
        ? (
            await upscaleVideo({
              videoUrl: seedanceResult.videoUrl,
              model: "Proteus",
              upscaleFactor: 2,
            })
          ).videoUrl
        : seedanceResult.videoUrl;
    const filename = `scene-${String(target.order).padStart(3, "0")}-${nanoid(6)}.mp4`;
    const stored = await storeFromUrl({
      url: finalVideoUrl,
      kind: "videos",
      projectId: plan.projectId,
      filename,
    });
    await markSceneAnimated(target.sceneId, { videoUrl: stored.url });
    const billedSec = Math.min(15, Math.max(4, target.durationSec + (plan.isMorph ? 0 : XFADE_SEC)));
    await recordSpend({
      projectId: plan.projectId,
      kind: "video",
      amountUsd: billedSec * FAL_SEEDANCE_PER_SECOND["1080p"],
      meta: { sceneOrder: target.order, durationSec: billedSec },
    });
    if (plan.quality === "hero") {
      await recordSpend({
        projectId: plan.projectId,
        kind: "upscale",
        amountUsd: estimateTopazUpscale(billedSec, "gt-1080p"),
        meta: { sceneOrder: target.order },
      });
    }
  };

  try {
    await attempt();
    return { ok: true };
  } catch {
    try {
      await attempt();
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      await markSceneAnimateFailed(target.sceneId, msg);
      return { ok: false };
    }
  }
}

/** Step 3: release the lock by settling status. */
export async function finishAnimate(projectId: string): Promise<void> {
  await updateProjectStatus(projectId, "ready");
}

/** Fixed motion direction for the before-after morph clip (first frame =
 *  operator's before photo, last frame = the generated after). Affirmative
 *  only, locked camera — the transformation IS the motion. */
const BEFORE_AFTER_MORPH_MOTION =
  "Locked-off static camera. The room transforms smoothly and continuously from its current state into the redesigned space: furniture, finishes, materials, and lighting morph in place while the architecture, walls, windows, and camera stay perfectly fixed. Gradual, seamless, satisfying transformation.";

// ── Stitch: assembled final video (fal ffmpeg compose) ──────────────────────

export type StitchResult = {
  finalVideoUrl: string;
};

/** How long the "before" still holds on screen before the morph clip plays,
 *  in ms. Long enough to register the original space, short enough that the
 *  transformation stays the star. */
const BEFORE_HOLD_MS = 2500;

/** Default hold per still in the style-explorer long-form slideshow. Long
 *  enough to read the room and register the style, short enough that a
 *  10-style video stays in the 1-2 minute band YouTube retention likes. */
const STYLE_EXPLORER_PER_STILL_SEC = 7;

/**
 * Stitch a project's assets into ONE ready-to-post video — the CapCut
 * replacement. Reel: clips concatenated in scene order. Before-after: the
 * operator's before still holds for 2.5s, then the morph clip plays.
 * Style-explorer: every still (Original first, then each style) holds for a
 * uniform `perStillSec` — a stills+music YouTube long-form; with uniform
 * timing the description's chapter timestamps are just i × perStillSec.
 *
 * Audio: each seedance clip carries its own synced ambient audio, and those
 * tracks differ segment to segment. With no music, the native audio
 * concatenates through (hard cuts between ambiences); stills-only timelines
 * are silent. Passing `musicUrl` lays ONE audio bed across the whole
 * timeline and REPLACES the per-clip ambient entirely (compose does not
 * mix) — the uniform-audio option, and effectively required for the
 * style-explorer YouTube upload.
 */
export type StitchOpts = {
  musicUrl?: string;
  perStillSec?: number;
  /** Style-explorer only: loop the full still sequence until the video
   *  reaches at least this many minutes (whole cycles only). The ambient/
   *  slideshow-channel play: 8+ minutes unlocks YouTube mid-roll ads and
   *  stacks watch time. Chapters in the description describe cycle one. */
  targetMinutes?: number;
  /** Duration of the music file in seconds (read client-side at upload).
   *  When the timeline outruns the song, the music keyframe is tiled so
   *  the bed loops instead of going silent. */
  musicDurationSec?: number;
};

/** Serializable stitch plan passed between Inngest steps. */
export type StitchPrep = {
  projectId: string;
  format: "reel" | "before-after" | "style-explorer";
  /** ONE cycle of the timeline. Style-explorer long-forms repeat it `cycles`
   *  times; every other format is inherently single-cycle. */
  segments: StitchSegment[];
  /** How many times the segment cycle repeats in the final video. Long-form
   *  looping renders the cycle ONCE on Shotstack and concats copies on fal —
   *  vendor minutes scale with the cycle, not the target length. Optional so
   *  preps serialized by in-flight jobs before this field existed still run. */
  cycles?: number;
  /** Full output duration: cycle duration × cycles. */
  totalMs: number;
  aspect: string;
  opts: StitchOpts;
};

/** Stitch step 1 — load, validate, and build the timeline. No vendor calls;
 *  every validation error surfaces here, before any money moves. */
export async function prepareStitch(
  projectId: string,
  opts: StitchOpts = {}
): Promise<StitchPrep> {
  const found = await getProjectWithScenes(projectId);
  if (!found) throw new Error(`Project ${projectId} not found`);
  const { project, scenes } = found;

  if (
    project.format !== "reel" &&
    project.format !== "before-after" &&
    project.format !== "style-explorer"
  ) {
    throw new Error("Stitch is only available for reel, before-after, and style-explorer projects.");
  }

  const ordered = [...scenes].sort((a, b) => a.order - b.order);
  const segments: StitchSegment[] = [];
  let cycles = 1;

  if (project.format === "style-explorer") {
    const renderable = ordered.filter(
      (s) => !!s.imageUrl && (s.status === "generated" || s.status === "approved")
    );
    if (renderable.length < ordered.length || renderable.length === 0) {
      const missing = ordered.length - renderable.length;
      throw new Error(
        `Cannot stitch: ${missing || "all"} style${missing === 1 ? "" : "s"} not generated yet.`
      );
    }
    const perStillMs = clamp(opts.perStillSec ?? STYLE_EXPLORER_PER_STILL_SEC, 3, 15) * 1000;
    const cycleMs = renderable.length * perStillMs;
    // Whole cycles only, so the video always ends on the last style. At
    // least one cycle; capped at 20 minutes as a runaway guard.
    const targetMs = opts.targetMinutes
      ? clamp(opts.targetMinutes, 1, 20) * 60_000
      : cycleMs;
    cycles = Math.max(1, Math.ceil(targetMs / cycleMs));
    // ONE cycle only — renderStitch repeats it (Shotstack renders the cycle,
    // fal concats copies) so vendor cost doesn't scale with target length.
    for (const s of renderable) {
      segments.push({ kind: "image", url: s.imageUrl as string, ms: perStillMs });
    }
  } else if (project.format === "before-after") {
    const before = ordered.find((s) => !s.referenceImageUrl);
    const after = ordered.find((s) => !!s.referenceImageUrl);
    if (!before?.imageUrl) throw new Error("Missing the before image.");
    if (!after?.videoUrl) throw new Error("Animate the after scene first — no morph clip yet.");
    segments.push({ kind: "image", url: before.imageUrl, ms: BEFORE_HOLD_MS });
    segments.push({ kind: "video", url: after.videoUrl, ms: (after.durationSec || 9) * 1000 });
  } else {
    const missing = ordered.filter((s) => !s.videoUrl);
    if (ordered.length === 0 || missing.length > 0) {
      throw new Error(
        `Cannot stitch: ${missing.length || "all"} scene${missing.length === 1 ? "" : "s"} not animated yet. Run Animate first.`
      );
    }
    for (const s of ordered) {
      segments.push({ kind: "video", url: s.videoUrl as string, ms: (s.durationSec || 5) * 1000 });
    }
  }

  const totalMs = segments.reduce((n, s) => n + s.ms, 0) * cycles;
  const aspect =
    project.format === "style-explorer"
      ? (project.aspectRatio ?? "16:9")
      : project.format === "before-after"
        ? (project.aspectRatio ?? "9:16")
        : "9:16";

  await updateStitchState(projectId, "rendering");
  return { projectId, format: project.format as StitchPrep["format"], segments, cycles, totalMs, aspect, opts };
}

/** Stitch step 2 — the long vendor render. Backend pick: Shotstack (true
 *  crossfades + Ken Burns on stills) when a key is configured; fal ffmpeg
 *  compose (hard cuts) otherwise — and as an automatic fallback if a
 *  Shotstack render errors, so stitch never hard-fails over the fancier
 *  backend. Returns the vendor-hosted URL. */
export async function renderStitch(prep: StitchPrep): Promise<string> {
  const { projectId, format, segments, totalMs, aspect, opts } = prep;
  const cycles = prep.cycles ?? 1;
  const cycleMs = segments.reduce((n, s) => n + s.ms, 0);
  let renderedUrl: string | null = null;
  if (isShotstackConfigured()) {
    try {
      if (cycles > 1) {
        // Long-form loop: Shotstack renders ONE cycle (crossfades + Ken
        // Burns, opening/ending fade so the loop seam lands on black), then
        // fal concats `cycles` copies and lays the music bed. Shotstack
        // bills per rendered minute — paying for the cycle instead of the
        // full 10-20 min timeline is ~6-9× cheaper per stitch. Music must
        // ride the concat pass, NOT the base: baked into the cycle it would
        // restart at every loop.
        const baseEdit = buildShotstackEdit(format, segments, aspect, {}, { loopBase: true });
        const baseUrl = (await renderShotstack(baseEdit)).videoUrl;
        await recordSpend({
          projectId,
          kind: "compose",
          amountUsd: (cycleMs / 60_000) * SHOTSTACK_PER_MINUTE,
          meta: { format, outputSec: Math.round(cycleMs / 1000), backend: "shotstack", pass: "base-cycle" },
        });
        const loops: StitchSegment[] = Array.from({ length: cycles }, () => ({
          kind: "video" as const,
          url: baseUrl,
          ms: cycleMs,
        }));
        renderedUrl = (await composeVideo(buildFalComposeTracks(loops, totalMs, opts))).videoUrl;
        await recordSpend({
          projectId,
          kind: "compose",
          amountUsd: (totalMs / 1000) * FAL_COMPOSE_PER_SECOND,
          meta: { format, outputSec: Math.round(totalMs / 1000), backend: "fal", pass: "loop-concat" },
        });
      } else {
        const edit = buildShotstackEdit(format, segments, aspect, opts);
        renderedUrl = (await renderShotstack(edit)).videoUrl;
        await recordSpend({
          projectId,
          kind: "compose",
          amountUsd: (totalMs / 60_000) * SHOTSTACK_PER_MINUTE,
          meta: { format, outputSec: Math.round(totalMs / 1000), backend: "shotstack" },
        });
      }
    } catch (err) {
      console.warn("[stitch] Shotstack failed; falling back to fal compose:", err);
      renderedUrl = null;
    }
  }
  if (!renderedUrl) {
    // fal-only path (no Shotstack key, or Shotstack errored): hard cuts over
    // the full timeline — tile the cycle back out to the target length.
    const fullTimeline =
      cycles > 1
        ? Array.from({ length: cycles }, () => segments).flat()
        : segments;
    renderedUrl = (await composeVideo(buildFalComposeTracks(fullTimeline, totalMs, opts))).videoUrl;
    await recordSpend({
      projectId,
      kind: "compose",
      amountUsd: (totalMs / 1000) * FAL_COMPOSE_PER_SECOND,
      meta: { format, outputSec: Math.round(totalMs / 1000), backend: "fal" },
    });
  }
  return renderedUrl;
}

/** Stitch step 3 — re-host on our own Blob (stable, downloadable URL),
 *  persist, and settle the lifecycle. */
export async function finishStitch(
  projectId: string,
  renderedUrl: string
): Promise<StitchResult> {
  const stored = await storeFromUrl({
    url: renderedUrl,
    kind: "videos",
    projectId,
    filename: `final-${nanoid(6)}.mp4`,
  });
  await markProjectFinalVideo(projectId, stored.url);
  await updateStitchState(projectId, "ready");
  return { finalVideoUrl: stored.url };
}

/** Record a stitch failure so the polling client stops with a reason. */
export async function failStitch(projectId: string, message: string): Promise<void> {
  await updateStitchState(projectId, "failed", message);
}

/** Sequential composition of the three stitch steps — used by tests and any
 *  environment without Inngest. Production runs the same helpers as
 *  individual Inngest steps (inngest/functions.ts). */
export async function stitchFinalVideo(
  projectId: string,
  opts: StitchOpts = {}
): Promise<StitchResult> {
  const prep = await prepareStitch(projectId, opts);
  const renderedUrl = await renderStitch(prep);
  return await finishStitch(projectId, renderedUrl);
}

/** One entry on the stitch timeline — backend-neutral. */
type StitchSegment = { kind: "video" | "image"; url: string; ms: number };

const SHOTSTACK_SIZES: Record<string, { width: number; height: number }> = {
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
  "1:1": { width: 1080, height: 1080 },
  "4:3": { width: 1440, height: 1080 },
  "3:4": { width: 1080, height: 1440 },
};

/** Crossfade length. Matches Shotstack's default "fade" transition duration
 *  so the incoming clip reaches full opacity right as the overlap ends. */
const XFADE_SEC = 1;

/**
 * Map the neutral timeline to a Shotstack edit.
 *
 * TRUE crossfades (verified on stage 2026-07-18): Shotstack forbids
 * overlapping clips on one track and its adjacent-clip "fade" dips to the
 * background, so each clip gets its OWN track — later clips on HIGHER
 * tracks (tracks[0] is topmost) — and each incoming clip starts XFADE_SEC
 * before the previous one ends with a fade-in, blending over it.
 *
 *  - Reel: crossfaded clips; total shortens by (n-1) × XFADE_SEC.
 *  - Style-explorer: crossfades + alternating slow Ken Burns zoom on every
 *    still. Timing is chapter-safe: still k fades IN over [k×per − X, k×per]
 *    and is fully visible at exactly k×per, so description timestamps hold;
 *    total duration stays cycles × per.
 *  - Before-after: NO overlap, NO fade, NO motion — the morph clip starts
 *    on exactly the before frame, so a hard joint is seamless by
 *    construction and a fade would soften the reveal.
 *  - Music: Shotstack MIXES audio tracks, so when a music bed is provided
 *    the video clips are muted to preserve the established "music replaces
 *    ambient" semantics; the bed is tiled when shorter than the timeline.
 *  - loopBase: the edit is ONE cycle destined for concatenation (long-form
 *    looping). The first clip fades in from black and the last fades out to
 *    black, so every concat seam is a fade-out → fade-in instead of a hard
 *    mid-image cut. Timing is unchanged — fades happen within the clips'
 *    existing holds, so cycle duration stays exact for the concat math.
 */
function buildShotstackEdit(
  format: string,
  segments: StitchSegment[],
  aspect: string,
  opts: { musicUrl?: string; musicDurationSec?: number },
  mode: { loopBase?: boolean } = {}
): ShotstackEdit {
  const crossfade = format !== "before-after";
  const kenBurns = format === "style-explorer";
  const muteClips = !!opts.musicUrl;
  const xfadeMs = crossfade ? XFADE_SEC * 1000 : 0;

  let boundary = 0; // where each segment WOULD start with hard cuts
  const clips: ShotstackClip[] = segments.map((seg, i) => {
    const overlap = i > 0 ? xfadeMs : 0;
    let startMs: number;
    let lengthMs: number;
    if (seg.kind === "image" && crossfade) {
      // Stills are elastic: start the fade X early and extend the hold so
      // full visibility lands exactly on the hard-cut boundary (chapters).
      startMs = boundary - overlap;
      lengthMs = seg.ms + overlap;
      boundary += seg.ms;
    } else if (crossfade) {
      // Videos carry XFADE_SEC of padded footage (rendered long at animate
      // time): each clip starts ON its boundary and its pad extends under
      // the next clip's fade-in, so the final keeps full nominal length.
      // The last clip trims its pad to end exactly on the boundary.
      startMs = boundary;
      lengthMs = seg.ms + (i < segments.length - 1 ? xfadeMs : 0);
      boundary += seg.ms;
    } else {
      startMs = boundary;
      lengthMs = seg.ms;
      boundary += seg.ms;
    }
    const clip: ShotstackClip = {
      asset:
        seg.kind === "video"
          ? { type: "video", src: seg.url, volume: muteClips ? 0 : 1 }
          : { type: "image", src: seg.url },
      start: startMs / 1000,
      length: lengthMs / 1000,
      fit: "crop",
    };
    if (crossfade && i > 0) clip.transition = { in: "fade" };
    if (mode.loopBase) {
      // Loop-friendly cycle: fade in from black at the start, out to black at
      // the end — the concat seam reads as an intentional beat, not a jump.
      if (i === 0) clip.transition = { ...clip.transition, in: "fade" };
      if (i === segments.length - 1) clip.transition = { ...clip.transition, out: "fade" };
    }
    if (kenBurns && seg.kind === "image") {
      clip.effect = i % 2 === 0 ? "zoomInSlow" : "zoomOutSlow";
    }
    return clip;
  });

  const totalMs = Math.max(...clips.map((c) => (c.start + c.length) * 1000));
  // One track per clip; LATER clips must sit on HIGHER tracks (tracks[0] is
  // topmost) so each fade-in blends over the clip beneath it.
  const tracks: { clips: ShotstackClip[] }[] = [...clips].reverse().map((c) => ({ clips: [c] }));

  const edit: ShotstackEdit = {
    timeline: { background: "#000000", tracks },
    output: {
      format: "mp4",
      size: SHOTSTACK_SIZES[aspect] ?? SHOTSTACK_SIZES["9:16"],
      fps: 30,
    },
  };

  if (opts.musicUrl) {
    const songMs = opts.musicDurationSec ? Math.floor(opts.musicDurationSec * 1000) : totalMs;
    if (songMs < totalMs) {
      // Tile the bed across the timeline on its own (bottom) audio track.
      const musicClips: ShotstackClip[] = [];
      for (let start = 0; start < totalMs; start += songMs) {
        musicClips.push({
          asset: { type: "audio", src: opts.musicUrl, volume: 1 },
          start: start / 1000,
          length: Math.min(songMs, totalMs - start) / 1000,
        });
      }
      tracks.push({ clips: musicClips });
    } else {
      edit.timeline.soundtrack = { src: opts.musicUrl, effect: "fadeInFadeOut" };
    }
  }

  return edit;
}

/** Map the neutral timeline to fal compose tracks (hard cuts, tiled music). */
function buildFalComposeTracks(
  segments: StitchSegment[],
  totalMs: number,
  opts: { musicUrl?: string; musicDurationSec?: number }
): ComposeTrack[] {
  let t = 0;
  const keyframes: ComposeKeyframe[] = segments.map((seg) => {
    const kf = { timestamp: t, duration: seg.ms, url: seg.url };
    t += seg.ms;
    return kf;
  });
  const tracks: ComposeTrack[] = [{ id: "video", type: "video", keyframes }];
  if (opts.musicUrl) {
    // Tile the song across the timeline when its length is known and shorter
    // than the video — compose does not loop audio, and a 10-minute ambient
    // video going silent at minute 3 is a dead upload. The last tile is
    // trimmed to the timeline end.
    const songMs = opts.musicDurationSec ? Math.floor(opts.musicDurationSec * 1000) : totalMs;
    const musicKeyframes: ComposeKeyframe[] = [];
    for (let start = 0; start < totalMs; start += songMs) {
      musicKeyframes.push({
        timestamp: start,
        duration: Math.min(songMs, totalMs - start),
        url: opts.musicUrl,
      });
    }
    tracks.push({ id: "music", type: "audio", keyframes: musicKeyframes });
  }
  return tracks;
}

/** Bumped when the bundle/manifest shape changes incompatibly. */
export const MANIFEST_VERSION = 2;

export type FinalizeResult = {
  metadata: Metadata;
  /** True when every clip exists and no final video is stitched — the ROUTE
   *  enqueues a background stitch (the vendor render never runs inside a
   *  request-bound function). */
  autoStitch?: boolean;
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
    await recordSpend({
      projectId,
      kind: "llm",
      amountUsd: estimateMetadataGen(),
      meta: { stage: "finalize" },
    });

    // Finalize means "package the deliverable" — so when every clip exists
    // and no final video has been stitched yet, flag the route to ENQUEUE a
    // background stitch (native ambient audio, default settings) rather
    // than rendering inline: vendor renders never run inside request-bound
    // functions. The stitch panel remains for re-stitching with a music bed
    // or different knobs.
    // Style-explorer is excluded on purpose — a stills slideshow without a
    // music upload is a silent video, so that stitch stays operator-driven.
    let autoStitch = false;
    if (
      (project.format === "reel" || project.format === "before-after") &&
      !project.finalVideoUrl
    ) {
      const animatable =
        project.format === "before-after"
          ? renderable.filter((s) => !!s.referenceImageUrl)
          : renderable;
      autoStitch = animatable.length > 0 && animatable.every((s) => !!s.videoUrl);
    }

    return { metadata, autoStitch };
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

/** What one nano-banana still actually costs at the project's quality tier. */
function imageSpendUsd(isEdit: boolean, quality: string | null | undefined): number {
  if (quality === "hero") return FAL_NANO_BANANA_PER_IMAGE_4K;
  return isEdit ? FAL_NANO_BANANA_EDIT_PER_IMAGE : FAL_NANO_BANANA_PER_IMAGE;
}
