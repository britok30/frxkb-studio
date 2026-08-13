import { createFalClient, type FalClient } from "@fal-ai/client";
import { currentOperator } from "@/lib/operators";

/**
 * Queue-based fal plumbing for renders that outlive a serverless invocation.
 *
 * `client.subscribe` blocks the calling process until the render finishes —
 * fatal on Vercel, where the invocation is killed at maxDuration and the kill
 * never reaches a catch block (observed in prod 2026-08-12: six seedance-2.5
 * scenes each died at exactly the 800s ceiling with no error written). The
 * queue API splits the same request into submit → status → result, each a
 * sub-second HTTP call, so the caller (an Inngest step) can sleep durably
 * between polls instead of holding a function open.
 */

/** Serializable handle to an in-flight queue request — safe to pass through
 *  Inngest step memoization (plain JSON, no client state). */
export type FalQueuedRequest = {
  endpoint: string;
  requestId: string;
};

const clientCache = new Map<string, FalClient>();

function clientForOperator(): FalClient {
  const op = currentOperator();
  let client = clientCache.get(op.email);
  if (!client) {
    client = createFalClient({ credentials: op.falKey });
    clientCache.set(op.email, client);
  }
  return client;
}

/** Test-only: clear the cache. */
export function __resetFalQueueForTests(): void {
  clientCache.clear();
}

/** Surface fal's validation detail — a bare "Unprocessable Entity" hides
 *  actionable causes like content_policy_violation. Returns null when the
 *  error carries no structured detail. */
export function falErrorDetail(err: unknown): string | null {
  const body = (err as { body?: { detail?: Array<{ msg?: string }> | string } }).body;
  return Array.isArray(body?.detail)
    ? body.detail.map((d) => d.msg).filter(Boolean).join("; ") || null
    : typeof body?.detail === "string"
      ? body.detail
      : null;
}

/** Enqueue a request. Returns immediately with the queue handle. */
export async function submitQueued(
  endpoint: string,
  input: Record<string, unknown>
): Promise<FalQueuedRequest> {
  const client = clientForOperator();
  try {
    const queued = await client.queue.submit(endpoint, { input });
    return { endpoint, requestId: queued.request_id };
  } catch (err) {
    const detail = falErrorDetail(err);
    if (detail) throw new Error(`${endpoint} rejected the request: ${detail}`);
    throw err;
  }
}

/** One status poll. True once the request has COMPLETED (failures also land
 *  on COMPLETED — collectQueued surfaces the error when fetching the result). */
export async function checkQueued(req: FalQueuedRequest): Promise<boolean> {
  const client = clientForOperator();
  const status = await client.queue.status(req.endpoint, {
    requestId: req.requestId,
    logs: false,
  });
  return status.status === "COMPLETED";
}

/** Fetch the result of a completed request. Throws (with fal's detail when
 *  available) if the render actually failed. */
export async function collectQueued<T>(req: FalQueuedRequest): Promise<T> {
  const client = clientForOperator();
  try {
    const result = await client.queue.result(req.endpoint, { requestId: req.requestId });
    return result.data as T;
  } catch (err) {
    const detail = falErrorDetail(err);
    if (detail) throw new Error(`${req.endpoint} failed: ${detail}`);
    throw err;
  }
}
