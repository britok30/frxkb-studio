"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

/**
 * Subtle "Regenerate all" affordance for the Scenes section header. Confirms
 * before firing because re-generating every scene re-pays the full image
 * batch cost AND invalidates any existing animations on those scenes.
 *
 * Mirrors the enqueue-bridge logic in ProjectActions: button stays locked
 * after the click until the server reports the worker has acquired the lock
 * (status === "generating"), preventing a second click during the brief
 * Inngest pickup gap from double-firing the job.
 */
export function RegenerateAllLink({
  projectId,
  totalScenes,
  costLabel,
  hasAnyAnimated,
  jobInFlight,
}: {
  projectId: string;
  totalScenes: number;
  costLabel: string;
  hasAnyAnimated: boolean;
  /** True when the server has flipped project.status into generating/finalizing. */
  jobInFlight: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [justEnqueued, setJustEnqueued] = useState(false);
  const enqueueTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (jobInFlight && justEnqueued) {
      if (enqueueTimerRef.current) clearTimeout(enqueueTimerRef.current);
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      setJustEnqueued(false);
    }
  }, [jobInFlight, justEnqueued]);

  useEffect(() => {
    return () => {
      if (enqueueTimerRef.current) clearTimeout(enqueueTimerRef.current);
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, []);

  const disabled = busy || jobInFlight || justEnqueued;

  async function run() {
    if (disabled) return;
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
      toast.success("Started — scenes will refresh as they complete", {
        id: toastId,
      });
      // Bridge the gap until the worker acquires the project lock.
      setJustEnqueued(true);
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      pollTimerRef.current = setInterval(() => router.refresh(), 1500);
      if (enqueueTimerRef.current) clearTimeout(enqueueTimerRef.current);
      enqueueTimerRef.current = setTimeout(() => {
        if (pollTimerRef.current) clearInterval(pollTimerRef.current);
        setJustEnqueued(false);
      }, 30_000);
      router.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error("Couldn't start regenerate", { id: toastId, description: message });
    } finally {
      setBusy(false);
    }
  }

  const label = jobInFlight
    ? "Generating…"
    : busy
      ? "Queuing…"
      : justEnqueued
        ? "Starting…"
        : `Regenerate all (~${costLabel})`;

  return (
    <button
      type="button"
      onClick={run}
      disabled={disabled}
      className="text-xs text-muted-foreground hover:text-foreground tracking-tight transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {label}
    </button>
  );
}
