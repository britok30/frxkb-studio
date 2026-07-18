/**
 * REAL end-to-end smoke test — spends real money (fal + seedance + OpenAI).
 * Never runs in the normal suite; opt in explicitly:
 *
 *   SMOKE=1 node --env-file=.env.local node_modules/vitest/vitest.mjs run scripts/smoke.e2e.test.ts
 *
 * Exercises the three paths that changed in the 2026-07-17 overhaul:
 *   1. Reel: anchor-chained stills (t2i → /edit) + seedance standard 1080p
 *      animate with audio.
 *   2. Carousel: chained stills only (4 slides to keep cost down).
 *   3. Before-after: /edit "after" + true first→last-frame morph.
 *
 * Projects land in the real DB so results are reviewable in the dashboard.
 */
import { describe, it, expect } from "vitest";
import {
  animateAllScenes,
  createBeforeAfterProject,
  createProject,
  generateAllImages,
  getProjectWithScenes,
} from "@/lib/projects";
import { getOperator, withOperator } from "@/lib/operators";

const RUN = process.env.SMOKE === "1";
const TIMEOUT = 15 * 60 * 1000;

function operator() {
  const op = getOperator("britok30@gmail.com");
  if (!op) throw new Error("Operator britok30 not configured — check FAL/OPENAI env keys");
  return op;
}

function logScenes(label: string, scenes: Array<Record<string, unknown>>) {
  console.log(`\n=== ${label} ===`);
  for (const s of scenes) {
    console.log(
      JSON.stringify({
        order: s.order,
        status: s.status,
        seed: s.seed,
        imageUrl: s.imageUrl,
        referenceImageUrl: s.referenceImageUrl,
        videoUrl: s.videoUrl,
        durationSec: s.durationSec,
        error: s.error,
      })
    );
  }
}

describe.runIf(RUN)("PROD SMOKE — real spend", () => {
  // Shared across tests so before-after can reuse the reel anchor as its
  // upload stand-in. Vitest runs a file's tests sequentially by default.
  let reelAnchorUrl: string | null = null;

  it(
    "reel: chained stills + 1080p animate",
    { timeout: TIMEOUT },
    async () => {
      await withOperator(operator(), async () => {
        const { project } = await createProject({
          niche: "sunlit Japandi apartment in Kyoto, tatami and pale oak",
          format: "reel",
          worldType: "interior",
          lookId: "golden-hour",
          quality: "standard",
        });
        console.log(`reel project: ${project.id} (${project.title})`);

        const gen = await generateAllImages(project.id);
        console.log("reel generate:", JSON.stringify(gen));
        expect(gen.failed).toBe(0);

        let data = await getProjectWithScenes(project.id);
        logScenes("REEL STILLS", data!.scenes);
        const ordered = [...data!.scenes].sort((a, b) => a.order - b.order);
        // Anchor chained: scene 1 has no reference, scenes 2+ reference the
        // anchor's stored URL; every scene persisted its seed.
        expect(ordered[0].referenceImageUrl).toBeNull();
        for (const s of ordered.slice(1)) {
          expect(s.referenceImageUrl).toBe(ordered[0].imageUrl);
        }
        for (const s of ordered) expect(s.seed).not.toBeNull();
        reelAnchorUrl = ordered[0].imageUrl;

        const anim = await animateAllScenes(project.id);
        console.log("reel animate:", JSON.stringify(anim));
        expect(anim.failed).toBe(0);

        data = await getProjectWithScenes(project.id);
        logScenes("REEL ANIMATED", data!.scenes);
        for (const s of data!.scenes) expect(s.videoUrl).toBeTruthy();
      });
    }
  );

  it(
    "carousel: 4 chained slides",
    { timeout: TIMEOUT },
    async () => {
      await withOperator(operator(), async () => {
        const { project } = await createProject({
          niche: "brutalist hillside house above Los Angeles at dusk",
          format: "carousel",
          worldType: "exterior",
          lookId: "twilight-hero",
          quality: "standard",
          sceneCount: 4,
        });
        console.log(`carousel project: ${project.id} (${project.title})`);

        const gen = await generateAllImages(project.id);
        console.log("carousel generate:", JSON.stringify(gen));
        expect(gen.failed).toBe(0);

        const data = await getProjectWithScenes(project.id);
        logScenes("CAROUSEL STILLS", data!.scenes);
        const ordered = [...data!.scenes].sort((a, b) => a.order - b.order);
        for (const s of ordered.slice(1)) {
          expect(s.referenceImageUrl).toBe(ordered[0].imageUrl);
        }
      });
    }
  );

  it(
    "before-after: /edit after + first→last morph",
    { timeout: TIMEOUT },
    async () => {
      await withOperator(operator(), async () => {
        if (!reelAnchorUrl) throw new Error("reel test must run first (provides the before image)");
        const { project } = await createBeforeAfterProject({
          beforeImageUrl: reelAnchorUrl,
          transformationPrompt:
            "Restyle this room as a moody dark-academia study: walnut bookshelves floor to ceiling, deep green walls, a leather chesterfield, brass picture lights, layered persian rugs.",
          aspectRatio: "9:16",
          worldType: "interior",
        });
        console.log(`before-after project: ${project.id} (${project.title})`);

        const gen = await generateAllImages(project.id);
        console.log("before-after generate:", JSON.stringify(gen));
        expect(gen.failed).toBe(0);

        const anim = await animateAllScenes(project.id);
        console.log("before-after animate:", JSON.stringify(anim));
        expect(anim.failed).toBe(0);

        const data = await getProjectWithScenes(project.id);
        logScenes("BEFORE-AFTER", data!.scenes);
        const after = data!.scenes.find((s) => s.order === 2);
        expect(after?.imageUrl).toBeTruthy();
        expect(after?.videoUrl).toBeTruthy();
      });
    }
  );
});
