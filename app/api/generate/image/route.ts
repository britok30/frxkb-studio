import { NextResponse } from "next/server";
import { z } from "zod";
import { nanoid } from "nanoid";
import { generateImage } from "@/lib/fal";
import { storeFromUrl } from "@/lib/storage";
import { withSessionOperator } from "@/lib/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Single nano-banana image — scratchpad.
export const maxDuration = 300;

// projectId becomes a path segment under public/generated/images — must be
// constrained to safe characters to prevent path traversal.
const PROJECT_ID_RE = /^[a-zA-Z0-9_-]+$/;

const BodySchema = z.object({
  prompt: z.string().min(3).max(4000),
  aspectRatio: z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]).optional(),
  outputFormat: z.enum(["jpeg", "png"]).optional(),
  projectId: z.string().min(1).max(64).regex(PROJECT_ID_RE).optional(),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }

  const { prompt, aspectRatio, outputFormat = "jpeg", projectId = "scratch" } = parsed.data;

  return withSessionOperator(async () => {
    try {
      const result = await generateImage({ prompt, aspectRatio, outputFormat });
      const first = result.images[0];
      if (!first) {
        return NextResponse.json({ error: "No image returned" }, { status: 502 });
      }

      if (!first.url) {
        return NextResponse.json({ error: "Malformed image response" }, { status: 502 });
      }

      const filename = `${nanoid(10)}.${outputFormat === "png" ? "png" : "jpg"}`;
      const stored = await storeFromUrl({
        url: first.url,
        kind: "images",
        projectId,
        filename,
      });

      return NextResponse.json({
        url: stored.url,
        requestId: result.requestId,
        ...(result.description ? { description: result.description } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[generate/image] failed:", err);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  });
}
