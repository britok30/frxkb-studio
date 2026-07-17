import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getOperator, withOperator } from "@/lib/operators";

/**
 * Resolve the operator for the current session and run the handler inside an
 * AsyncLocalStorage scope so deeper code (lib/fal, lib/claude, project
 * substitution) can read currentOperator() implicitly.
 *
 * proxy.ts already gates the route to allowlisted accounts; this returns a
 * 403 only if the account is allowlisted but the per-operator env vars
 * aren't configured (e.g., missing FAL_KEY_BRITOK30).
 */
export async function withSessionOperator(
  fn: () => Promise<Response>
): Promise<Response> {
  const session = await auth();
  const operator = getOperator(session?.user?.email);
  if (!operator) {
    return NextResponse.json(
      {
        error:
          "Operator not configured for this account. Set FAL_KEY_* and OPENAI_KEY_* in the environment.",
      },
      { status: 403 }
    );
  }
  return withOperator(operator, fn);
}
