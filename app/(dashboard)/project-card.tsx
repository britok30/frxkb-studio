"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ease, staggerDelay } from "@/lib/motion";

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  scripting: "Scripted",
  generating: "Generating",
  ready: "Ready",
  finalizing: "Finalizing",
  exported: "Exported",
};

const FORMAT_LABEL: Record<string, string> = {
  "yt-long": "YouTube long-form",
  reel: "Reel / Short",
  carousel: "Carousel",
};

export function ProjectCard({
  project,
  index,
}: {
  project: {
    id: string;
    title: string;
    niche: string;
    format: string;
    status: string;
    targetDurationSec: number | null;
  };
  index: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease, delay: staggerDelay(index) }}
    >
      <Link href={`/projects/${project.id}`}>
        <Card className="h-full hover:border-foreground/30 transition-colors">
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-base line-clamp-2">{project.title}</CardTitle>
              <Badge variant="secondary" className="text-[10px]">
                {STATUS_LABEL[project.status] ?? project.status}
              </Badge>
            </div>
            <CardDescription className="line-clamp-1">{project.niche}</CardDescription>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground flex items-center gap-3">
            <span>{FORMAT_LABEL[project.format] ?? project.format}</span>
            {project.targetDurationSec ? (
              <span>· {Math.round(project.targetDurationSec / 60) || 1}m target</span>
            ) : null}
          </CardContent>
        </Card>
      </Link>
    </motion.div>
  );
}
