import { NextResponse } from "next/server";
import { z } from "zod";
import { withSessionOperator } from "@/lib/route-helpers";
import { currentOperator } from "@/lib/operators";
import { inngest } from "@/inngest/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z
  .object({
    force: z.boolean().optional(),
    concurrency: z.number().int().min(1).max(4).optional(),
  })
  .default({});

/**
 * Enqueue an animate job (reel-only). Heavy work (motion prompts + seedance
 * + Topaz upscale × N scenes) runs in the Inngest function — animate at 5
 * scenes is ~150s wall-clock, far past Vercel's per-request limits.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  let body: unknown = {};
  try {
    const text = await req.text();
    body = text ? JSON.parse(text) : {};
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
      const op = currentOperator();
      await inngest.send({
        name: "project/animate.requested",
        data: {
          projectId: id,
          operatorEmail: op.email,
          ...parsed.data,
        },
      });
      return NextResponse.json({ enqueued: true }, { status: 202 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[api/projects/[id]/animate] enqueue failed:", err);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  });
}
