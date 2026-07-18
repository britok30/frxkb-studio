import { describe, it, expect } from "vitest";
import {
  FAL_NANO_BANANA_PER_IMAGE,
  FAL_NANO_BANANA_PER_IMAGE_4K,
  FAL_NANO_BANANA_EDIT_PER_IMAGE,
  FAL_SEEDANCE_PER_SECOND,
  FAL_TOPAZ_PER_SECOND_GT_1080P,
  GPT_5_5_INPUT_PER_MTOK,
  GPT_5_5_OUTPUT_PER_MTOK,
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

  it("GPT-5.5: $5/MTok in, $30/MTok out", () => {
    expect(GPT_5_5_INPUT_PER_MTOK).toBe(5);
    expect(GPT_5_5_OUTPUT_PER_MTOK).toBe(30);
  });
});

describe("estimateImageBatch", () => {
  it("anchor is text-to-image, every other scene is an /edit against it", () => {
    expect(estimateImageBatch(1)).toBeCloseTo(FAL_NANO_BANANA_PER_IMAGE, 6);
    expect(estimateImageBatch(3)).toBeCloseTo(
      FAL_NANO_BANANA_PER_IMAGE + 2 * FAL_NANO_BANANA_EDIT_PER_IMAGE,
      6
    );
    expect(estimateImageBatch(10)).toBeCloseTo(
      FAL_NANO_BANANA_PER_IMAGE + 9 * FAL_NANO_BANANA_EDIT_PER_IMAGE,
      6
    );
  });

  it("hero quality renders everything at 4K", () => {
    expect(estimateImageBatch(3, "hero")).toBeCloseTo(3 * FAL_NANO_BANANA_PER_IMAGE_4K, 6);
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
    // per-scene portion. Differential: 55 scenes × 100 tokens out × $30/Mtok.
    expect(sixty - five).toBeCloseTo((55 * 100 * 30) / 1_000_000, 4);
  });

  it("guards against negative scene count", () => {
    expect(estimateSceneGen(-3)).toBeGreaterThan(0); // input cost still applies
  });
});

describe("estimateProjectTotal (Pro pricing — anchor t2i + /edit chain)", () => {
  it("reel with 3 scenes is roughly $0.55-$0.75 (1 t2i + 2 edits)", () => {
    const total = estimateProjectTotal("reel", 3);
    expect(total).toBeGreaterThan(0.55);
    expect(total).toBeLessThan(0.75);
  });

  it("carousel with 10 slides is roughly $1.60-$1.80 (1 t2i + 9 edits)", () => {
    const total = estimateProjectTotal("carousel", 10);
    expect(total).toBeGreaterThan(1.6);
    expect(total).toBeLessThan(1.8);
  });

  it("scales with scene count — 20 carousel slides costs more than 10", () => {
    const ten = estimateProjectTotal("carousel", 10);
    const twenty = estimateProjectTotal("carousel", 20);
    expect(twenty).toBeGreaterThan(ten);
    // 10 extra slides × $0.15 (/edit) = $1.50 + small GPT-5.5 bump.
    expect(twenty - ten).toBeGreaterThan(1.45);
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
  it("is a small fraction of a dollar (single GPT-5.5 call)", () => {
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
  it("seedance standard is token-billed by pixels — 720p matches the $0.3024/s flat rate, 1080p is the default", () => {
    expect(FAL_SEEDANCE_PER_SECOND["720p"]).toBe(0.3024);
    expect(FAL_SEEDANCE_PER_SECOND["1080p"]).toBe(0.6804);
    expect(FAL_SEEDANCE_PER_SECOND["4k"]).toBe(2.7216);
    expect(estimateSeedance(3)).toBeCloseTo(3 * 0.6804, 6);
    expect(estimateSeedance(3, "720p")).toBeCloseTo(3 * 0.3024, 6);
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

  it("animate batch for a 3×5s reel at standard quality is ~$10.20-$10.50 (native 1080p, no upscale)", () => {
    const total = estimateAnimateBatch(3, 5);
    expect(total).toBeGreaterThan(10.1);
    expect(total).toBeLessThan(10.5);
  });

  it("hero quality adds the Topaz 4K60 pass on top", () => {
    const standard = estimateAnimateBatch(3, 5, "standard");
    const hero = estimateAnimateBatch(3, 5, "hero");
    expect(hero - standard).toBeCloseTo(15 * FAL_TOPAZ_PER_SECOND_GT_1080P * 2, 6);
  });

  it("animate batch scales linearly with total seconds", () => {
    const baseline = estimateAnimateBatch(3, 5); // 15s
    const doubled = estimateAnimateBatch(6, 5); // 30s
    const perSecCost = FAL_SEEDANCE_PER_SECOND["1080p"];
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
