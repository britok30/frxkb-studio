import { NextResponse } from "next/server";
import { finalizeProject, ProjectBusyError } from "@/lib/projects";
import { updateStitchState } from "@/lib/projects-db";
import { requireProjectOwnership, withSessionOperator } from "@/lib/route-helpers";
import { currentOperator } from "@/lib/operators";
import { inngest } from "@/inngest/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One GPT metadata call; the auto-stitch is ENQUEUED, never rendered here.
export const maxDuration = 120;

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  return withSessionOperator(async () => {
    const denied = await requireProjectOwnership(id);
    if (denied) return denied;
    try {
      const result = await finalizeProject(id);
      // Auto-stitch rides the same background pipeline as the stitch panel.
      // Soft-fail: an enqueue hiccup must never un-finalize the project.
      if (result.autoStitch) {
        try {
          await updateStitchState(id, "queued");
          await inngest.send({
            name: "project/stitch.requested",
            data: { projectId: id, operatorEmail: currentOperator().email, opts: {} },
          });
        } catch (err) {
          console.warn("[finalize] auto-stitch enqueue failed (project stays finalized):", err);
        }
      }
      return NextResponse.json(result);
    } catch (err) {
      if (err instanceof ProjectBusyError) {
        return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
      }
      const message = err instanceof Error ? err.message : "Unknown error";
      if (/not found/i.test(message)) {
        return NextResponse.json({ error: message }, { status: 404 });
      }
      if (/cannot finalize|no generated scenes|no concept/i.test(message)) {
        return NextResponse.json({ error: message }, { status: 409 });
      }
      console.error("[api/projects/[id]/finalize] failed:", err);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  });
}
