"use client";

import { useState } from "react";
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
  // While Inngest is mid-job the project carries the generation/finalization
  // lock. Block all action buttons so a second click can't enqueue a duplicate
  // before the first run finishes.
  const jobInFlight = status === "generating" || status === "finalizing";
  const disabled = !!busy || jobInFlight;

  const remaining = counts.pending + counts.rejected;
  const ready = counts.generated + counts.approved;
  const allStillsDone = totalScenes > 0 && remaining === 0 && counts.generating === 0 && ready === totalScenes;

  // Reel-only animate gating: stills all done, but not all animated yet.
  const isReel = format === "reel";
  const animateNeeded = isReel && allStillsDone && animatedCount < totalScenes;
  // Finalize is gated behind animation for reels (otherwise the bundle would
  // ship stills only, defeating the point of the feature).
  const canFinalize = allStillsDone && (!isReel || animatedCount === totalScenes);

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
      // Route returns 202 — work runs in the background. The project page
      // polls (AutoRefresh island) so per-scene flips appear without reload.
      toast.success("Started — scenes will appear as they complete", {
        id: toastId,
      });
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
      "Finalizing — metadata, thumbnail… usually under a minute"
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
    estimateAnimateBatch(totalScenes - animatedCount, perSceneDurationSec || 3)
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
              : `Animate ${totalScenes - animatedCount} (~${animateCost})`}
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
              : remaining === totalScenes
                ? `Generate all ${totalScenes} (~${generateBatchCost})`
                : `Generate ${remaining} pending (~${generateBatchCost})`}
        </Button>
      ) : !animateNeeded && !canFinalize ? (
        <Button variant="outline" onClick={() => generate(true)} disabled={disabled}>
          {busy === "generate" ? "Queuing…" : `Regenerate all (~${regenerateAllCost})`}
        </Button>
      ) : null}
    </div>
  );
}
