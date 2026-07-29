// Next.js 16 proxy (formerly middleware). Runs on the Node.js runtime.
//
// IMPORTANT — why the allowlist gate is enforced HERE and not left to the
// `authorized` callback in auth.ts: next-auth only honors that callback's
// boolean when `auth` is exported directly. The moment you WRAP it
// (`auth(async (req) => …)`, which the time-out feature needs), next-auth
// runs the callback but discards a `false` result and calls the wrapper
// instead (see handleAuth in next-auth/lib/index.js: the `else if
// (userMiddlewareOrRoute)` branch short-circuits the `else if (!authorized)`
// redirect). Wrapping without re-implementing the gate silently made the
// whole studio public — shipped 2026-07-23, caught 2026-07-29.

import { NextResponse } from "next/server";
import { auth, isAllowedEmail } from "@/auth";
import { getTimeoutSetting, TIMEOUT_TARGET_EMAIL } from "@/lib/app-settings";

/** Surfaces that must stay reachable without a session. */
function isPublicPath(path: string): boolean {
  return (
    path.startsWith("/signin") ||
    path.startsWith("/api/auth") ||
    // Inngest webhook: authed by INNGEST_SIGNING_KEY signature, not a session.
    path === "/api/inngest"
  );
}

export const proxy = auth(async (req) => {
  const path = req.nextUrl.pathname;
  const email = req.auth?.user?.email;

  if (!isPublicPath(path)) {
    // Gate 1 — allowlist. Mirrors the `authorized` callback in auth.ts, which
    // next-auth ignores for wrapped middleware (see header comment).
    if (!isAllowedEmail(email)) {
      if (path.startsWith("/api/")) {
        return NextResponse.json({ error: "Not authorized" }, { status: 401 });
      }
      const signInUrl = req.nextUrl.clone();
      signInUrl.pathname = "/signin";
      signInUrl.search = "";
      signInUrl.searchParams.set("callbackUrl", req.nextUrl.href);
      return NextResponse.redirect(signInUrl);
    }

    // Gate 2 — time-out mode: while enabled, the target account is locked out
    // of the whole app: every page rewrites to /timeout, every API call 403s.
    // The DB lookup only runs for that one account, so it costs every other
    // request nothing; a lookup error fails open rather than locking anyone
    // out by accident.
    if (email === TIMEOUT_TARGET_EMAIL && path !== "/timeout") {
      try {
        const setting = await getTimeoutSetting();
        if (setting.enabled) {
          if (path.startsWith("/api/")) {
            return NextResponse.json({ error: "Unavailable" }, { status: 403 });
          }
          return NextResponse.rewrite(new URL("/timeout", req.nextUrl));
        }
      } catch {
        // fail open
      }
    }
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|fonts/|generated/).*)"],
};
