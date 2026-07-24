"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { toast } from "sonner";
import { RotateCcw } from "lucide-react";
import { Card } from "@/components/ui/card";
import { ease, staggerDelay } from "@/lib/motion";

export type AnimatedSceneCardProps = {
  scene: {
    id: string;
    order: number;
    videoUrl: string;
    /** Used as the video poster so the first frame doesn't flash white. */
    posterUrl: string | null;
    durationSec: number | null;
  };
  /** Reels render at 9:16 (the deliverable aspect, so the operator judges
   *  motion at the right shape). Before-after inherits from the uploaded
   *  before image — could be any of the 5 enum values. */
  aspect: "9:16" | "16:9" | "1:1" | "4:3" | "3:4";
  projectId?: string;
  /** Owner-only (the animate route 403s non-owners): re-run seedance+Topaz
   *  on just this clip with a fresh seed + motion prompt. Cost label comes
   *  precomputed from the server (pricing lives server-side). */
  canReanimate?: boolean;
  reanimateCostLabel?: string;
};

const ASPECT_CLASS: Record<AnimatedSceneCardProps["aspect"], string> = {
  "9:16": "aspect-[9/16]",
  "16:9": "aspect-video",
  "1:1": "aspect-square",
  "4:3": "aspect-[4/3]",
  "3:4": "aspect-[3/4]",
};

export function AnimatedSceneCard({
  scene,
  aspect,
  projectId,
  canReanimate = false,
  reanimateCostLabel,
}: AnimatedSceneCardProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  async function reanimate() {
    if (busy || !projectId) return;
    if (
      !window.confirm(
        `Re-animate scene ${scene.order}${reanimateCostLabel ? ` (~${reanimateCostLabel})` : ""}? A fresh camera move replaces this clip.`
      )
    ) {
      return;
    }
    setBusy(true);
    const toastId = toast.loading(`Re-animating scene ${scene.order} — the new clip lands in a few minutes…`);
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
      toast.success("Queued — the current clip stays until the new one replaces it", {
        id: toastId,
      });
      startTransition(() => router.refresh());
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error("Couldn't re-animate", { id: toastId, description: message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease, delay: staggerDelay(scene.order - 1) }}
    >
      <Card className="overflow-hidden p-0 bg-black/90 border-none">
        <div className={`relative ${ASPECT_CLASS[aspect]} w-full`}>
          <video
            src={scene.videoUrl}
            poster={scene.posterUrl ?? undefined}
            className="absolute inset-0 w-full h-full object-cover"
            autoPlay
            loop
            muted
            playsInline
          />
          <div className="absolute inset-x-0 bottom-0 px-2.5 py-1.5 flex items-center justify-between text-[10px] tracking-tight text-white/90 bg-gradient-to-t from-black/70 via-black/30 to-transparent">
            <span className="tabular-nums">Scene {scene.order}</span>
            <span className="flex items-center gap-2">
              {scene.durationSec ? (
                <span className="tabular-nums opacity-70">{scene.durationSec}s</span>
              ) : null}
              {canReanimate && projectId && (
                <button
                  type="button"
                  onClick={() => void reanimate()}
                  disabled={busy}
                  title={`Re-animate this clip${reanimateCostLabel ? ` (~${reanimateCostLabel})` : ""} — fresh camera move`}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-white/15 transition-colors disabled:opacity-50"
                >
                  <RotateCcw className="size-3" />
                  {busy ? "Queuing…" : "Redo"}
                </button>
              )}
            </span>
          </div>
        </div>
      </Card>
    </motion.div>
  );
}
