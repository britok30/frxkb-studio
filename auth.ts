import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

/**
 * Hardcoded allowlist — only these two operators may sign in.
 * Adding a user is a code change, on purpose: no self-serve signup.
 */
export const ALLOWED_EMAILS = new Set<string>([
  "britok30@gmail.com",
  "fremyrosso1@gmail.com",
]);

export function isAllowedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return ALLOWED_EMAILS.has(email.toLowerCase());
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [Google],
  session: { strategy: "jwt" },
  pages: {
    signIn: "/signin",
    error: "/signin",
  },
  callbacks: {
    /**
     * Block sign-in unless the Google account's email is in the allowlist.
     * Returning false renders the configured error page with `?error=AccessDenied`.
     */
    signIn({ profile }) {
      return isAllowedEmail(profile?.email);
    },
    /**
     * Mirror the email onto the JWT so the session in middleware/server
     * components has it without an extra DB lookup.
     */
    jwt({ token, profile }) {
      if (profile?.email) token.email = profile.email;
      return token;
    },
    session({ session, token }) {
      if (token?.email && session.user) {
        session.user.email = token.email as string;
      }
      return session;
    },
    /**
     * Authorize callback runs on every request through middleware.
     * Returning a boolean tells next-auth whether the request is allowed.
     */
    authorized({ auth: a, request: { nextUrl } }) {
      const path = nextUrl.pathname;
      // Public surfaces — sign-in flow + auth handler endpoints.
      if (path.startsWith("/signin") || path.startsWith("/api/auth")) return true;
      return !!a?.user && isAllowedEmail(a.user.email);
    },
  },
});
