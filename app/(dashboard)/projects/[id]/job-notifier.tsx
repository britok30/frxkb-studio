"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";

/**
 * Fires a browser notification (plus a toast) when a long-running job on this
 * project finishes — i.e. when `busy` transitions true → false. Lets the
 * operator kick off a generate/animate batch and switch tabs instead of
 * babysitting the polling page.
 *
 * Permission is requested lazily the first time a job is observed running,
 * so the prompt appears in a context where the value is obvious.
 */
export function JobNotifier({ busy, projectTitle }: { busy: boolean; projectTitle: string }) {
  const wasBusy = useRef(busy);

  useEffect(() => {
    if (busy && !wasBusy.current) {
      // Job just started — ask for permission now (no-op if already decided).
      if (typeof Notification !== "undefined" && Notification.permission === "default") {
        void Notification.requestPermission();
      }
    }
    if (!busy && wasBusy.current) {
      toast.success(`${projectTitle}: job finished`);
      if (
        typeof Notification !== "undefined" &&
        Notification.permission === "granted" &&
        document.visibilityState !== "visible"
      ) {
        new Notification("frxkb studio", {
          body: `${projectTitle} — job finished. Ready to review.`,
        });
      }
    }
    wasBusy.current = busy;
  }, [busy, projectTitle]);

  return null;
}
