import { NextResponse } from "next/server";
import { z } from "zod";
import { createProject, listProjects } from "@/lib/projects";
import { FormatSchema, WorldTypeSchema } from "@/lib/prompts/types";
import { LookIdSchema } from "@/lib/prompts/looks";
import { currentOperator } from "@/lib/operators";
import { withSessionOperator } from "@/lib/route-helpers";

export const runtime = "nodejs";
// Concept + scene generation can take 20-60s; opt out of static generation.
export const dynamic = "force-dynamic";
// Two interactive GPT calls the UI needs synchronously — bounded, but give
// them real headroom. Anything heavier than LLM text belongs on Inngest.
export const maxDuration = 300;

const CreateBody = z.object({
  /** The world/topic seed. Operators paste anything from two words to a
   *  full written brief — long pastes are BETTER input for the concept
   *  stage, so the cap matches operatorNotes. */
  niche: z.string().min(2).max(2000),
  format: FormatSchema,
  worldType: WorldTypeSchema,
  sceneCount: z.number().int().min(1).max(120).optional(),
  sceneDurationSec: z.number().int().min(0).max(15).optional(),
  operatorNotes: z.string().max(2000).optional(),
  /** Committed photographic look — an id from lib/prompts/looks.ts. */
  lookId: LookIdSchema.optional(),
  /** Render-quality tier: standard (2K stills, 1080p video) or hero
   *  (4K stills, Topaz 4K60 video). */
  quality: z.enum(["standard", "hero"]).optional(),
  /** Moodboard / photo references (Blob URLs from /api/upload, ≤5). Steer
   *  materials/palette/mood for every render; also shown to GPT-5.5 while
   *  it writes the brief. */
  referenceImageUrls: z.array(z.string().url()).max(5).optional(),
});

export async function GET() {
  return withSessionOperator(async () => {
    try {
      const projects = await listProjects(currentOperator().email);
      return NextResponse.json({ projects });
    } catch (err) {
      return errorResponse(err);
    }
  });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = CreateBody.safeParse(body);
  if (!parsed.success) {
    // Name the failing field in the message — the client toasts `error`
    // verbatim, and a bare "Invalid input" helps nobody.
    const first = parsed.error.issues[0];
    const where = first?.path.join(".") || "input";
    return NextResponse.json(
      { error: `Invalid ${where}: ${first?.message ?? "invalid input"}`, issues: parsed.error.issues },
      { status: 400 }
    );
  }

  return withSessionOperator(async () => {
    try {
      const result = await createProject(parsed.data);
      return NextResponse.json(result, { status: 201 });
    } catch (err) {
      return errorResponse(err);
    }
  });
}

function errorResponse(err: unknown) {
  const message = err instanceof Error ? err.message : "Unknown error";
  console.error("[api/projects] failed:", err);
  return NextResponse.json({ error: message }, { status: 500 });
}
