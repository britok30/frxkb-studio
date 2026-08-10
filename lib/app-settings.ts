// Studio-level runtime settings backed by the app_settings key/value table.
// First (and so far only) consumer: Kelvin's personal "timeout" prank toggle
// that swaps Fremy's dashboard for a custom message.

import { eq } from "drizzle-orm";
import { appSettings, getDb } from "@/lib/db";

/** The only account allowed to see or change personal settings. */
export const ADMIN_EMAIL = "britok30@gmail.com";
/** The account the timeout screen targets. */
export const TIMEOUT_TARGET_EMAIL = "fremyrosso1@gmail.com";

const TIMEOUT_KEY = "timeout-mode";

export type TimeoutSetting = {
  enabled: boolean;
  message: string;
};

const TIMEOUT_DEFAULT: TimeoutSetting = { enabled: false, message: "" };

export async function getTimeoutSetting(): Promise<TimeoutSetting> {
  const rows = await getDb()
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, TIMEOUT_KEY))
    .limit(1);
  const value = rows[0]?.value;
  if (!value) return TIMEOUT_DEFAULT;
  return {
    enabled: value.enabled === true,
    message: typeof value.message === "string" ? value.message : "",
  };
}

export async function setTimeoutSetting(setting: TimeoutSetting): Promise<void> {
  await getDb()
    .insert(appSettings)
    .values({ key: TIMEOUT_KEY, value: setting, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: setting, updatedAt: new Date() },
    });
}

const UPSCALER_KEY = "upscaler";

export type UpscalerSetting = "topaz" | "seedvr2";

/** Which model runs the crisp-pipeline upscale after seedance. Runtime-
 *  switchable (admin page) so Topaz vs SeedVR2 can be A/B'd without a
 *  deploy; planAnimate snapshots it into the plan so an in-flight batch
 *  stays consistent mid-toggle. Default: topaz (the incumbent). */
export async function getUpscalerSetting(): Promise<UpscalerSetting> {
  const rows = await getDb()
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, UPSCALER_KEY))
    .limit(1);
  const value = rows[0]?.value as { model?: string } | undefined;
  return value?.model === "seedvr2" ? "seedvr2" : "topaz";
}

export async function setUpscalerSetting(model: UpscalerSetting): Promise<void> {
  await getDb()
    .insert(appSettings)
    .values({ key: UPSCALER_KEY, value: { model }, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: { model }, updatedAt: new Date() },
    });
}

const BUDGETS_KEY = "daily-budgets";

/** Runtime per-operator daily-cap overrides (USD), keyed by email. Absent
 *  email = the operator's compiled-in default (lib/operators.ts, $50). */
export async function getDailyBudgetOverrides(): Promise<Record<string, number>> {
  const rows = await getDb()
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, BUDGETS_KEY))
    .limit(1);
  const value = rows[0]?.value;
  if (!value) return {};
  const out: Record<string, number> = {};
  for (const [email, usd] of Object.entries(value)) {
    if (typeof usd === "number" && usd > 0) out[email] = usd;
  }
  return out;
}

export async function setDailyBudgetOverride(email: string, usd: number): Promise<void> {
  const current = await getDailyBudgetOverrides();
  const next = { ...current, [email]: usd };
  await getDb()
    .insert(appSettings)
    .values({ key: BUDGETS_KEY, value: next, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: next, updatedAt: new Date() },
    });
}
