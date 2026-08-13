import { nanoid } from "nanoid";
import { generateBeforeAfterConcept, generateConcept } from "@/lib/prompts/concept";
import { generateScenePrompts } from "@/lib/prompts/scenes";
import { ARCHITECTURE_LOCK, ARCHITECTURE_LOCK_CLOSE, generateStyles } from "@/lib/prompts/styles";
import { applyLookToPrompt, getLook, type LookId } from "@/lib/prompts/looks";
import {
  assembleYouTubeMetadata,
  generateMetadata,
  generateYouTubeMetadata,
  type Metadata,
} from "@/lib/prompts/metadata";
import {
  defaultsForFormat,
  SHOWCASE_REEL_MAX_TOTAL_SEC,
  SHOWCASE_SHOT_MAX_SEC,
  SHOWCASE_SHOT_MIN_SEC,
  STYLE_EXPLORER_HOLD_SEC,
  type Format,
  type AspectRatio,
  type PropertyType,
  type WorldType,
} from "@/lib/prompts/types";
import { editImage, generateImage, type Resolution } from "@/lib/fal";
import { generateShowcaseCopy } from "@/lib/prompts/showcase";
import { composeVideo, type ComposeKeyframe, type ComposeTrack } from "@/lib/compose";
import {
  isShotstackConfigured,
  renderShotstack,
  SHOTSTACK_PER_MINUTE,
  type ShotstackClip,
  type ShotstackEdit,
} from "@/lib/shotstack";
import { collectVideo, generateVideo, submitVideo } from "@/lib/seedance";
import { collectUpscale, submitUpscale, upscaleVideo } from "@/lib/topaz";
import { collectSeedVRUpscale, submitSeedVRUpscale, upscaleVideoSeedVR } from "@/lib/seedvr";
import { checkQueued, type FalQueuedRequest } from "@/lib/fal-queue";
import { getUpscalerSetting, type UpscalerSetting } from "@/lib/app-settings";
import { generateMotionPrompts, getCameraMove } from "@/lib/prompts/motion";
import {
  completeLargeRehost,
  ensurePngStill,
  planLargeRehost,
  storeFromUrl,
  transferRehostParts,
  type RehostPart,
  type RehostPlan,
} from "@/lib/storage";
import { runWithConcurrency } from "@/lib/concurrency";
import { assertWithinDailyBudget, recordSpend } from "@/lib/spend";
import {
  estimateAnimateBatch,
  estimateConceptGen,
  estimateImageBatch,
  estimateMetadataGen,
  estimateSceneGen,
  estimateShowcaseCopy,
  estimateStylesGen,
  estimateSeedVR,
  estimateTopazUpscale,
  FAL_COMPOSE_PER_SECOND,
  FAL_NANO_BANANA_EDIT_PER_IMAGE,
  FAL_NANO_BANANA_PER_IMAGE,
  FAL_NANO_BANANA_PER_IMAGE_4K,
  FAL_SEEDANCE_25_720P_PER_SECOND,
  FAL_SEEDANCE_FAST_720P_PER_SECOND,
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
  swapScenePreviousVideo,
  selectRecentStyleNames,
  selectRecentTitles,
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
   *  video. hero = 4K stills + full-tier 1080p seedance source. */
  quality?: "standard" | "hero";
  /** Seedance generation for the animate step (reels). Defaults to 2.0 —
   *  the proven pipeline. 2.5 = better motion, 720p-only, ~2× the standard
   *  video cost; both quality tiers ride 720p + Topaz 3× on 2.5. */
  videoModel?: "seedance-2.0" | "seedance-2.5";
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
  // Voice avoid-list: what this studio has already titled. The world-dedupe
  // below stops repeated SUBJECTS; this stops the repeated VOICE. Soft-fails
  // to empty so freshness never blocks creation.
  const recentTitles = await selectRecentTitles().catch(() => [] as string[]);
  const concept = await generateConcept({
    niche: input.niche,
    format: input.format,
    worldType: input.worldType,
    targetDurationSec: targetDurationSec || undefined,
    operatorNotes: input.operatorNotes,
    referenceImageUrls: referenceImageUrls.length > 0 ? referenceImageUrls : undefined,
    recentTitles,
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
    videoModel: input.videoModel ?? "seedance-2.0",
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
  /** Operator's transformation direction — what the afters should explore
   *  ("modernize this kitchen", "coastal budget refresh", …). Steers the
   *  four AI-proposed concepts. */
  transformationPrompt: string;
  /** Aspect ratio detected from the uploaded image (snapped to enum by
   *  /api/upload). Persisted on the project so downstream calls inherit it. */
  aspectRatio: AspectRatio;
  worldType: WorldType;
  /** Residential vs commercial. Optional — the /new flow doesn't collect it
   *  for this format yet, so it defaults to residential (the prior
   *  hardcoded value). */
  propertyType?: PropertyType;
};

/** How many distinct "after" concepts a before-after explores — 9, so the
 *  before + afters land as a full 10-image IG carousel. */
const BEFORE_AFTER_CONCEPT_COUNT = 9;

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

  // Two GPT calls before any DB write (a failure leaves no orphan row):
  //   1. Slim concept — workingTitle/hook/vibe for finalize metadata.
  //   2. Vision styles call — GPT SEES the upload and proposes 9 distinct
  //      "after" concepts steered by the operator's transformation prompt
  //      (same machinery as style-explorer, smaller fan-out).
  // Voice avoid-list: what this studio has already titled. Soft-fails to
  // empty — freshness must never block creation.
  const recentTitles = await selectRecentTitles().catch(() => [] as string[]);
  const [concept, stylesResp] = await Promise.all([
    generateBeforeAfterConcept({
      transformationPrompt: input.transformationPrompt,
      worldType: input.worldType,
      recentTitles,
    }),
    selectRecentStyleNames()
      .catch(() => [] as string[])
      .then((recentStyleNames) =>
        generateStyles({
          baseImageUrl: input.beforeImageUrl,
          worldType: input.worldType,
          propertyType: input.propertyType ?? "residential",
          count: BEFORE_AFTER_CONCEPT_COUNT,
          // The transformation brief GOVERNS these concepts — concepts mode
          // treats it as hard constraints, not a gentle bias.
          operatorNotes: input.transformationPrompt,
          recentStyleNames,
          mode: "concepts",
        })
      ),
  ]);
  if (stylesResp.styles.length === 0) {
    throw new Error("Concept generation returned nothing. Try again or adjust the prompt.");
  }

  const project = await insertProject({
    id: projectId,
    title: concept.workingTitle,
    niche: input.transformationPrompt,
    format: "before-after",
    worldType: input.worldType,
    aspectRatio: input.aspectRatio,
    status: "scripting",
    operatorEmail: op.email,
    // Stills-only format (video was retired 2026-07-24) — no duration.
    targetDurationSec: null,
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
  // Scenes 2..10 = the nine "after" concepts — pending, each pinned to the
  // upload via referenceImageUrl so generateAllImages routes them through
  // nano-banana /edit. ARCHITECTURE_LOCK keeps every concept on the exact
  // same camera so the before→after comparison reads honestly.
  const insertedScenes = await insertScenes([
    {
      id: nanoid(12),
      projectId,
      order: 1,
      prompt: `(uploaded before) ${concept.workingTitle}`,
      styleName: "Before",
      styleSubtitle: "The space as uploaded",
      durationSec: 0,
      status: "generated",
      imageUrl: input.beforeImageUrl,
      referenceImageUrl: null, // it IS the reference for the after scenes
    },
    ...stylesResp.styles.map((s, i) => ({
      id: nanoid(12),
      projectId,
      order: i + 2,
      prompt: `${ARCHITECTURE_LOCK}${s.editPrompt}`,
      styleName: s.styleName,
      styleSubtitle: s.styleSubtitle,
      durationSec: 0,
      status: "pending" as const,
      referenceImageUrl: input.beforeImageUrl,
    })),
  ]);

  // LLM spend for creation (slim concept + the vision styles proposal) —
  // estimate-based, mirroring createProject's scripting bookkeeping.
  await recordSpend({
    projectId,
    kind: "llm",
    amountUsd: estimateConceptGen() + estimateStylesGen(stylesResp.styles.length),
    meta: { stage: "scripting", concepts: stylesResp.styles.length },
  });

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
 *  - Stills first; the operator can optionally Animate every style into a
 *    chapter-hold clip afterwards. No dedupe.
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
  /** Seedance generation for the optional per-style Animate step. Defaults
   *  to 2.0; 2.5 = better motion at ~2× the video cost. */
  videoModel?: "seedance-2.0" | "seedance-2.5";
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
  // Avoid-list so consecutive videos don't ship the same style lineup —
  // soft-fails to empty (freshness must never block creation).
  const recentStyleNames = await selectRecentStyleNames().catch(() => [] as string[]);
  const stylesResp = await generateStyles({
    baseImageUrl: input.baseImageUrl,
    worldType: input.worldType,
    propertyType: input.propertyType,
    count: styleCount,
    operatorNotes: input.operatorNotes,
    recentStyleNames,
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

  // Normalize the base to PNG BEFORE anything persists — a JPEG base among
  // the PNG style renders silently corrupts fal's slideshow stitch (see
  // ensurePngStill). No-op when the base is already PNG.
  const baseImageUrl = await ensurePngStill({
    url: input.baseImageUrl,
    projectId,
    filename: "base.png",
  });

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
    videoModel: input.videoModel ?? "seedance-2.0",
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
    referenceImageUrl: baseImageUrl,
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
      imageUrl: baseImageUrl,
      referenceImageUrl: null,
    },
    ...styleScenes,
  ]);

  // LLM spend for the styles proposal — estimate-based.
  await recordSpend({
    projectId,
    kind: "llm",
    amountUsd: estimateStylesGen(stylesResp.styles.length),
    meta: { stage: "scripting", styles: stylesResp.styles.length },
  });

  return { project, scenes: insertedScenes };
}

// ── Showcase: the operator's OWN images → reel or long-form ────────────────
//
// No image generation at all: the uploads ARE the stills. One GPT vision
// pass names + describes every shot (names → YouTube chapters / card copy,
// descriptions → the prompts that later drive motion generation), then the
// scenes insert pre-"generated" and the project drops straight into the
// existing Animate → Stitch → Finalize flow of its target format:
//   reel      → format "reel"           (9:16, 5s clips, crossfade stitch)
//   long-form → format "style-explorer" (16:9, chapter holds, loop + music)
// uploadSourced=true hard-blocks every regeneration path — a regen would
// overwrite the client's photo with an AI render of its description.

export type CreateShowcaseInput = {
  /** Public Blob URLs from /api/upload, in presentation order (2–20). */
  imageUrls: string[];
  deliverable: "reel" | "long-form";
  worldType: WorldType;
  /** Long-form metadata grounding; defaults to residential. */
  propertyType?: PropertyType;
  /** Seedance generation for the animate step. */
  videoModel?: "seedance-2.0" | "seedance-2.5";
  /** Reel only: per-shot clip lengths in seconds, parallel to imageUrls —
   *  the operator's pacing (e.g. [6, 4, 5] to let the hero shot breathe).
   *  Each 3-10s, total ≤ 90s (the IG discovery ceiling). Omitted = 5s each. */
  shotDurationsSec?: number[];
  /** Steering for the copy pass — location, tier, what to emphasise. */
  operatorNotes?: string;
};

export async function createShowcaseProject(
  input: CreateShowcaseInput
): Promise<ProjectWithScenes> {
  const op = currentOperator();
  if (!op.worldTypes.includes(input.worldType)) {
    throw new Error(
      `Operator ${op.email} doesn't cover ${input.worldType} content. Allowed: ${op.worldTypes.join(", ")}.`
    );
  }
  const imageUrls = input.imageUrls.slice(0, 20);
  if (imageUrls.length < 2) {
    throw new Error("Showcase needs at least 2 images.");
  }
  // Operator pacing (reel only): each shot 3-10s, total ≤ 90s (the IG
  // discovery ceiling — see SHOWCASE_REEL_MAX_TOTAL_SEC). Long-form ignores
  // it — chapters depend on the uniform hold. The default 5s/shot means a
  // full 20-shot set lands at 100s, so big sets need explicit pacing.
  const shotDurations =
    input.deliverable === "reel" && input.shotDurationsSec
      ? input.shotDurationsSec
      : null;
  if (shotDurations) {
    if (shotDurations.length !== imageUrls.length) {
      throw new Error(
        `shotDurationsSec has ${shotDurations.length} entries for ${imageUrls.length} images.`
      );
    }
    if (
      shotDurations.some(
        (s) =>
          !Number.isInteger(s) || s < SHOWCASE_SHOT_MIN_SEC || s > SHOWCASE_SHOT_MAX_SEC
      )
    ) {
      throw new Error(
        `Every shot needs ${SHOWCASE_SHOT_MIN_SEC}-${SHOWCASE_SHOT_MAX_SEC} seconds.`
      );
    }
  }
  if (input.deliverable === "reel") {
    const total = (shotDurations ?? imageUrls.map(() => 5)).reduce((n, s) => n + s, 0);
    if (total > SHOWCASE_REEL_MAX_TOTAL_SEC) {
      throw new Error(
        `Shot timings total ${total}s — reels cap at ${SHOWCASE_REEL_MAX_TOTAL_SEC}s (IG stops recommending longer to non-followers). Tighten the pacing or switch to the YouTube long-form.`
      );
    }
  }

  const projectId = nanoid(12);
  const isReel = input.deliverable === "reel";
  const format: Format = isReel ? "reel" : "style-explorer";
  const aspectRatio: AspectRatio = isReel ? "9:16" : "16:9";

  // Vision pass BEFORE any DB write — a failure leaves no orphan row.
  const copy = await generateShowcaseCopy({
    imageUrls,
    worldType: input.worldType,
    deliverable: input.deliverable,
    operatorNotes: input.operatorNotes,
  });

  // Long-form slideshows can hit fal's image track on the stitch fallback,
  // which silently corrupts on mixed JPEG/PNG inputs (see ensurePngStill) —
  // normalize every upload. Reels never stitch stills (clips only), and
  // seedance takes JPEG fine, so they keep the original uploads.
  const stills = isReel
    ? imageUrls
    : await Promise.all(
        imageUrls.map((url, i) =>
          ensurePngStill({
            url,
            projectId,
            filename: `shot-${String(i + 1).padStart(2, "0")}.png`,
          })
        )
      );

  const project = await insertProject({
    id: projectId,
    title: copy.workingTitle,
    niche: input.operatorNotes?.trim() || copy.workingTitle,
    format,
    worldType: input.worldType,
    propertyType: input.propertyType ?? "residential",
    aspectRatio,
    // Stills already exist — the project is born ready to Animate.
    status: "ready",
    operatorEmail: op.email,
    videoModel: input.videoModel ?? "seedance-2.0",
    uploadSourced: true,
    targetDurationSec: isReel
      ? (shotDurations?.reduce((n, s) => n + s, 0) ?? imageUrls.length * 5)
      : null,
    concept: {
      workingTitle: copy.workingTitle,
      hook: `${imageUrls.length} shots of one real ${input.worldType === "interior" ? "interior" : "property"}, presented as a cinematic ${isReel ? "reel" : "tour"}.`,
      vibe: copy.vibe,
      notes: input.operatorNotes?.trim() ?? "",
      objectSet: [],
    },
    // No dedupe — every property is unique.
    worldSignature: null,
    worldKeywords: null,
  });

  const insertedScenes = await insertScenes(
    copy.shots.map((shot, i) => ({
      id: nanoid(12),
      projectId,
      order: i + 1,
      // The description is what the motion-prompt call reads — it must
      // describe THIS image so seedance animates what's actually in frame.
      prompt: shot.description,
      styleName: shot.name,
      styleSubtitle: shot.subtitle,
      durationSec: isReel ? (shotDurations?.[i] ?? 5) : 0,
      status: "generated" as const,
      imageUrl: stills[i],
      referenceImageUrl: null,
    }))
  );

  await recordSpend({
    projectId,
    kind: "llm",
    amountUsd: estimateShowcaseCopy(imageUrls.length),
    meta: { stage: "showcase-copy", shots: imageUrls.length },
  });

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
  // Showcase projects: the stills ARE the operator's uploads — generating
  // would overwrite a client's photo with an AI render of its description.
  if (project.uploadSourced) {
    throw new Error(
      "This showcase uses your uploaded images — there is nothing to generate. Animate or stitch instead."
    );
  }

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

export type SceneAction = "approve" | "reject" | "regenerate" | "set-motion" | "restore-video";

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
    case "regenerate": {
      // Showcase scenes are the operator's own uploads — regenerating would
      // replace a client's photo with an AI render of its description.
      const project = await selectProjectById(projectId);
      if (project?.uploadSourced) {
        throw new Error("This scene is your uploaded image — it can't be regenerated.");
      }
      await regenerateScene(projectId, scene, options);
      break;
    }
    case "set-motion": {
      const preset = options.motionPreset ?? null;
      if (preset && !getCameraMove(preset)) {
        throw new Error(`Unknown camera move "${preset}".`);
      }
      await setSceneMotionPreset(sceneId, preset);
      break;
    }
    case "restore-video": {
      // Swap the active clip with the take it replaced (re-animate undo).
      const swapped = await swapScenePreviousVideo(sceneId);
      if (!swapped) throw new Error("No previous take to restore for this scene.");
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
  // Restyle formats: the "same space, restyled" contract. Before-after joined
  // style-explorer here when it became 9 concepts off one upload.
  const isRestyle =
    project.format === "style-explorer" || project.format === "before-after";
  if (!isRestyle || !scene.referenceImageUrl) return scene.prompt;
  const lead = scene.prompt.startsWith(ARCHITECTURE_LOCK)
    ? scene.prompt
    : `${ARCHITECTURE_LOCK}${scene.prompt}`;
  // Sandwich: re-assert at the END too. A lead-only lock loses to style text
  // that implies new massing (see ARCHITECTURE_LOCK_CLOSE). Applied at
  // generation time so existing projects pick it up on regenerate.
  return lead.includes(ARCHITECTURE_LOCK_CLOSE) ? lead : `${lead}${ARCHITECTURE_LOCK_CLOSE}`;
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

  // Per-scene regens spend real money too — same daily cap as the batches.
  // (Upper-bound estimate: a t2i at the project's quality tier.)
  await assertWithinDailyBudget(
    estimateImageBatch(1, project.quality === "hero" ? "hero" : "standard")
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
  // Reel: every scene → clip. Style-explorer: every style → a chapter-hold
  // clip (optional upgrade from the stills slideshow). Carousel stays static;
  // before-after went stills-only 2026-07-24 (4 static "after" concepts).
  if (project.format !== "reel" && project.format !== "style-explorer") {
    throw new Error("Animate is only available for reel and style-explorer projects.");
  }
  if (!project.concept) throw new Error("Project has no concept brief — animate after concept exists.");
  // Style-explorer scenes carry durationSec 0 (stills); their clips fill the
  // chapter hold exactly so description timestamps stay true.
  const clipSecFor = (sceneDurationSec: number | null) =>
    project.format === "style-explorer" ? STYLE_EXPLORER_HOLD_SEC : sceneDurationSec || 5;

  // Reels are always 9:16; before-after inherits from the upload (stored on
  // project.aspectRatio). The seedance call below uses this so the after
  // video matches the source.
  const animateAspect: AspectRatio =
    project.aspectRatio ?? defaultsForFormat(project.format).aspectRatio;
  const concurrency = opts.concurrency ?? 2; // seedance is heavy — keep parallelism low

  // Same upscaler snapshot the Inngest path takes at plan time.
  const upscaler = await getUpscalerSetting().catch((): UpscalerSetting => "topaz");
  const useSeedVR = upscaler === "seedvr2";

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

    const targets = candidates.filter((s) => (opts.force ? true : !s.videoUrl));
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
        clipSecFor(targets[0]?.durationSec ?? null),
        project.quality === "hero" ? "hero" : "standard",
        project.videoModel === "seedance-2.5" ? "seedance-2.5" : "seedance-2.0"
      )
    );

    // One GPT-5.5 call for all motion prompts — cheaper than per-scene and
    // gives GPT-5.5 the full sequence so it can vary moves intentionally.
    // Defensive [] fallback for objectSet — pre-2026-05 concepts persisted
    // before the field existed.
    const motionByOrder = new Map(
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
        // Reels render one extra second of footage per clip: the stitch's
        // 1s crossfades consume overlap, and without the pad a 3×5s reel
        // lands at 13s instead of 15s.
        // Tiering matches animatePlannedScene: 2.0 standard reels ride the
        // fast 720p endpoint + Topaz 3×; 2.0 hero rides full 1080p + Topaz
        // 2×; 2.5 always rides 720p (its ceiling) + Topaz 3×.
        const is25 = project.videoModel === "seedance-2.5";
        const useFast = !is25 && project.quality !== "hero";
        const at720 = is25 || useFast;
        const seedanceResult = await generateVideo({
          imageUrl: scene.imageUrl as string,
          motionPrompt: motion,
          durationSec: clipSecFor(scene.durationSec) + XFADE_SEC,
          resolution: at720 ? "720p" : "1080p",
          fast: useFast,
          model: is25 ? "seedance-2.5" : "seedance-2.0",
          aspectRatio: animateAspect,
          seed: freshSeed(),
        });

        // Crisp-pipeline (matches animatePlannedScene): every animate ends at
        // ~4K; the stitch downsamples to a supersampled 1080p/30.
        const finalVideoUrl = useSeedVR
          ? (
              await upscaleVideoSeedVR({
                videoUrl: seedanceResult.videoUrl,
                targetResolution: "2160p",
              })
            ).videoUrl
          : (
              await upscaleVideo({
                videoUrl: seedanceResult.videoUrl,
                model: "Proteus",
                upscaleFactor: at720 ? 3 : 2,
                // 30 across the board — the stitch renders 30fps output, so
                // 60fps interpolation would be synthesized then discarded.
                targetFps: 30,
              })
            ).videoUrl;

      // Re-host on our own Blob so the URL is stable + downloadable.
      const filename = `scene-${String(scene.order).padStart(3, "0")}-${nanoid(6)}.mp4`;
      const stored = await storeFromUrl({
        url: finalVideoUrl,
        kind: "videos",
        projectId,
        filename,
      });

      await markSceneAnimated(scene.id, { videoUrl: stored.url });
      // Ledger: seedance tier per quality/model; Topaz 4K30 rides every clip.
      // Bill what was actually requested — durationSec + the crossfade pad,
      // same as animatePlannedScene (this path used to under-bill by the pad).
      const billedSec = Math.min(is25 ? 30 : 15, Math.max(4, clipSecFor(scene.durationSec) + XFADE_SEC));
      await recordSpend({
        projectId,
        kind: "video",
        amountUsd:
          billedSec *
          (is25
            ? FAL_SEEDANCE_25_720P_PER_SECOND
            : useFast
              ? FAL_SEEDANCE_FAST_720P_PER_SECOND
              : FAL_SEEDANCE_PER_SECOND["1080p"]),
        meta: { sceneOrder: scene.order, durationSec: billedSec },
      });
      await recordSpend({
        projectId,
        kind: "upscale",
        amountUsd: useSeedVR
          ? estimateSeedVR(billedSec)
          : estimateTopazUpscale(billedSec, "gt-1080p"),
        meta: { sceneOrder: scene.order, upscaler },
      });
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
  durationSec: number;
  motion: string;
};

export type AnimatePlan = {
  projectId: string;
  quality: "standard" | "hero";
  /** Seedance generation for every clip in this batch. Optional so plans
   *  serialized by Inngest before the field existed still replay — absent
   *  means 2.0, the only model that existed then. */
  videoModel?: "seedance-2.0" | "seedance-2.5";
  /** Which upscaler runs after seedance — snapshotted from the runtime
   *  setting at plan time so a mid-batch toggle can't mix models. Absent
   *  (pre-field plans) means topaz. */
  upscaler?: UpscalerSetting;
  aspectRatio: AspectRatio;
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
  opts: {
    force?: boolean;
    /** Re-animate exactly this scene (fresh seed + fresh motion prompt),
     *  even though it already has a video. The full-coverage "every scene
     *  generated" check is skipped — only the target must be renderable. */
    sceneId?: string;
  } = {}
): Promise<AnimatePlan> {
  const project = await selectProjectById(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);
  // Reel: every scene → clip (required for stitch). Style-explorer: every
  // style → a STYLE_EXPLORER_HOLD_SEC clip (OPTIONAL — the stitch upgrades
  // from stills slideshow to real footage once all styles have one).
  // before-after went stills-only 2026-07-24; carousel stays static.
  if (project.format !== "reel" && project.format !== "style-explorer") {
    throw new Error("Animate is only available for reel and style-explorer projects.");
  }
  if (!project.concept) throw new Error("Project has no concept brief — animate after concept exists.");

  // Style-explorer scenes carry durationSec 0 (stills); their clips must fill
  // exactly the chapter hold so description timestamps stay true.
  const clipSecFor = (sceneDurationSec: number | null) =>
    project.format === "style-explorer"
      ? STYLE_EXPLORER_HOLD_SEC
      : sceneDurationSec || 5;

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
    if (!opts.sceneId && candidates.length < allScenes.length) {
      const missing = allScenes.length - candidates.length;
      throw new Error(
        `Cannot animate: ${missing} scene${missing === 1 ? "" : "s"} not yet generated. Generate or reject them first.`
      );
    }

    const targetsRaw = opts.sceneId
      ? candidates.filter((s) => s.id === opts.sceneId)
      : candidates.filter((s) => (opts.force ? true : !s.videoUrl));
    if (opts.sceneId && targetsRaw.length === 0) {
      throw new Error("Scene not found or not animatable (needs a generated still).");
    }
    const skipped = candidates.length - targetsRaw.length;
    const quality: "standard" | "hero" = project.quality === "hero" ? "hero" : "standard";
    const videoModel: "seedance-2.0" | "seedance-2.5" =
      project.videoModel === "seedance-2.5" ? "seedance-2.5" : "seedance-2.0";
    // Soft-fail to the incumbent — a settings-table hiccup must never block
    // an animate batch.
    const upscaler = await getUpscalerSetting().catch((): UpscalerSetting => "topaz");

    if (targetsRaw.length === 0) {
      await updateProjectStatus(projectId, "ready");
      return { projectId, quality, videoModel, upscaler, aspectRatio, skipped, targets: [] };
    }

    await assertWithinDailyBudget(
      estimateAnimateBatch(
        targetsRaw.length,
        clipSecFor(targetsRaw[0]?.durationSec ?? null),
        quality,
        videoModel
      )
    );

    const motionByOrder = new Map(
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
        durationSec: clipSecFor(s.durationSec),
        motion: motionByOrder.get(s.order) as string,
      }));

    return { projectId, quality, videoModel, upscaler, aspectRatio, skipped, targets };
  } catch (err) {
    await updateProjectStatus(projectId, "ready");
    throw err;
  }
}

