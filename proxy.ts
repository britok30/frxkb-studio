// Next.js 16 proxy (formerly middleware). Runs on the Node.js runtime.
// The `authorized` callback in auth.ts decides what's public vs. gated;
// the matcher below excludes static assets, _next, fonts, and generated media.

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getTimeoutSetting, TIMEOUT_TARGET_EMAIL } from "@/lib/app-settings";

export const proxy = auth(async (req) => {
  const path = req.nextUrl.pathname;
  const email = req.auth?.user?.email;

  // Time-out mode: while enabled, the target account is locked out of the
  // whole app — every page rewrites to /timeout and every API call 403s.
  // Auth surfaces stay open (so sign-out still works) and /api/inngest is
  // webhook-authed, not session-authed. The DB lookup only runs for the
  // target's own session, so it costs every other request nothing; a
  // lookup error fails open rather than locking anyone out by accident.
  if (
    email === TIMEOUT_TARGET_EMAIL &&
    path !== "/timeout" &&
    path !== "/api/inngest" &&
    !path.startsWith("/signin") &&
    !path.startsWith("/api/auth")
  ) {
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
  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|fonts/|generated/).*)"],
};
