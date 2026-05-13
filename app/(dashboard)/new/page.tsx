"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import { ease } from "@/lib/motion";
import { estimateProjectTotal, estimateSuggestWorld, formatCost } from "@/lib/pricing";
import { NICHE_POOL, sampleN } from "@/lib/prompts/niche-pool";

type Format = "reel" | "carousel" | "before-after";
type WorldType = "interior" | "exterior";
type AspectRatio = "16:9" | "9:16" | "1:1" | "4:3" | "3:4";

const FORMAT_PRESETS: Record<
  Format,
  {
    label: string;
    /** Where this format actually lives. Sits as a tiny uppercase eyebrow
     *  above the format title — same pattern as the home cards. */
    kicker: string;
    hint: string;
    sceneCount: number;
    sceneDurationSec: number;
    aspectClass: string;
  }
> = {
  reel: {
    label: "Reel",
    kicker: "Instagram · TikTok · YouTube Shorts",
    hint: "Each scene animated via Seedance 2.0 then upscaled to 2K with Topaz Proteus. Premium feel, slow cuts.",
    sceneCount: 3,
    sceneDurationSec: 5,
    aspectClass: "aspect-[9/16]",
  },
  carousel: {
    label: "Carousel",
    kicker: "Instagram",
    hint: "Static slides built for slow-swipe scroll. No video — one image per slide.",
    sceneCount: 10,
    sceneDurationSec: 0,
    aspectClass: "aspect-square",
  },
  "before-after": {
    label: "Before / after",
    kicker: "Instagram · TikTok",
    hint: "Drop a real photo, describe the transformation. Live demo content for ArchitectGPT.",
    sceneCount: 2, // before + after
    sceneDurationSec: 9,
    aspectClass: "aspect-square", // overridden by uploaded image's actual aspect
  },
};

// NICHE_POOL + sampleN live in lib/prompts/niche-pool.ts so suggest-world
// can reuse them as altitude-calibration examples for the AI-suggest flow.

const STEPS = ["Format", "World", "Review"] as const;

function isFormat(v: string | null): v is Format {
  return v === "reel" || v === "carousel" || v === "before-after";
}

