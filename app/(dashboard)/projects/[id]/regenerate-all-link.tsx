"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

/**
 * Subtle "Regenerate all" affordance for the Scenes section header. Confirms
 * before firing because re-generating every scene re-pays the full image
 * batch cost AND invalidates any existing animations on those scenes.
 */
export function RegenerateAllLink({
  projectId,
  totalScenes,
  costLabel,
  hasAnyAnimated,
}: {
  projectId: string;
  totalScenes: number;
  costLabel: string;
  hasAnyAnimated: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function run() {
    if (busy) return;
    const warning = hasAnyAnimated
      ? `This will re-generate all ${totalScenes} stills (${costLabel}) and invalidate the existing video animations. Continue?`
      : `This will re-generate all ${totalScenes} stills (${costLabel}). Continue?`;
    if (typeof window !== "undefined" && !window.confirm(warning)) return;

    setBusy(true);
    const toastId = toast.loading(`Queuing ${totalScenes} stills…`);
    try {
      const res = await fetch(`/api/projects/${projectId}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      // 202 — work runs in the background. AutoRefresh in page.tsx will keep
      // the page in sync as scenes flip from generating → generated.
      toast.success("Started — scenes will refresh as they complete", {
        id: toastId,
      });
      router.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error("Couldn't start regenerate", { id: toastId, description: message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={run}
      disabled={busy}
      className="text-xs text-muted-foreground hover:text-foreground tracking-tight transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {busy ? "Queuing…" : `Regenerate all (~${costLabel})`}
    </button>
  );
}
