import { NextResponse } from "next/server";
import { z } from "zod";
import { approveAllGeneratedScenes } from "@/lib/projects-db";
import { withSessionOperator } from "@/lib/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PostBody = z.object({
  /** approve-ready: flip every "generated" scene to "approved" in one shot.
   *  (Regenerate-rejected already exists as POST /generate without force —
   *  its default targets are pending + rejected scenes.) */
  action: z.literal("approve-ready"),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  let body: unknown;
  try {
    body = await req.json();
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
      const approved = await approveAllGeneratedScenes(id);
      return NextResponse.json({ approved });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[api/projects/[id]/scenes/batch] failed:", err);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  });
}
