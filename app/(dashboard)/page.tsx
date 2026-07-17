import Link from "next/link";
import { listProjectsForDashboard } from "@/lib/projects";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import type { Project } from "@/lib/db";
import { ProjectCard } from "./project-card";
import { FeatureCard } from "./feature-card";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  let projects: Array<Project & { coverUrl: string | null }> = [];
  let loadError: string | null = null;
  try {
    projects = await listProjectsForDashboard();
  } catch (err) {
    loadError = err instanceof Error ? err.message : "Failed to load projects";
  }

  return (
    <div className="mx-auto max-w-6xl w-full px-6 pt-16 pb-20 flex flex-col gap-16">
      <header className="flex flex-col gap-4 max-w-2xl">
        <span className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          The studio
        </span>
        <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight leading-[1.03]">
          A studio for ambient
          <br />
          architecture and interior content.
        </h1>
        <p className="text-base text-muted-foreground tracking-tight max-w-md leading-relaxed">
          Concepts, scenes, and exports — for the chillest end of the design feed.
        </p>
      </header>

      {/* Feature shortcuts — one card per thing the studio can produce. */}
      <section className="flex flex-col gap-5">
        <div className="flex items-baseline justify-between gap-4 border-b pb-3">
          <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
            Start something
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">5</span>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <FeatureCard
            href="/new?format=reel"
            kicker="Instagram · TikTok · YouTube Shorts"
            title="Reel"
            hint="3 × 5s, each a fresh text-to-image, animated via Seedance + Topaz Proteus 2K + Apollo 60fps."
            cost="~$6.80"
            aspectClass="aspect-[9/16]"
          />
          <FeatureCard
            href="/new?format=before-after"
            kicker="Instagram · TikTok"
            title="Before / after"
            hint="Drop a real photo, AI transforms it. After is animated (7s); the upload stays static for a clean cut. Live ArchitectGPT demo."
            cost="~$3.05"
            aspectClass="aspect-[9/16]"
          />
          <FeatureCard
            href="/new?format=style-explorer"
            kicker="YouTube long-form"
            title="Style explorer"
            hint="Describe a space, review the rendered base, then GPT-5.5 restyles that exact space into ~10 recognisable styles. SEO metadata + card copy included."
            cost="~$1.75"
            aspectClass="aspect-video"
          />
          <FeatureCard
            href="/new?format=carousel"
            kicker="Instagram"
            title="Carousel"
            hint="10 still slides, no video."
            cost="~$2.35"
            aspectClass="aspect-square"
          />
          <FeatureCard
            href="/scratch"
            kicker="Free play"
            title="Scratch image"
            hint="One-off prompt → single nano-banana-pro image."
            cost="~$0.23"
            aspectClass="aspect-square"
            variant="ghost"
          />
        </div>
      </section>

      {/* Loaded state for the projects list. */}
      {loadError && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Couldn&apos;t load projects</CardTitle>
            <CardDescription>{loadError}</CardDescription>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Likely cause: <code>DATABASE_URL</code> isn&apos;t set or the schema hasn&apos;t been
            pushed yet. Add it to <code>.env.local</code> and run <code>npm run db:push</code>.
          </CardContent>
        </Card>
      )}

      {!loadError && (
        <section className="flex flex-col gap-5">
          <div className="flex items-baseline justify-between gap-4 border-b pb-3">
            <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
              Projects
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">{projects.length}</span>
          </div>
          {projects.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {projects.map((p, i) => (
                <ProjectCard key={p.id} project={p} index={i} />
              ))}
            </div>
          ) : (
            <ProjectsEmptyState />
          )}
        </section>
      )}
    </div>
  );
}

/** Empty-state for the Projects section. Three ghost cards mirror the grid
 *  layout that future projects will land in, then a tight text block explains
 *  what to do next. No icons — visual interest comes from the placeholder
 *  silhouettes themselves. */
function ProjectsEmptyState() {
  return (
    <div className="flex flex-col gap-8 py-6">
      <div
        aria-hidden
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 select-none pointer-events-none"
      >
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="rounded-lg border border-dashed h-[148px] flex flex-col gap-3 p-5 opacity-60"
            style={{ opacity: 0.7 - i * 0.18 }}
          >
            <div className="h-3 w-2/3 rounded bg-muted" />
            <div className="h-2 w-1/2 rounded bg-muted/70" />
            <div className="mt-auto flex items-center gap-2">
              <div className="h-2 w-16 rounded bg-muted/60" />
              <div className="h-2 w-1 rounded-full bg-muted/40" />
              <div className="h-2 w-10 rounded bg-muted/60" />
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-col items-center text-center gap-1.5 max-w-md mx-auto">
        <p className="text-base font-medium tracking-tight">Nothing here yet.</p>
        <p className="text-xs text-muted-foreground tracking-tight leading-relaxed">
          Your projects will land in this grid once you start one. Pick a format above
          and we&apos;ll script the rest.
        </p>
      </div>
    </div>
  );
}
