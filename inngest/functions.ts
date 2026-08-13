import { inngest } from "./client";
import {
  completeStitchRehost,
  failSceneAnimation,
  failStitch,
  finishAnimate,
  finishSceneAnimation,
  finishStitch,
  generateAllImages,
  planAnimate,
  planStitchRehost,
  pollSceneRequest,
  prepareStitch,
  ProjectBusyError,
  renderStitch,
  startSceneUpscale,
  startSceneVideo,
  transferStitchRehostParts,
  type AnimatePlan,
  type AnimatePlanTarget,
  type RenderStitchResult,
  type ScenePlan,
  type StitchOpts,
  type StitchPrep,
} from "@/lib/projects";
import type { FalQueuedRequest } from "@/lib/fal-queue";
import { REHOST_PARTS_PER_STEP, type RehostPart, type RehostPlan } from "@/lib/storage";
import { getOperator, withOperator } from "@/lib/operators";
import { cleanupOrphanedUploads } from "@/lib/cleanup";
import type { AspectRatio } from "@/lib/prompts/types";

/**
 * Step shape we rely on. Inngest's real `step.run` runs the inner fn and
 * memoizes its result so a retry doesn't re-execute completed steps. For
 * testing we accept any callable with that signature.
 */
type StepRunner = {
  run: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  /** Inngest's durable sleep: the function invocation ENDS and a new one is
   *  scheduled after the delay — no serverless time is spent waiting. */
  sleep: (name: string, duration: string | number) => Promise<void>;
};

type GenerateEvent = {
  data: {
    projectId: string;
    operatorEmail: string;
    force?: boolean;
    concurrency?: number;
    aspectRatio?: AspectRatio;
  };
};

type AnimateEvent = {
  data: {
    projectId: string;
    operatorEmail: string;
    force?: boolean;
    concurrency?: number;
    /** Re-animate exactly this scene (fresh seed + motion prompt). */
    sceneId?: string;
  };
};

/**
 * Pure orchestration handler for `project/generate.requested`. Exported so
 * unit tests can drive it without standing up the Inngest runtime.
 *
 * Resolves the operator from the email payload (env vars stay server-side —
 * they are never serialized into the event), then runs generateAllImages
 * inside an `withOperator` AsyncLocalStorage scope so deeper code can read
 * `currentOperator()`.
 *
 * ProjectBusyError → return a `busy: true` summary instead of throwing, so
 * Inngest doesn't burn a retry on what's actually a benign double-fire.
 */
export async function handleGenerate(
  { event }: { event: GenerateEvent },
  step: StepRunner
) {
  const { projectId, operatorEmail, ...opts } = event.data;
  const operator = getOperator(operatorEmail);
  if (!operator) {
    throw new Error(
      `Operator not configured for ${operatorEmail}. Check FAL_KEY_* and OPENAI_KEY_* env vars on the deployment.`
    );
  }
  return await step.run("generate-images", async () => {
    try {
      return await withOperator(operator, () => generateAllImages(projectId, opts));
    } catch (err) {
      if (err instanceof ProjectBusyError) {
        return { skipped: 0, generated: 0, failed: 0, reclaimed: 0, busy: true };
      }
      throw err;
    }
  });
}

/**
 * Pure orchestration handler for `project/animate.requested` — PER-SCENE
 * steps. One "plan" step (lock + validation + motion prompts), then each
 * scene animates in its own step so no single serverless invocation carries
 * the whole batch (a 3×1080p batch outlives Vercel's maxDuration — observed
 * in prod 2026-07-19), then a "finish" step settles status. Step memoization
 * means retries never re-render completed scenes.
 */
export async function handleAnimate(
  { event }: { event: AnimateEvent },
  step: StepRunner
) {
  const { projectId, operatorEmail, force, sceneId } = event.data;
  const operator = getOperator(operatorEmail);
  if (!operator) {
    throw new Error(
      `Operator not configured for ${operatorEmail}. Check FAL_KEY_* and OPENAI_KEY_* env vars on the deployment.`
    );
  }

  const plan = await step.run("plan", async () => {
    try {
      return await withOperator(operator, () => planAnimate(projectId, { force, sceneId }));
    } catch (err) {
      if (err instanceof ProjectBusyError) return { busy: true as const };
      throw err;
    }
  });

  if ("busy" in plan) {
    return { animated: 0, failed: 0, skipped: 0, busy: true };
  }
  const typedPlan = plan as AnimatePlan;
  if (typedPlan.targets.length === 0) {
    return { animated: 0, failed: 0, skipped: typedPlan.skipped };
  }

  // Parallel per-scene pipelines — every step is a sub-second HTTP call
  // (queue submit / status poll / result fetch); the render waits happen in
  // durable sleeps, so no invocation ever rides out a multi-minute vendor
  // call (that pattern died silently at Vercel's maxDuration, 2026-08-12).
  const results = await Promise.all(
    typedPlan.targets.map((target) =>
      animateSceneStepwise(step, operator, typedPlan, target)
    )
  );

  await step.run("finish", () => withOperator(operator, () => finishAnimate(projectId)));

  const animated = results.filter((r) => r.ok).length;
  return { animated, failed: results.length - animated, skipped: typedPlan.skipped };
}

