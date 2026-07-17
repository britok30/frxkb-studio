import { inngest } from "./client";
import { animateAllScenes, generateAllImages, ProjectBusyError } from "@/lib/projects";
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
 * Pure orchestration handler for `project/animate.requested`. Same shape as
 * handleGenerate. See note on per-scene retry granularity below.
 */
export async function handleAnimate(
  { event }: { event: AnimateEvent },
  step: StepRunner
) {
  const { projectId, operatorEmail, ...opts } = event.data;
  const operator = getOperator(operatorEmail);
  if (!operator) {
    throw new Error(
      `Operator not configured for ${operatorEmail}. Check FAL_KEY_* and OPENAI_KEY_* env vars on the deployment.`
    );
  }
  return await step.run("animate-scenes", async () => {
    try {
      return await withOperator(operator, () => animateAllScenes(projectId, opts));
    } catch (err) {
      if (err instanceof ProjectBusyError) {
        return { animated: 0, failed: 0, skipped: 0, busy: true };
      }
      throw err;
    }
  });
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
 * Background animator (reel-only).
 *
 * Per-scene retry granularity is intentionally NOT here yet — the existing
 * orchestrator catches per-scene failures and marks rows accordingly. If we
 * ever want step-level retry per scene (e.g. seedance succeeds for #3 but
 * topaz fails for #4 — only retry #4's topaz), refactor animateAllScenes to
 * expose per-scene work and wrap each in its own step.run.
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

/** Every function we want Inngest to discover at /api/inngest. */
export const functions = [generateProject, animateProject];
