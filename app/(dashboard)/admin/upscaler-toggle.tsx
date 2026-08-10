"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** Admin: which model runs the crisp-pipeline upscale after seedance.
 *  Takes effect on the NEXT animate (plans snapshot the setting), so a
 *  running batch never mixes upscalers. */
export function UpscalerToggle({ initial }: { initial: "topaz" | "seedvr2" }) {
  const [model, setModel] = useState<"topaz" | "seedvr2">(initial);
  const [saving, setSaving] = useState(false);

  async function save(next: "topaz" | "seedvr2") {
    if (saving || next === model) return;
    setSaving(true);
    const prev = model;
    setModel(next);
    try {
      const res = await fetch("/api/settings/upscaler", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: next }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      toast.success(
        next === "seedvr2"
          ? "SeedVR2 — takes effect on the next animate"
          : "Topaz — takes effect on the next animate"
      );
    } catch (err) {
      setModel(prev);
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error("Couldn't switch upscaler", { description: message });
    } finally {
      setSaving(false);
    }
  }

  const options = [
    {
      id: "topaz" as const,
      name: "Topaz Proteus",
      detail: "The incumbent — 3×/2× upscale + Apollo 24→30fps interpolation (~$0.16/s)",
    },
    {
      id: "seedvr2" as const,
      name: "SeedVR2",
      detail:
        "ByteDance restoration — more natural texture, strong temporal consistency, 2160p target. Stays 24fps (stitch resamples). ~$0.20/s est.",
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Video upscaler</CardTitle>
        <CardDescription>
          Runs on every animated clip after Seedance. Switching applies to the next
          Animate — in-flight batches keep the model they started with.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3">
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              disabled={saving}
              onClick={() => void save(o.id)}
              className={`text-left rounded-xl border px-3 py-2.5 flex flex-col gap-0.5 transition-colors disabled:opacity-60 ${
                model === o.id ? "border-foreground bg-foreground/[0.03]" : "hover:border-foreground/30"
              }`}
            >
              <span className="text-xs font-semibold tracking-tight">{o.name}</span>
              <span className="text-[10px] text-muted-foreground tracking-tight leading-snug">
                {o.detail}
              </span>
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