/** Serializable plan slice every stepwise scene function takes. */
export type ScenePlan = Pick<
  AnimatePlan,
  "projectId" | "quality" | "videoModel" | "upscaler" | "aspectRatio"
>;

// Crisp-pipeline tiers (all end at ~4K sources, stitched to 1080p/30):
//   2.0 standard reel: Seedance FAST 720p (~$0.24/s, quicker) → Topaz 3× → 4K30
//   2.0 hero reel:     Seedance full 1080p (~$0.68/s)         → Topaz 2× → 4K30
//   2.5 (any quality): Seedance 2.5 720p (~$0.47/s, no 1080p) → Topaz 3× → 4K30
function animateTier(plan: ScenePlan): { is25: boolean; useFast: boolean; at720: boolean } {
  const is25 = plan.videoModel === "seedance-2.5";
  const useFast = !is25 && plan.quality !== "hero";
  return { is25, useFast, at720: is25 || useFast };
}

/**
 * Step 2a (× N): ENQUEUE one scene's seedance render and return the queue
 * handle immediately. The render itself runs on fal's side — no serverless
 * invocation waits on it (a blocking wait died at Vercel's maxDuration with
 * nothing written back, observed in prod 2026-08-12). The orchestrator polls
 * via pollSceneRequest between durable sleeps.
 */
