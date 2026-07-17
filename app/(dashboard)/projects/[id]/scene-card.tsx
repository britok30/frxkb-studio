"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import { RotateCw, Check, X } from "lucide-react";
import { Dialog } from "@base-ui/react/dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { ease, staggerDelay } from "@/lib/motion";
import { looksForWorld } from "@/lib/prompts/looks";

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
    error: string | null;
    /** Style-explorer card copy. When present, the card titles with the style
     *  name + subtitle instead of "Scene N" — this is the text the operator
     *  recreates in CapCut. */
    styleName?: string | null;
    styleSubtitle?: string | null;
  };
  /** True once Animate has been kicked off on the project — clicking Animate
   *  is an implicit approval of all stills, so the per-scene action overlay
   *  (Approve/Regenerate/Reject) is hidden from that point on. */
  hideActions?: boolean;
  /** The project's visual lane. Filters which look chips the regen dialog
   *  offers; when omitted the look row is hidden entirely. */
  worldType?: "interior" | "exterior";
};

export function SceneCard({ projectId, scene, hideActions = false, worldType }: SceneCardProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "regenerate" | "approve" | "reject">(null);
  const [regenDialogOpen, setRegenDialogOpen] = useState(false);
  const [regenDirection, setRegenDirection] = useState("");
  const [regenLookId, setRegenLookId] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const looks = worldType ? looksForWorld(worldType) : [];

  async function run(
    action: "regenerate" | "approve" | "reject",
    options: { designDirection?: string; lookId?: string } = {},
  ) {
    if (busy) return;
    setBusy(action);
    const verbing =
      action === "regenerate" ? "Regenerating" : action === "approve" ? "Approving" : "Rejecting";
    const toastId = toast.loading(`${verbing} scene ${scene.order}…`);
    try {
      const res = await fetch(`/api/projects/${projectId}/scenes/${scene.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          ...(options.designDirection ? { designDirection: options.designDirection } : {}),
          ...(options.lookId ? { lookId: options.lookId } : {}),
        }),
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

  /** Submit the regenerate request with the current direction text (which
   *  may be empty — empty direction = blind reroll, same as the pre-dialog
   *  behavior). Closes the dialog and clears the field afterward. */
  async function submitRegen() {
    const direction = regenDirection.trim();
    const lookId = regenLookId;
    setRegenDialogOpen(false);
    setRegenDirection("");
    setRegenLookId(null);
    await run("regenerate", {
      ...(direction ? { designDirection: direction } : {}),
      ...(lookId ? { lookId } : {}),
    });
  }

  const isApproved = scene.status === "approved";
  const isRejected = scene.status === "rejected";
  const isGenerating = scene.status === "generating" || busy === "regenerate";
  const hasImage = !!scene.imageUrl;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease, delay: staggerDelay(scene.order - 1) }}
    >
      <Card className="overflow-hidden group pt-0">
        <div className="relative aspect-video bg-muted/40 flex items-center justify-center text-xs text-muted-foreground">
          <AnimatePresence mode="wait">
            {hasImage ? (
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

          {/* Hover-revealed action overlay. Hidden once Animate has been
              kicked off — that's an implicit approval, no need to keep
              showing review controls on stills the operator already moved on
              from. */}
          {!hideActions && (
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
                onClick={() => setRegenDialogOpen(true)}
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
          )}
        </div>
        <CardHeader className="py-3">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-sm">
              {scene.styleName ?? `Scene ${scene.order}`}
            </CardTitle>
            <Badge variant={STATUS_VARIANT[scene.status]} className="text-[10px]">
              {scene.status}
            </Badge>
          </div>
          {scene.styleSubtitle && (
            <p className="text-xs text-muted-foreground tracking-tight">{scene.styleSubtitle}</p>
          )}
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground line-clamp-4 leading-relaxed pt-0">
          {scene.prompt}
        </CardContent>
      </Card>

      <Dialog.Root open={regenDialogOpen} onOpenChange={setRegenDialogOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 transition-opacity duration-200" />
          <Dialog.Popup
            className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-[min(92vw,520px)] rounded-xl border bg-background p-6 shadow-2xl outline-none data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[ending-style]:scale-95 transition-[opacity,transform] duration-200 ease-out"
          >
            <Dialog.Title className="text-base font-semibold tracking-tight">
              Regenerate scene {scene.order}
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-xs text-muted-foreground leading-relaxed">
              The original world stays locked. Your direction layers on top — same materials, same lineage, the nudge only adjusts what you name. Leave blank to just re-roll with a fresh seed.
            </Dialog.Description>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submitRegen();
              }}
              className="mt-5 flex flex-col gap-3"
            >
              <Textarea
                value={regenDirection}
                onChange={(e) => setRegenDirection(e.target.value)}
                rows={3}
                maxLength={500}
                autoFocus
                placeholder="e.g. tighter on the kitchen counter, more plants, shift to morning light"
                className="text-sm resize-none"
              />
              {looks.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                    Look override (this regen only)
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {looks.map((l) => (
                      <button
                        key={l.id}
                        type="button"
                        onClick={() =>
                          setRegenLookId((cur) => (cur === l.id ? null : l.id))
                        }
                        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] tracking-tight transition-colors ${
                          regenLookId === l.id
                            ? "border-foreground bg-foreground/[0.06]"
                            : "text-muted-foreground hover:text-foreground hover:border-foreground/30"
                        }`}
                      >
                        <span
                          aria-hidden
                          className="size-2.5 rounded-full"
                          style={{ background: l.swatch }}
                        />
                        {l.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {regenDirection.length}/500
                </span>
                <div className="flex items-center gap-2">
                  <Dialog.Close
                    className="h-9 rounded-md px-3 text-sm tracking-tight text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Cancel
                  </Dialog.Close>
                  <button
                    type="submit"
                    className="h-9 rounded-md bg-foreground px-4 text-sm text-background font-medium tracking-tight hover:opacity-90 transition-opacity inline-flex items-center gap-1.5"
                  >
                    <RotateCw className="size-3.5" />
                    Regenerate
                  </button>
                </div>
              </div>
            </form>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
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
