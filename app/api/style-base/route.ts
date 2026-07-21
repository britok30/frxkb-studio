import { NextResponse } from "next/server";
import { z } from "zod";
import { generateImage } from "@/lib/fal";
import { buildBaseImagePrompt } from "@/lib/prompts/styles";
import { PropertyTypeSchema, WorldTypeSchema } from "@/lib/prompts/types";
import { storeOperatorUpload } from "@/lib/storage";
import { withSessionOperator } from "@/lib/route-helpers";
import { currentOperator } from "@/lib/operators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Single nano-banana text-to-image (~15-40s at 2K).
export const maxDuration = 300;

const Body = z.object({
  /** Operator's free-text description of the space to render as the base. */
  description: z.string().min(8).max(1200),
  worldType: WorldTypeSchema,
  propertyType: PropertyTypeSchema,
});

/**
 * Render a style-explorer BASE image from a text description (text-to-image).
 * Pre-project: the operator generates + reviews + regenerates this base on the
 * /new/styles page, then passes the approved URL to /api/projects/style-explorer
 * to fan out the styles. Stored on Blob like an upload so the URL is permanent
 * (it becomes the project's reference for every styled edit).
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
      const { description, worldType, propertyType } = parsed.data;
      const prompt = buildBaseImagePrompt(description, worldType, propertyType);
      // Fresh seed each call so "Regenerate base" actually produces a different
      // take rather than re-landing on the same composition.
      const result = await generateImage({
        prompt,
        aspectRatio: "16:9",
        outputFormat: "jpeg",
        seed: Math.floor(Math.random() * 2_147_483_647),
      });
      const first = result.images[0];
      if (!first?.url) throw new Error("Base image generation returned no image.");

      // Re-host on our Blob (fal URLs expire) so the base stays valid as the
      // project's reference image.
      const res = await fetch(first.url);
      if (!res.ok) throw new Error(`Failed to fetch generated base: ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      const contentType = res.headers.get("content-type") ?? "image/jpeg";
      const ext = contentType.includes("png") ? "png" : "jpg";

      const op = currentOperator();
      const stored = await storeOperatorUpload({
        operatorEmail: op.email,
        buffer,
        ext,
        contentType,
      });

      return NextResponse.json({ url: stored.url, aspectRatio: "16:9" }, { status: 201 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[api/style-base] failed:", err);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  });
}
