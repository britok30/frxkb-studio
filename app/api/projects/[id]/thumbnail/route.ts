import { NextResponse } from "next/server";
import { z } from "zod";
import { generateThumbnail } from "@/lib/thumbnail";
import { getProjectWithScenes } from "@/lib/projects";
import { setProjectThumbnail } from "@/lib/projects-db";
import { requireProjectOwnership, withSessionOperator } from "@/lib/route-helpers";
import { BudgetExceededError } from "@/lib/spend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// gpt-image-2 edits routinely take 30-90s.
export const maxDuration = 300;

const Body = z
  .object({
    /** Override for the burn-in text; defaults to the finalize-generated
     *  metadata.thumbnailText. */
    text: z.string().min(1).max(120).optional(),
  })
  .default({});

/**
 * Generate the YouTube thumbnail for a style-explorer project: base still +
 * the finalize-generated thumbnailText → gpt-image-2 → 1280×720 JPEG,
 * persisted on the project (and packed into the export bundle).
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
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  return withSessionOperator(async () => {
    const denied = await requireProjectOwnership(id);
    if (denied) return denied;
    try {
      const found = await getProjectWithScenes(id);
      if (!found) return NextResponse.json({ error: "Project not found" }, { status: 404 });
      const { project, scenes } = found;

      if (project.format !== "style-explorer") {
        return NextResponse.json(
          { error: "Thumbnails are generated for YouTube (style-explorer) projects." },
          { status: 400 }
        );
      }

      const text =
        parsed.data.text?.trim() ||
        (project.metadata?.kind === "youtube" ? project.metadata.thumbnailText : null);
      if (!text) {
        return NextResponse.json(
          { error: "No thumbnail text yet — finalize the project first (or provide text)." },
          { status: 409 }
        );
      }

      // Source = the base still (order 1, the space every style restyles) —
      // it IS the video's subject. Fall back to the first rendered scene.
      const source =
        scenes.find((s) => s.order === 1 && !!s.imageUrl) ?? scenes.find((s) => !!s.imageUrl);
      if (!source?.imageUrl) {
        return NextResponse.json(
          { error: "No rendered still to build the thumbnail from." },
          { status: 409 }
        );
      }

      const result = await generateThumbnail({
        sourceImageUrl: source.imageUrl,
        text,
      });
      await setProjectThumbnail(id, result.url);
      return NextResponse.json({ url: result.url, text });
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        return NextResponse.json({ error: err.message }, { status: 402 });
      }
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[api/projects/[id]/thumbnail] failed:", err);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  });
}
