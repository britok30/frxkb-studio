/**
 * Cost estimation for studio operations. Numbers verified against vendor
 * pricing pages on 2026-07-17 (fal model pages + OpenAPI schemas). Update
 * this file when prices change — every UI cost label reads from here.
 *
 * All prices stored in **dollars** (not cents) to keep math obvious; format
 * with `formatCost` for display.
 */

import { defaultsForFormat, type Format } from "@/lib/prompts/types";

// ── Vendor prices ────────────────────────────────────────────────────────────

/** fal.ai nano-banana-pro (Gemini 3 Pro Image). We default to 2K resolution
 *  ($0.225/img). 1K is $0.15 (cheaper but visibly softer on Retina), 4K is
 *  $0.30 — used by hero-quality projects. */
export const FAL_NANO_BANANA_PER_IMAGE = 0.225;
export const FAL_NANO_BANANA_PER_IMAGE_4K = 0.3;

/** fal.ai nano-banana-pro/edit — flat $0.15/image at 1K/2K (4K is $0.30).
 *  Used for non-anchor scenes to lock visual continuity against an anchor
 *  image. Cheaper per call than text-to-image at 2K. */
export const FAL_NANO_BANANA_EDIT_PER_IMAGE = 0.15;
export const FAL_NANO_BANANA_EDIT_PER_IMAGE_4K = 0.3;

/** Seedance 2.0 standard image-to-video, token-billed by pixels:
 *  tokens = (height × width × duration × 24) / 1024 at $0.014/1k tokens.
 *  Works out per second of output to the rates below (720p matches the
 *  advertised $0.3024/s flat rate exactly). The old Fast tier was $0.2419/s
 *  at 720p but caps there and lacks end_image_url, so we run standard. */
export const FAL_SEEDANCE_PER_SECOND: Record<"480p" | "720p" | "1080p" | "4k", number> = {
  "480p": 0.1345,
  "720p": 0.3024,
  "1080p": 0.6804,
  "4k": 2.7216,
};

/** Seedance 2.0 FAST tier at 720p (fal, 2026-07). Same output quality per
 *  fal's docs, lower latency, ~2.8× cheaper than full-tier 1080p — the
 *  standard-quality reel path (Topaz 3× recovers the resolution). */
export const FAL_SEEDANCE_FAST_720P_PER_SECOND = 0.2419;

/** Topaz video upscale tiered pricing per second of OUTPUT.
 *  ≤720p: $0.01/s, ≤1080p: $0.02/s, >1080p: $0.08/s.
 *  Doubles when target_fps is set (Apollo frame-interpolation surcharge). */
export const FAL_TOPAZ_PER_SECOND_LE_720P = 0.01;
export const FAL_TOPAZ_PER_SECOND_LE_1080P = 0.02;
export const FAL_TOPAZ_PER_SECOND_GT_1080P = 0.08;
/** Multiplier applied to the tier rate when target_fps is set. Default
 *  pipeline upscales 24fps → 60fps, so the multiplier always applies. */
export const FAL_TOPAZ_FPS_INTERPOLATION_MULTIPLIER = 2;

/** fal ffmpeg-api/compose (final-video stitch) — $0.0002 per second of
 *  output. Rounding error next to seedance; surfaced for completeness. */
export const FAL_COMPOSE_PER_SECOND = 0.0002;

/** OpenAI GPT-5.6 Sol (lib/llm.ts LLM_MODEL) — $5/MTok input, $30/MTok
 *  output, same rates as the gpt-5.5 it replaced. (Reasoning tokens bill as
 *  output; we run reasoning_effort=low so the per-call output stays modest.) */
export const LLM_INPUT_PER_MTOK = 5;
export const LLM_OUTPUT_PER_MTOK = 30;

/** OpenAI auto-caches stable prompt prefixes (our long system prompts) with no
 *  cache_control needed; cached input tokens bill at a steep discount. Averaged
 *  across a session — one uncached call plus cached hits — the effective input
 *  rate lands around 0.4× headline. */
const LLM_CACHE_INPUT_DISCOUNT_FACTOR = 0.4;

// ── Token estimates per call type ────────────────────────────────────────────
//
// These are empirical averages from inspecting a few projects' GPT-5.5 calls.
// Tweak when prompts change materially. Output tokens dominate — input is
// largely cached.

