"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export type InstagramAccountRow = {
  id: string;
  username: string;
  accountType: string | null;
  tokenExpiresAt: string | null;
};

/** Admin: connected Instagram professional accounts + the connect button.
 *  Tokens never reach the client — this lists usernames only. */
export function InstagramAccounts({
  initial,
  configured,
  loadError,
  justConnected,
  connectError,
}: {
  initial: InstagramAccountRow[];
  /** INSTAGRAM_APP_ID + INSTAGRAM_APP_SECRET + SOCIAL_TOKEN_KEY are all set. */
  configured: boolean;
  loadError: string | null;
  justConnected: string | null;
  connectError: string | null;
}) {
  const [accounts, setAccounts] = useState(initial);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Captured once on mount — "days left" needn't tick live.
  const [now] = useState(() => Date.now());

  useEffect(() => {
    if (justConnected) toast.success(`Connected @${justConnected}`);
    if (connectError) toast.error("Instagram connection failed", { description: connectError });
    if (justConnected || connectError) {
      // Drop the one-shot params so a refresh doesn't re-toast.
      window.history.replaceState(null, "", "/admin");
    }
  }, [justConnected, connectError]);

  async function disconnect(id: string, username: string) {
    if (busyId) return;
    setBusyId(id);
    try {
      const res = await fetch(`/api/social/accounts/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      setAccounts((a) => a.filter((x) => x.id !== id));
      toast.success(`Disconnected @${username}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error("Couldn't disconnect", { description: message });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Instagram accounts</CardTitle>
        <CardDescription>
          Professional (Business or Creator) accounts the studio can publish to. Connect signs in
          with the Instagram account itself — no Facebook Page needed. Tokens are refreshed weekly.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {loadError && (
          <p className="text-xs text-destructive tracking-tight">
            Couldn&apos;t load accounts: {loadError}. If the tables don&apos;t exist yet, run{" "}
            <code>npm run db:push</code>.
          </p>
        )}
        {accounts.length === 0 && !loadError && (
          <p className="text-xs text-muted-foreground tracking-tight">No accounts connected yet.</p>
        )}
        {accounts.map((a) => {
          const expires = a.tokenExpiresAt ? new Date(a.tokenExpiresAt) : null;
          const daysLeft = expires ? Math.round((expires.getTime() - now) / 86_400_000) : null;
          return (
            <div key={a.id} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
              <div className="flex flex-col">
                <span className="text-sm tracking-tight">@{a.username}</span>
                <span className="text-[11px] text-muted-foreground tracking-tight">
                  {a.accountType ? `${a.accountType.toLowerCase()} · ` : ""}
                  {daysLeft === null ? "token" : daysLeft <= 0 ? "token expired — reconnect" : `token valid ${daysLeft}d`}
                </span>
              </div>
              <button
                type="button"
                disabled={busyId === a.id}
                onClick={() => void disconnect(a.id, a.username)}
                className="text-xs text-muted-foreground hover:text-destructive tracking-tight disabled:opacity-50"
              >
                Disconnect
              </button>
            </div>
          );
        })}
        {configured ? (
          <a
            href="/api/social/instagram/connect"
            className="self-start inline-flex h-9 items-center rounded-md border px-3 text-sm tracking-tight hover:border-foreground/40 transition-colors"
          >
            {accounts.length > 0 ? "Connect another account" : "Connect Instagram"}
          </a>
        ) : (
          <p className="text-[11px] text-muted-foreground tracking-tight leading-relaxed">
            Not configured — set <code>INSTAGRAM_APP_ID</code>, <code>INSTAGRAM_APP_SECRET</code>, and{" "}
            <code>SOCIAL_TOKEN_KEY</code> on the deployment to enable connecting.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
