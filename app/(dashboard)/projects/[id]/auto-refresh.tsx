"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Polls the current route while a background job is in flight. Mounts as a
 * null island; toggling `active` start/stops the interval. Uses
 * router.refresh() to re-render the parent server component, which re-reads
 * scenes/project from Drizzle so per-scene flips (generating → generated,
 * videoUrl appearing) surface without a hard reload.
 *
 * 5s cadence balances UI responsiveness with DB load — generate flips happen
 * roughly every 6–10s per scene, animate every 30–40s per scene.
 */
export function AutoRefresh({
  active,
  intervalMs = 5000,
}: {
  active: boolean;
  intervalMs?: number;
}) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs, router]);
  return null;
}
