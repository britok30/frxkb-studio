import { NextResponse } from "next/server";
import { finalizeProject, ProjectBusyError } from "@/lib/projects";
import { withSessionOperator } from "@/lib/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Metadata + thumbnail call still bounded; no ffmpeg here. Default ~60s is enough.
export const maxDuration = 120;

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  return withSessionOperator(async () => {
    try {
      const result = await finalizeProject(id);
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
