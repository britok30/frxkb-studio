import { NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { auth } from "@/auth";
import { getOperator } from "@/lib/operators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Token endpoint for CLIENT-DIRECT music uploads (browser → Vercel Blob).
 * Regular multipart uploads through a serverless function die at Vercel's
 * 4.5MB request-body cap — a normal 320kbps MP3 is 7-10MB — so the music
 * bed uploads straight to Blob with a short-lived token minted here.
 */
export async function POST(request: Request): Promise<Response> {
  const session = await auth();
  const operator = getOperator(session?.user?.email);
  if (!operator) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const body = (await request.json()) as HandleUploadBody;
  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: [
          "audio/mpeg",
          "audio/mp4",
          "audio/x-m4a",
          "audio/wav",
          "audio/x-wav",
        ],
        maximumSizeInBytes: 30 * 1024 * 1024,
        addRandomSuffix: true,
      }),
      // Fires from Vercel's side after the blob lands (not reachable on
      // localhost — that's fine, the upload itself still completes).
      onUploadCompleted: async () => {},
    });
    return NextResponse.json(jsonResponse);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
