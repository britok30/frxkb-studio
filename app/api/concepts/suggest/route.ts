import { NextResponse } from "next/server";
import { z } from "zod";
import { suggestWorld } from "@/lib/prompts/suggest-world";
import { FormatSchema, WorldTypeSchema } from "@/lib/prompts/types";
import { selectRecentWorlds } from "@/lib/projects-db";
import { withSessionOperator } from "@/lib/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Single GPT-5.5 call — completes in well under default timeout.
export const maxDuration = 60;

const Body = z.object({
  format: FormatSchema,
  worldType: WorldTypeSchema,
  /** Niches the operator just rejected via "Try another." Persisted only
   *  client-side; passed back so GPT-5.5 knows not to re-propose them. */
  recentlyShown: z.array(z.string().min(1).max(300)).max(20).optional(),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  return withSessionOperator(async () => {
    try {
      const history = await selectRecentWorlds(50);
      const result = await suggestWorld({
        format: parsed.data.format,
        worldType: parsed.data.worldType,
        history,
        recentlyShown: parsed.data.recentlyShown,
      });
      return NextResponse.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[api/concepts/suggest] failed:", err);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  });
}
