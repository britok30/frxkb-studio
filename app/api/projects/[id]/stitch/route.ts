import { NextResponse } from "next/server";
import { z } from "zod";
import { withSessionOperator } from "@/lib/route-helpers";
import { currentOperator } from "@/lib/operators";
import { prepareStitch } from "@/lib/projects";
import { updateStitchState } from "@/lib/projects-db";
import { inngest } from "@/inngest/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Enqueue + a validation dry-run only — the render lives in Inngest
// (stitch-project), free of request-bound duration limits.
export const maxDuration = 60;

const PostBody = z.object({
  /** Optional music bed (public Blob URL from /api/upload). Spans the whole
   *  timeline and REPLACES the per-clip ambient audio — the fix for each
   *  seedance segment carrying a different ambience. Omit to keep the native
   *  per-clip audio. */
  musicUrl: z.string().url().optional(),
  /** Style-explorer only: seconds each still holds on screen (uniform).
   *  Chapters in the description land at i × perStillSec. */
  perStillSec: z.number().int().min(3).max(15).optional(),
  /** Style-explorer only: loop the sequence until the video reaches at least
   *  this many minutes (whole cycles). 8+ unlocks YouTube mid-rolls. */
  targetMinutes: z.number().int().min(1).max(20).optional(),
  /** Music file duration in seconds (read client-side) — lets the server
   *  tile the bed so long videos don't go silent when the song ends. */
  musicDurationSec: z.number().positive().max(3600).optional(),
});

/**
 * Enqueue a stitch job. prepareStitch runs here first as a validation
 * dry-run (cheap, no vendor calls) so "not animated yet"-class errors reach
 * the operator immediately instead of dying in a background job.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  let body: unknown = {};
  try {
    const text = await req.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = PostBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  return withSessionOperator(async () => {
    try {
      await prepareStitch(id, parsed.data); // validation dry-run
      const op = currentOperator();
      await updateStitchState(id, "queued");
      await inngest.send({
        name: "project/stitch.requested",
        data: { projectId: id, operatorEmail: op.email, opts: parsed.data },
      });
      return NextResponse.json({ enqueued: true }, { status: 202 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      if (/not found/i.test(message)) {
        return NextResponse.json({ error: message }, { status: 404 });
      }
      if (/only available|not animated|not generated|Missing the before|Animate the after/i.test(message)) {
        return NextResponse.json({ error: message }, { status: 400 });
      }
      console.error("[api/projects/[id]/stitch] enqueue failed:", err);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  });
}
