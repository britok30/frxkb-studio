import { NextResponse } from "next/server";
import { buildAuthorizeUrl, signState } from "@/lib/instagram";
import { withSessionOperator } from "@/lib/route-helpers";
import { currentOperator } from "@/lib/operators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The callback URL Instagram redirects to. Must match the app's configured
 *  redirect URI exactly (https). Override with INSTAGRAM_REDIRECT_URI. */
function instagramRedirectUri(req: Request): string {
  return process.env.INSTAGRAM_REDIRECT_URI ?? `${new URL(req.url).origin}/api/social/instagram/callback`;
}

/** Start the Instagram OAuth dance for the signed-in operator. */
export async function GET(req: Request): Promise<Response> {
  return withSessionOperator(async () => {
    try {
      const url = buildAuthorizeUrl({
        redirectUri: instagramRedirectUri(req),
        state: signState({ email: currentOperator().email }),
      });
      return NextResponse.redirect(url);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  });
}
