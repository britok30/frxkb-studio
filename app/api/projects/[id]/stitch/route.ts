import { NextResponse } from "next/server";
import { z } from "zod";
import { stitchFinalVideo } from "@/lib/projects";
import { withSessionOperator } from "@/lib/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Compose runs in seconds, but leave headroom for long reels + Blob re-host.
export const maxDuration = 120;

const PostBody = z.object({
  /** Optional music bed (public Blob URL from /api/upload). Spans the whole
   *  timeline and REPLACES the per-clip ambient audio — the fix for each
   *  seedance segment carrying a different ambience. Omit to keep the native
   *  per-clip audio. */
  musicUrl: z.string().url().optional(),
  /** Style-explorer only: seconds each still holds on screen (uniform).
   *  Chapters in the description land at i × perStillSec. */
  perStillSec: z.number().int().min(3).max(15).optional(),
  /** Style-explorer only: loop the sequence until the video reaches at least
   *  this many minutes (whole cycles). 8+ unlocks YouTube mid-rolls. */
  targetMinutes: z.number().int().min(1).max(20).optional(),
  /** Music file duration in seconds (read client-side) — lets the server
   *  tile the bed so long videos don't go silent when the song ends. */
  musicDurationSec: z.number().positive().max(3600).optional(),
});

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

  const parsed = PostBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  return withSessionOperator(async () => {
    try {
      const result = await stitchFinalVideo(id, {
        musicUrl: parsed.data.musicUrl,
        perStillSec: parsed.data.perStillSec,
        targetMinutes: parsed.data.targetMinutes,
        musicDurationSec: parsed.data.musicDurationSec,
      });
      return NextResponse.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      if (/not found/i.test(message)) {
        return NextResponse.json({ error: message }, { status: 404 });
      }
      if (/only available|not animated|not generated|Missing the before|Animate the after/i.test(message)) {
        return NextResponse.json({ error: message }, { status: 400 });
      }
      console.error("[api/projects/[id]/stitch] failed:", err);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  });
}
