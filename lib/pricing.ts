/**
 * Cost estimation for studio operations. Numbers verified against vendor
 * pricing pages on 2026-05-09 (see project memory for sources). Update this
 * file when prices change — every UI cost label reads from here.
 *
 * All prices stored in **dollars** (not cents) to keep math obvious; format
 * with `formatCost` for display.
 */

import type { Format } from "@/lib/prompts/types";

// ── Vendor prices ────────────────────────────────────────────────────────────

/** fal.ai nano-banana-pro (Gemini 3 Pro Image). We default to 2K resolution
 *  ($0.225/img). 1K is $0.15 (cheaper but visibly softer on Retina), 4K is
 *  $0.30 (overkill for our use). */
export const FAL_NANO_BANANA_PER_IMAGE = 0.225;

/** Seedance 2.0 Fast image-to-video at 720p — $0.2419 per second of video. */
export const FAL_SEEDANCE_FAST_PER_SECOND_720P = 0.2419;

/** Topaz video upscale tiered pricing per second of OUTPUT.
 *  ≤720p: $0.01/s, ≤1080p: $0.02/s, >1080p: $0.08/s. */
export const FAL_TOPAZ_PER_SECOND_LE_720P = 0.01;
export const FAL_TOPAZ_PER_SECOND_LE_1080P = 0.02;
export const FAL_TOPAZ_PER_SECOND_GT_1080P = 0.08;

/** Anthropic Claude Opus 4.7 — $5/MTok input, $25/MTok output. */
export const CLAUDE_OPUS_4_7_INPUT_PER_MTOK = 5;
export const CLAUDE_OPUS_4_7_OUTPUT_PER_MTOK = 25;

/** Cached system prompts (every Claude call we make uses ephemeral cache).
 *  Cache hits are ~90% off input rate; first call pays full price + 25% write
 *  premium. Averaged across calls in a session, effective input rate is
 *  roughly 30% of headline. We approximate at 0.4× to be honest about the
 *  first-call write premium. */
const CLAUDE_CACHE_INPUT_DISCOUNT_FACTOR = 0.4;

// ── Token estimates per call type ────────────────────────────────────────────
//
// These are empirical averages from inspecting a few projects' Claude calls.
// Tweak when prompts change materially. Output tokens dominate — input is
// largely cached.

const CLAUDE_INPUT_TOKENS = {
  concept: 2200, // system + user
  sceneGen: 2400, // system + user with concept context
  metadata: 2300, // system + user with concept + format/duration
  suggestWorld: 1800, // system + format + history (~10 niches at ~30 tok each)
};

const CLAUDE_OUTPUT_TOKENS = {
  concept: 600, // workingTitle + hook + vibe + notes + signature + keywords
  sceneGenPerScene: 100, // each scene prompt ~80-120 tokens
  sceneGenOverhead: 200, // tool boilerplate
  metadata: 1500, // title + alts + description + tags + caption + hashtags + pinned
  suggestWorld: 200, // niche + rationale
};

// ── Per-call cost helpers ────────────────────────────────────────────────────

function claudeCost(inputTokens: number, outputTokens: number): number {
  const inputCost =
    (inputTokens / 1_000_000) *
    CLAUDE_OPUS_4_7_INPUT_PER_MTOK *
    CLAUDE_CACHE_INPUT_DISCOUNT_FACTOR;
  const outputCost = (outputTokens / 1_000_000) * CLAUDE_OPUS_4_7_OUTPUT_PER_MTOK;
  return inputCost + outputCost;
}

export function estimateConceptGen(): number {
  return claudeCost(CLAUDE_INPUT_TOKENS.concept, CLAUDE_OUTPUT_TOKENS.concept);
}

export function estimateSceneGen(sceneCount: number): number {
  const out =
    CLAUDE_OUTPUT_TOKENS.sceneGenOverhead +
    CLAUDE_OUTPUT_TOKENS.sceneGenPerScene * Math.max(0, sceneCount);
  return claudeCost(CLAUDE_INPUT_TOKENS.sceneGen, out);
}

export function estimateMetadataGen(): number {
  return claudeCost(CLAUDE_INPUT_TOKENS.metadata, CLAUDE_OUTPUT_TOKENS.metadata);
}

export function estimateSuggestWorld(): number {
  return claudeCost(CLAUDE_INPUT_TOKENS.suggestWorld, CLAUDE_OUTPUT_TOKENS.suggestWorld);
}

export function estimateImageBatch(imageCount: number): number {
  return Math.max(0, imageCount) * FAL_NANO_BANANA_PER_IMAGE;
}

export function estimateThumbnail(): number {
  return FAL_NANO_BANANA_PER_IMAGE;
}

// ── Phase totals ─────────────────────────────────────────────────────────────

/** Cost of project creation only (concept brief + scene-prompt generation).
 *  Doesn't include images or finalize. */
export function estimateProjectScripting(sceneCount: number): number {
  return estimateConceptGen() + estimateSceneGen(sceneCount);
}

/** Cost of running the full image batch on a project. */
export function estimateBatchImages(sceneCount: number): number {
  return estimateImageBatch(sceneCount);
}

/** Cost of finalize — Claude metadata + nano-banana thumbnail. */
export function estimateFinalize(): number {
  return estimateMetadataGen() + estimateThumbnail();
}

// ── Video pipeline (reels) ──────────────────────────────────────────────────

/** Seedance 2.0 Fast image-to-video at 720p, billed per second of output. */
export function estimateSeedance(durationSec: number): number {
  return Math.max(0, durationSec) * FAL_SEEDANCE_FAST_PER_SECOND_720P;
}

/** Topaz upscale cost. Default path: 720p → 1440p (2× upscale → above 1080p). */
export function estimateTopazUpscale(
  durationSec: number,
  outputTier: "le-720p" | "le-1080p" | "gt-1080p" = "gt-1080p"
): number {
  const rate =
    outputTier === "le-720p"
      ? FAL_TOPAZ_PER_SECOND_LE_720P
      : outputTier === "le-1080p"
        ? FAL_TOPAZ_PER_SECOND_LE_1080P
        : FAL_TOPAZ_PER_SECOND_GT_1080P;
  return Math.max(0, durationSec) * rate;
}

/** Cost of one motion-prompts batch (single Claude call for N scenes). */
export function estimateMotionPromptsGen(sceneCount: number): number {
  // Reuses the same rough shape as scene-prompt gen — system prompt is cached,
  // each motion is ~30-50 output tokens.
  const inputTokens = 1800;
  const outputTokens = 200 + sceneCount * 60;
  return claudeCost(inputTokens, outputTokens);
}

/** All-in cost of the animate step for N scenes at D seconds each. Includes
 *  motion prompts + seedance + Topaz upscale (defaults to gt-1080p tier
 *  since our default is 720p → 1440p Proteus 2×). */
export function estimateAnimateBatch(sceneCount: number, perSceneDurationSec: number): number {
  const totalSec = sceneCount * Math.max(0, perSceneDurationSec);
  return (
    estimateMotionPromptsGen(sceneCount) +
    estimateSeedance(totalSec) +
    estimateTopazUpscale(totalSec, "gt-1080p")
  );
}

/** All-in cost of producing one project end-to-end (scripting → images →
 *  finalize), assuming no scene rejects/regens. */
export function estimateProjectTotal(_format: Format, sceneCount: number): number {
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