const LLM_INPUT_TOKENS = {
  concept: 2200, // system + user
  sceneGen: 2400, // system + user with concept context
  metadata: 2300, // system + user with concept + format/duration
  suggestWorld: 1800, // system + format + history (~10 niches at ~30 tok each)
};

const LLM_OUTPUT_TOKENS = {
  concept: 600, // workingTitle + hook + vibe + notes + signature + keywords
  sceneGenPerScene: 100, // each scene prompt ~80-120 tokens
  sceneGenOverhead: 200, // tool boilerplate
  metadata: 1500, // title + alts + description + tags + caption + hashtags + pinned
  suggestWorld: 200, // niche + rationale
};

// ── Per-call cost helpers ────────────────────────────────────────────────────

function llmCost(inputTokens: number, outputTokens: number): number {
  const inputCost =
    (inputTokens / 1_000_000) *
    LLM_INPUT_PER_MTOK *
    LLM_CACHE_INPUT_DISCOUNT_FACTOR;
  const outputCost = (outputTokens / 1_000_000) * LLM_OUTPUT_PER_MTOK;
  return inputCost + outputCost;
}

export function estimateConceptGen(): number {
  return llmCost(LLM_INPUT_TOKENS.concept, LLM_OUTPUT_TOKENS.concept);
}

export function estimateSceneGen(sceneCount: number): number {
  const out =
    LLM_OUTPUT_TOKENS.sceneGenOverhead +
    LLM_OUTPUT_TOKENS.sceneGenPerScene * Math.max(0, sceneCount);
  return llmCost(LLM_INPUT_TOKENS.sceneGen, out);
}

export function estimateMetadataGen(): number {
  return llmCost(LLM_INPUT_TOKENS.metadata, LLM_OUTPUT_TOKENS.metadata);
}

export function estimateSuggestWorld(): number {
  return llmCost(LLM_INPUT_TOKENS.suggestWorld, LLM_OUTPUT_TOKENS.suggestWorld);
}

/**
 * Cost of generating N scene images for reel/carousel. The anchor (lowest-
 * order scene) runs text-to-image; every other scene runs /edit conditioned
 * on the anchor so the whole set reads as one home. At standard (2K) that's
 * 1 × $0.225 + (N-1) × $0.15; hero quality renders everything at 4K ($0.30).
 *
 * Before-after pricing is separate (see estimateProjectTotal): the "after"
 * is a legitimate edit of the operator's upload and uses /edit at $0.15.
 */
export function estimateImageBatch(
  imageCount: number,
  quality: "standard" | "hero" = "standard"
): number {
  const n = Math.max(0, imageCount);
  if (n === 0) return 0;
  if (quality === "hero") return n * FAL_NANO_BANANA_PER_IMAGE_4K;
  return FAL_NANO_BANANA_PER_IMAGE + (n - 1) * FAL_NANO_BANANA_EDIT_PER_IMAGE;
}

/** Thumbnail uses nano-banana-pro/edit conditioned on the project's anchor
 *  Deprecated 2026-05-10 — covers now derive live from scenes (no fal call).
 *  Returns 0 so any straggler caller doesn't double-count. */
export function estimateThumbnail(): number {
  return 0;
}

// ── Phase totals ─────────────────────────────────────────────────────────────

/** Cost of project creation only (concept brief + scene-prompt generation).
 *  Doesn't include images or finalize. */
export function estimateProjectScripting(sceneCount: number): number {
  return estimateConceptGen() + estimateSceneGen(sceneCount);
}

/** Cost of running the full image batch on a project. */
export function estimateBatchImages(
  sceneCount: number,
  quality: "standard" | "hero" = "standard"
): number {
  return estimateImageBatch(sceneCount, quality);
}

/** Cost of finalize — GPT-5.5 metadata only. Thumbnail generation was
 *  deprecated; covers derive live from scenes. */
export function estimateFinalize(): number {
  return estimateMetadataGen();
}

// ── Video pipeline (reels) ──────────────────────────────────────────────────

/** Seedance 2.0 standard image-to-video, billed per second of output at the
 *  chosen resolution. Pipeline default is 1080p. */
export function estimateSeedance(
  durationSec: number,
  resolution: "480p" | "720p" | "1080p" | "4k" = "1080p"
): number {
  return Math.max(0, durationSec) * FAL_SEEDANCE_PER_SECOND[resolution];
}

