import { NextResponse } from "next/server";
import { z } from "zod";
import { AspectRatioSchema } from "@/lib/prompts/types";
import { withSessionOperator } from "@/lib/route-helpers";
import { currentOperator } from "@/lib/operators";
import { inngest } from "@/inngest/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GenerateBody = z
  .object({
    force: z.boolean().optional(),
    concurrency: z.number().int().min(1).max(8).optional(),
    aspectRatio: AspectRatioSchema.optional(),
  })
  .default({});

/**
 * Enqueue an image-batch job. The actual fal calls happen inside the
 * Inngest function (inngest/functions.ts) so the route returns in <1s and
 * isn't bound by Vercel function timeouts. The UI polls /api/projects/[id]
 * to surface progress as scenes flip from generating → generated in the DB.
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

  const parsed = GenerateBody.safeParse(body);
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
        name: "project/generate.requested",
        data: {
          projectId: id,
          operatorEmail: op.email,
          ...parsed.data,
        },
      });
      return NextResponse.json({ enqueued: true }, { status: 202 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[api/projects/[id]/generate] enqueue failed:", err);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  });
}
