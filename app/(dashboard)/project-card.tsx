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
  reel: "Reel / Short",
  carousel: "Carousel",
  "before-after": "Before / after",
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
    worldType: string;
    status: string;
    targetDurationSec: number | null;
    /** Resolved hero image: post-finalize thumbnailUrl, else the after image
     *  (for before-after) or the anchor still. Null when no scene has
     *  rendered yet — we fall back to a placeholder. */
    coverUrl: string | null;
  };
  index: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease, delay: staggerDelay(index) }}
      className="h-full"
    >
      <Link href={`/projects/${project.id}`} className="h-full block">
        <Card className="h-full hover:border-foreground/30 transition-colors overflow-hidden p-0 flex flex-col gap-0">
          {/* Hero cover — uniform aspect-video across all cards keeps the
              dashboard grid visually rhythmic regardless of source aspect. */}
          <div className="relative aspect-video bg-muted/40 overflow-hidden">
            {project.coverUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={project.coverUrl}
                alt=""
                className="absolute inset-0 w-full h-full object-cover"
              />
            ) : (
              <ProjectCoverPlaceholder />
            )}
          </div>

          <CardHeader className="pt-4">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-base line-clamp-2">{project.title}</CardTitle>
              <Badge variant="secondary" className="text-[10px] shrink-0">
                {STATUS_LABEL[project.status] ?? project.status}
              </Badge>
            </div>
            <CardDescription className="line-clamp-1">{project.niche}</CardDescription>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground flex items-center gap-3 pb-4">
            <span>{FORMAT_LABEL[project.format] ?? project.format}</span>
            <span aria-hidden>·</span>
            <span className="capitalize">{project.worldType}</span>
            {project.targetDurationSec ? (
              <span>· {Math.round(project.targetDurationSec / 60) || 1}m target</span>
            ) : null}
          </CardContent>
        </Card>
      </Link>
    </motion.div>
  );
}

/** Quiet placeholder for projects that haven't generated any scenes yet —
 *  matches the dashed-border aesthetic of the empty state. */
function ProjectCoverPlaceholder() {
  return (
    <div className="absolute inset-0 flex items-center justify-center text-[10px] uppercase tracking-[0.18em] text-muted-foreground/60">
      Pending
    </div>
  );
}
