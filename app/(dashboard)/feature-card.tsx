"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { ease, staggerDelay } from "@/lib/motion";

export type FeatureCardProps = {
  href: string;
  kicker: string;
  title: string;
  hint: string;
  /** Pre-formatted cost string (e.g. "~$2.55") shown bottom-right. */
  cost: string;
  /** Tailwind aspect class for the visual proof rectangle on the left. */
  aspectClass: string;
  /** "ghost" variant for non-format actions like Scratch — different border treatment. */
  variant?: "default" | "ghost";
  index?: number;
};

export function FeatureCard({
  href,
  kicker,
  title,
  hint,
  cost,
  aspectClass,
  variant = "default",
  index = 0,
}: FeatureCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease, delay: staggerDelay(index) }}
    >
      <Link
        href={href}
        className={`group relative flex flex-col gap-5 rounded-xl border p-5 h-full transition-colors ${
          variant === "ghost"
            ? "border-dashed hover:border-foreground/40"
            : "hover:border-foreground/30"
        }`}
      >
        {/* Visual proof — proportional rectangle matching the format's aspect. */}
        <div className="h-20 flex items-center justify-start">
          <div
            className={`${aspectClass} max-h-full max-w-full rounded-md border-2 border-foreground/25 group-hover:border-foreground/50 transition-colors`}
            style={{ height: "100%" }}
          />
        </div>

        <div className="flex flex-col gap-1.5 flex-1">
          <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            {kicker}
          </span>
          <span className="text-base font-semibold tracking-tight">{title}</span>
          <span className="text-xs text-muted-foreground leading-relaxed">{hint}</span>
        </div>

        <div className="flex items-center justify-between border-t pt-3 text-xs">
          <span className="text-muted-foreground tracking-tight">{cost} all-in</span>
          <span
            aria-hidden
            className="text-muted-foreground group-hover:text-foreground group-hover:translate-x-0.5 transition-all"
          >
            →
          </span>
        </div>
      </Link>
    </motion.div>
  );
}
