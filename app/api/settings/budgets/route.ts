import { NextResponse } from "next/server";
import { z } from "zod";
import { auth, ALLOWED_EMAILS } from "@/auth";
import { getOperator } from "@/lib/operators";
import {
  ADMIN_EMAIL,
  getDailyBudgetOverrides,
  setDailyBudgetOverride,
} from "@/lib/app-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PutBody = z.object({
  email: z.string().email(),
  /** USD/day. Clamped range keeps a typo from minting an unlimited cap. */
  dailyBudgetUsd: z.number().min(1).max(2000),
});

/** Admin-only: non-admin sessions get a 404 (same policy as the timeout
 *  setting — the endpoint's existence never leaks). */
async function requireAdmin(): Promise<Response | null> {
  const session = await auth();
  if (session?.user?.email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return null;
}

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;
  try {
    const overrides = await getDailyBudgetOverrides();
    const budgets = [...ALLOWED_EMAILS].map((email) => ({
      email,
      defaultUsd: getOperator(email)?.dailyBudgetUsd ?? null,
      effectiveUsd: overrides[email] ?? getOperator(email)?.dailyBudgetUsd ?? null,
    }));
    return NextResponse.json({ budgets });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = PutBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  if (!ALLOWED_EMAILS.has(parsed.data.email.toLowerCase())) {
    return NextResponse.json({ error: "Unknown operator" }, { status: 400 });
  }

  try {
    await setDailyBudgetOverride(parsed.data.email.toLowerCase(), parsed.data.dailyBudgetUsd);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
