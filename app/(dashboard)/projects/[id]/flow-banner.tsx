"use client";

import { Fragment } from "react";
import { motion } from "motion/react";
import { ease } from "@/lib/motion";

type FlowState = {
  totalScenes: number;
  generated: number;
  approved: number;
  rejected: number;
  pending: number;
  generating: number;
  hasExport: boolean;
  /** Reel-only: how many scenes have a videoUrl. */
  animated: number;
  format: string;
};

type Step = "concept" | "images" | "animate" | "review" | "export";

function stepsFor(format: string): { key: Step; label: string }[] {
  const base: { key: Step; label: string }[] = [
    { key: "concept", label: "Concept" },
    { key: "images", label: "Images" },
  ];
  if (format === "reel") base.push({ key: "animate", label: "Animate" });
  base.push({ key: "review", label: "Review" }, { key: "export", label: "Export" });
  return base;
}

/** Returns the step the operator should focus on right now. */
function activeStep(s: FlowState): Step {
  if (s.totalScenes === 0) return "concept";
  if (s.hasExport) return "export";
  if (s.pending > 0 || s.generating > 0 || s.rejected > 0) return "images";
  // For reels, animation gates the review step.
  if (s.format === "reel" && s.animated < s.totalScenes) return "animate";
  return "review";
}

function nextActionHint(s: FlowState): string {
  const remaining = s.pending + s.rejected;
  if (s.generating > 0) {
    return `${s.generating} scene${s.generating === 1 ? "" : "s"} generating right now…`;
  }
  if (remaining > 0) {
    return `Generate ${remaining} more scene${remaining === 1 ? "" : "s"} to keep going.`;
  }
  if (s.hasExport) {
    return "Bundle is ready — scroll down to download.";
  }
  if (s.format === "reel" && s.animated < s.totalScenes) {
    const left = s.totalScenes - s.animated;
    return `Stills are in. Animate ${left} ${left === 1 ? "scene" : "scenes"} via Seedance + Topaz.`;
  }
  return "All scenes are in. Finalize to generate the thumbnail and metadata.";
}

export function FlowBanner({ state }: { state: FlowState }) {
  const steps = stepsFor(state.format);
  const active = activeStep(state);
  const activeIndex = steps.findIndex((s) => s.key === active);
  const hint = nextActionHint(state);

  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease }}
      className="rounded-xl border bg-muted/20 px-5 py-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <ol className="flex items-center gap-2 text-xs tracking-tight">
        {steps.map((s, i) => {
          const isActive = i === activeIndex;
          const isDone = i < activeIndex || (i === activeIndex && active === "export");
          return (
            <Fragment key={s.key}>
              <li className="flex items-center gap-2">
                <span
                  className={`size-5 rounded-full border flex items-center justify-center text-[9px] font-medium tabular-nums transition-colors ${
                    isActive
                      ? "bg-foreground text-background border-foreground"
                      : isDone
                        ? "bg-foreground/10 text-foreground border-foreground/20"
                        : "border-border text-muted-foreground"
                  }`}
                >
                  {isDone && !isActive ? "✓" : i + 1}
                </span>
                <span
                  className={`uppercase tracking-[0.18em] text-[10px] ${
                    isActive
                      ? "text-foreground"
                      : isDone
                        ? "text-foreground/60"
                        : "text-muted-foreground"
                  }`}
                >
                  {s.label}
                </span>
              </li>
              {i < steps.length - 1 && (
                <li aria-hidden className="h-px w-6 bg-border flex-shrink-0" />
              )}
            </Fragment>
          );
        })}
      </ol>
      <p className="text-xs text-muted-foreground sm:text-right tracking-tight">{hint}</p>
    </motion.div>
  );
}
