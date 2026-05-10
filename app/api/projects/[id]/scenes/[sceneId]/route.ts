import { NextResponse } from "next/server";
import { z } from "zod";
import { applySceneAction } from "@/lib/projects";
import { withSessionOperator } from "@/lib/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const PatchBody = z.object({
  action: z.enum(["approve", "reject", "regenerate"]),
});

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string; sceneId: string }> }
): Promise<Response> {
  const { id, sceneId } = await ctx.params;
  if (!id || !sceneId) {
    return NextResponse.json({ error: "Missing id or sceneId" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = PatchBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  return withSessionOperator(async () => {
    try {
      const scene = await applySceneAction(id, sceneId, parsed.data.action);
      return NextResponse.json({ scene });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      if (/not found/i.test(message)) {
        return NextResponse.json({ error: message }, { status: 404 });
      }
      if (/does not belong/i.test(message)) {
        return NextResponse.json({ error: message }, { status: 400 });
      }
      console.error("[api/projects/[id]/scenes/[sceneId]] failed:", err);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  });
}