export default function NewProjectPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // If the dashboard cards linked here with ?format=…, skip step 1 and land
  // straight on the niche step with the right defaults already loaded.
  // Default to reel — short-form is the channel's primary surface.
  const initialFormatParam = searchParams.get("format");
  const initialFormat: Format = isFormat(initialFormatParam) ? initialFormatParam : "reel";
  const initialStep: 1 | 2 | 3 = isFormat(initialFormatParam) ? 2 : 1;

  const [step, setStep] = useState<1 | 2 | 3>(initialStep);
  const [direction, setDirection] = useState<1 | -1>(1);

  const [format, setFormat] = useState<Format>(initialFormat);
  // Operator-allowed visual lanes (e.g., InteriorGPT operators only get
  // "interior"). Fetched from /api/me on mount; drives the WorldTypePicker.
  // Null while the request is in flight.
  const [allowedWorldTypes, setAllowedWorldTypes] = useState<WorldType[] | null>(null);
  // No default — operator must explicitly pick a side, EXCEPT when their
  // operator config only allows one (we auto-select to skip the friction).
  const [worldType, setWorldType] = useState<WorldType | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/me");
        if (!res.ok) return;
        const data = (await res.json()) as { worldTypes: WorldType[] };
        setAllowedWorldTypes(data.worldTypes);
        if (data.worldTypes.length === 1) {
          setWorldType(data.worldTypes[0]);
        }
      } catch {
        // Silent — operator can still pick interior or exterior manually.
      }
    })();
  }, []);
  const [niche, setNiche] = useState("");
  const [operatorNotes, setOperatorNotes] = useState("");
  const [showCustomize, setShowCustomize] = useState(false);
  const [sceneCount, setSceneCount] = useState(FORMAT_PRESETS[initialFormat].sceneCount);
  const [sceneDurationSec, setSceneDurationSec] = useState(
    FORMAT_PRESETS[initialFormat].sceneDurationSec
  );
  const [submitting, setSubmitting] = useState(false);

  // Before-after-only state. Populated by the upload step.
  const [beforeImageUrl, setBeforeImageUrl] = useState<string | null>(null);
  const [beforeAspect, setBeforeAspect] = useState<AspectRatio | null>(null);
  const [transformationPrompt, setTransformationPrompt] = useState("");

  // Per-session rotated examples. useMemo keyed on worldType so the operator
  // gets a stable set within one session per lane (no jumpy re-rolls on every
  // re-render) but a fresh set each visit and on lane-switch.
  const presets = useMemo(
    () => (worldType ? sampleN(NICHE_POOL[worldType], 5) : []),
    [worldType]
  );
  const placeholderExample = useMemo(
    () => (worldType ? sampleN(NICHE_POOL[worldType], 1)[0] : ""),
    [worldType]
  );

  function changeFormat(f: Format) {
    setFormat(f);
    setSceneCount(FORMAT_PRESETS[f].sceneCount);
    setSceneDurationSec(FORMAT_PRESETS[f].sceneDurationSec);
  }

  function go(next: 1 | 2 | 3) {
    setDirection(next > step ? 1 : -1);
    setStep(next);
  }

  const targetLabel = useMemo(() => {
    if (format === "carousel") return `${sceneCount} slides`;
    const total = sceneCount * sceneDurationSec;
    if (total < 60) return `~${total}s`;
    return `~${Math.round((total / 60) * 10) / 10} min`;
  }, [format, sceneCount, sceneDurationSec]);

  type SimilarProject = {
    project: { id: string; title: string; niche: string; format: string; createdAt: string | Date };
    reason: "exact-signature" | "keyword-overlap";
    confidence: number;
  };
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(null);
  const [similarProjects, setSimilarProjects] = useState<SimilarProject[]>([]);

  const canContinueStep1 = !!format;
  const canContinueStep2 =
    format === "before-after"
      ? !!worldType && !!beforeImageUrl && transformationPrompt.trim().length >= 8
      : !!worldType && niche.trim().length >= 2;

  async function submit() {
    setSubmitting(true);
    try {
      if (!worldType) throw new Error("Pick interior or exterior first.");

      if (format === "before-after") {
        if (!beforeImageUrl || !beforeAspect) {
          throw new Error("Upload a 'before' image first.");
        }
        const res = await fetch("/api/projects/before-after", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            beforeImageUrl,
            transformationPrompt: transformationPrompt.trim(),
            aspectRatio: beforeAspect,
            worldType,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error ?? `HTTP ${res.status}`);
        }
        const data = await res.json();
        toast.success("Project created");
        router.push(`/projects/${data.project.id}`);
        return;
      }

      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          niche: niche.trim(),
          format,
          worldType,
          sceneCount,
          sceneDurationSec,
          operatorNotes: operatorNotes.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      const matches: SimilarProject[] = data.similarProjects ?? [];
      if (matches.length > 0) {
        // Don't auto-navigate — let the operator decide between the new
        // project and the similar existing one. Project is already in the DB.
        setCreatedProjectId(data.project.id);
        setSimilarProjects(matches);
        toast.success("Project created — heads up on the dupes panel");
        setSubmitting(false);
      } else {
        toast.success("Project created");
        router.push(`/projects/${data.project.id}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error("Couldn't create project", { description: message });
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl w-full px-6 pt-12 pb-20 flex flex-col gap-12">
      <header className="flex items-baseline justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Link
            href="/"
            className="text-xs text-muted-foreground hover:text-foreground tracking-tight inline-flex items-center gap-1"
          >
            <span aria-hidden>←</span> Studio
          </Link>
          <h1 className="text-3xl font-semibold tracking-tight leading-[1.05]">New project</h1>
        </div>
      </header>

      <Stepper current={step} onJump={(n) => n < step && go(n)} />

      <div className="relative min-h-[420px]">
        <AnimatePresence mode="wait" custom={direction}>
          {step === 1 && (
            <StepShell key="1" direction={direction}>
              <StepHeader
                eyebrow="Where it lives"
                title="Pick a format."
                hint="Each format produces a different deliverable — a long ambient YouTube slideshow, a 15-second animated reel, or a static Instagram carousel."
              />
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {(Object.keys(FORMAT_PRESETS) as Format[]).map((f) => (
                  <FormatCard
                    key={f}
                    selected={format === f}
                    onSelect={() => changeFormat(f)}
                    kicker={FORMAT_PRESETS[f].kicker}
                    label={FORMAT_PRESETS[f].label}
                    hint={FORMAT_PRESETS[f].hint}
                    aspectClass={FORMAT_PRESETS[f].aspectClass}
                    detail={
                      f === "carousel"
                        ? `${FORMAT_PRESETS[f].sceneCount} slides`
                        : `${FORMAT_PRESETS[f].sceneCount} × ${FORMAT_PRESETS[f].sceneDurationSec}s`
                    }
                    cost={`~${formatCost(estimateProjectTotal(f, FORMAT_PRESETS[f].sceneCount))} all-in`}
                  />
                ))}
              </div>
              <Footer>
                <FooterCta
                  onClick={() => go(2)}
                  disabled={!canContinueStep1}
                  label="Continue"
                />
              </Footer>
            </StepShell>
          )}

          {step === 2 && (
            <StepShell key="2" direction={direction}>
              <StepHeader
                eyebrow="Step 2 of 3"
                title={format === "before-after" ? "Drop the before, describe the after." : "What's the world?"}
                hint={
                  format === "before-after"
                    ? "Upload a real photo of an interior or exterior. Describe what should change. The studio generates the after, animates it, and bundles a transformation triptych."
                    : "Describe a home a designer would screenshot — a place with strong identity, a quality of light, materials and the kind of objects (plants, art, books) that fill it. Or have the studio suggest one."
                }
              />

              <WorldTypePicker
                value={worldType}
                onChange={setWorldType}
                allowed={allowedWorldTypes ?? ["interior", "exterior"]}
              />

              {format === "before-after" ? (
                <BeforeAfterStep
                  beforeImageUrl={beforeImageUrl}
                  beforeAspect={beforeAspect}
                  onUploaded={(url, aspect) => {
                    setBeforeImageUrl(url);
                    setBeforeAspect(aspect);
                  }}
                  transformationPrompt={transformationPrompt}
                  onTransformationChange={setTransformationPrompt}
                />
              ) : (
                worldType && (
                  <WorldChooser
                    niche={niche}
                    onNiche={setNiche}
                    format={format}
                    worldType={worldType}
                    presets={presets}
                    placeholderExample={placeholderExample}
                  />
                )
              )}

              <div className="flex flex-col gap-3">
                {format !== "before-after" && (
                <button
                  type="button"
                  onClick={() => setShowCustomize((v) => !v)}
                  className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 self-start tracking-tight"
                >
                  <span
                    aria-hidden
                    className={`inline-block transition-transform ${showCustomize ? "rotate-90" : ""}`}
                  >
                    ›
                  </span>
                  {format === "reel"
                    ? "Add notes for Claude"
                    : `Customize (${sceneCount} slides)`}
                </button>
                )}

                <AnimatePresence>
                  {showCustomize && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.25, ease }}
                      className="overflow-hidden"
                    >
                      <div className="flex flex-col gap-5 pt-2">
                        {/* Reel is locked at 3 × 5s — that's the format's
                            shape, not a knob to tune. Carousel still exposes
                            slide count since it varies legitimately. */}
                        {format === "carousel" && (
                          <NumberField
                            label="Slides"
                            value={sceneCount}
                            onChange={setSceneCount}
                            min={1}
                            max={120}
                          />
                        )}

                        <label className="flex flex-col gap-1.5">
                          <span className="text-xs text-muted-foreground tracking-tight">
                            Notes for Claude (optional)
                          </span>
                          <textarea
                            value={operatorNotes}
                            onChange={(e) => setOperatorNotes(e.target.value)}
                            rows={3}
                            placeholder="Anchor a feeling, a quality of light, a material palette, the kinds of plants/art/objects that fill the home. Anything that has to stay consistent."
                            className="w-full rounded-md border bg-transparent px-3 py-2 text-sm focus:border-foreground outline-none resize-none"
                          />
                        </label>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              <Footer>
                <FooterBack onClick={() => go(1)} />
                <FooterCta
                  onClick={() => go(3)}
                  disabled={!canContinueStep2}
                  label="Continue"
                />
              </Footer>
            </StepShell>
          )}

          {step === 3 && (
            <StepShell key="3" direction={direction}>
              <StepHeader
                eyebrow="Step 3 of 3"
                title="Ready to script."
                hint="Claude writes a concept brief, then a scene-by-scene shotlist. Takes about 30 seconds. You'll review before any images get generated."
              />

              <div className="rounded-xl border divide-y">
                <ReviewRow
                  label="Format"
                  value={FORMAT_PRESETS[format].label}
                  onEdit={() => go(1)}
                />
                {worldType && (
                  <ReviewRow
                    label="Visual lane"
                    value={worldType === "interior" ? "Interior" : "Exterior"}
                    onEdit={() => go(2)}
                  />
                )}
                {format === "before-after" ? (
                  <>
                    <ReviewRow
                      label="Before"
                      value={beforeImageUrl ? `Uploaded (${beforeAspect})` : "Not uploaded"}
                      onEdit={() => go(2)}
                    />
                    <ReviewRow
                      label="Transformation"
                      value={transformationPrompt.trim()}
                      onEdit={() => go(2)}
                    />
                  </>
                ) : (
                  <>
                    <ReviewRow label="Niche" value={niche.trim()} onEdit={() => go(2)} />
                    <ReviewRow
                      label={format === "carousel" ? "Slides" : "Scenes"}
                      value={`${sceneCount}${format === "carousel" ? "" : ` × ${sceneDurationSec}s`}`}
                      // Reel is locked at 3 × 5s — no edit affordance for that row.
                      onEdit={format === "carousel" ? () => go(2) : undefined}
                    />
                    <ReviewRow label="Target" value={targetLabel} />
                  </>
                )}
                <ReviewRow
                  label="Est. cost"
                  value={`~${formatCost(estimateProjectTotal(format, sceneCount))} all-in`}
                />
                {format !== "before-after" && operatorNotes.trim() && (
                  <ReviewRow label="Notes" value={operatorNotes.trim()} onEdit={() => go(2)} />
                )}
              </div>

              {createdProjectId && similarProjects.length > 0 ? (
                <SimilarPanel
                  matches={similarProjects}
                  onContinue={() => router.push(`/projects/${createdProjectId}`)}
                />
              ) : (
                <Footer>
                  <FooterBack onClick={() => go(2)} />
                  <motion.button
                    type="button"
                    onClick={submit}
                    disabled={submitting}
                    whileTap={{ scale: 0.98 }}
                    transition={{ duration: 0.12 }}
                    className="inline-flex h-11 items-center rounded-md bg-foreground px-6 text-sm text-background font-medium tracking-tight hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed transition-opacity"
                  >
                    {submitting ? "Scripting…" : "Create project →"}
                  </motion.button>
                </Footer>
              )}
            </StepShell>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ── Step chrome ─────────────────────────────────────────────────────────────

function Stepper({ current, onJump }: { current: 1 | 2 | 3; onJump: (n: 1 | 2 | 3) => void }) {
  return (
    <ol className="flex items-center gap-2 text-xs tracking-tight">
      {STEPS.map((label, i) => {
        const n = (i + 1) as 1 | 2 | 3;
        const state =
          n < current ? "done" : n === current ? "current" : "upcoming";
        const interactive = n < current;
        return (
          <Fragment key={label}>
            <li>
              <button
                type="button"
                disabled={!interactive}
                onClick={() => interactive && onJump(n)}
                className={`flex items-center gap-2.5 ${
                  interactive ? "cursor-pointer" : "cursor-default"
                }`}
              >
                <span
                  className={`size-6 rounded-full border flex items-center justify-center text-[10px] font-medium tabular-nums transition-colors ${
                    state === "current"
                      ? "bg-foreground text-background border-foreground"
                      : state === "done"
                        ? "bg-foreground/10 text-foreground border-foreground/20"
                        : "border-border text-muted-foreground"
                  }`}
                >
                  {n}
                </span>
                <span
                  className={`uppercase tracking-[0.18em] text-[10px] ${
                    state === "upcoming" ? "text-muted-foreground" : "text-foreground"
                  }`}
                >
                  {label}
                </span>
              </button>
            </li>
            {i < STEPS.length - 1 && (
              <li aria-hidden className="h-px w-10 bg-border flex-shrink-0" />
            )}
          </Fragment>
        );
      })}
    </ol>
  );
}

function StepShell({
  children,
  direction,
}: {
  children: React.ReactNode;
  direction: 1 | -1;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, x: direction * 24 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: direction * -24 }}
      transition={{ duration: 0.32, ease }}
      className="flex flex-col gap-8"
    >
      {children}
    </motion.div>
  );
}

function StepHeader({
  eyebrow,
  title,
  hint,
}: {
  eyebrow: string;
  title: string;
  hint: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
        {eyebrow}
      </span>
      <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight leading-[1.1]">
        {title}
      </h2>
      <p className="text-sm text-muted-foreground tracking-tight max-w-lg leading-relaxed">
        {hint}
      </p>
    </div>
  );
}

function Footer({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 pt-4 border-t">
      {children}
    </div>
  );
}

function FooterBack({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-sm text-muted-foreground hover:text-foreground tracking-tight inline-flex items-center gap-1"
    >
      <span aria-hidden>←</span> Back
    </button>
  );
}

function FooterCta({
  onClick,
  disabled,
  label,
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      whileTap={disabled ? undefined : { scale: 0.98 }}
      transition={{ duration: 0.12 }}
      className="ml-auto inline-flex h-10 items-center rounded-md bg-foreground px-5 text-sm text-background font-medium tracking-tight hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
    >
      {label}
    </motion.button>
  );
}

// ── Format picker card ─────────────────────────────────────────────────────

function FormatCard({
  selected,
  onSelect,
  kicker,
  label,
  hint,
  aspectClass,
  detail,
  cost,
}: {
  selected: boolean;
  onSelect: () => void;
  kicker: string;
  label: string;
  hint: string;
  aspectClass: string;
  detail: string;
  cost: string;
}) {
  return (
    <motion.button
      type="button"
      onClick={onSelect}
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.98 }}
      transition={{ duration: 0.16, ease }}
      className={`text-left rounded-xl border p-5 flex flex-col gap-4 transition-colors ${
        selected ? "border-foreground bg-foreground/[0.03]" : "hover:border-foreground/30"
      }`}
    >
      {/* Proportional shape — visual proof of the aspect. Capped height so all three cards align. */}
      <div className="h-28 flex items-center justify-center">
        <div
          className={`${aspectClass} max-h-full max-w-full rounded-md border-2 transition-colors ${
            selected ? "border-foreground bg-foreground" : "border-foreground/30"
          }`}
          style={{ height: "100%" }}
        />
      </div>
      <div className="flex flex-col gap-1.5 flex-1">
        <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          {kicker}
        </span>
        <div className="text-base font-semibold tracking-tight">{label}</div>
        <div className="text-xs text-muted-foreground leading-relaxed">{hint}</div>
      </div>
      <div className="flex items-center justify-between border-t pt-3 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        <span>{detail}</span>
        <span className="tracking-tight normal-case text-xs">{cost}</span>
      </div>
    </motion.button>
  );
}

// ── Review row ─────────────────────────────────────────────────────────────

function ReviewRow({
  label,
  value,
  onEdit,
}: {
  label: string;
  value: string;
  onEdit?: () => void;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-5 py-4">
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          {label}
        </span>
        <span className="text-sm tracking-tight truncate">{value}</span>
      </div>
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          className="text-xs text-muted-foreground hover:text-foreground tracking-tight"
        >
          Edit
        </button>
      )}
    </div>
  );
}

// ── Similar-project warning panel ───────────────────────────────────────────

function SimilarPanel({
  matches,
  onContinue,
}: {
  matches: Array<{
    project: { id: string; title: string; niche: string; format: string };
    reason: "exact-signature" | "keyword-overlap";
    confidence: number;
  }>;
  onContinue: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease }}
      className="flex flex-col gap-4 rounded-xl border border-foreground/30 bg-muted/20 p-5"
    >
      <div className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          Heads up
        </span>
        <h3 className="text-base font-semibold tracking-tight">
          You already have {matches.length === 1 ? "a similar project" : `${matches.length} similar projects`}.
        </h3>
        <p className="text-xs text-muted-foreground tracking-tight leading-relaxed">
          The new project was created. If this was unintentional, open the existing one instead — same world, no need for a duplicate.
        </p>
      </div>

      <ul className="flex flex-col divide-y border-y">
        {matches.map((m) => (
          <li key={m.project.id} className="flex items-center justify-between gap-4 py-3">
            <div className="flex flex-col min-w-0">
              <span className="text-sm font-medium tracking-tight truncate">
                {m.project.title}
              </span>
              <span className="text-[11px] text-muted-foreground tracking-tight">
                {m.project.niche} · {m.reason === "exact-signature" ? "exact world match" : `${Math.round(m.confidence * 100)}% keyword overlap`}
              </span>
            </div>
            <Link
              href={`/projects/${m.project.id}`}
              className="text-xs text-muted-foreground hover:text-foreground tracking-tight whitespace-nowrap"
            >
              Open →
            </Link>
          </li>
        ))}
      </ul>

      <div className="flex items-center justify-end gap-3">
        <motion.button
          type="button"
          onClick={onContinue}
          whileTap={{ scale: 0.98 }}
          transition={{ duration: 0.12 }}
          className="inline-flex h-10 items-center rounded-md bg-foreground px-5 text-sm text-background font-medium tracking-tight hover:opacity-90 transition-opacity"
        >
          Continue to new project →
        </motion.button>
      </div>
    </motion.div>
  );
}

// ── World type picker (interior vs exterior) ────────────────────────────────

function WorldTypePicker({
  value,
  onChange,
  allowed,
}: {
  value: WorldType | null;
  onChange: (v: WorldType) => void;
  /** Which lanes the operator's config covers (e.g., InteriorGPT = ["interior"]
   *  only). When the list has one entry we render a static badge instead of a
   *  picker — there's no choice to make. */
  allowed: WorldType[];
}) {
  // Single-lane operators don't need a picker; show a tiny pinned tag so they
  // know which lane will be used.
  if (allowed.length === 1) {
    return (
      <div className="flex flex-col gap-2">
        <span className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          Visual lane
        </span>
        <div className="text-sm tracking-tight">
          <span className="capitalize font-medium">{allowed[0]}</span>{" "}
          <span className="text-xs text-muted-foreground">
            (only lane this operator's apps cover)
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
        Visual lane
      </span>
      <div className="grid grid-cols-2 gap-3">
        {allowed.map((wt) => (
          <motion.button
            key={wt}
            type="button"
            onClick={() => onChange(wt)}
            whileTap={{ scale: 0.98 }}
            transition={{ duration: 0.12 }}
            className={`text-left rounded-xl border px-4 py-3 transition-colors ${
              value === wt
                ? "border-foreground bg-foreground/[0.03]"
                : "hover:border-foreground/30"
            }`}
          >
            <div className="text-sm font-semibold tracking-tight capitalize">{wt}</div>
            <div className="text-[11px] text-muted-foreground tracking-tight mt-0.5">
              {wt === "interior"
                ? "Inside a home — rooms, plants, art, things in use."
                : "A home from outside — house, garden, porch, the life around it."}
            </div>
          </motion.button>
        ))}
      </div>
    </div>
  );
}

// ── Before-after step (upload + transformation prompt) ────────────────────

function BeforeAfterStep({
  beforeImageUrl,
  beforeAspect,
  onUploaded,
  transformationPrompt,
  onTransformationChange,
}: {
  beforeImageUrl: string | null;
  beforeAspect: AspectRatio | null;
  onUploaded: (url: string, aspect: AspectRatio) => void;
  transformationPrompt: string;
  onTransformationChange: (s: string) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  async function handleFile(file: File) {
    if (uploading) return;
    setUploading(true);
    const toastId = toast.loading("Uploading…");
    try {
      const form = new FormData();
      form.set("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: form });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { url: string; aspectRatio: AspectRatio };
      onUploaded(data.url, data.aspectRatio);
      toast.success(`Uploaded (${data.aspectRatio})`, { id: toastId });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error("Upload failed", { id: toastId, description: message });
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files?.[0];
          if (file) void handleFile(file);
        }}
        onClick={() => inputRef.current?.click()}
        className={`relative cursor-pointer rounded-xl border-2 border-dashed transition-colors flex flex-col items-center justify-center gap-2 p-6 ${
          dragOver
            ? "border-foreground bg-foreground/[0.04]"
            : "border-foreground/30 hover:border-foreground/60"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
          }}
        />
        {beforeImageUrl ? (
          <div className="flex flex-col items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={beforeImageUrl}
              alt="Before"
              className="max-h-[280px] rounded-md border bg-muted/30"
            />
            <div className="text-xs text-muted-foreground tracking-tight">
              Before · {beforeAspect} — click to replace
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-1.5 py-6">
            <div className="text-sm tracking-tight">
              {uploading ? "Uploading…" : "Drop a photo or click to choose"}
            </div>
            <div className="text-[11px] text-muted-foreground">
              JPEG, PNG, or WebP · max 8MB
            </div>
          </div>
        )}
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          Transformation
        </span>
        <textarea
          value={transformationPrompt}
          onChange={(e) => onTransformationChange(e.target.value)}
          rows={3}
          placeholder="Modernize this kitchen — walnut cabinets, terrazzo floor, soft north-skylight, stripped of all clutter."
          className="w-full rounded-md border bg-transparent px-3 py-2 text-sm focus:border-foreground outline-none resize-none tracking-tight"
        />
        <span className="text-[11px] text-muted-foreground tracking-tight">
          What should change about the before? Be specific — materials, light, mood.
        </span>
      </label>
    </div>
  );
}

