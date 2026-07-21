// Pure, client-safe operator display helpers (lib/operators.ts itself is
// server-only via AsyncLocalStorage — don't import it in client components).

/** Monogram shown on project cards: who created this. */
const INITIALS: Record<string, string> = {
  "britok30@gmail.com": "KB",
  "fremyrosso1@gmail.com": "FR",
};

/** Two-letter creator label for an operator email; null hides the chip
 *  (legacy rows without attribution). Unknown allowlist additions fall back
 *  to the email's first two letters so new operators are never blank. */
export function operatorInitials(email: string | null | undefined): string | null {
  if (!email) return null;
  const lower = email.toLowerCase();
  return INITIALS[lower] ?? lower.slice(0, 2).toUpperCase();
}
