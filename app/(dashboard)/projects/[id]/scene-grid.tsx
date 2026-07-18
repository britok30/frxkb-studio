"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { SceneCard, sceneActionRequest, type SceneCardProps } from "./scene-card";

type SceneRow = SceneCardProps["scene"];

/**
 * Client wrapper around the stills grid that adds keyboard review:
 *   J / → : focus next scene      K / ← : focus previous scene
 *   A     : approve focused        X    : reject focused
 *   R     : regenerate focused (blind reroll)
 *   Esc   : clear focus
 * Shortcuts stay inert while the operator is typing or a dialog is open.
 */
export function SceneGrid({
  projectId,
  scenes,
  format,
  hideActions,
  worldType,
}: {
  projectId: string;
  scenes: SceneRow[];
  format?: string;
  hideActions: boolean;
  worldType?: "interior" | "exterior";
}) {
  const router = useRouter();
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const [, startTransition] = useTransition();
  const busyRef = useRef(false);

  const runFocused = useCallback(
    async (action: "approve" | "reject" | "regenerate") => {
      if (focusedIndex === null || busyRef.current) return;
      const scene = scenes[focusedIndex];
      if (!scene) return;
      if (hideActions && action !== "regenerate") return;
      busyRef.current = true;
      const verbing =
        action === "regenerate" ? "Regenerating" : action === "approve" ? "Approving" : "Rejecting";
      const toastId = toast.loading(`${verbing} scene ${scene.order}…`);
      try {
        await sceneActionRequest(projectId, scene.id, action);
        toast.success(
          `Scene ${scene.order} ${action === "regenerate" ? "regenerated" : action + "d"}`,
          { id: toastId }
        );
        startTransition(() => router.refresh());
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        toast.error(`Scene ${scene.order} action failed`, { id: toastId, description: message });
      } finally {
        busyRef.current = false;
      }
    },
    [focusedIndex, scenes, projectId, hideActions, router]
  );

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Never steal keys from form fields or open dialogs.
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.closest("input, textarea, select, [contenteditable=true]") ||
          target.closest("[role=dialog]"))
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const key = e.key.toLowerCase();
      if (key === "j" || key === "arrowright") {
        e.preventDefault();
        setFocusedIndex((i) => Math.min((i ?? -1) + 1, scenes.length - 1));
      } else if (key === "k" || key === "arrowleft") {
        e.preventDefault();
        setFocusedIndex((i) => Math.max((i ?? 1) - 1, 0));
      } else if (key === "escape") {
        setFocusedIndex(null);
      } else if (key === "a") {
        e.preventDefault();
        void runFocused("approve");
      } else if (key === "x") {
        e.preventDefault();
        void runFocused("reject");
      } else if (key === "r") {
        e.preventDefault();
        void runFocused("regenerate");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [scenes.length, runFocused]);

  // Keep the focused card in view while J/K-ing through a long grid.
  useEffect(() => {
    if (focusedIndex === null) return;
    const scene = scenes[focusedIndex];
    if (!scene) return;
    document
      .querySelector(`[data-scene-card="${scene.id}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focusedIndex, scenes]);

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {scenes.map((s, i) => (
        <SceneCard
          key={s.id}
          projectId={projectId}
          scene={s}
          format={format}
          hideActions={hideActions}
          worldType={worldType}
          focused={focusedIndex === i}
        />
      ))}
    </div>
  );
}
