import { NextResponse } from "next/server";
import { withSessionOperator } from "@/lib/route-helpers";
import { currentOperator } from "@/lib/operators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Lightweight metadata about the signed-in operator. Used by /new to scope
 * the WorldTypePicker (interior-only operators don't see exterior) and to
 * surface app names where useful. Secrets (fal/anthropic keys, real app URLs)
 * never cross this boundary.
 */
export async function GET(): Promise<Response> {
  return withSessionOperator(async () => {
    const op = currentOperator();
    return NextResponse.json({
      email: op.email,
      appNames: op.apps.map((a) => a.name),
      worldTypes: op.worldTypes,
    });
  });
}