export async function startSceneVideo(
  plan: ScenePlan,
  target: AnimatePlanTarget
): Promise<FalQueuedRequest> {
  const { is25, useFast, at720 } = animateTier(plan);
  await heartbeatGenerationLock(plan.projectId);
  await markSceneAnimating(target.sceneId, target.motion);
  // Crossfade pad — see animateAllScenes: reels render +XFADE_SEC of
  // footage so the stitched final keeps its full nominal length.
  return await submitVideo({
    imageUrl: target.imageUrl,
    motionPrompt: target.motion,
    durationSec: target.durationSec + XFADE_SEC,
    resolution: at720 ? "720p" : "1080p",
    fast: useFast,
    model: is25 ? "seedance-2.5" : "seedance-2.0",
    aspectRatio: plan.aspectRatio,
    seed: freshSeed(),
  });
}

/** One status poll for an in-flight queue request. Doubles as the lock
 *  heartbeat: polls land every ~30s, well inside STALE_LOCK_MS, so a fresh
 *  animate click can't reclaim the lock mid-batch. */
export async function pollSceneRequest(
  projectId: string,
  req: FalQueuedRequest
): Promise<boolean> {
  await heartbeatGenerationLock(projectId);
  return await checkQueued(req);
}

/**
 * Step 2b: the seedance render is done — fetch its URL and enqueue the
 * upscale. Supersampled delivery: detail synthesized at 4K survives the
 * stitch's 1080p/30 downscale and platform recompression far better than
 * native seedance output shipped as-is. Upscaler per the plan's snapshot:
 * Topaz Proteus (+30fps Apollo interpolation) or SeedVR2 (2160p, stays
 * 24fps — the stitch resamples).
 */
