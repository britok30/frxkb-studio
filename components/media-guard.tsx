"use client";

import { useEffect } from "react";

/**
 * Site-wide deterrent against casually lifting media: blocks the right-click
 * context menu and drag-to-desktop on every <img> and <video>. Mounted once
 * in the root layout so it covers the dashboard, project pages, exports,
 * thumbnails — everything.
 *
 * Deterrent, not DRM: the files live on public Blob URLs and devtools always
 * works. The point is stopping the reflexive right-click → Save Image As.
 */
export function MediaGuard() {
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest?.("img, video")) {
        e.preventDefault();
      }
    };
    const onDragStart = (e: DragEvent) => {
      if ((e.target as Element | null)?.closest?.("img")) {
        e.preventDefault();
      }
    };
    document.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("dragstart", onDragStart);
    return () => {
      document.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("dragstart", onDragStart);
    };
  }, []);

  return null;
}
