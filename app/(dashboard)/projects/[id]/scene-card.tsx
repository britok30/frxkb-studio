"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import { RotateCw, Check, X, History } from "lucide-react";
import { Dialog } from "@base-ui/react/dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { ease, staggerDelay } from "@/lib/motion";
import { looksForWorld } from "@/lib/prompts/looks";
import { CAMERA_MOVES } from "@/lib/prompts/camera-moves";

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
    /** Operator-locked camera move (CAMERA_MOVES id) for the animate pass. */
    motionPreset?: string | null;
  };
  /** Project format — reels get the camera-move picker. */
  format?: string;
  /** True once Animate has been kicked off on the project — clicking Animate
   *  is an implicit approval of all stills, so Approve/Reject hide from that
   *  point on. Regenerate stays available: a targeted fix invalidates just
   *  that scene's video, and re-running Animate only re-renders scenes
   *  without a videoUrl. */
  hideActions?: boolean;
  /** The project's visual lane. Filters which look chips the regen dialog
   *  offers; when omitted the look row is hidden entirely. */
  worldType?: "interior" | "exterior";
  /** Keyboard-review focus ring (driven by SceneGrid's J/K navigation). */
  focused?: boolean;
};

/** Shared PATCH helper for scene actions — used by the card buttons and by
 *  SceneGrid's keyboard shortcuts so both paths behave identically. */