export async function startSceneUpscale(
  plan: ScenePlan,
  target: AnimatePlanTarget,
  videoReq: FalQueuedRequest
): Promise<FalQueuedRequest> {
  const { at720 } = animateTier(plan);
  await heartbeatGenerationLock(plan.projectId);
  const seedanceResult = await collectVideo(videoReq);
  return plan.upscaler === "seedvr2"
    ? await submitSeedVRUpscale({
        videoUrl: seedanceResult.videoUrl,
        targetResolution: "2160p",
      })
    : await submitUpscale({
        videoUrl: seedanceResult.videoUrl,
        model: "Proteus",
        upscaleFactor: at720 ? 3 : 2,
        // 30 across the board — the stitch renders 30fps output, so 60fps
        // interpolation here would be synthesized and then discarded.
        targetFps: 30,
      });
}

/**
 * Step 2c: the upscale is done — re-host the clip on our Blob, mark the
 * scene animated, and record spend for both vendor calls.
 */
export async function finishSceneAnimation(
  plan: ScenePlan,
  target: AnimatePlanTarget,
  upscaleReq: FalQueuedRequest
): Promise<{ ok: true }> {
  const { is25, useFast } = animateTier(plan);
  const useSeedVR = plan.upscaler === "seedvr2";
  await heartbeatGenerationLock(plan.projectId);
  const upscaled = useSeedVR
    ? await collectSeedVRUpscale(upscaleReq)
    : await collectUpscale(upscaleReq);
  const filename = `scene-${String(target.order).padStart(3, "0")}-${nanoid(6)}.mp4`;
  const stored = await storeFromUrl({
    url: upscaled.videoUrl,
    kind: "videos",
    projectId: plan.projectId,
    filename,
  });
  await markSceneAnimated(target.sceneId, { videoUrl: stored.url });
  const billedSec = Math.min(is25 ? 30 : 15, Math.max(4, target.durationSec + XFADE_SEC));
  await recordSpend({
    projectId: plan.projectId,
    kind: "video",
    amountUsd:
      billedSec *
      (is25
        ? FAL_SEEDANCE_25_720P_PER_SECOND
        : useFast
          ? FAL_SEEDANCE_FAST_720P_PER_SECOND
          : FAL_SEEDANCE_PER_SECOND["1080p"]),
    meta: {
      sceneOrder: target.order,
      durationSec: billedSec,
      tier: is25 ? "2.5-720p" : useFast ? "fast-720p" : "1080p",
    },
  });
  await recordSpend({
    projectId: plan.projectId,
    kind: "upscale",
    amountUsd: useSeedVR
      ? estimateSeedVR(billedSec)
      : estimateTopazUpscale(billedSec, "gt-1080p"),
    meta: { sceneOrder: target.order, upscaler: useSeedVR ? "seedvr2" : "topaz" },
  });
  return { ok: true };
}

