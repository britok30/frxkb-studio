import { AsyncLocalStorage } from "node:async_hooks";
import type { PropertyType, WorldType } from "@/lib/prompts/types";

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
  /** Social handle (no @ prefix) appended to captions on IG / TikTok / Shorts
   *  as a promo line. Same handle assumed across platforms — split per
   *  platform if that ever stops being true. */
  handle: string;
  /** Niche keywords that prefer this app. First match wins; if no app
   *  matches, the operator's first-listed app is the fallback. */
  pattern?: RegExp;
};

export type Operator = {
  email: string;
  falKey: string;
  openaiKey: string;
  apps: AppLink[];
  /** Visual lanes this operator's apps cover. ArchitectGPT = both interior +
   *  exterior; InteriorGPT = interior only. The /new wizard hides disallowed
   *  options and createProject rejects out-of-lane requests server-side. */
  worldTypes: WorldType[];
  /** Program lanes this operator covers, orthogonal to worldTypes. ArchitectGPT
   *  spans residential + commercial architecture; InteriorGPT is residential
   *  homes only. Gated server-side in the style-explorer create path. */
  propertyTypes: PropertyType[];
  /** Public links surfaced in YouTube long-form metadata CTAs — the app's
   *  Instagram handle (no @) and marketing site. Public, not secrets, so
   *  hardcoded like `handle`. */
  socials: { instagram: string; website: string };
  /** Hard daily spend cap in USD, enforced by assertWithinDailyBudget before
   *  every batch (generate / animate / stitch). 0 or undefined disables the
   *  gate. Raise deliberately, per operator — this is the backstop against a
   *  runaway 120-scene animate. */
  dailyBudgetUsd?: number;
};

/** Resolve an operator config from an allowlisted email. Returns null if the
 *  email isn't allowlisted OR if its required env vars aren't all set. */
export function getOperator(email: string | null | undefined): Operator | null {
  if (!email) return null;
  const lower = email.toLowerCase();

  if (lower === "britok30@gmail.com") {
    const falKey = process.env.FAL_KEY_BRITOK30;
    const openaiKey = process.env.OPENAI_KEY_BRITOK30;
    if (!falKey || !openaiKey) return null;
    return {
      email: lower,
      falKey,
      openaiKey,
      // ArchitectGPT only — strategic focus on the bigger account. CasaGPT
      // can be added back later (with a `pattern` regex on this entry) if
      // the second app warrants its own content stream.
      apps: [
        {
          name: "ArchitectGPT",
          url: process.env.APP_LINK_ARCHITECTGPT ?? "",
          handle: "architectgpt",
        },
      ],
      // ArchitectGPT covers both interior and exterior architecture. Add
      // "landscape" here when that vertical ships.
      worldTypes: ["interior", "exterior"],
      // ArchitectGPT spans homes and commercial buildings alike.
      propertyTypes: ["residential", "commercial"],
      socials: { instagram: "architectgpt", website: "https://www.architectgpt.io" },
      dailyBudgetUsd: 50,
    };
  }

  if (lower === "fremyrosso1@gmail.com") {
    const falKey = process.env.FAL_KEY_FREMYROSSO1;
    const openaiKey = process.env.OPENAI_KEY_FREMYROSSO1;
    if (!falKey || !openaiKey) return null;
    return {
      email: lower,
      falKey,
      openaiKey,
      apps: [
        // Single app, but interior pattern still set so {APP_LINK} substitution
        // works the same way for both operators.
        {
          name: "InteriorGPT",
          url: process.env.APP_LINK_INTERIORGPT ?? "",
          handle: "interiorgpt",
        },
      ],
      // InteriorGPT is interior-only by design.
      worldTypes: ["interior"],
      // InteriorGPT covers both residential and commercial interiors.
      propertyTypes: ["residential", "commercial"],
      socials: { instagram: "interiordesigngpt", website: "https://www.aiinterior.design" },
      dailyBudgetUsd: 50,
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
// Every request that hits fal/GPT-5.5/app-link substitution needs to know
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
