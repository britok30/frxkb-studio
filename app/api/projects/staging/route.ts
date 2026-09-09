import { NextResponse } from "next/server";
import { z } from "zod";
import { createStagingProject } from "@/lib/projects";
import {
  AspectRatioSchema,
  STAGING_MAX_FURNITURE_REFS,
  StagingStyleIdSchema,
} from "@/lib/prompts/types";
import { withSessionOperator } from "@/lib/route-helpers";
import { assertWithinDailyBudget, BudgetExceededError } from "@/lib/spend";
import { estimateProjectTotal } from "@/lib/pricing";
import { currentOperator } from "@/lib/operators";
import { inngest } from "@/inngest/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One GPT-6 vision call (the staging brief) — interactive, bounded. The
// image render itself is ENQUEUED, never awaited here.
export const maxDuration = 300;

const Body = z.object({
  /** Public Vercel Blob URL returned by /api/upload. */
  beforeImageUrl: z.string().url(),
  /** Snapped aspect ratio returned by /api/upload. */
  aspectRatio: AspectRatioSchema,
  roomType: z.string().min(2).max(60).optional(),
  styleId: StagingStyleIdSchema.optional(),
  brief: z.string().max(1000).optional(),
  furnitureReferenceUrls: z.array(z.string().url()).max(STAGING_MAX_FURNITURE_REFS).optional(),
});

/**
 * Create a virtual-staging project from an already-uploaded empty-room photo
 * and immediately enqueue the after render, so the operator lands on the
 * project page with the staging already in flight (one photo, one after —
 * there is nothing to review between "create" and "generate").
 */
export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  return withSessionOperator(async () => {
    try {
      // Whole-package estimate up front: the brief call happens in this
      // request, the render right after it in the background.
      try {
        await assertWithinDailyBudget(estimateProjectTotal("staging", 2));
      } catch (budgetErr) {
        if (budgetErr instanceof BudgetExceededError) {
          return NextResponse.json({ error: budgetErr.message }, { status: 402 });
        }
        throw budgetErr;
      }
      const result = await createStagingProject(parsed.data);
      // Auto-start the after. Soft-fail: an enqueue hiccup leaves a normal
      // "scripting" project the operator can Generate by hand.
      let enqueued = false;
      try {
        await inngest.send({
          name: "project/generate.requested",
          data: { projectId: result.project.id, operatorEmail: currentOperator().email },
        });
        enqueued = true;
      } catch (err) {
        console.warn("[api/projects/staging] auto-generate enqueue failed:", err);
      }
      return NextResponse.json({ ...result, enqueued }, { status: 201 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[api/projects/staging] failed:", err);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  });
}
