import Link from "next/link";
import { auth, signOut } from "@/auth";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const email = session?.user?.email ?? null;

  async function doSignOut() {
    "use server";
    await signOut({ redirectTo: "/signin" });
  }

  return (
    <div className="flex flex-col flex-1 min-h-full">
      <header className="border-b">
        <div className="mx-auto max-w-6xl px-6 h-14 flex items-center justify-between">
          <Link href="/" className="text-sm font-semibold tracking-tight">
            frxkb&nbsp;<span className="text-muted-foreground font-normal">studio</span>
          </Link>
          {email && (
            <form action={doSignOut}>
              <button
                type="submit"
                title={email}
                className="text-xs text-muted-foreground hover:text-foreground tracking-tight transition-colors"
              >
                Sign out
              </button>
            </form>
          )}
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
