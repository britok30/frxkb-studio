import { NextResponse } from "next/server";
import { z } from "zod";
import { createBeforeAfterProject } from "@/lib/projects";
import { AspectRatioSchema, WorldTypeSchema } from "@/lib/prompts/types";
import { withSessionOperator } from "@/lib/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One GPT concept call — interactive, bounded.
export const maxDuration = 300;

const Body = z.object({
  /** Public Vercel Blob URL returned by /api/upload. */
  beforeImageUrl: z.string().url(),
  /** Operator's transformation prompt — what should change about the before. */
  transformationPrompt: z.string().min(8).max(1000),
  /** Snapped aspect ratio returned by /api/upload — must match enum. */
  aspectRatio: AspectRatioSchema,
  worldType: WorldTypeSchema,
});

/**
 * Create a before-after project from an already-uploaded "before" image.
 * Distinct from /api/projects (which expects a niche + format) because the
 * input shape is fundamentally different: upload-driven, no scene-prompt
 * batch, no dedupe.
 */
export async function POST(req: Request): Promise<Response> {
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
      const result = await createBeforeAfterProject(parsed.data);
      return NextResponse.json(result, { status: 201 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[api/projects/before-after] failed:", err);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  });
}
