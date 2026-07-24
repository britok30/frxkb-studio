import { inngest } from "./client";
import {
  animatePlannedScene,
  failStitch,
  finishAnimate,
  finishStitch,
  generateAllImages,
  planAnimate,
  prepareStitch,
  ProjectBusyError,
  renderStitch,
  type AnimatePlan,
  type StitchOpts,
  type StitchPrep,
} from "@/lib/projects";
import { getOperator, withOperator } from "@/lib/operators";
import type { AspectRatio } from "@/lib/prompts/types";

/**
 * Step shape we rely on. Inngest's real `step.run` runs the inner fn and
 * memoizes its result so a retry doesn't re-execute completed steps. For
 * testing we accept any callable with that signature.
 */
type StepRunner = {
  run: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
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

  // Parallel per-scene steps — Inngest runs each as its own invocation.
  const results = await Promise.all(
    typedPlan.targets.map((target) =>
      step.run(`scene-${target.order}`, () =>
        withOperator(operator, () => animatePlannedScene(typedPlan, target))
      )
    )
  );

  await step.run("finish", () => withOperator(operator, () => finishAnimate(projectId)));

  const animated = results.filter((r) => r.ok).length;
  return { animated, failed: results.length - animated, skipped: typedPlan.skipped };
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

  const renderedUrl = (await step.run("render", () =>
    withOperator(operator, () => renderStitch(prep))
  )) as string;

  return await step.run("finish", () =>
    withOperator(operator, () => finishStitch(projectId, renderedUrl))
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

/** Every function we want Inngest to discover at /api/inngest. */
export const functions = [generateProject, animateProject, stitchProject];