export async function sceneActionRequest(
  projectId: string,
  sceneId: string,
  action: "regenerate" | "approve" | "reject",
  options: { designDirection?: string; lookId?: string } = {}
): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/scenes/${sceneId}`, {
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
}

export function SceneCard({
  projectId,
  scene,
  format,
  hideActions = false,
  worldType,
  focused = false,
}: SceneCardProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "regenerate" | "approve" | "reject">(null);
  const [regenDialogOpen, setRegenDialogOpen] = useState(false);
  const [regenDirection, setRegenDirection] = useState("");
  const [regenLookId, setRegenLookId] = useState<string | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
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
      await sceneActionRequest(projectId, scene.id, action, options);
      toast.success(`Scene ${scene.order} ${action === "regenerate" ? "regenerated" : action + "d"}`, { id: toastId });
      startTransition(() => router.refresh());
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error(`Scene ${scene.order} action failed`, { id: toastId, description: message });
    } finally {
      setBusy(null);
    }
  }

  /** Lock (or clear) the camera move for this scene's animate pass. */
  async function setMotion(motionPreset: string | null) {
    try {
      const res = await fetch(`/api/projects/${projectId}/scenes/${scene.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set-motion", motionPreset }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      startTransition(() => router.refresh());
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error("Couldn't set camera move", { description: message });
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
      <Card
        data-scene-card={scene.id}
        className={`overflow-hidden group pt-0 transition-shadow ${
          focused ? "ring-2 ring-foreground ring-offset-2 ring-offset-background" : ""
        }`}
      >
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
                {/* Click to open the full-size lightbox — thumbnails are for
                    triage, judging materials/light needs the real pixels. */}
                <button
                  type="button"
                  onClick={() => setLightboxOpen(true)}
                  className="w-full h-full cursor-zoom-in"
                  aria-label={`Open scene ${scene.order} full size`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={scene.imageUrl!}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                </button>
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

          {/* Hover-revealed action overlay. Once Animate has been kicked off,
              Approve/Reject hide (implicit approval) but Regenerate stays —
              a targeted fix nulls that scene's video and re-running Animate
              only re-renders scenes missing a videoUrl. */}
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-end gap-1 p-2 bg-gradient-to-t from-black/55 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
            {!hideActions && (
              <ActionButton
                label="Approve"
                icon={<Check className="size-3.5" />}
                active={isApproved}
                disabled={!hasImage || !!busy || isGenerating}
                onClick={() => run("approve")}
              />
            )}
            <ActionButton
              label="Regenerate"
              icon={<RotateCw className={`size-3.5 ${busy === "regenerate" ? "animate-spin" : ""}`} />}
              disabled={!!busy || isGenerating}
              onClick={() => setRegenDialogOpen(true)}
            />
            {hasImage && (
              <ActionButton
                label="History"
                icon={<History className="size-3.5" />}
                disabled={!!busy || isGenerating}
                onClick={() => setLightboxOpen(true)}
              />
            )}
            {!hideActions && (
              <ActionButton
                label="Reject"
                icon={<X className="size-3.5" />}
                active={isRejected}
                destructive
                disabled={!!busy || isGenerating}
                onClick={() => run("reject")}
              />
            )}
          </div>
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
          {/* Camera-move lock (reels, pre-animate): the Higgsfield pattern —
              pick the move by name instead of trusting GPT's roulette. */}
          {format === "reel" && !hideActions && (
            <label className="flex items-center gap-2 pt-1 text-[11px] text-muted-foreground tracking-tight">
              Camera
              <select
                value={scene.motionPreset ?? ""}
                disabled={!!busy || isGenerating}
                onChange={(e) => void setMotion(e.target.value || null)}
                className="h-7 flex-1 rounded-md border bg-transparent px-1.5 text-[11px] text-foreground focus:border-foreground outline-none disabled:opacity-50"
              >
                <option value="">Auto (GPT picks)</option>
                {CAMERA_MOVES.map((m) => (
                  <option key={m.id} value={m.id} title={m.hint}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
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

      {/* Lightbox: full-size view + variant history. Regens never destroy a
          take — earlier renders live here and can be restored with one click. */}
      <Dialog.Root open={lightboxOpen} onOpenChange={setLightboxOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 transition-opacity duration-200" />
          <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-[min(94vw,1100px)] max-h-[92vh] overflow-y-auto rounded-xl border bg-background p-4 shadow-2xl outline-none data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 transition-opacity duration-200">
            <div className="flex items-center justify-between gap-3 pb-3">
              <Dialog.Title className="text-sm font-semibold tracking-tight">
                {scene.styleName ?? `Scene ${scene.order}`} — full size
              </Dialog.Title>
              <Dialog.Close className="text-muted-foreground hover:text-foreground transition-colors" aria-label="Close">
                <X className="size-4" />
              </Dialog.Close>
            </div>
            {scene.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={scene.imageUrl}
                alt=""
                className="w-full max-h-[64vh] object-contain rounded-md bg-muted/30"
              />
            )}
            {lightboxOpen && (
              <VersionStrip
                projectId={projectId}
                sceneId={scene.id}
                sceneOrder={scene.order}
                activeImageUrl={scene.imageUrl}
                onRestored={() => {
                  startTransition(() => router.refresh());
                }}
              />
            )}
            <p className="pt-3 text-xs text-muted-foreground leading-relaxed">{scene.prompt}</p>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </motion.div>
  );
}

type SceneVersionRow = {
  id: string;
  imageUrl: string;
  createdAt: string;
};

/** Lazy-loaded variant history inside the lightbox. Fetches when mounted
 *  (i.e. when the lightbox opens); "Use this take" swaps the version in as
 *  the active image — the outgoing render goes back into the history. */
function VersionStrip({
  projectId,
  sceneId,
  sceneOrder,
  activeImageUrl,
  onRestored,
}: {
  projectId: string;
  sceneId: string;
  sceneOrder: number;
  activeImageUrl: string | null;
  onRestored: () => void;
}) {
  const [versions, setVersions] = useState<SceneVersionRow[] | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/scenes/${sceneId}/versions`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { versions: SceneVersionRow[] };
        if (!cancelled) setVersions(data.versions);
      } catch {
        if (!cancelled) setVersions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, sceneId]);

  async function restore(versionId: string) {
    if (restoring) return;
    setRestoring(versionId);
    const toastId = toast.loading(`Restoring earlier take of scene ${sceneOrder}…`);
    try {
      const res = await fetch(`/api/projects/${projectId}/scenes/${sceneId}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ versionId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      toast.success(`Scene ${sceneOrder} restored`, { id: toastId });
      setVersions(null); // refetch below via onRestored's refresh; clear stale strip
      onRestored();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error("Restore failed", { id: toastId, description: message });
    } finally {
      setRestoring(null);
    }
  }

  if (versions === null) {
    return (
      <div className="pt-3 text-[11px] text-muted-foreground tracking-tight">Loading takes…</div>
    );
  }
  if (versions.length === 0) {
    return (
      <div className="pt-3 text-[11px] text-muted-foreground tracking-tight">
        No earlier takes yet — every regenerate archives the outgoing render here.
      </div>
    );
  }
  return (
    <div className="pt-3 flex flex-col gap-2">
      <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        Earlier takes ({versions.length})
      </span>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {activeImageUrl && (
          <div className="relative shrink-0 w-36">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={activeImageUrl}
              alt=""
              className="aspect-video w-full object-cover rounded-md ring-2 ring-foreground"
            />
            <span className="absolute bottom-1 left-1 rounded bg-background/85 px-1.5 py-0.5 text-[9px] tracking-tight">
              current
            </span>
          </div>
        )}
        {versions.map((v) => (
          <button
            key={v.id}
            type="button"
            disabled={!!restoring}
            onClick={() => void restore(v.id)}
            className="group/take relative shrink-0 w-36 rounded-md overflow-hidden border hover:border-foreground/50 transition-colors disabled:opacity-50"
            title="Use this take"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={v.imageUrl} alt="" className="aspect-video w-full object-cover" />
            <span className="absolute inset-0 hidden group-hover/take:flex items-center justify-center bg-black/45 text-[10px] font-medium text-white tracking-tight">
              {restoring === v.id ? "Restoring…" : "Use this take"}
            </span>
          </button>
        ))}
      </div>
    </div>
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
