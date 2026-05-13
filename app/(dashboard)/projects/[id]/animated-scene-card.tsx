"use client";

import { motion } from "motion/react";
import { Card } from "@/components/ui/card";
import { ease, staggerDelay } from "@/lib/motion";

export type AnimatedSceneCardProps = {
  scene: {
    id: string;
    order: number;
    videoUrl: string;
    /** Used as the video poster so the first frame doesn't flash white. */
    posterUrl: string | null;
    durationSec: number | null;
  };
  /** Reels render at 9:16 (the deliverable aspect, so the operator judges
   *  motion at the right shape). Before-after inherits from the uploaded
   *  before image — could be any of the 5 enum values. */
  aspect: "9:16" | "16:9" | "1:1" | "4:3" | "3:4";
};

const ASPECT_CLASS: Record<AnimatedSceneCardProps["aspect"], string> = {
  "9:16": "aspect-[9/16]",
  "16:9": "aspect-video",
  "1:1": "aspect-square",
  "4:3": "aspect-[4/3]",
  "3:4": "aspect-[3/4]",
};

export function AnimatedSceneCard({ scene, aspect }: AnimatedSceneCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease, delay: staggerDelay(scene.order - 1) }}
    >
      <Card className="overflow-hidden p-0 bg-black/90 border-none">
        <div className={`relative ${ASPECT_CLASS[aspect]} w-full`}>
          <video
            src={scene.videoUrl}
            poster={scene.posterUrl ?? undefined}
            className="absolute inset-0 w-full h-full object-cover"
            autoPlay
            loop
            muted
            playsInline
          />
          <div className="absolute inset-x-0 bottom-0 px-2.5 py-1.5 flex items-center justify-between text-[10px] tracking-tight text-white/90 bg-gradient-to-t from-black/70 via-black/30 to-transparent">
            <span className="tabular-nums">Scene {scene.order}</span>
            {scene.durationSec ? (
              <span className="tabular-nums opacity-70">{scene.durationSec}s</span>
            ) : null}
          </div>
        </div>
      </Card>
    </motion.div>
  );
}