/** Topaz upscale cost. Default path: 720p → 1440p (2× upscale → above 1080p)
 *  with frame interpolation to 60fps (target_fps in lib/topaz.ts), so the
 *  per-second rate doubles via the Apollo surcharge. Pass interpolated=false
 *  to estimate without it. */
export function estimateTopazUpscale(
  durationSec: number,
  outputTier: "le-720p" | "le-1080p" | "gt-1080p" = "gt-1080p",
  interpolated: boolean = true
): number {
  const baseRate =
    outputTier === "le-720p"
      ? FAL_TOPAZ_PER_SECOND_LE_720P
      : outputTier === "le-1080p"
        ? FAL_TOPAZ_PER_SECOND_LE_1080P
        : FAL_TOPAZ_PER_SECOND_GT_1080P;
  const rate = interpolated ? baseRate * FAL_TOPAZ_FPS_INTERPOLATION_MULTIPLIER : baseRate;
  return Math.max(0, durationSec) * rate;
}

/** Cost of one motion-prompts batch (single GPT-5.5 call for N scenes). */
export function estimateMotionPromptsGen(sceneCount: number): number {
  // Reuses the same rough shape as scene-prompt gen — system prompt is cached,
  // each motion is ~30-50 output tokens.
  const inputTokens = 1800;
  const outputTokens = 200 + sceneCount * 60;
  return llmCost(inputTokens, outputTokens);
}

/** All-in cost of the animate step for N scenes at D seconds each.
 *  Standard: Seedance FAST 720p + Topaz 3×→4K30. Hero: Seedance full 1080p
 *  + Topaz 2×→4K60. Both stitch to a supersampled 1080p/30 (hero 60) final. */
export function estimateAnimateBatch(
  sceneCount: number,
  perSceneDurationSec: number,
  quality: "standard" | "hero" = "standard"
): number {
  const totalSec = sceneCount * Math.max(0, perSceneDurationSec);
  const seedance =
    quality === "hero"
      ? estimateSeedance(totalSec, "1080p")
      : totalSec * FAL_SEEDANCE_FAST_720P_PER_SECOND;
  return (
    estimateMotionPromptsGen(sceneCount) +
    seedance +
    estimateTopazUpscale(totalSec, "gt-1080p")
  );
}

/** All-in cost of producing one project end-to-end (scripting → images →
 *  finalize), assuming no scene rejects/regens. Before-after is special:
 *  the "before" image is operator-uploaded (free), only the "after" runs
 *  through fal (1 edit at $0.15), animate runs on the after only (the
 *  upload stays static — animating real photos invites uncanny artifacts),
 *  and the cover is just the after image (no fal call). */
export function estimateProjectTotal(format: Format, sceneCount: number): number {
  if (format === "before-after") {
    const dur = defaultsForFormat("before-after").sceneDurationSec;
    return (
      estimateConceptGen() +
      FAL_NANO_BANANA_EDIT_PER_IMAGE + // 1 edit (the "after")
      estimateAnimateBatch(1, dur) + // only the after animates
      estimateMetadataGen() // metadata only — no thumbnail fal call
    );
  }
  if (format === "style-explorer") {
    // 1 base render (text-to-image) + N styled edits ($0.15 each) + the styles
    // GPT-5.5 call (bigger per-style output than scene gen) + the YouTube
    // metadata GPT-5.5 call. No animation (static stills).
    const styles = Math.max(0, sceneCount);
    const stylesGen = llmCost(2400, 300 + styles * 350);
    return (
      FAL_NANO_BANANA_PER_IMAGE + // base render
      styles * FAL_NANO_BANANA_EDIT_PER_IMAGE + // styled edits
      stylesGen +
      estimateMetadataGen() // YouTube metadata
    );
  }
  return (
    estimateProjectScripting(sceneCount) +
    estimateBatchImages(sceneCount) +
    estimateFinalize()
  );
}

// ── Display ──────────────────────────────────────────────────────────────────

/** Format a USD amount. Uses "<$0.01" for sub-cent values, two decimals
 *  otherwise. Always prefixed with `~` when used as an estimate (caller
 *  decides — this fn returns the bare number). */
export function formatCost(usd: number): string {
  if (usd <= 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  if (usd < 1) return `$${usd.toFixed(2)}`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd)}`;
}
