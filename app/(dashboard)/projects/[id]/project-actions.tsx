"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  estimateAnimateBatch,
  estimateBatchImages,
  estimateFinalize,
  formatCost,
} from "@/lib/pricing";

type Counts = {
  pending: number;
  generating: number;
  generated: number;
  approved: number;
  rejected: number;
};

export function ProjectActions({
  projectId,
  totalScenes,
  counts,
  status,
  hasExport,
  format,
  perSceneDurationSec,
  animatedCount,
}: {
  projectId: string;
  totalScenes: number;
  counts: Counts;
  status: string;
  hasExport: boolean;
  format: string;
  perSceneDurationSec: number;
  /** How many scenes already have a videoUrl. Reels only — used to gate Animate button. */
  animatedCount: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "generate" | "animate" | "finalize">(null);
  // Bridges the gap between user click and the Inngest worker acquiring the
  // project lock. Without this the button would re-enable for a few seconds
  // after enqueue (worker pickup latency) and a second click could double-fire.
  // Cleared automatically once the server reports status === generating
  // (taking over) or after the safety timeout fires.
  const [justEnqueued, setJustEnqueued] = useState(false);
  const enqueueTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Server-driven flag — true once the orchestrator has acquired its lock.
  const jobInFlight = status === "generating" || status === "finalizing";
  // Once the server confirms the job is running, drop the optimistic flag so
  // the rest of the lifecycle (status flips to "ready") can re-enable buttons.
  useEffect(() => {
    if (jobInFlight && justEnqueued) {
      if (enqueueTimerRef.current) clearTimeout(enqueueTimerRef.current);
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      setJustEnqueued(false);
    }
  }, [jobInFlight, justEnqueued]);
  // Safety: cleanup timers if the component unmounts mid-bridge.
  useEffect(() => {
    return () => {
      if (enqueueTimerRef.current) clearTimeout(enqueueTimerRef.current);
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, []);

  const disabled = !!busy || jobInFlight || justEnqueued;

  /**
   * Called after a successful enqueue. Locks the buttons + triggers polling
   * for ~30s (covering Inngest pickup latency + the brief window before the
   * worker acquires the lock). Once the server reports `generating`, the
   * effect above tears this down.
   */
  function startEnqueueBridge() {
    setJustEnqueued(true);
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    pollTimerRef.current = setInterval(() => router.refresh(), 1500);
    if (enqueueTimerRef.current) clearTimeout(enqueueTimerRef.current);
    enqueueTimerRef.current = setTimeout(() => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      setJustEnqueued(false);
    }, 30_000);
  }

  const remaining = counts.pending + counts.rejected;
  const ready = counts.generated + counts.approved;
  const allStillsDone = totalScenes > 0 && remaining === 0 && counts.generating === 0 && ready === totalScenes;

  // Animate gating: stills all done, but not all the animatable scenes have
  // a video yet. Reels animate every scene; before-after only animates the
  // AI-generated "after" (one of two scenes — the upload stays static).
  const isReel = format === "reel";
  const isAnimatable = isReel || format === "before-after";
  const animatableCount = format === "before-after" ? 1 : totalScenes;
  const animateNeeded = isAnimatable && allStillsDone && animatedCount < animatableCount;
  // Finalize is gated behind animation for both formats — a before-after
  // bundle without the after video is missing the whole point, same as a
  // reel without its motion.
  const canFinalize =
    allStillsDone && (!isAnimatable || animatedCount >= animatableCount);

  async function generate(force = false) {
    setBusy("generate");
    const targetCount = force ? totalScenes : remaining;
    const toastId = toast.loading(
      `Queuing ${targetCount} ${targetCount === 1 ? "image" : "images"}…`
    );
    try {
      const res = await fetch(`/api/projects/${projectId}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      // Route returns 202 — work runs in the background. Trigger the local
      // bridge so the button stays disabled until the server reports the
      // worker has acquired the lock (status === "generating").
      toast.success("Started — scenes will appear as they complete", {
        id: toastId,
      });
      startEnqueueBridge();
      router.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error("Couldn't start generation", { id: toastId, description: message });
    } finally {
      setBusy(null);
    }
  }

  async function animate() {
    setBusy("animate");
    const toastId = toast.loading("Queuing animate job…");
    try {
      const res = await fetch(`/api/projects/${projectId}/animate`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      toast.success("Started — videos will appear as they finish", {
        id: toastId,
      });
      startEnqueueBridge();
      router.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error("Couldn't start animate", { id: toastId, description: message });
    } finally {
      setBusy(null);
    }
  }

  async function finalize() {
    setBusy("finalize");
    const toastId = toast.loading(
      "Finalizing — metadata… usually under a minute"
    );
    try {
      const res = await fetch(`/api/projects/${projectId}/finalize`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      toast.success("Export ready — scroll down for the bundle", { id: toastId });
      router.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error("Finalize failed", { id: toastId, description: message });
    } finally {
      setBusy(null);
    }
  }

  const generateBatchCost = formatCost(
    estimateBatchImages(remaining === totalScenes ? totalScenes : remaining)
  );
  const regenerateAllCost = formatCost(estimateBatchImages(totalScenes));
  const animateCost = formatCost(
    estimateAnimateBatch(Math.max(0, animatableCount - animatedCount), perSceneDurationSec || 3)
  );
  const finalizeCost = formatCost(estimateFinalize());

  return (
    <div className="flex items-center gap-2">
      {status === "exported" && hasExport ? (
        <Button variant="outline" onClick={finalize} disabled={disabled}>
          {busy === "finalize" ? "Re-finalizing…" : `Re-finalize (~${finalizeCost})`}
        </Button>
      ) : canFinalize ? (
        <Button onClick={finalize} disabled={disabled}>
          {busy === "finalize" ? "Finalizing…" : `Finalize & export (~${finalizeCost})`}
        </Button>
      ) : null}

      {animateNeeded && (
        <Button onClick={animate} disabled={disabled}>
          {jobInFlight
            ? "Animating…"
            : busy === "animate"
              ? "Queuing…"
              : justEnqueued
                ? "Starting…"
                : `Animate ${animatableCount - animatedCount} (~${animateCost})`}
        </Button>
      )}

      {allStillsDone && !animateNeeded && !canFinalize ? null : null}

      {allStillsDone && !animateNeeded && status !== "exported" && !canFinalize ? null : null}

      {!allStillsDone ? (
        <Button onClick={() => generate(false)} disabled={disabled || totalScenes === 0}>
          {jobInFlight
            ? "Generating…"
            : busy === "generate"
              ? "Queuing…"
              : justEnqueued
                ? "Starting…"
                : remaining === totalScenes
                  ? `Generate all ${totalScenes} (~${generateBatchCost})`
                  : `Generate ${remaining} pending (~${generateBatchCost})`}
        </Button>
      ) : !animateNeeded && !canFinalize ? (
        <Button variant="outline" onClick={() => generate(true)} disabled={disabled}>
          {busy === "generate"
            ? "Queuing…"
            : justEnqueued
              ? "Starting…"
              : `Regenerate all (~${regenerateAllCost})`}
        </Button>
      ) : null}
    </div>
  );
}