// ── World chooser (write or AI-suggest) ─────────────────────────────────────

type Mode = "write" | "ai";

function WorldChooser({
  niche,
  onNiche,
  format,
  worldType,
  presets,
  placeholderExample,
}: {
  niche: string;
  onNiche: (s: string) => void;
  format: Format;
  worldType: WorldType;
  presets: string[];
  /** One sampled example from NICHE_POOL[worldType], stable per session.
   *  Replaces the old static "e.g. ..." string so the operator sees a
   *  different lineage on every visit. */
  placeholderExample: string;
}) {
  const [mode, setMode] = useState<Mode>("write");
  const [suggesting, setSuggesting] = useState(false);
  const [rationale, setRationale] = useState<string | null>(null);
  const aiNicheRef = useRef<string>("");
  const writeNicheRef = useRef<string>("");
  // Tracks the in-flight suggest request so we can cancel it when the
  // operator switches modes or kicks off a new request. Without this,
  // a stale Claude response overwrites the input the user has since cleared.
  const inflightController = useRef<AbortController | null>(null);
  // Niches Claude has proposed and the operator has rejected. Persisted to
  // localStorage so the avoid-list is non-empty even on a fresh session's
  // first click — otherwise Claude gets identical input every time and keeps
  // proposing the same "obvious gap" answer. Capped at 30.
  const REJECTED_KEY = "frxkb-rejected-niches";
  const REJECTED_CAP = 30;
  const rejectedNichesRef = useRef<string[]>([]);

  // Hydrate the rejected list once on mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(REJECTED_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          rejectedNichesRef.current = parsed.filter((s) => typeof s === "string").slice(0, REJECTED_CAP);
        }
      }
    } catch {
      // Corrupted storage — ignore, start fresh.
    }
  }, []);

  function rememberRejection(niche: string) {
    if (!niche) return;
    const next = [niche, ...rejectedNichesRef.current.filter((n) => n !== niche)].slice(0, REJECTED_CAP);
    rejectedNichesRef.current = next;
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(REJECTED_KEY, JSON.stringify(next));
      } catch {
        // Storage full / disabled — degrade gracefully.
      }
    }
  }

  const suggestRequest = useCallback(async () => {
    // Whatever Claude proposed last is now considered rejected — record it
    // before we ask for another. Persisted to localStorage so it survives
    // page refresh / new sessions.
    if (aiNicheRef.current) rememberRejection(aiNicheRef.current);

    // Cancel any previous in-flight suggest before starting a new one.
    inflightController.current?.abort();
    const controller = new AbortController();
    inflightController.current = controller;

    setSuggesting(true);
    setRationale(null);
    onNiche(""); // clear while we wait so the loading state is honest
    const toastId = toast.loading("Looking for an underexplored world…");
    try {
      const res = await fetch("/api/concepts/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          format,
          worldType,
          // Hard cap at 20 so the prompt doesn't bloat. Most-recent first.
          recentlyShown: rejectedNichesRef.current.slice(0, 20),
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      // If we got pre-empted (mode switched, new request started), discard.
      if (controller.signal.aborted) {
        toast.dismiss(toastId);
        return;
      }
      aiNicheRef.current = data.niche;
      onNiche(data.niche);
      setRationale(data.rationale ?? null);
      toast.success("World proposed", { id: toastId });
    } catch (err) {
      // Aborted requests aren't failures — they're intentional cancellations.
      if (err instanceof DOMException && err.name === "AbortError") {
        toast.dismiss(toastId);
        return;
      }
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error("Couldn't propose a world", { id: toastId, description: message });
    } finally {
      // Only flip the loading flag if THIS request is still the current one.
      if (inflightController.current === controller) {
        setSuggesting(false);
        inflightController.current = null;
      }
    }
  }, [format, worldType, onNiche]);

  // Switch handler: preserve text on each side. Never auto-fires Claude —
  // suggestion only happens when the operator clicks the button.
  function switchMode(next: Mode) {
    if (next === mode) return;
    if (mode === "write") writeNicheRef.current = niche;
    else aiNicheRef.current = niche;

    // Cancel any pending suggest if we're leaving AI mode — otherwise the
    // late response would overwrite the write-mode input.
    if (mode === "ai") {
      inflightController.current?.abort();
      inflightController.current = null;
      setSuggesting(false);
    }

    setMode(next);
    if (next === "write") {
      onNiche(writeNicheRef.current);
      setRationale(null);
    } else {
      // Show the cached suggestion if there is one; otherwise leave the input
      // empty so the operator's first action is hitting the button.
      onNiche(aiNicheRef.current);
    }
  }

  // Edits in AI mode override the cached suggestion (operator is now driving).
  function onInputChange(v: string) {
    onNiche(v);
    if (mode === "ai") aiNicheRef.current = v;
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Mode selector */}
      <div className="inline-flex self-start rounded-lg border p-1 bg-muted/30">
        <ModeTab active={mode === "write"} onClick={() => switchMode("write")} label="Write your own" />
        <ModeTab active={mode === "ai"} onClick={() => switchMode("ai")} label="Suggest one" />
      </div>

      {/* Hero input — shared across modes; the input IS the world. */}
      <div className="flex flex-col gap-2">
        <div className="relative">
          <input
            type="text"
            value={niche}
            onChange={(e) => onInputChange(e.target.value)}
            placeholder={
              suggesting
                ? "Thinking…"
                : mode === "ai"
                  ? "Edit if you'd like, or suggest another."
                  : `e.g. ${placeholderExample}`
            }
            disabled={suggesting}
            autoFocus={mode === "write"}
            className={`w-full text-2xl sm:text-3xl tracking-tight font-medium border-b bg-transparent py-3 outline-none transition-colors placeholder:font-normal ${
              suggesting
                ? "border-foreground/30 placeholder:text-foreground/40 animate-pulse"
                : "border-foreground/30 focus:border-foreground placeholder:text-muted-foreground/50"
            }`}
          />
        </div>
        {rationale && !suggesting && (
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3, ease }}
            className="text-xs text-muted-foreground tracking-tight leading-relaxed"
          >
            <span className="text-foreground">Why this:</span> {rationale}
          </motion.p>
        )}
      </div>

      <AnimatePresence mode="wait">
        {mode === "write" ? (
          <motion.div
            key="write"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2, ease }}
            className="flex flex-col gap-2"
          >
            <span className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
              Try one
            </span>
            <div className="flex flex-wrap gap-1.5">
              {presets.map((n) => (
                <motion.button
                  key={n}
                  type="button"
                  whileTap={{ scale: 0.97 }}
                  onClick={() => onNiche(n)}
                  className={`text-[11px] rounded-full border px-3 py-1.5 tracking-tight transition-colors ${
                    niche === n
                      ? "bg-foreground text-background border-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent"
                  }`}
                >
                  {n}
                </motion.button>
              ))}
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="ai"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2, ease }}
            className="flex items-center justify-between gap-4 rounded-xl border border-dashed p-4"
          >
            <span className="text-xs text-muted-foreground tracking-tight max-w-md leading-relaxed">
              Claude looks at past worlds and the ones you&apos;ve skipped, then
              proposes a fresh save-worthy one.
            </span>
            <motion.button
              type="button"
              onClick={() => void suggestRequest()}
              disabled={suggesting}
              whileTap={suggesting ? undefined : { scale: 0.97 }}
              transition={{ duration: 0.12 }}
              className="inline-flex h-10 items-center gap-2 rounded-md bg-foreground px-5 text-sm text-background font-medium tracking-tight hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed transition-opacity whitespace-nowrap"
            >
              {suggesting
                ? "Thinking…"
                : `${aiNicheRef.current ? "Suggest another" : "Suggest a world"} (~${formatCost(estimateSuggestWorld())})`}
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ModeTab({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-xs px-3 py-1.5 rounded-md tracking-tight transition-colors ${
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
}

// ── Number field ───────────────────────────────────────────────────────────

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground tracking-tight">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || min)}
        disabled={disabled}
        className="rounded-md border bg-transparent px-3 py-2 text-sm focus:border-foreground outline-none disabled:opacity-50"
      />
    </label>
  );
}
