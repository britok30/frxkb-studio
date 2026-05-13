import { describe, it, expect } from "vitest";
import {
  FAL_NANO_BANANA_PER_IMAGE,
  FAL_SEEDANCE_FAST_PER_SECOND_720P,
  FAL_TOPAZ_PER_SECOND_GT_1080P,
  CLAUDE_OPUS_4_7_INPUT_PER_MTOK,
  CLAUDE_OPUS_4_7_OUTPUT_PER_MTOK,
  estimateConceptGen,
  estimateSceneGen,
  estimateMetadataGen,
  estimateSuggestWorld,
  estimateImageBatch,
  estimateThumbnail,
  estimateProjectScripting,
  estimateBatchImages,
  estimateFinalize,
  estimateProjectTotal,
  estimateSeedance,
  estimateTopazUpscale,
  estimateAnimateBatch,
  formatCost,
} from "./pricing";

describe("vendor price constants", () => {
  it("nano-banana-pro is $0.225/image at 2K — our default (verified 2026-05-09)", () => {
    expect(FAL_NANO_BANANA_PER_IMAGE).toBe(0.225);
  });

  it("Claude Opus 4.7: $5/MTok in, $25/MTok out", () => {
    expect(CLAUDE_OPUS_4_7_INPUT_PER_MTOK).toBe(5);
    expect(CLAUDE_OPUS_4_7_OUTPUT_PER_MTOK).toBe(25);
  });
});

describe("estimateImageBatch", () => {
  it("every scene is text-to-image (no anchor, no /edit savings — reel/carousel only)", () => {
    expect(estimateImageBatch(1)).toBeCloseTo(FAL_NANO_BANANA_PER_IMAGE, 6);
    expect(estimateImageBatch(3)).toBeCloseTo(3 * FAL_NANO_BANANA_PER_IMAGE, 6);
    expect(estimateImageBatch(10)).toBeCloseTo(10 * FAL_NANO_BANANA_PER_IMAGE, 6);
  });

  it("returns 0 for zero or negative count", () => {
    expect(estimateImageBatch(0)).toBe(0);
    expect(estimateImageBatch(-5)).toBe(0);
  });
});

describe("estimateThumbnail", () => {
  it("is 0 — thumbnail generation deprecated; covers derive from scenes", () => {
    expect(estimateThumbnail()).toBe(0);
  });
});

describe("estimateSceneGen", () => {
  it("scales with scene count (more scenes = more output tokens)", () => {
    const five = estimateSceneGen(5);
    const sixty = estimateSceneGen(60);
    expect(sixty).toBeGreaterThan(five);
    // Output dominates — should scale ~linearly with scene count for the
    // per-scene portion. Differential: 55 scenes × 100 tokens out × $25/Mtok.
    expect(sixty - five).toBeCloseTo((55 * 100 * 25) / 1_000_000, 4);
  });

  it("guards against negative scene count", () => {
    expect(estimateSceneGen(-3)).toBeGreaterThan(0); // input cost still applies
  });
});

describe("estimateProjectTotal (Pro pricing — $0.225/img at 2K)", () => {
  it("reel with 3 scenes is roughly $0.70-$0.90 (3 × text-to-image, no thumbnail)", () => {
    const total = estimateProjectTotal("reel", 3);
    expect(total).toBeGreaterThan(0.7);
    expect(total).toBeLessThan(0.9);
  });

  it("carousel with 10 slides is roughly $2.30-$2.55 (10 × text-to-image, no thumbnail)", () => {
    const total = estimateProjectTotal("carousel", 10);
    expect(total).toBeGreaterThan(2.3);
    expect(total).toBeLessThan(2.55);
  });

  it("scales with scene count — 20 carousel slides costs more than 10", () => {
    const ten = estimateProjectTotal("carousel", 10);
    const twenty = estimateProjectTotal("carousel", 20);
    expect(twenty).toBeGreaterThan(ten);
    // 10 extra slides × $0.225 (text-to-image) = $2.25 + small Claude bump.
    expect(twenty - ten).toBeGreaterThan(2.2);
  });

  it("decomposes cleanly: total = scripting + images + finalize", () => {
    const sceneCount = 10;
    const total = estimateProjectTotal("carousel", sceneCount);
    const sum =
      estimateProjectScripting(sceneCount) +
      estimateBatchImages(sceneCount) +
      estimateFinalize();
    expect(total).toBeCloseTo(sum, 6);
  });
});

