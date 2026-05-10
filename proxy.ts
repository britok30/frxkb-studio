// Next.js 16 proxy (formerly middleware). Runs on the Node.js runtime.
// The `authorized` callback in auth.ts decides what's public vs. gated;
// the matcher below excludes static assets, _next, fonts, and generated media.
export { auth as proxy } from "@/auth";

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|fonts/|generated/).*)"],
};
