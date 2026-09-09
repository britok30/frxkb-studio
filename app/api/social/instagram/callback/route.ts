import { NextResponse } from "next/server";
import { exchangeCode, exchangeForLongLived, fetchProfile, verifyState } from "@/lib/instagram";
import { upsertInstagramAccount } from "@/lib/social-db";
import { withSessionOperator } from "@/lib/route-helpers";
import { currentOperator } from "@/lib/operators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function redirectUri(req: Request): string {
  return process.env.INSTAGRAM_REDIRECT_URI ?? `${new URL(req.url).origin}/api/social/instagram/callback`;
}

/** Instagram sends the operator back here with ?code=…&state=… */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const back = (params: Record<string, string>) => {
    const to = new URL("/admin", url.origin);
    for (const [k, v] of Object.entries(params)) to.searchParams.set(k, v);
    return NextResponse.redirect(to);
  };
  const error = url.searchParams.get("error");
  if (error) {
    return back({ ig_error: url.searchParams.get("error_description") ?? error });
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return back({ ig_error: "Missing code or state" });

  return withSessionOperator(async () => {
    const op = currentOperator();
    const verified = verifyState(state);
    if (!verified || verified.email !== op.email) {
      return back({ ig_error: "OAuth state didn't verify — start the connection again." });
    }
    try {
      // Instagram appends "#_" to the redirect; strip anything after it.
      const cleanCode = code.replace(/#_$/, "");
      const short = await exchangeCode({ code: cleanCode, redirectUri: redirectUri(req) });
      const long = await exchangeForLongLived(short.access_token);
      const profile = await fetchProfile(long.access_token);
      const account = await upsertInstagramAccount({
        operatorEmail: op.email,
        platformUserId: String(profile.user_id ?? short.user_id),
        username: profile.username,
        accountType: profile.account_type ?? null,
        accessToken: long.access_token,
        expiresInSec: long.expires_in,
      });
      return back({ ig_connected: account.username });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[instagram/callback] failed:", err);
      return back({ ig_error: message });
    }
  });
}
