import { NextResponse } from "next/server";
import { z } from "zod";
import { listSceneVersions, restoreSceneVersion } from "@/lib/projects";
import { requireProjectOwnership, withSessionOperator } from "@/lib/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PostBody = z.object({
  /** Version to restore as the scene's active image. The current active
   *  render swaps into the history — nothing is lost. */
  versionId: z.string().min(1),
});

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string; sceneId: string }> }
): Promise<Response> {
  const { id, sceneId } = await ctx.params;
  if (!id || !sceneId) {
    return NextResponse.json({ error: "Missing id or sceneId" }, { status: 400 });
  }

  return withSessionOperator(async () => {
    try {
      const versions = await listSceneVersions(id, sceneId);
      return NextResponse.json({ versions });
    } catch (err) {
      return errorResponse(err);
    }
  });
}

export async function POST(
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

  const parsed = PostBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  return withSessionOperator(async () => {
    const denied = await requireProjectOwnership(id);
    if (denied) return denied;
    try {
      const scene = await restoreSceneVersion(id, sceneId, parsed.data.versionId);
      return NextResponse.json({ scene });
    } catch (err) {
      return errorResponse(err);
    }
  });
}

function errorResponse(err: unknown) {
  const message = err instanceof Error ? err.message : "Unknown error";
  if (/not found/i.test(message)) {
    return NextResponse.json({ error: message }, { status: 404 });
  }
  if (/does not belong/i.test(message)) {
    return NextResponse.json({ error: message }, { status: 400 });
  }
  console.error("[api/.../versions] failed:", err);
  return NextResponse.json({ error: message }, { status: 500 });
}
