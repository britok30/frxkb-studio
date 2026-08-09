import { NextResponse } from "next/server";
import { z } from "zod";
import { createShowcaseProject } from "@/lib/projects";
import {
  PropertyTypeSchema,
  SHOWCASE_REEL_MAX_SHOTS,
  WorldTypeSchema,
} from "@/lib/prompts/types";
import { withSessionOperator } from "@/lib/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One GPT vision call over up to 20 images + (long-form) PNG normalization
// of every upload — interactive but bounded.
export const maxDuration = 300;

const Body = z
  .object({
  /** Public Blob URLs from /api/upload, in presentation order. Reels cap
   *  lower (SHOWCASE_REEL_MAX_SHOTS) — refined below. */
  imageUrls: z.array(z.string().url()).min(2).max(20),
  /** reel = 9:16 crossfaded clips; long-form = 16:9 chaptered YouTube tour. */
  deliverable: z.enum(["reel", "long-form"]),
  worldType: WorldTypeSchema,
  propertyType: PropertyTypeSchema.optional(),
  /** Seedance generation for the animate step. */
  videoModel: z.enum(["seedance-2.0", "seedance-2.5"]).optional(),
  operatorNotes: z.string().max(2000).optional(),
  })
  .refine(
    (b) => b.deliverable !== "reel" || b.imageUrls.length <= SHOWCASE_REEL_MAX_SHOTS,
    {
      path: ["imageUrls"],
      message: `A showcase reel caps at ${SHOWCASE_REEL_MAX_SHOTS} shots — pick your best ${SHOWCASE_REEL_MAX_SHOTS} or switch to the long-form.`,
    }
  );

/**
 * Create a showcase project from the operator's OWN images (client photos or
 * renders). No image generation — GPT names + describes each shot, the
 * uploads become pre-"generated" scenes, and the project lands ready to
 * Animate → Stitch → Finalize in its target format.
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
    const first = parsed.error.issues[0];
    const where = first?.path.join(".") || "input";
    return NextResponse.json(
      { error: `Invalid ${where}: ${first?.message ?? "invalid input"}`, issues: parsed.error.issues },
      { status: 400 }
    );
  }

  return withSessionOperator(async () => {
    try {
      const result = await createShowcaseProject(parsed.data);
      return NextResponse.json(result, { status: 201 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[api/projects/showcase] failed:", err);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  });
}
