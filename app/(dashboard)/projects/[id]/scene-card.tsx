"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import { RotateCw, Check, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ease, staggerDelay } from "@/lib/motion";

type SceneStatus = "pending" | "generating" | "generated" | "approved" | "rejected";

const STATUS_VARIANT: Record<SceneStatus, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "outline",
  generating: "secondary",
  generated: "default",
  approved: "default",
  rejected: "destructive",
};

export type SceneCardProps = {
  projectId: string;
  scene: {
    id: string;
    order: number;
    prompt: string;
    status: SceneStatus;
    imageUrl: string | null;
    /** Set after Animate runs (reels). When present, render a looping video
     *  preview instead of the still image. */
    videoUrl: string | null;
    error: string | null;
  };
};

export function SceneCard({ projectId, scene }: SceneCardProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "regenerate" | "approve" | "reject">(null);
  const [, startTransition] = useTransition();

  async function run(action: "regenerate" | "approve" | "reject") {
    if (busy) return;
    setBusy(action);
    const verbing =
      action === "regenerate" ? "Regenerating" : action === "approve" ? "Approving" : "Rejecting";
    const toastId = toast.loading(`${verbing} scene ${scene.order}…`);
    try {
      const res = await fetch(`/api/projects/${projectId}/scenes/${scene.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      toast.success(`Scene ${scene.order} ${action === "regenerate" ? "regenerated" : action + "d"}`, { id: toastId });
      startTransition(() => router.refresh());
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error(`Scene ${scene.order} action failed`, { id: toastId, description: message });
    } finally {
      setBusy(null);
    }
  }

  const isApproved = scene.status === "approved";
  const isRejected = scene.status === "rejected";
  const isGenerating = scene.status === "generating" || busy === "regenerate";
  const hasImage = !!scene.imageUrl;
  const hasVideo = !!scene.videoUrl;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease, delay: staggerDelay(scene.order - 1) }}
    >
      <Card className="overflow-hidden group">
        <div className="relative aspect-video bg-muted/40 flex items-center justify-center text-xs text-muted-foreground">
          <AnimatePresence mode="wait">
            {hasVideo ? (
              <motion.div
                key={scene.videoUrl}
                className="w-full h-full"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.5, ease }}
              >
                <video
                  src={scene.videoUrl!}
                  className="w-full h-full object-cover"
                  autoPlay
                  loop
                  muted
                  playsInline
                  poster={scene.imageUrl ?? undefined}
                />
              </motion.div>
            ) : hasImage ? (
              <motion.div
                key={scene.imageUrl}
                className="w-full h-full"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.5, ease }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={scene.imageUrl!}
                  alt=""
                  className="w-full h-full object-cover"
                />
              </motion.div>
            ) : isGenerating ? (
              <motion.span
                key="generating"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                generating…
              </motion.span>
            ) : isRejected ? (
              <motion.span
                key="rejected"
                className="text-destructive line-clamp-2 px-2 text-center"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                {scene.error || "failed"}
              </motion.span>
            ) : (
              <motion.span
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                scene {scene.order}
              </motion.span>
            )}
          </AnimatePresence>

          {/* Hover-revealed action overlay */}
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-end gap-1 p-2 bg-gradient-to-t from-black/55 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
            <ActionButton
              label="Approve"
              icon={<Check className="size-3.5" />}
              active={isApproved}
              disabled={!hasImage || !!busy || isGenerating}
              onClick={() => run("approve")}
            />
            <ActionButton
              label="Regenerate"
              icon={<RotateCw className={`size-3.5 ${busy === "regenerate" ? "animate-spin" : ""}`} />}
              disabled={!!busy || isGenerating}
              onClick={() => run("regenerate")}
            />
            <ActionButton
              label="Reject"
              icon={<X className="size-3.5" />}
              active={isRejected}
              destructive
              disabled={!!busy || isGenerating}
              onClick={() => run("reject")}
            />
          </div>
        </div>
        <CardHeader className="py-3">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-sm">Scene {scene.order}</CardTitle>
            <Badge variant={STATUS_VARIANT[scene.status]} className="text-[10px]">
              {scene.status}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground line-clamp-4 leading-relaxed pt-0">
          {scene.prompt}
        </CardContent>
      </Card>
    </motion.div>
  );
}

function ActionButton({
  label,
  icon,
  active,
  destructive,
  disabled,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  active?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <motion.button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      whileTap={disabled ? undefined : { scale: 0.94 }}
      transition={{ duration: 0.12 }}
      className={`size-7 rounded-md inline-flex items-center justify-center transition-colors ${
        active
          ? destructive
            ? "bg-destructive text-destructive-foreground"
            : "bg-foreground text-background"
          : "bg-background/85 hover:bg-background text-foreground"
      } ${disabled ? "opacity-40 cursor-not-allowed" : ""}`}
    >
      {icon}
    </motion.button>
  );
}
