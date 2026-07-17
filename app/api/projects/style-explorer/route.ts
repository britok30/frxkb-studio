import { NextResponse } from "next/server";
import { z } from "zod";
import { createStyleExplorerProject } from "@/lib/projects";
import {
  AspectRatioSchema,
  PropertyTypeSchema,
  WorldTypeSchema,
} from "@/lib/prompts/types";
import { withSessionOperator } from "@/lib/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  /** Public Vercel Blob URL returned by /api/upload. */
  baseImageUrl: z.string().url(),
  /** Snapped aspect ratio returned by /api/upload — must match enum. */
  aspectRatio: AspectRatioSchema,
  worldType: WorldTypeSchema,
  propertyType: PropertyTypeSchema,
  styleCount: z.number().int().min(3).max(20).optional(),
  operatorNotes: z.string().max(500).optional(),
  /** The operator's base-space description (from /api/style-base) — persisted so
   *  the YouTube metadata grounds its title/description in the real space. */
  baseDescription: z.string().max(1200).optional(),
});

/**
 * Create a style-explorer project from an already-uploaded base image. GPT-5.5
 * sees the base (vision) and proposes the styles; each becomes a pending scene
 * pinned to the base. The route returns the created project + scenes — the
 * operator then triggers the image fan-out from the project page (the existing
 * "Generate" action), so the spend is a deliberate click, not a side effect of
 * creating the project.
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
      const result = await createStyleExplorerProject(parsed.data);
      return NextResponse.json(result, { status: 201 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[api/projects/style-explorer] failed:", err);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  });
}
