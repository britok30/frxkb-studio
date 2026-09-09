import { NextResponse } from "next/server";
import { listSocialAccounts } from "@/lib/social-db";
import { withSessionOperator } from "@/lib/route-helpers";
import { currentOperator } from "@/lib/operators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The signed-in operator's connected accounts (never the tokens). */
export async function GET(): Promise<Response> {
  return withSessionOperator(async () => {
    try {
      const rows = await listSocialAccounts(currentOperator().email);
      return NextResponse.json({
        accounts: rows.map((a) => ({
          id: a.id,
          platform: a.platform,
          username: a.username,
          accountType: a.accountType,
          tokenExpiresAt: a.tokenExpiresAt,
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  });
}
