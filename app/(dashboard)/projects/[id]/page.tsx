import { notFound } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import { getOperator } from "@/lib/operators";
import { getProjectWithScenes } from "@/lib/projects";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ProjectActions } from "./project-actions";
import { SceneGrid } from "./scene-grid";
import { AnimatedSceneCard } from "./animated-scene-card";
import { ExportPanel, type ExportPanelData } from "./export-panel";
import { FlowBanner } from "./flow-banner";
import { RegenerateAllLink } from "./regenerate-all-link";
import { AutoRefresh } from "./auto-refresh";
import { BatchActions } from "./batch-actions";
import { JobNotifier } from "./job-notifier";
import { StitchPanel } from "./stitch-panel";
import { estimateBatchImages, estimateImageBatch, formatCost } from "@/lib/pricing";
import { sumProjectSpend } from "@/lib/spend";

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
  // Actual recorded spend for this project (soft-fails to null).
  let projectSpend: number | null = null;
  try {
    projectSpend = await sumProjectSpend(project.id);
  } catch {
    projectSpend = null;
  }

  // Whether the signed-in operator has their own Shotstack key. Without one,
  // stitching still works via the fal fallback (hard cuts) — the panel shows
  // an opt-in hint for crossfades. Soft-fails to true to avoid nagging when
  // the session can't be read.
  let hasShotstack = true;
  let sessionEmail: string | null = null;
  try {
    const session = await auth();
    sessionEmail = session?.user?.email ?? null;
    hasShotstack = !!getOperator(sessionEmail)?.shotstackKey;
  } catch {
    hasShotstack = true;
  }
  // Export/download/finalize/stitch are owner-only (enforced server-side in
  // the finalize/stitch routes too). Legacy rows with no operatorEmail
  // predate attribution and stay open to every operator.
  const isOwner = !project.operatorEmail || project.operatorEmail === sessionEmail;
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
      <JobNotifier busy={isBusy} projectTitle={project.title} />
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
            {project.quality === "hero" && (
              <>
                <span aria-hidden>·</span>
                <span>Hero 4K</span>
              </>
            )}
            {projectSpend !== null && projectSpend > 0 && (
              <>
                <span aria-hidden>·</span>
                <span className="tabular-nums" title="Actual recorded spend on this project">
                  {formatCost(projectSpend)} spent
                </span>
              </>
            )}
            <span aria-hidden>·</span>
            <Badge variant="secondary" className="text-[10px]">{project.status}</Badge>
            {(project.format === "reel" || project.format === "carousel") && (
              <>
                <span aria-hidden>·</span>
                <Link
                  href={duplicateHref(project)}
                  className="text-xs hover:text-foreground transition-colors"
                  title="Start a new project pre-filled with this one's recipe"
                >
                  Duplicate as template
                </Link>
              </>
            )}
          </div>
        </div>
        {/* Every action here spends the owner's credits — owner-only, same
            as the server-side gate on the generate/animate/finalize routes. */}
        {isOwner && (
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
        )}
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

      {/* Stitch appears once the deliverable's inputs exist: all clips for a
          reel, the morph for before-after, all stills for style-explorer's
          stills+music YouTube long-form. */}
      {((project.format === "reel" &&
        scenes.length > 0 &&
        animatedCount === scenes.length) ||
        (project.format === "before-after" && animatedCount > 0) ||
        (project.format === "style-explorer" &&
          scenes.length > 0 &&
          counts.generated + counts.approved === scenes.length)) && (
        <StitchPanel
          projectId={project.id}
          format={project.format}
          finalVideoUrl={project.finalVideoUrl}
          hasShotstack={hasShotstack}
          isOwner={isOwner}
          stitchStatus={project.stitchStatus}
          stitchError={project.stitchError}
          aspect={
            project.format === "before-after"
              ? (project.aspectRatio ?? "1:1")
              : project.format === "style-explorer"
                ? (project.aspectRatio ?? "16:9")
                : "9:16"
          }
        />
      )}

      {/* Export bundle is owner-only — the zip is the deliverable. */}
      {exportData && isOwner && <ExportPanel data={exportData} />}

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
            {!animateStarted && isOwner && (
              <BatchActions
                projectId={project.id}
                generatedCount={counts.generated}
                retryableCount={counts.pending + counts.rejected}
                retryCostLabel={formatCost(
                  estimateImageBatch(counts.pending + counts.rejected, project.quality)
                )}
                jobInFlight={
                  project.status === "generating" || project.status === "finalizing"
                }
              />
            )}
            {scenes.length > 0 && isOwner && (
              <RegenerateAllLink
                projectId={project.id}
                totalScenes={scenes.length}
                costLabel={formatCost(estimateBatchImages(scenes.length, project.quality))}
                hasAnyAnimated={animatedCount > 0}
                jobInFlight={
                  project.status === "generating" || project.status === "finalizing"
                }
              />
            )}
          </div>
        </div>

        <SceneGrid
          projectId={project.id}
          scenes={scenes.map((s) => ({
            id: s.id,
            order: s.order,
            prompt: s.prompt,
            status: s.status,
            imageUrl: s.imageUrl,
            error: s.error,
            styleName: s.styleName,
            styleSubtitle: s.styleSubtitle,
            motionPreset: s.motionPreset,
          }))}
          format={project.format}
          hideActions={animateStarted || !isOwner}
          worldType={project.worldType}
        />
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
  finalVideoUrl: string | null;
  metadata: ExportPanelData["metadata"] | null;
};

type SceneRow = {
  order: number;
  prompt: string;
  durationSec: number | null;
  imageUrl: string | null;
  videoUrl: string | null;
  status: string;
  styleName: string | null;
  styleSubtitle: string | null;
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
      styleName: s.styleName,
      styleSubtitle: s.styleSubtitle,
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
    finalVideoUrl: project.finalVideoUrl,
    metadata: project.metadata,
    scenes: renderableScenes,
  };
}

/** Deep-link to /new pre-filled with this project's recipe — format, niche,
 *  lane, look, and quality. The proven-recipe path to "make my Tuesday reel". */
function duplicateHref(project: {
  format: string;
  niche: string;
  worldType: string;
  lookId: string | null;
  quality: string;
}): string {
  const params = new URLSearchParams({
    format: project.format,
    niche: project.niche,
    world: project.worldType,
    quality: project.quality,
  });
  if (project.lookId) params.set("look", project.lookId);
  return `/new?${params.toString()}`;
}

function formatLabel(f: string) {
  switch (f) {
    case "reel":
      return "Reel";
    case "carousel":
      return "Carousel";
    case "before-after":
      return "Before / After";
    case "style-explorer":
      return "Style explorer";
    default:
      return f;
  }
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
