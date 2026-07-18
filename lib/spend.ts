// Actual-spend ledger. Amounts are computed at the call site from the
// verified vendor rates in lib/pricing.ts — this is bookkeeping of what we
// KNOW we spent, not a scrape of vendor invoices. Two consumers:
//   1. Readouts: per-project total, operator daily/monthly totals.
//   2. The daily budget gate (assertWithinDailyBudget) that stops a runaway
//      batch BEFORE it fires.

import { and, eq, gte, sql as dsql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDb, spendEvents, type NewSpendEvent } from "@/lib/db";
import { currentOperator } from "@/lib/operators";
import { formatCost } from "@/lib/pricing";

export type SpendKind = NewSpendEvent["kind"];

/**
 * Record one billable vendor call. Fire-and-forget by design: ledger writes
 * must NEVER fail a generation that already succeeded (and already cost the
 * money), so failures log and are swallowed.
 */
export async function recordSpend(input: {
  projectId?: string | null;
  kind: SpendKind;
  amountUsd: number;
  meta?: Record<string, unknown>;
}): Promise<void> {
  try {
    const op = currentOperator();
    await getDb()
      .insert(spendEvents)
      .values({
        id: nanoid(12),
        projectId: input.projectId ?? null,
        operatorEmail: op.email,
        kind: input.kind,
        amountUsd: input.amountUsd,
        meta: input.meta ?? null,
      });
  } catch (err) {
    console.warn("[spend] failed to record spend event:", err);
  }
}

/** Total recorded spend for the current operator since local midnight UTC. */
export async function sumSpendToday(operatorEmail: string): Promise<number> {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const rows = await getDb()
    .select({ total: dsql<number>`coalesce(sum(${spendEvents.amountUsd}), 0)` })
    .from(spendEvents)
    .where(
      and(eq(spendEvents.operatorEmail, operatorEmail), gte(spendEvents.createdAt, midnight))
    );
  return rows[0]?.total ?? 0;
}

/** Total recorded spend for the current operator over the last N days. */
export async function sumSpendSince(operatorEmail: string, since: Date): Promise<number> {
  const rows = await getDb()
    .select({ total: dsql<number>`coalesce(sum(${spendEvents.amountUsd}), 0)` })
    .from(spendEvents)
    .where(and(eq(spendEvents.operatorEmail, operatorEmail), gte(spendEvents.createdAt, since)));
  return rows[0]?.total ?? 0;
}

/** Total recorded spend attributed to one project. */
export async function sumProjectSpend(projectId: string): Promise<number> {
  const rows = await getDb()
    .select({ total: dsql<number>`coalesce(sum(${spendEvents.amountUsd}), 0)` })
    .from(spendEvents)
    .where(eq(spendEvents.projectId, projectId));
  return rows[0]?.total ?? 0;
}

/** Thrown when a batch would push the operator past their daily budget. */
export class BudgetExceededError extends Error {
  readonly code = "BUDGET_EXCEEDED";
  constructor(opts: { spentToday: number; estimate: number; budget: number }) {
    super(
      `Daily budget reached: ${formatCost(opts.spentToday)} spent today + ~${formatCost(opts.estimate)} for this batch exceeds the ${formatCost(opts.budget)}/day cap. Raise dailyBudgetUsd for this operator in lib/operators.ts, or try again tomorrow.`
    );
    this.name = "BudgetExceededError";
  }
}

/**
 * Budget gate — call BEFORE firing a batch. Throws BudgetExceededError when
 * today's recorded spend plus the batch estimate would exceed the operator's
 * daily cap. A ledger read failure fails OPEN (a missed gate beats blocking
 * all work on a transient DB error — the lock + confirm dialogs still stand).
 */
export async function assertWithinDailyBudget(estimateUsd: number): Promise<void> {
  const op = currentOperator();
  const budget = op.dailyBudgetUsd;
  if (!budget || budget <= 0) return;
  let spentToday = 0;
  try {
    spentToday = await sumSpendToday(op.email);
  } catch (err) {
    console.warn("[spend] budget check failed open:", err);
    return;
  }
  if (spentToday + estimateUsd > budget) {
    throw new BudgetExceededError({ spentToday, estimate: estimateUsd, budget });
  }
}
