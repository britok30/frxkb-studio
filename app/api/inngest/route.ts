import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { functions } from "@/inngest/functions";

export const runtime = "nodejs";
// Inngest invokes this endpoint to drive each function step. Animate runs
// per-scene steps so each invocation carries at most one seedance clip
// (+Topaz on hero) — but a single hero clip can still take several minutes,
// so take the full Fluid-compute ceiling. Generate remains one step; its
// batch is bounded by fal image latency (seconds per image).
export const maxDuration = 800;

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions,
});
