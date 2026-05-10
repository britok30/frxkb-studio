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
  it("multiplies image count by per-image price", () => {
    expect(estimateImageBatch(60)).toBeCloseTo(60 * 0.225, 6);
    expect(estimateImageBatch(1)).toBeCloseTo(0.225, 6);
  });

  it("returns 0 for zero or negative count", () => {
    expect(estimateImageBatch(0)).toBe(0);
    expect(estimateImageBatch(-5)).toBe(0);
  });
});

describe("estimateThumbnail", () => {
  it("equals one nano-banana image", () => {
    expect(estimateThumbnail()).toBe(FAL_NANO_BANANA_PER_IMAGE);
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
  it("yt-long with 60 scenes is roughly $13.80-$14.20", () => {
    const total = estimateProjectTotal("yt-long", 60);
    expect(total).toBeGreaterThan(13.8);
    expect(total).toBeLessThan(14.2);
  });

  it("reel with 5 scenes is roughly $1.30-$1.55", () => {
    const total = estimateProjectTotal("reel", 5);
    expect(total).toBeGreaterThan(1.3);
    expect(total).toBeLessThan(1.55);
  });

  it("carousel with 10 slides is roughly $2.45-$2.75 (new default)", () => {
    const total = estimateProjectTotal("carousel", 10);
    expect(total).toBeGreaterThan(2.45);
    expect(total).toBeLessThan(2.75);
  });

  it("scales with scene count — 120 scenes costs more than 60", () => {
    const sixty = estimateProjectTotal("yt-long", 60);
    const oneTwenty = estimateProjectTotal("yt-long", 120);
    expect(oneTwenty).toBeGreaterThan(sixty);
    // Roughly: 60 more scenes × $0.225 = $13.50 + extra Claude tokens.
    expect(oneTwenty - sixty).toBeGreaterThan(13.4);
  });

  it("decomposes cleanly: total = scripting + images + finalize", () => {
    const sceneCount = 60;
    const total = estimateProjectTotal("yt-long", sceneCount);
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

  it("topaz above-1080p output is $0.08/sec (default for our 720p→1440p path)", () => {
    expect(FAL_TOPAZ_PER_SECOND_GT_1080P).toBe(0.08);
    expect(estimateTopazUpscale(15)).toBeCloseTo(15 * 0.08, 6);
  });

  it("topaz tier picker", () => {
    expect(estimateTopazUpscale(10, "le-720p")).toBeCloseTo(0.1, 6);
    expect(estimateTopazUpscale(10, "le-1080p")).toBeCloseTo(0.2, 6);
    expect(estimateTopazUpscale(10, "gt-1080p")).toBeCloseTo(0.8, 6);
  });

  it("animate batch for a 5×3s reel is in the $4.50-$5.20 range", () => {
    const total = estimateAnimateBatch(5, 3);
    expect(total).toBeGreaterThan(4.5);
    expect(total).toBeLessThan(5.2);
  });

  it("animate batch scales linearly with total seconds", () => {
    const five = estimateAnimateBatch(5, 3); // 15s
    const ten = estimateAnimateBatch(10, 3); // 30s
    // Roughly 2× the per-sec (seedance + topaz) costs, plus a smaller Claude bump.
    const perSecCost = FAL_SEEDANCE_FAST_PER_SECOND_720P + FAL_TOPAZ_PER_SECOND_GT_1080P;
    expect(ten - five).toBeGreaterThan(15 * perSecCost * 0.95);
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
