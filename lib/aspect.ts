import type { AspectRatio } from "@/lib/prompts/types";

const RATIOS: ReadonlyArray<{ aspect: AspectRatio; value: number }> = [
  { aspect: "16:9", value: 16 / 9 },
  { aspect: "9:16", value: 9 / 16 },
  { aspect: "1:1", value: 1 },
  { aspect: "4:3", value: 4 / 3 },
  { aspect: "3:4", value: 3 / 4 },
];

/**
 * Snap a raw width × height to the closest AspectRatio enum member. We use
 * this on uploaded "before" images for before-after projects: the user might
 * upload a 1920×1080 (1.778) or 1080×1349 (0.800) and we map to 16:9 or 3:4
 * respectively. Distance is measured by absolute ratio diff so 1080×1080
 * (1.0) snaps to 1:1 cleanly.
 */
export function detectAspectRatio(width: number, height: number): AspectRatio {
  if (width <= 0 || height <= 0) {
    throw new Error(`Invalid dimensions: ${width}×${height}`);
  }
  const ratio = width / height;
  let best = RATIOS[0];
  let bestDiff = Math.abs(ratio - best.value);
  for (let i = 1; i < RATIOS.length; i++) {
    const diff = Math.abs(ratio - RATIOS[i].value);
    if (diff < bestDiff) {
      best = RATIOS[i];
      bestDiff = diff;
    }
  }
  return best.aspect;
}
