import { upload } from "@vercel/blob/client";
import { detectAspectRatio } from "@/lib/aspect";
import type { AspectRatio } from "@/lib/prompts/types";

// Browser-side image upload: straight to Vercel Blob (no serverless proxy,
// no 4.5MB body cap), with dimensions read locally so the server never
// needs to touch the bytes.

const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BYTES = 30 * 1024 * 1024;

export type UploadedImage = {
  url: string;
  aspectRatio: AspectRatio;
  width: number;
  height: number;
};

/** Read intrinsic dimensions in the browser. */
function readDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      if (!img.naturalWidth || !img.naturalHeight) {
        reject(new Error("Couldn't read image dimensions"));
        return;
      }
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Couldn't read image — is the file a valid JPEG/PNG/WebP?"));
    };
    img.src = url;
  });
}

/** Upload one image client-direct; returns URL + snapped aspect ratio. */
export async function uploadImage(file: File): Promise<UploadedImage> {
  if (!ALLOWED.has(file.type)) {
    throw new Error(`Unsupported file type: ${file.type || "unknown"}. Use JPEG, PNG, or WebP.`);
  }
  if (file.size > MAX_BYTES) {
    throw new Error(
      `File too large (${Math.round(file.size / 1024 / 1024)}MB). Max ${MAX_BYTES / 1024 / 1024}MB.`
    );
  }
  const { width, height } = await readDimensions(file);
  const blob = await upload(`uploads/${file.name}`, file, {
    access: "public",
    handleUploadUrl: "/api/upload/image",
  });
  return { url: blob.url, aspectRatio: detectAspectRatio(width, height), width, height };
}
