import { notFound } from "next/navigation";
import Link from "next/link";
import { getProjectWithScenes } from "@/lib/projects";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ProjectActions } from "./project-actions";
import { SceneCard } from "./scene-card";
import { AnimatedSceneCard } from "./animated-scene-card";
import { ExportPanel, type ExportPanelData } from "./export-panel";
import { FlowBanner } from "./flow-banner";
import { RegenerateAllLink } from "./regenerate-all-link";
import { AutoRefresh } from "./auto-refresh";
import { estimateBatchImages, formatCost } from "@/lib/pricing";

export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let data;
  try {
    data = await getProjectWithScenes(id);
  } catch (err) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10">
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle>Couldn&apos;t load project</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {err instanceof Error ? err.message : "Unknown error"}
          </CardContent>
        </Card>
      </div>
    );
  }
  if (!data) notFound();

  const { project, scenes } = data;
  const concept = project.concept;
  const counts = countByStatus(scenes);
  const exportData = buildExportData(project, scenes);
  const animatedCount = scenes.filter((s) => !!s.videoUrl).length;
  // Per-scene duration is uniform across the project — pull from the first
  // scene with a value, fall back to 3 (reel default).
  const perSceneDurationSec = scenes[0]?.durationSec ?? 3;
  // Once Animate has been kicked off, hide per-scene action buttons. Signal:
  // any scene has a videoUrl OR a motionPrompt (set by markSceneAnimating
  // before seedance runs). Approving/regenerating/rejecting stills past this
  // point is meaningless — the operator already moved on.
  const animateStarted = scenes.some((s) => !!s.videoUrl || !!s.motionPrompt);
  // Background job in flight: project-level lock or per-scene generating.
  // Drives the AutoRefresh island so the page polls without manual reload.
  const isBusy =
    project.status === "generating" ||
    project.status === "finalizing" ||
    counts.generating > 0;

  return (
    <div className="mx-auto max-w-6xl px-6 pt-10 pb-16 flex flex-col gap-8">
      <AutoRefresh active={isBusy} />
      <div className="flex items-start justify-between gap-6">
        <div className="flex flex-col gap-2">
          <Link
            href="/"
            className="text-xs text-muted-foreground hover:text-foreground tracking-tight inline-flex items-center gap-1 self-start"
          >
            <span aria-hidden>←</span> Studio
          </Link>
          <h1 className="text-3xl font-semibold tracking-tight leading-[1.05]">{project.title}</h1>
          <div className="text-sm text-muted-foreground flex items-center gap-3 tracking-tight">
            <span>{project.niche}</span>
            <span aria-hidden>·</span>
            <span>{formatLabel(project.format)}</span>
            <span aria-hidden>·</span>
            <span className="capitalize">{project.worldType}</span>
            <span aria-hidden>·</span>
            <Badge variant="secondary" className="text-[10px]">{project.status}</Badge>
          </div>
        </div>
        <ProjectActions
          projectId={project.id}
          totalScenes={scenes.length}
          counts={counts}
          status={project.status}
          hasExport={!!exportData}
          format={project.format}
          perSceneDurationSec={perSceneDurationSec}
          animatedCount={animatedCount}
        />
      </div>

      <FlowBanner
        state={{
          totalScenes: scenes.length,
          generated: counts.generated,
          approved: counts.approved,
          rejected: counts.rejected,
          pending: counts.pending,
          generating: counts.generating,
          hasExport: !!exportData,
          animated: animatedCount,
          format: project.format,
        }}
      />

      {concept && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Concept brief</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            {concept.hook && (
              <div>
                <div className="text-xs text-muted-foreground mb-0.5">Hook</div>
                <div>{concept.hook}</div>
              </div>
            )}
            {concept.vibe && (
              <div>
                <div className="text-xs text-muted-foreground mb-0.5">Vibe</div>
                <div className="leading-relaxed">{concept.vibe}</div>
              </div>
            )}
            {concept.notes && (
              <div>
                <div className="text-xs text-muted-foreground mb-0.5">Visual rules</div>
                <div className="whitespace-pre-line text-muted-foreground">{concept.notes}</div>
              </div>
            )}
            {concept.objectSet && concept.objectSet.length > 0 && (
              <div>
                <div className="text-xs text-muted-foreground mb-1.5">Object set</div>
                <div className="flex flex-wrap gap-1.5">
                  {concept.objectSet.map((obj: string, i: number) => (
                    <span
                      key={i}
                      className="text-xs rounded-full border px-2 py-0.5 bg-muted/30 tracking-tight"
                    >
                      {obj}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {exportData && <ExportPanel data={exportData} />}

      <section className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between gap-4 border-b pb-3">
          <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
            Stills
          </span>
          <div className="flex items-baseline gap-4">
            <div className="text-xs text-muted-foreground tabular-nums">
              {counts.generated + counts.approved}/{scenes.length} ready ·{" "}
              {counts.pending} pending · {counts.rejected} failed
            </div>
            {scenes.length > 0 && (
              <RegenerateAllLink
                projectId={project.id}
                totalScenes={scenes.length}
                costLabel={formatCost(estimateBatchImages(scenes.length))}
                hasAnyAnimated={animatedCount > 0}
                jobInFlight={
                  project.status === "generating" || project.status === "finalizing"
                }
              />
            )}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {scenes.map((s) => (
            <SceneCard
              key={s.id}
              projectId={project.id}
              scene={{
                id: s.id,
                order: s.order,
                prompt: s.prompt,
                status: s.status,
                imageUrl: s.imageUrl,
                error: s.error,
              }}
              hideActions={animateStarted}
            />
          ))}
        </div>
      </section>

      {(project.format === "reel" || project.format === "before-after") &&
        animatedCount > 0 && (
          <section className="flex flex-col gap-4">
            <div className="flex items-baseline justify-between gap-4 border-b pb-3">
              <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                Animated
              </span>
              <div className="text-xs text-muted-foreground tabular-nums">
                {animatedCount}/{scenes.length} animated
              </div>
            </div>
            {/* Reels: 9:16 cards (the deliverable aspect). Before-after: use
                the project's stored aspect since the upload defines it. */}
            <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
              {scenes
                .filter((s) => !!s.videoUrl)
                .map((s) => (
                  <AnimatedSceneCard
                    key={s.id}
                    scene={{
                      id: s.id,
                      order: s.order,
                      videoUrl: s.videoUrl as string,
                      posterUrl: s.imageUrl,
                      durationSec: s.durationSec,
                    }}
                    aspect={
                      project.format === "before-after"
                        ? (project.aspectRatio ?? "1:1")
                        : "9:16"
                    }
                  />
                ))}
            </div>
          </section>
        )}
    </div>
  );
}

type ProjectRow = {
  id: string;
  title: string;
  niche: string;
  format: string;
  metadata: ExportPanelData["metadata"] | null;
};

type SceneRow = {
  order: number;
  prompt: string;
  durationSec: number | null;
  imageUrl: string | null;
  videoUrl: string | null;
  status: string;
};

/** Build the props for ExportPanel out of the DB row. Returns null until
 *  finalize has set the metadata. The cover image always derives live from
 *  scenes (anchor for reel/carousel, after for before-after) — thumbnail
 *  generation was deprecated. */
function buildExportData(project: ProjectRow, scenes: SceneRow[]): ExportPanelData | null {
  if (!project.metadata) return null;
  const renderableScenes = scenes
    .filter((s) => !!s.imageUrl && (s.status === "generated" || s.status === "approved"))
    .map((s) => ({
      order: s.order,
      prompt: s.prompt,
      durationSec: s.durationSec,
      imageUrl: s.imageUrl as string,
      videoUrl: s.videoUrl,
    }));

  if (renderableScenes.length === 0) return null;

  // Cover = anchor scene by default (lowest order). Before-after uses the
  // highest-order scene (the "after") as its visual payoff.
  const sortedAsc = [...renderableScenes].sort((a, b) => a.order - b.order);
  const cover =
    project.format === "before-after"
      ? sortedAsc[sortedAsc.length - 1]
      : sortedAsc[0];

  return {
    projectId: project.id,
    title: project.title,
    niche: project.niche,
    format: project.format,
    thumbnailUrl: cover.imageUrl,
    metadata: project.metadata,
    scenes: renderableScenes,
  };
}

function formatLabel(f: string) {
  return f === "reel" ? "Reel" : f === "carousel" ? "Carousel" : f;
}

type StatusCounts = {
  pending: number;
  generating: number;
  generated: number;
  approved: number;
  rejected: number;
};

function countByStatus(scenes: { status: string }[]): StatusCounts {
  const counts: StatusCounts = {
    pending: 0,
    generating: 0,
    generated: 0,
    approved: 0,
    rejected: 0,
  };
  for (const s of scenes) {
    if (s.status in counts) counts[s.status as keyof StatusCounts]++;
  }
  return counts;
}
