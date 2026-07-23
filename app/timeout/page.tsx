import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getTimeoutSetting, TIMEOUT_TARGET_EMAIL } from "@/lib/app-settings";

export const dynamic = "force-dynamic";

/**
 * The lockout screen the proxy rewrites EVERY page to for the timed-out
 * account. Nothing but the admin's message, centered and bold. Anyone else
 * landing here directly (or the target once the toggle is off) bounces home.
 */
export default async function TimeoutPage() {
  const session = await auth().catch(() => null);
  const setting = await getTimeoutSetting().catch(() => null);
  if (!setting?.enabled || session?.user?.email !== TIMEOUT_TARGET_EMAIL) {
    redirect("/");
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <p className="text-center text-2xl font-bold tracking-tight max-w-xl">
        {setting.message || "You're in time-out."}
      </p>
    </div>
  );
}
