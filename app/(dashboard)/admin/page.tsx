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

export const dynamic = "force-dynamic";

/** Kelvin-only admin settings. Non-admin sessions 404 — the page's existence
 *  never leaks (same policy as the settings APIs behind it). */
export default async function AdminPage() {
  const session = await auth().catch(() => null);
  if (session?.user?.email !== ADMIN_EMAIL) notFound();

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

      <UpscalerToggle initial={upscaler} />

      <BudgetEditor initial={budgets} />

      <TimeoutToggle
        initialEnabled={timeout?.enabled ?? false}
        initialMessage={timeout?.message ?? ""}
      />
    </div>
  );
}
