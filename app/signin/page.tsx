import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";
import { SignInClient } from "./signin-client";

export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; callbackUrl?: string }>;
}) {
  const session = await auth();
  const params = await searchParams;
  // Only ever bounce to a path on THIS origin. The proxy puts an absolute
  // URL in callbackUrl, and a crafted one ("?callbackUrl=https://evil.com")
  // would otherwise turn this page into an open redirect for anyone already
  // signed in — a clean phishing hop off a trusted domain.
  const safeCallback = toSamePath(params.callbackUrl);

  // Already signed in → bounce home.
  if (session?.user) redirect(safeCallback);

  async function continueWithGoogle() {
    "use server";
    await signIn("google", { redirectTo: safeCallback });
  }

  const errorMessage = params.error
    ? params.error === "AccessDenied"
      ? "That email isn't on the studio's allowlist."
      : "Sign-in didn't go through. Try again."
    : null;

  return <SignInClient action={continueWithGoogle} errorMessage={errorMessage} />;
}

/** Reduce a callbackUrl to a same-origin PATH, or "/" when it points
 *  anywhere else (absolute externals, protocol-relative "//evil.com",
 *  javascript:, garbage). */
function toSamePath(callbackUrl: string | undefined): string {
  if (!callbackUrl) return "/";
  // Relative path — accept, but reject protocol-relative "//host".
  if (callbackUrl.startsWith("/") && !callbackUrl.startsWith("//")) {
    return callbackUrl;
  }
  try {
    const url = new URL(callbackUrl);
    const base = process.env.NEXTAUTH_URL ?? process.env.AUTH_URL;
    if (base && url.origin === new URL(base).origin) {
      return `${url.pathname}${url.search}`;
    }
  } catch {
    // not a parseable URL
  }
  return "/";
}