/** Terminal per-scene failure: record the error on the scene (the still is
 *  untouched) so the operator sees why and can re-animate just that scene. */
export async function failSceneAnimation(
  sceneId: string,
  message: string
): Promise<{ ok: false }> {
  await markSceneAnimateFailed(sceneId, message);
  return { ok: false };
}

/** Step 3: release the lock by settling status. */
export async function finishAnimate(projectId: string): Promise<void> {
  await updateProjectStatus(projectId, "ready");
}


// ── Stitch: assembled final video (fal ffmpeg compose) ──────────────────────

export type StitchResult = {
  finalVideoUrl: string;
};


/** Default hold per still in the style-explorer long-form slideshow. Long
 *  enough to read the room and register the style, short enough that a
 *  10-style video stays in the 1-2 minute band YouTube retention likes. */
// 10s per still since 2026-07-25 (was 7): at 15 styles + base the video
// needs room to breathe, and longer holds read better for ambient viewing.
// MUST match the chapter-stamp default in lib/prompts/metadata.ts AND the
// animate clip length — the shared constant enforces all three.
const STYLE_EXPLORER_PER_STILL_SEC = STYLE_EXPLORER_HOLD_SEC;

/**
 * Stitch a project's assets into ONE ready-to-post video — the CapCut
 * replacement. Reel: clips concatenated in scene order. Before-after: the
 * operator's before still holds for 2.5s, then the morph clip plays.
 * Style-explorer: every still (Original first, then each style) holds for a
 * uniform `perStillSec` — a stills+music YouTube long-form; with uniform
 * timing the description's chapter timestamps are just i × perStillSec.
 * When every style has been Animated, the same uniform slots carry the
 * seedance clips instead — real footage, chapter timestamps unchanged.
 *
 * Audio: clips render SILENT (per-clip seedance ambience was turned off —
 * it never synced across cuts). Passing `musicUrl` lays ONE audio bed
 * across the whole timeline; without it the final ships without sound.
 * Legacy clips animated before the switch may still carry ambience — the
 * music bed replaces it (compose/Shotstack don't mix), and muting covers it.
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
  /** Style-explorer long-forms: render the FULL timeline in one Shotstack
   *  pass (~14-17 Mbps at quality "high"). DEFAULT (undefined = true) — the
   *  long-form's job is YouTube and quality is the product. Pass FALSE
   *  explicitly for a cheap draft loop (fal concat re-encode, ~2-3 Mbps,
   *  ~$1 vs ~$5 for a 16-min final). */
  fullQuality?: boolean;
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

  // before-after is stills-only (no video deliverable since 2026-07-24).
  if (project.format !== "reel" && project.format !== "style-explorer") {
    throw new Error("Stitch is only available for reel and style-explorer projects.");
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
    // Animated long-form: once EVERY style has a clip, chapters become real
    // footage. All-or-nothing on purpose — a mixed stills+clips timeline
    // can't render on the fal fallback (image and video tracks can't
    // coexist), so until the last style is animated the stitch stays a
    // stills slideshow. Clips were rendered to fill exactly the chapter
    // hold (+ crossfade pad), so the hold is PINNED when animated — an
    // opts.perStillSec override would outrun the footage.
    const allAnimated = renderable.every((s) => !!s.videoUrl);
    const perStillMs = allAnimated
      ? STYLE_EXPLORER_PER_STILL_SEC * 1000
      : clamp(opts.perStillSec ?? STYLE_EXPLORER_PER_STILL_SEC, 3, 15) * 1000;
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
      segments.push(
        allAnimated
          ? { kind: "video", url: s.videoUrl as string, ms: perStillMs }
          : { kind: "image", url: s.imageUrl as string, ms: perStillMs }
      );
    }
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
    project.format === "style-explorer" ? (project.aspectRatio ?? "16:9") : "9:16";

  await updateStitchState(projectId, "rendering");
  return { projectId, format: project.format as StitchPrep["format"], segments, cycles, totalMs, aspect, opts };
}

