"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export type BudgetRow = {
  email: string;
  defaultUsd: number | null;
  effectiveUsd: number | null;
};

/** Per-operator daily-cap editor. Writes a runtime override (app_settings) —
 *  no deploy needed; the spend gate reads it on every check. */
export function BudgetEditor({ initial }: { initial: BudgetRow[] }) {
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(initial.map((b) => [b.email, String(b.effectiveUsd ?? 50)]))
  );
  const [saving, setSaving] = useState<string | null>(null);

  async function save(email: string) {
    const usd = Number(values[email]);
    if (!Number.isFinite(usd) || usd < 1 || usd > 2000) {
      toast.error("Cap must be between $1 and $2000 per day");
      return;
    }
    setSaving(email);
    try {
      const res = await fetch("/api/settings/budgets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, dailyBudgetUsd: usd }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      toast.success(`${email} capped at $${usd}/day`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error("Couldn't save", { description: message });
    } finally {
      setSaving(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Daily spend caps</CardTitle>
        <CardDescription>
          Per operator, USD per day (default $50). Applies immediately to every
          spend-gated action; resets at midnight UTC.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {initial.map((b) => (
          <div key={b.email} className="flex flex-wrap items-center gap-2">
            <span className="text-sm tracking-tight min-w-[220px]">{b.email}</span>
            <span className="text-xs text-muted-foreground">$</span>
            <Input
              type="number"
              min={1}
              max={2000}
              value={values[b.email] ?? ""}
              onChange={(e) =>
                setValues((v) => ({ ...v, [b.email]: e.target.value }))
              }
              className="w-24 tabular-nums"
            />
            <span className="text-xs text-muted-foreground">/day</span>
            <Button
              variant="outline"
              size="sm"
              disabled={saving === b.email}
              onClick={() => void save(b.email)}
            >
              {saving === b.email ? "Saving…" : "Save"}
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
