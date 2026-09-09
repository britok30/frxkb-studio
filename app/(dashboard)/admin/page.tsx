import { notFound } from "next/navigation";
import { auth, ALLOWED_EMAILS } from "@/auth";
import { getOperator } from "@/lib/operators";
import {
  ADMIN_EMAIL,
  getDailyBudgetOverrides,
  getTimeoutSetting,
  getUpscalerSetting,
  type TimeoutSetting,
  type UpscalerSetting,
} from "@/lib/app-settings";
import { TimeoutToggle } from "../timeout-toggle";
import { BudgetEditor, type BudgetRow } from "./budget-editor";
import { UpscalerToggle } from "./upscaler-toggle";
import { InstagramAccounts, type InstagramAccountRow } from "./instagram-accounts";
import { listSocialAccounts } from "@/lib/social-db";

export const dynamic = "force-dynamic";

/** Kelvin-only admin settings. Non-admin sessions 404 — the page's existence
 *  never leaks (same policy as the settings APIs behind it). */
export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ ig_connected?: string; ig_error?: string }>;
}) {
  const session = await auth().catch(() => null);
  if (session?.user?.email !== ADMIN_EMAIL) notFound();
  const sp = await searchParams;

  let instagram: InstagramAccountRow[] = [];
  let instagramError: string | null = null;
  try {
    instagram = (await listSocialAccounts(ADMIN_EMAIL)).map((a) => ({
      id: a.id,
      username: a.username,
      accountType: a.accountType,
      tokenExpiresAt: a.tokenExpiresAt ? a.tokenExpiresAt.toISOString() : null,
    }));
  } catch (err) {
    instagramError = err instanceof Error ? err.message : "Couldn't load accounts";
  }
  const instagramConfigured = !!(
    process.env.INSTAGRAM_APP_ID &&
    process.env.INSTAGRAM_APP_SECRET &&
    process.env.SOCIAL_TOKEN_KEY
  );

  let timeout: TimeoutSetting | null = null;
  try {
    timeout = await getTimeoutSetting();
  } catch {
    timeout = null;
  }

  let upscaler: UpscalerSetting = "topaz";
  try {
    upscaler = await getUpscalerSetting();
  } catch {
    upscaler = "topaz";
  }

  let budgets: BudgetRow[] = [];
  try {
    const overrides = await getDailyBudgetOverrides();
    budgets = [...ALLOWED_EMAILS].map((email) => ({
      email,
      defaultUsd: getOperator(email)?.dailyBudgetUsd ?? null,
      effectiveUsd: overrides[email] ?? getOperator(email)?.dailyBudgetUsd ?? null,
    }));
  } catch {
    budgets = [...ALLOWED_EMAILS].map((email) => ({
      email,
      defaultUsd: getOperator(email)?.dailyBudgetUsd ?? null,
      effectiveUsd: getOperator(email)?.dailyBudgetUsd ?? null,
    }));
  }

  return (
    <div className="mx-auto max-w-3xl w-full px-6 pt-12 pb-20 flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          Admin
        </span>
        <h1 className="text-3xl font-semibold tracking-tight leading-[1.05]">Settings</h1>
        <p className="text-xs text-muted-foreground tracking-tight">
          Only your account can see this page.
        </p>
      </header>

      <InstagramAccounts
        initial={instagram}
        configured={instagramConfigured}
        loadError={instagramError}
        justConnected={sp.ig_connected ?? null}
        connectError={sp.ig_error ?? null}
      />

      <UpscalerToggle initial={upscaler} />

      <BudgetEditor initial={budgets} />

      <TimeoutToggle
        initialEnabled={timeout?.enabled ?? false}
        initialMessage={timeout?.message ?? ""}
      />
    </div>
  );
}