/** Stitch step 2 — the long vendor render. Backend pick: Shotstack (true
 *  crossfades + Ken Burns on stills) when a key is configured; fal ffmpeg
 *  compose (hard cuts) otherwise — and as an automatic fallback if a
 *  Shotstack render errors, so stitch never hard-fails over the fancier
 *  backend. Returns the vendor-hosted URL. */
export type RenderStitchResult = {
  videoUrl: string;
  /** Set when the premium Shotstack path failed and the fal fallback (hard
   *  cuts, capped bitrate) produced this video — surfaced to the operator
   *  so a silent quality downgrade can't happen (observed 2026-07-24:
   *  Fremy's long-form shipped without transitions and nobody knew why). */
  degraded?: string;
};

export async function renderStitch(prep: StitchPrep): Promise<RenderStitchResult> {
  const { projectId, format, segments, totalMs, aspect, opts } = prep;
  const cycles = prep.cycles ?? 1;
  const cycleMs = segments.reduce((n, s) => n + s.ms, 0);
  let renderedUrl: string | null = null;
  let degraded: string | undefined;
  if (isShotstackConfigured()) {
    try {
      if (cycles > 1 && opts.fullQuality !== false) {
        // Upload-quality long-form: ONE Shotstack render of the whole tiled
        // timeline (music included) at quality "high" — no fal re-encode to
        // cap the bitrate. Costs the full output minutes.
        const fullTimeline = Array.from({ length: cycles }, () => segments).flat();
        const edit = buildShotstackEdit(format, fullTimeline, aspect, opts);
        renderedUrl = (await renderShotstack(edit)).videoUrl;
        await recordSpend({
          projectId,
          kind: "compose",
          amountUsd: (totalMs / 60_000) * SHOTSTACK_PER_MINUTE,
          meta: { format, outputSec: Math.round(totalMs / 1000), backend: "shotstack", pass: "full-quality" },
        });
      } else if (cycles > 1) {
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
      degraded = err instanceof Error ? err.message : String(err);
      console.warn("[stitch] Shotstack failed; falling back to fal compose:", err);
      renderedUrl = null;
    }
  } else if (opts.fullQuality !== false && format === "style-explorer") {
    degraded = "No Shotstack key configured for this operator.";
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
  return { videoUrl: renderedUrl, degraded };
}

/** Stitch step 3a (large finals): probe the rendered file and open a
 *  chunked multipart re-host when it's too big for one invocation. */
export async function planStitchRehost(
  projectId: string,
  renderedUrl: string
): Promise<RehostPlan> {
  return await planLargeRehost({
    url: renderedUrl,
    kind: "videos",
    projectId,
    filename: `final-${nanoid(6)}.mp4`,
  });
}

/** Stitch step 3b (× N): transfer one batch of parts. Pure passthrough —
 *  exists so the Inngest orchestrator imports everything from lib/projects. */
export async function transferStitchRehostParts(
  renderedUrl: string,
  plan: Extract<RehostPlan, { mode: "multipart" }>,
  fromPart: number,
  toPart: number
): Promise<RehostPart[]> {
  return await transferRehostParts(renderedUrl, plan, fromPart, toPart);
}

/** Stitch step 3c: assemble the parts, persist, settle the lifecycle. */
export async function completeStitchRehost(
  projectId: string,
  plan: Extract<RehostPlan, { mode: "multipart" }>,
  parts: RehostPart[],
  degradedNote?: string
): Promise<StitchResult> {
  const stored = await completeLargeRehost(plan, parts);
  await markProjectFinalVideo(projectId, stored.url);
  await updateStitchState(projectId, "ready", degradedNote ?? null);
  return { finalVideoUrl: stored.url };
}

/** Stitch step 3 — re-host on our own Blob (stable, downloadable URL),
 *  persist, and settle the lifecycle. */
export async function finishStitch(
  projectId: string,
  renderedUrl: string,
  degradedNote?: string
): Promise<StitchResult> {
  const stored = await storeFromUrl({
    url: renderedUrl,
    kind: "videos",
    projectId,
    filename: `final-${nanoid(6)}.mp4`,
  });
  await markProjectFinalVideo(projectId, stored.url);
  // A degradation note rides stitchError alongside status "ready" — the
  // panel renders it as a warning, not a failure.
  await updateStitchState(projectId, "ready", degradedNote ?? null);
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
  const rendered = await renderStitch(prep);
  return await finishStitch(projectId, rendered.videoUrl, rendered.degraded);
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
      // "high" pushes the encoder into the ~14-17 Mbps band at 1080p — the
      // crisp-pipeline delivery target. Clips arrive as Topaz 4K sources, so
      // this render is a supersampled downscale, not an upscale.
      quality: "high",
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

/** Map the neutral timeline to fal compose tracks (hard cuts, tiled music).
 *
 *  Track type matters — live-verified 2026-07-23:
 *  - An image URL as a keyframe on a `video` track renders ~1 FRAME no
 *    matter its duration (Fremy's 11-min long-form came out as 0.32s of
 *    video under 11 min of audio). Stills need a `type:"image"` track,
 *    which honors keyframe durations.
 *  - An image track can't coexist with a video track ("Multiple video
 *    tracks are not supported"), so mixed timelines (before-after's
 *    still + morph) must stay on a video track and only render correctly
 *    via Shotstack.
 *  - Audio keyframes are never trimmed to their duration — the last music
 *    tile plays out past the video's end and the container runs long by up
 *    to one song. Cosmetic for ambient long-forms; nothing we can do
 *    compose-side. */
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
  const allStills = segments.every((s) => s.kind === "image");
  const tracks: ComposeTrack[] = [
    { id: "video", type: allStills ? "image" : "video", keyframes },
  ];
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
    // Chapters mirror the stitched timeline: scene 1 plays at 00:00 (its
    // chapter label below), every later scene at k × hold. Style-explorer's
    // scene 1 is the "Original" base → labeled "Intro"; showcase's scene 1
    // is a real shot → its own name.
    const ordered = [...scenes].sort((a, b) => a.order - b.order);
    const firstName = ordered[0]?.styleName;
    const styleNames = ordered
      .slice(1)
      .filter((s) => !!s.styleName)
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
      // Showcase long-forms are property TOURS (the operator's own images,
      // chapter per room) — not style walkthroughs.
      mode: project.uploadSourced ? "tour" : "styles",
    });

    const metadata = assembleYouTubeMetadata({
      draft,
      styleNames,
      introLabel: firstName && firstName !== "Original" ? firstName : undefined,
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
      // Before-after: the named "after" concepts (swipe order) so the caption
      // can reference them and ask the concrete "which one?" vote.
      conceptNames:
        project.format === "before-after"
          ? renderable
              .filter((s) => !!s.styleName && s.styleName !== "Before")
              .sort((a, b) => a.order - b.order)
              .map((s) => s.styleName as string)
          : undefined,
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
    // background stitch (silent — clips carry no audio; the stitch panel
    // adds the music bed) rather than rendering inline: vendor renders
    // never run inside request-bound functions.
    // Style-explorer is excluded on purpose — a stills slideshow without a
    // music upload is a silent video, so that stitch stays operator-driven.
    let autoStitch = false;
    if (project.format === "reel" && !project.finalVideoUrl) {
      autoStitch = renderable.length > 0 && renderable.every((s) => !!s.videoUrl);
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