describe("estimateSuggestWorld", () => {
  it("is a small fraction of a dollar (single Claude call)", () => {
    const cost = estimateSuggestWorld();
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(0.1);
  });
});

describe("estimateConceptGen + estimateMetadataGen", () => {
  it("both are small per-call costs", () => {
    expect(estimateConceptGen()).toBeGreaterThan(0);
    expect(estimateConceptGen()).toBeLessThan(0.1);
    expect(estimateMetadataGen()).toBeGreaterThan(0);
    expect(estimateMetadataGen()).toBeLessThan(0.1);
  });
});

describe("video pipeline pricing", () => {
  it("seedance fast at 720p is $0.2419/sec", () => {
    expect(FAL_SEEDANCE_FAST_PER_SECOND_720P).toBe(0.2419);
    expect(estimateSeedance(3)).toBeCloseTo(3 * 0.2419, 6);
    expect(estimateSeedance(0)).toBe(0);
  });

  it("topaz above-1080p output is $0.08/sec base (doubles with 60fps interpolation)", () => {
    expect(FAL_TOPAZ_PER_SECOND_GT_1080P).toBe(0.08);
    // Default path runs interpolation (target_fps=60), so the rate doubles.
    expect(estimateTopazUpscale(15)).toBeCloseTo(15 * 0.16, 6);
  });

  it("topaz tier picker (interpolated default)", () => {
    expect(estimateTopazUpscale(10, "le-720p")).toBeCloseTo(0.2, 6);
    expect(estimateTopazUpscale(10, "le-1080p")).toBeCloseTo(0.4, 6);
    expect(estimateTopazUpscale(10, "gt-1080p")).toBeCloseTo(1.6, 6);
  });

  it("topaz interpolated=false uses base rate (24fps passthrough)", () => {
    expect(estimateTopazUpscale(10, "gt-1080p", false)).toBeCloseTo(0.8, 6);
  });

  it("animate batch for a 3×5s reel is in the $5.80-$6.30 range (Apollo 60fps interp included)", () => {
    const total = estimateAnimateBatch(3, 5);
    expect(total).toBeGreaterThan(5.8);
    expect(total).toBeLessThan(6.3);
  });

  it("animate batch scales linearly with total seconds", () => {
    const baseline = estimateAnimateBatch(3, 5); // 15s
    const doubled = estimateAnimateBatch(6, 5); // 30s
    // Roughly 2× the per-sec (seedance + topaz w/ interp) costs, plus a smaller Claude bump.
    const perSecCost =
      FAL_SEEDANCE_FAST_PER_SECOND_720P + FAL_TOPAZ_PER_SECOND_GT_1080P * 2;
    expect(doubled - baseline).toBeGreaterThan(15 * perSecCost * 0.95);
  });
});

describe("formatCost", () => {
  it("formats zero", () => {
    expect(formatCost(0)).toBe("$0.00");
  });

  it("collapses sub-cent to <$0.01", () => {
    expect(formatCost(0.001)).toBe("<$0.01");
    expect(formatCost(0.009)).toBe("<$0.01");
  });

  it("two decimals for sub-dollar", () => {
    expect(formatCost(0.04)).toBe("$0.04");
    expect(formatCost(0.39)).toBe("$0.39");
  });

  it("two decimals for sub-100", () => {
    expect(formatCost(2.34)).toBe("$2.34");
    expect(formatCost(99.99)).toBe("$99.99");
  });

  it("rounds to whole dollars at $100+", () => {
    expect(formatCost(150.7)).toBe("$151");
  });

  it("never returns a negative", () => {
    expect(formatCost(-5)).toBe("$0.00");
  });
});
