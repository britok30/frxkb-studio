import { NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { auth } from "@/auth";
import { getOperator } from "@/lib/operators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Token endpoint for CLIENT-DIRECT image uploads (browser → Vercel Blob).
 * Multipart uploads through a serverless function die at Vercel's 4.5MB
 * request-body cap — a modern phone/DSLR exterior shot is routinely 5-15MB —
 * so images upload straight to Blob with a short-lived token minted here,
 * exactly like the music path. Dimensions/aspect are read client-side.
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
        allowedContentTypes: ["image/jpeg", "image/png", "image/webp"],
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
