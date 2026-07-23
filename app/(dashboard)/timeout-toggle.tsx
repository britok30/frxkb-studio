"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

/**
 * Kelvin-only prank/admin control (never rendered for other sessions — the
 * server component gates it, and the API 404s non-admin calls). While the
 * toggle is on, Fremy's dashboard is replaced by the message below.
 */
export function TimeoutToggle({
  initialEnabled,
  initialMessage,
}: {
  initialEnabled: boolean;
  initialMessage: string;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [message, setMessage] = useState(initialMessage);
  const [saving, setSaving] = useState(false);

  async function save(next: { enabled: boolean; message: string }) {
    setSaving(true);
    try {
      const res = await fetch("/api/settings/timeout", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      setEnabled(next.enabled);
      toast.success(
        next.enabled ? "Timeout is ON — Fremy sees your message" : "Timeout is off"
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      toast.error("Couldn't save", { description: msg });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle className="text-base">Time-out</CardTitle>
            <CardDescription>
              Only you can see this. While on, Fremy&apos;s home shows your message
              instead of the studio.
            </CardDescription>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            disabled={saving}
            onClick={() => void save({ enabled: !enabled, message })}
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
              enabled ? "bg-foreground" : "bg-muted"
            }`}
          >
            <span
              className={`absolute top-0.5 size-5 rounded-full bg-background shadow transition-[left] ${
                enabled ? "left-[22px]" : "left-0.5"
              }`}
            />
          </button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        <Input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={500}
          placeholder="You're in time-out. Come see me."
          className="max-w-md"
        />
        <Button
          variant="outline"
          disabled={saving}
          onClick={() => void save({ enabled, message })}
        >
          {saving ? "Saving…" : "Save message"}
        </Button>
      </CardContent>
    </Card>
  );
}
