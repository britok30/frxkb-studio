import { NextResponse } from "next/server";
import { z } from "zod";
import { generateThumbnail } from "@/lib/thumbnail";
import { withSessionOperator } from "@/lib/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// gpt-image-2 edits routinely take 30-90s.
export const maxDuration = 300;

const Body = z.object({
  /** Public Blob URL from /api/upload/image. */
  imageUrl: z.string().url(),
  /** The text burned into the thumbnail. YouTube-thumb length, not an essay. */
  text: z.string().min(1).max(120),
  /** Optional art direction. */
  notes: z.string().max(300).optional(),
});

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
      { error: `Invalid ${where}: ${first?.message ?? "invalid input"}` },
      { status: 400 }
    );
  }

  return withSessionOperator(async () => {
    try {
      const result = await generateThumbnail({
        sourceImageUrl: parsed.data.imageUrl,
        text: parsed.data.text,
        notes: parsed.data.notes,
      });
      return NextResponse.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[api/thumbnail] failed:", err);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  });
}
