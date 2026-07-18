"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

/**
 * Batch review actions for the Stills section header:
 *  - "Approve all ready" flips every generated scene to approved in one call.
 *  - "Regenerate failed (n)" re-runs ONLY pending/rejected scenes (the
 *    non-force default of POST /generate) — approved/generated stills keep
 *    their renders and their cost.
 */
export function BatchActions({
  projectId,
  generatedCount,
  retryableCount,
  retryCostLabel,
  jobInFlight,
}: {
  projectId: string;
  generatedCount: number;
  retryableCount: number;
  retryCostLabel: string;
  jobInFlight: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "approve" | "retry">(null);
  const [, startTransition] = useTransition();

  async function approveAll() {
    if (busy || jobInFlight) return;
    setBusy("approve");
    const toastId = toast.loading(`Approving ${generatedCount} scenes…`);
    try {
      const res = await fetch(`/api/projects/${projectId}/scenes/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve-ready" }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { approved: number };
      toast.success(`Approved ${data.approved} scenes`, { id: toastId });
      startTransition(() => router.refresh());
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error("Couldn't approve all", { id: toastId, description: message });
    } finally {
      setBusy(null);
    }
  }

  async function retryFailed() {
    if (busy || jobInFlight) return;
    setBusy("retry");
    const toastId = toast.loading(`Queuing ${retryableCount} scenes…`);
    try {
      const res = await fetch(`/api/projects/${projectId}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      toast.success("Started — scenes will refresh as they complete", { id: toastId });
      startTransition(() => router.refresh());
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error("Couldn't start retry", { id: toastId, description: message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex items-center gap-4">
      {generatedCount > 0 && !jobInFlight && (
        <button
          type="button"
          onClick={() => void approveAll()}
          disabled={!!busy}
          className="text-xs text-muted-foreground hover:text-foreground tracking-tight transition-colors disabled:opacity-50"
        >
          {busy === "approve" ? "Approving…" : `Approve all ready (${generatedCount})`}
        </button>
      )}
      {retryableCount > 0 && !jobInFlight && (
        <button
          type="button"
          onClick={() => void retryFailed()}
          disabled={!!busy}
          className="text-xs text-muted-foreground hover:text-foreground tracking-tight transition-colors disabled:opacity-50"
        >
          {busy === "retry"
            ? "Queuing…"
            : `Regenerate failed (${retryableCount}, ~${retryCostLabel})`}
        </button>
      )}
    </div>
  );
}
