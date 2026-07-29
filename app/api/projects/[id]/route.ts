import { NextResponse } from "next/server";
import { getProjectWithScenes } from "@/lib/projects";
import { withSessionOperator } from "@/lib/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  // Defense in depth: the proxy gates this too, but this route returns full
  // project data and was the ONLY data API with no check of its own during
  // the window when the proxy silently stopped enforcing (07-23 → 07-29).
  return withSessionOperator(async () => {
    try {
      const found = await getProjectWithScenes(id);
      if (!found) return NextResponse.json({ error: "Not found" }, { status: 404 });
      return NextResponse.json(found);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[api/projects/[id]] failed:", err);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  });
}
