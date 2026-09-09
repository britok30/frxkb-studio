"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Send, ExternalLink } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export type PublishAccount = { id: string; username: string };
export type PublishPostRow = {
  id: string;
  accountId: string;
  status: "queued" | "publishing" | "published" | "failed";
  permalink: string | null;
  error: string | null;
  createdAt: string;
};

/** Publish the finalized package to a connected Instagram account. Caption
 *  is prefilled from the finalize copy and editable before sending. */
export function PublishPanel({
  projectId,
  accounts,
  posts,
  defaultCaption,
  mediaSummary,
}: {
  projectId: string;
  accounts: PublishAccount[];
  posts: PublishPostRow[];
  defaultCaption: string;
  /** e.g. "Carousel — before (cleared) + staged after" */
  mediaSummary: string;
}) {
  const router = useRouter();
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [caption, setCaption] = useState(defaultCaption);
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  const inFlight = posts.some((p) => p.status === "queued" || p.status === "publishing");

  async function publish() {
    if (busy || !accountId) return;
    setBusy(true);
    const toastId = toast.loading("Queuing the Instagram post…");
    try {
      const res = await fetch(`/api/projects/${projectId}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, caption }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      toast.success("Publishing — usually live within a minute", { id: toastId });
      startTransition(() => router.refresh());
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error("Couldn't publish", { id: toastId, description: message });
    } finally {
      setBusy(false);
    }
  }

  const byId = new Map(accounts.map((a) => [a.id, a.username]));

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base inline-flex items-center gap-2">
              <Send className="size-4" /> Publish to Instagram
            </CardTitle>
            <CardDescription>{mediaSummary}. Review the caption, then post.</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {accounts.length === 0 ? (
          <p className="text-xs text-muted-foreground tracking-tight">
            No Instagram account connected — connect one on the admin page.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">Account</span>
              {accounts.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setAccountId(a.id)}
                  aria-pressed={accountId === a.id}
                  className={`text-xs px-3 py-1.5 rounded-full border tracking-tight transition-colors ${
                    accountId === a.id
                      ? "bg-foreground text-background border-foreground"
                      : "text-muted-foreground border-border hover:text-foreground hover:border-foreground/40"
                  }`}
                >
                  @{a.username}
                </button>
              ))}
            </div>
            <label className="flex flex-col gap-1.5">
              <span className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">Caption</span>
              <textarea
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                rows={8}
                maxLength={2200}
                className="w-full rounded-md border bg-transparent px-3 py-2 text-sm focus:border-foreground outline-none resize-y tracking-tight leading-relaxed"
              />
              <span className="text-[11px] text-muted-foreground tracking-tight tabular-nums">
                {caption.length}/2200
              </span>
            </label>
            <button
              type="button"
              onClick={() => void publish()}
              disabled={busy || inFlight || !accountId || caption.trim().length === 0}
              className="self-start h-10 rounded-md bg-foreground px-4 text-sm text-background font-medium tracking-tight hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
            >
              {inFlight ? "Publishing…" : busy ? "Queuing…" : `Post to @${byId.get(accountId) ?? "instagram"}`}
            </button>
          </>
        )}

        {posts.length > 0 && (
          <div className="flex flex-col gap-1.5 border-t pt-3">
            {posts.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-3 text-xs tracking-tight">
                <span className="text-muted-foreground">
                  @{byId.get(p.accountId) ?? "account"} ·{" "}
                  {new Date(p.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                </span>
                <span className="inline-flex items-center gap-2">
                  {p.status === "published" && p.permalink ? (
                    <a href={p.permalink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">
                      View post <ExternalLink className="size-3" />
                    </a>
                  ) : p.status === "failed" ? (
                    <span className="text-destructive" title={p.error ?? undefined}>
                      Failed{p.error ? ` — ${p.error.slice(0, 120)}` : ""}
                    </span>
                  ) : null}
                  <Badge variant={p.status === "published" ? "default" : "secondary"} className="text-[10px]">
                    {p.status}
                  </Badge>
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