/** Poll cadence for queued fal renders. 30s keeps the generation lock fresh
 *  (STALE_LOCK_MS is 10 min) without hammering fal; 40 polls bounds a stage
 *  at 20 minutes — beyond any observed seedance/Topaz/SeedVR2 render. */
const FAL_POLL_INTERVAL = "30s";
const FAL_MAX_POLLS = 40;

type Operator = NonNullable<ReturnType<typeof getOperator>>;

/** Sleep → poll until the queued request completes, or throw on timeout. */
async function waitForFal(
  step: StepRunner,
  operator: Operator,
  projectId: string,
  label: string,
  req: FalQueuedRequest
): Promise<void> {
  for (let i = 0; i < FAL_MAX_POLLS; i++) {
    await step.sleep(`${label}-wait-${i}`, FAL_POLL_INTERVAL);
    const done = await step.run(`${label}-poll-${i}`, () =>
      withOperator(operator, () => pollSceneRequest(projectId, req))
    );
    if (done) return;
  }
  throw new Error(
    `${req.endpoint} request ${req.requestId} still not done after ${FAL_MAX_POLLS} polls — giving up on this scene.`
  );
}

/**
 * One scene's full pipeline as short steps: submit seedance → poll → submit
 * upscale → poll → store/bill. Any stage failing (submit rejected, render
 * failed, timeout) marks the scene failed and resolves ok:false so the batch
 * keeps its per-scene independence.
 */
