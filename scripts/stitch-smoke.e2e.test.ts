/**
 * Stitch smoke — re-stitches the existing smoke reel through whichever
 * backend is configured (Shotstack when SHOTSTACK_API_KEY is set). Stage
 * renders are free (watermarked). Opt in explicitly:
 *
 *   STITCH_SMOKE=1 node --env-file=.env.local node_modules/vitest/vitest.mjs run scripts/stitch-smoke.e2e.test.ts
 */
import { describe, it, expect } from "vitest";
import { stitchFinalVideo } from "@/lib/projects";
import { getOperator, withOperator } from "@/lib/operators";
import { isShotstackConfigured } from "@/lib/shotstack";

const RUN = process.env.STITCH_SMOKE === "1";
const REEL_PROJECT_ID = "veHQjQXvcJA6"; // Kyoto Japandi smoke reel

describe.runIf(RUN)("stitch smoke", () => {
  it("re-stitches the smoke reel with the configured backend", { timeout: 10 * 60 * 1000 }, async () => {
    console.log("shotstack configured:", isShotstackConfigured());
    const op = getOperator("britok30@gmail.com");
    if (!op) throw new Error("operator not configured");
    await withOperator(op, async () => {
      const out = await stitchFinalVideo(REEL_PROJECT_ID);
      console.log("final:", out.finalVideoUrl);
      expect(out.finalVideoUrl).toMatch(/^https:/);
    });
  });
});
