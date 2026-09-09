import { NextResponse } from "next/server";
import { deleteSocialAccount } from "@/lib/social-db";
import { withSessionOperator } from "@/lib/route-helpers";
import { currentOperator } from "@/lib/operators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Disconnect (forgets the token; posts already published stay published). */
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await ctx.params;
  return withSessionOperator(async () => {
    try {
      const ok = await deleteSocialAccount(id, currentOperator().email);
      if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
      return NextResponse.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  });
}