async function animateSceneStepwise(
  step: StepRunner,
  operator: Operator,
  plan: ScenePlan,
  target: AnimatePlanTarget
): Promise<{ ok: boolean }> {
  const label = `scene-${target.order}`;
  try {
    const videoReq = (await step.run(`${label}-submit-video`, () =>
      withOperator(operator, () => startSceneVideo(plan, target))
    )) as FalQueuedRequest;
    await waitForFal(step, operator, plan.projectId, `${label}-video`, videoReq);

    const upscaleReq = (await step.run(`${label}-submit-upscale`, () =>
      withOperator(operator, () => startSceneUpscale(plan, target, videoReq))
    )) as FalQueuedRequest;
    await waitForFal(step, operator, plan.projectId, `${label}-upscale`, upscaleReq);

    return await step.run(`${label}-store`, () =>
      withOperator(operator, () => finishSceneAnimation(plan, target, upscaleReq))
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return await step.run(`${label}-fail`, () =>
      withOperator(operator, () => failSceneAnimation(target.sceneId, msg))
    );
  }
}

/**
 * Background image-batch generator. The route handler sends
 * `project/generate.requested` and returns 202 immediately; this function
 * does the heavy fal calls in a step so it isn't bound by Vercel's per-
 * function timeout.
 *
 * Concurrency: at most one job per project at a time. Inngest queues
 * additional events for the same project until the running one finishes,
 * which prevents accidental double-spending.
 */
export const generateProject = inngest.createFunction(
  {
    id: "generate-project",
    concurrency: { limit: 1, key: "event.data.projectId" },
    // Inngest auto-retries failed steps. Any uncaught error here is structural
    // (DB unreachable, bad env). Per-scene fal failures are caught inside the
    // orchestrator and don't bubble.
    retries: 2,
    triggers: [{ event: "project/generate.requested" }],
  },
  // Inngest passes ({ event, step, ...ctx }); we only use event + step.
  // Cast: we control all senders so the event shape is guaranteed; the runtime
  // type comes back as a loose `ReceivedEvent` with `BasicDataAny`.
  ({ event, step }) =>
    handleGenerate({ event: event as unknown as GenerateEvent }, step as unknown as StepRunner)
);

/**
 * Background animator (reel + before-after) — per-scene step granularity.
 */
export const animateProject = inngest.createFunction(
  {
    id: "animate-project",
    concurrency: { limit: 1, key: "event.data.projectId" },
    retries: 2,
    triggers: [{ event: "project/animate.requested" }],
  },
  ({ event, step }) =>
    handleAnimate({ event: event as unknown as AnimateEvent }, step as unknown as StepRunner)
);

type StitchEvent = {
  data: {
    projectId: string;
    operatorEmail: string;
    opts?: StitchOpts;
  };
};

/**
 * Pure orchestration handler for `project/stitch.requested` — prepare
 * (validate + timeline, no spend) → render (the long vendor call) → finish
 * (Blob re-host + persist). A 10-20 minute style-explorer long-form
 * composes for several minutes and re-hosts hundreds of MB; that lives
 * here, not inside a request-bound route.
 */
export async function handleStitch(
  { event }: { event: StitchEvent },
  step: StepRunner
) {
  const { projectId, operatorEmail, opts } = event.data;
  const operator = getOperator(operatorEmail);
  if (!operator) {
    throw new Error(
      `Operator not configured for ${operatorEmail}. Check FAL_KEY_* and OPENAI_KEY_* env vars on the deployment.`
    );
  }

  const prep = (await step.run("prepare", () =>
    withOperator(operator, () => prepareStitch(projectId, opts))
  )) as StitchPrep;

  const rendered = (await step.run("render", () =>
    withOperator(operator, () => renderStitch(prep))
  )) as RenderStitchResult;
  const renderedUrl = rendered.videoUrl;

  // Re-host: full-quality long-forms run 1.5-2GB — one invocation can't
  // move that (observed platform kill 2026-07-24). Plan step decides:
  // small files stream in one "finish" step as before; large files split
  // into Range-download part batches, each in its OWN invocation, then a
  // complete step assembles them.
  const rehostPlan = (await step.run("rehost-plan", () =>
    withOperator(operator, () => planStitchRehost(projectId, renderedUrl))
  )) as RehostPlan;

  if (rehostPlan.mode === "simple") {
    return await step.run("finish", () =>
      withOperator(operator, () => finishStitch(projectId, renderedUrl, rendered.degraded))
    );
  }

  let parts: RehostPart[] = [];
  for (let from = 1; from <= rehostPlan.partCount; from += REHOST_PARTS_PER_STEP) {
    const to = Math.min(from + REHOST_PARTS_PER_STEP - 1, rehostPlan.partCount);
    const batch = (await step.run(`rehost-parts-${from}-${to}`, () =>
      withOperator(operator, () =>
        transferStitchRehostParts(renderedUrl, rehostPlan, from, to)
      )
    )) as RehostPart[];
    parts = parts.concat(batch);
  }

  return await step.run("finish-large", () =>
    withOperator(operator, () => completeStitchRehost(projectId, rehostPlan, parts, rendered.degraded))
  );
}

/**
 * Background stitcher. The route enqueues and returns 202; the client polls
 * the project's stitchStatus. onFailure (all retries exhausted) records the
 * failure so polling stops with a reason instead of spinning forever.
 */
export const stitchProject = inngest.createFunction(
  {
    id: "stitch-project",
    concurrency: { limit: 1, key: "event.data.projectId" },
    retries: 2,
    onFailure: async ({ event }) => {
      // v4 failure payload nests the original event.
      const original = (event as unknown as { data: { event: StitchEvent } }).data.event;
      const message =
        (event as unknown as { data: { error?: { message?: string } } }).data.error?.message ??
        "Stitch failed after retries.";
      await failStitch(original.data.projectId, message);
    },
    triggers: [{ event: "project/stitch.requested" }],
  },
  ({ event, step }) =>
    handleStitch({ event: event as unknown as StitchEvent }, step as unknown as StepRunner)
);

/**
 * Weekly blob hygiene — deletes pre-project uploads (uploads/, thumbnail-src/,
 * music/) that are 7+ days old and referenced by nothing in the DB. Mondays
 * 06:00 UTC; a failed run just leaves the remainder for next week.
 */
export const cleanupUploads = inngest.createFunction(
  { id: "cleanup-orphaned-uploads", retries: 1, triggers: [{ cron: "0 6 * * 1" }] },
  async () => {
    const result = await cleanupOrphanedUploads();
    return result;
  }
);

/** Every function we want Inngest to discover at /api/inngest. */
export const functions = [generateProject, animateProject, stitchProject, cleanupUploads];
