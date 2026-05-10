import { NextResponse } from "next/server";
import { z } from "zod";
import { createProject, listProjects } from "@/lib/projects";
import { FormatSchema } from "@/lib/prompts/types";
import { withSessionOperator } from "@/lib/route-helpers";

export const runtime = "nodejs";
// Concept + scene generation can take 20-60s; opt out of static generation.
export const dynamic = "force-dynamic";

const CreateBody = z.object({
  niche: z.string().min(2).max(200),
  format: FormatSchema,
  sceneCount: z.number().int().min(1).max(120).optional(),
  sceneDurationSec: z.number().int().min(0).max(15).optional(),
  operatorNotes: z.string().max(2000).optional(),
});

export async function GET() {
  try {
    const projects = await listProjects();
    return NextResponse.json({ projects });
  } catch (err) {
    return errorResponse(err);
  }
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
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.issues },
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
