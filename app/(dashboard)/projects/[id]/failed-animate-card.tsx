"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { toast } from "sonner";
import { RotateCcw, TriangleAlert } from "lucide-react";
import { Card } from "@/components/ui/card";
import { ease, staggerDelay } from "@/lib/motion";

/**
 * A scene whose animate pipeline failed (still is fine, video never landed).
 * Previously these vanished from the Animated grid entirely — the operator's
 * only clue was finalize/stitch refusing later. Shows the still dimmed, the
 * actual error, and a one-click retry (owner-only).
 */
export function FailedAnimateCard({
  projectId,
  scene,
  aspect,
  canRetry,
  index,
}: {
  projectId: string;
  scene: { id: string; order: number; posterUrl: string | null; error: string };
  aspect: "9:16" | "16:9" | "1:1" | "4:3" | "3:4";
  canRetry: boolean;
  index: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  const ASPECT_CLASS: Record<typeof aspect, string> = {
    "9:16": "aspect-[9/16]",
    "16:9": "aspect-video",
    "1:1": "aspect-square",
    "4:3": "aspect-[4/3]",
    "3:4": "aspect-[3/4]",
  };

  async function retry() {
    if (busy) return;
    setBusy(true);
    const toastId = toast.loading(`Retrying scene ${scene.order} animation…`);
    try {
      const res = await fetch(`/api/projects/${projectId}/animate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sceneId: scene.id }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      toast.success("Queued — the clip lands here in a few minutes", { id: toastId });
      startTransition(() => router.refresh());
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error("Couldn't retry", { id: toastId, description: message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease, delay: staggerDelay(index) }}
    >
      <Card className="overflow-hidden p-0 border-destructive/40">
        <div className={`relative ${ASPECT_CLASS[aspect]} w-full bg-muted/30`}>
          {scene.posterUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={scene.posterUrl}
              alt=""
              className="absolute inset-0 w-full h-full object-cover opacity-40"
            />
          )}
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-3 text-center">
            <TriangleAlert className="size-4 text-destructive" />
            <span className="text-[11px] font-medium tracking-tight">
              Scene {scene.order} didn&apos;t animate
            </span>
            <span className="text-[10px] text-muted-foreground leading-snug line-clamp-4">
              {scene.error}
            </span>
            {canRetry && (
              <button
                type="button"
                onClick={() => void retry()}
                disabled={busy}
                className="mt-1 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] tracking-tight hover:border-foreground/40 transition-colors disabled:opacity-50"
              >
                <RotateCcw className="size-3" />
                {busy ? "Queuing…" : "Retry animate"}
              </button>
            )}
          </div>
        </div>
      </Card>
    </motion.div>
  );
}
