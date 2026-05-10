/**
 * Shared motion presets for the studio. Bias: slow, decelerating, calm —
 * the same energy as the ambient slideshow content the studio produces.
 * Don't reach for snappy springs here.
 */
import type { Transition, Variants } from "motion/react";

export const ease = [0.22, 1, 0.36, 1] as const; // out-quint

export const baseTransition: Transition = {
  duration: 0.35,
  ease,
};

export const fadeUp: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
};

export const fadeIn: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
};

/** Compute a small entry delay from a 0-based index, capped so long lists
 *  finish animating in under ~1s. */
export function staggerDelay(index: number, step = 0.025, cap = 0.7): number {
  return Math.min(index * step, cap);
}
