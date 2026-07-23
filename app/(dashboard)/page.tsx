import Link from "next/link";
import { auth } from "@/auth";
import { getOperator } from "@/lib/operators";
import { listProjectsForDashboard } from "@/lib/projects";
import { sumSpendSince, sumSpendToday } from "@/lib/spend";
import {
  estimateAnimateBatch,
  estimateProjectTotal,
  FAL_NANO_BANANA_PER_IMAGE,
  formatCost,
} from "@/lib/pricing";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import type { Project } from "@/lib/db";
import { ADMIN_EMAIL, getTimeoutSetting, type TimeoutSetting } from "@/lib/app-settings";
import { ProjectCard } from "./project-card";
import { FeatureCard } from "./feature-card";
import { TimeoutToggle } from "./timeout-toggle";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const session = await auth().catch(() => null);
  const sessionEmail = session?.user?.email ?? null;

  // Kelvin's personal "time-out" toggle — enforcement lives in proxy.ts
  // (every page + API for the target account); this read only feeds the
  // admin card below. Soft-fails to null so a settings hiccup never blocks
  // the dashboard.
  let timeout: TimeoutSetting | null = null;
  try {
    timeout = await getTimeoutSetting();
  } catch {
    timeout = null;
  }

  let projects: Array<Project & { coverUrl: string | null }> = [];
  let loadError: string | null = null;
  try {
    projects = await listProjectsForDashboard();
  } catch (err) {
    loadError = err instanceof Error ? err.message : "Failed to load projects";
  }

  // Operator spend readout — actuals from the ledger, not estimates. Soft-
  // fails to null so a ledger hiccup never blocks the dashboard.
  let spend: { today: number; month: number; budget: number | null } | null = null;
  try {
    const operator = getOperator(sessionEmail);
    if (operator) {
      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      const [today, month] = await Promise.all([
        sumSpendToday(operator.email),
        sumSpendSince(operator.email, monthStart),
      ]);
      spend = { today, month, budget: operator.dailyBudgetUsd ?? null };
    }
  } catch {
    spend = null;
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
        {spend && (
          <p className="text-xs text-muted-foreground tracking-tight tabular-nums">
            Spend: {formatCost(spend.today)} today
            {spend.budget ? ` of ${formatCost(spend.budget)}/day` : ""} ·{" "}
            {formatCost(spend.month)} this month
          </p>
        )}
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
            hint="3 × 5s, each a fresh text-to-image, animated at native 1080p via Seedance. Hero quality adds Topaz 4K60."
            cost={`~${formatCost(estimateProjectTotal("reel", 3) + estimateAnimateBatch(3, 5))}`}
            aspectClass="aspect-[9/16]"
          />
          <FeatureCard
            href="/new?format=before-after"
            kicker="Instagram · TikTok"
            title="Before / after"
            hint="Drop a real photo, AI transforms it. After is animated (7s); the upload stays static for a clean cut. Live ArchitectGPT demo."
            cost={`~${formatCost(estimateProjectTotal("before-after", 2))}`}
            aspectClass="aspect-[9/16]"
          />
          <FeatureCard
            href="/new?format=style-explorer"
            kicker="YouTube long-form"
            title="Style explorer"
            hint="Describe a space, review the rendered base, then GPT-5.6 restyles that exact space into ~10 recognisable styles. SEO metadata + card copy included."
            cost={`~${formatCost(estimateProjectTotal("style-explorer", 10))}`}
            aspectClass="aspect-video"
          />
          <FeatureCard
            href="/new?format=carousel"
            kicker="Instagram"
            title="Carousel"
            hint="10 still slides, no video."
            cost={`~${formatCost(estimateProjectTotal("carousel", 10))}`}
            aspectClass="aspect-square"
          />
          <FeatureCard
            href="/scratch"
            kicker="Free play"
            title="Scratch image"
            hint="One-off prompt → single nano-banana-pro image."
            cost={`~${formatCost(FAL_NANO_BANANA_PER_IMAGE)}`}
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

      {/* Admin-only personal settings — rendered for Kelvin's session only. */}
      {sessionEmail === ADMIN_EMAIL && (
        <section className="flex flex-col gap-5">
          <div className="flex items-baseline justify-between gap-4 border-b pb-3">
            <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
              Personal
            </span>
          </div>
          <TimeoutToggle
            initialEnabled={timeout?.enabled ?? false}
            initialMessage={timeout?.message ?? ""}
          />
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
