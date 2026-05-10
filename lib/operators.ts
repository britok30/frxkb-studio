import { AsyncLocalStorage } from "node:async_hooks";

// ── Operator config ──────────────────────────────────────────────────────────
//
// Each allowlisted email maps to its own credentials + app links. Adding a
// user is a code change, on purpose: secrets are namespaced per email so a
// leaked key only burns one operator's account, not both.

export type AppLink = {
  /** Display name (used in metadata prompt context). */
  name: "ArchitectGPT" | "CasaGPT" | "InteriorGPT";
  /** The full URL we substitute into {APP_LINK} placeholders. May be empty. */
  url: string;
  /** Niche keywords that prefer this app. First match wins; if no app
   *  matches, the operator's first-listed app is the fallback. */
  pattern?: RegExp;
};

export type Operator = {
  email: string;
  falKey: string;
  anthropicKey: string;
  apps: AppLink[];
};

const INTERIOR_RE =
  /(interior|room|kitchen|living|bedroom|bath|home|casa|apartment|loft)/;

/** Resolve an operator config from an allowlisted email. Returns null if the
 *  email isn't allowlisted OR if its required env vars aren't all set. */
export function getOperator(email: string | null | undefined): Operator | null {
  if (!email) return null;
  const lower = email.toLowerCase();

  if (lower === "britok30@gmail.com") {
    const falKey = process.env.FAL_KEY_BRITOK30;
    const anthropicKey = process.env.ANTHROPIC_KEY_BRITOK30;
    if (!falKey || !anthropicKey) return null;
    return {
      email: lower,
      falKey,
      anthropicKey,
      apps: [
        // Order matters: first matching pattern wins; if nothing matches, [0] is the fallback.
        // Architecture-first puts ArchitectGPT in slot 0 as the default.
        { name: "ArchitectGPT", url: process.env.APP_LINK_ARCHITECTGPT ?? "" },
        { name: "CasaGPT", url: process.env.APP_LINK_CASAGPT ?? "", pattern: INTERIOR_RE },
      ],
    };
  }

  if (lower === "fremyrosso1@gmail.com") {
    const falKey = process.env.FAL_KEY_FREMYROSSO1;
    const anthropicKey = process.env.ANTHROPIC_KEY_FREMYROSSO1;
    if (!falKey || !anthropicKey) return null;
    return {
      email: lower,
      falKey,
      anthropicKey,
      apps: [
        // Single app, but interior pattern still set so {APP_LINK} substitution
        // works the same way for both operators.
        { name: "InteriorGPT", url: process.env.APP_LINK_INTERIORGPT ?? "" },
      ],
    };
  }

  return null;
}

/** Pick the operator's app URL most relevant to the given niche. Returns the
 *  first-listed app's URL as a fallback when nothing matches. */
export function pickAppLink(operator: Operator, niche: string): string {
  const lower = niche.toLowerCase();
  for (const app of operator.apps) {
    if (app.pattern && app.pattern.test(lower)) return app.url;
  }
  return operator.apps[0]?.url ?? "";
}

// ── Per-request operator context ─────────────────────────────────────────────
//
// Every request that hits fal/Claude/app-link substitution needs to know
// which operator it's running on behalf of. We thread that via
// AsyncLocalStorage rather than passing `operator` through every function
// signature. Each authed API route wraps its handler in withOperator() once;
// inner code reads currentOperator() implicitly.

const storage = new AsyncLocalStorage<{ operator: Operator }>();

export function withOperator<T>(operator: Operator, fn: () => T): T {
  return storage.run({ operator }, fn);
}

/** Throws if called outside a withOperator() scope. */
export function currentOperator(): Operator {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error(
      "No operator in current context. The route handler must wrap its work in withOperator(...)."
    );
  }
  return ctx.operator;
}
