import Link from "next/link";
import { auth, signOut } from "@/auth";
import { ADMIN_EMAIL } from "@/lib/app-settings";

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
            <div className="flex items-center gap-4">
              {email === ADMIN_EMAIL && (
                <Link
                  href="/admin"
                  className="text-xs text-muted-foreground hover:text-foreground tracking-tight transition-colors"
                >
                  Admin
                </Link>
              )}
              {/* flex on the form so the button's baseline matches the Admin
                  link — a bare form is display:block and sits a hair low. */}
              <form action={doSignOut} className="flex items-center">
                <button
                  type="submit"
                  title={email}
                  className="text-xs text-muted-foreground hover:text-foreground tracking-tight transition-colors"
                >
                  Sign out
                </button>
              </form>
            </div>
          )}
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
