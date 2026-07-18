import { NextResponse } from "next/server";
import sharp from "sharp";
import { storeOperatorUpload } from "@/lib/storage";
import { detectAspectRatio } from "@/lib/aspect";
import { withSessionOperator } from "@/lib/route-helpers";
import { currentOperator } from "@/lib/operators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 8 * 1024 * 1024; // 8MB — Vercel body limit headroom
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const TYPE_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
/** Audio uploads (music bed for the stitched final video). Skips the sharp/
 *  aspect pipeline entirely — stored as-is and returned with kind:"audio". */
const ALLOWED_AUDIO_TYPES: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};

/**
 * Operator-uploaded "before" image for a before-after project. Validates type
 * + size, runs sharp to detect dimensions, snaps to the closest AspectRatio
 * enum member, stores on Vercel Blob, returns the public URL plus aspect/size.
 *
 * Frontend uses the returned URL + aspectRatio when posting to /api/projects
 * to create the actual project row.
 */
export async function POST(req: Request): Promise<Response> {
  return withSessionOperator(async () => {
    let file: File | null;
    try {
      const form = await req.formData();
      const f = form.get("file");
      file = f instanceof File ? f : null;
    } catch {
      return NextResponse.json(
        { error: "Invalid form data — POST as multipart/form-data with a 'file' field." },
        { status: 400 }
      );
    }

    if (!file) {
      return NextResponse.json({ error: "Missing 'file' field" }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: `File too large (${Math.round(file.size / 1024 / 1024)}MB). Max ${MAX_BYTES / 1024 / 1024}MB.` },
        { status: 400 }
      );
    }

    // Audio branch: store as-is, no dimension/aspect pipeline.
    if (ALLOWED_AUDIO_TYPES[file.type]) {
      const audioBuffer = Buffer.from(await file.arrayBuffer());
      try {
        const op = currentOperator();
        const stored = await storeOperatorUpload({
          operatorEmail: op.email,
          buffer: audioBuffer,
          ext: ALLOWED_AUDIO_TYPES[file.type],
          contentType: file.type,
        });
        return NextResponse.json({ url: stored.url, kind: "audio" });
      } catch (err) {
        const message = err instanceof Error ? err.message : "unknown error";
        console.error("[api/upload] audio blob upload failed:", err);
        return NextResponse.json({ error: message }, { status: 500 });
      }
    }

    if (!ALLOWED_TYPES.has(file.type)) {
      return NextResponse.json(
        { error: `Unsupported file type: ${file.type}. Use JPEG, PNG, WebP, or MP3/M4A/WAV for music.` },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    let width: number;
    let height: number;
    try {
      const meta = await sharp(buffer).metadata();
      if (!meta.width || !meta.height) {
        throw new Error("could not read image dimensions");
      }
      width = meta.width;
      height = meta.height;
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      return NextResponse.json(
        { error: `Couldn't read image: ${message}` },
        { status: 400 }
      );
    }

    const aspectRatio = detectAspectRatio(width, height);
    const op = currentOperator();
    const ext = TYPE_TO_EXT[file.type];

    try {
      const stored = await storeOperatorUpload({
        operatorEmail: op.email,
        buffer,
        ext,
        contentType: file.type,
      });
      return NextResponse.json({
        url: stored.url,
        aspectRatio,
        width,
        height,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      console.error("[api/upload] blob upload failed:", err);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  });
}
