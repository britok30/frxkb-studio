"use client";

import { useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import { Download, ImagePlus } from "lucide-react";
import { saveAs } from "file-saver";
import { upload } from "@vercel/blob/client";
import { ease } from "@/lib/motion";
import { formatCost, GPT_IMAGE_2_THUMBNAIL_USD } from "@/lib/pricing";

/**
 * YouTube thumbnail generator. Upload a base image (a render or video frame),
 * type the text to burn in, optionally steer the art direction — gpt-image-2
 * restyles it into a thumbnail, delivered at YouTube's exact 1280×720 spec.
 */
export default function ThumbnailPage() {
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [text, setText] = useState("");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [resultUrl, setResultUrl] = useState<string | null>(null);

  async function onPickFile(file: File) {
    setUploading(true);
    const toastId = toast.loading(`Uploading ${file.name}…`);
    try {
      // Client-direct to Blob — image uploads routinely beat the 4.5MB
      // serverless body cap (same flow as the before-after upload).
      const blob = await upload(`thumbnail-src/${file.name}`, file, {
        access: "public",
        handleUploadUrl: "/api/upload/image",
      });
      setSourceUrl(blob.url);
      setResultUrl(null);
      toast.success("Base image ready", { id: toastId });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error("Upload failed", { id: toastId, description: message });
    } finally {
      setUploading(false);
    }
  }

  async function generate() {
    if (!sourceUrl || text.trim().length === 0 || loading) return;
    setLoading(true);
    setResultUrl(null);
    try {
      const res = await fetch("/api/thumbnail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageUrl: sourceUrl,
          text: text.trim(),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      setResultUrl(data.url);
      toast.success("Thumbnail ready");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error("Generation failed", { description: message });
    } finally {
      setLoading(false);
    }
  }

  async function download(url: string) {
    const toastId = toast.loading("Downloading…");
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      saveAs(await res.blob(), url.split("/").pop()?.split("?")[0] || "thumbnail.jpg");
      toast.success("Saved", { id: toastId });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error("Download failed", { id: toastId, description: message });
    }
  }

  return (
    <div className="mx-auto max-w-6xl w-full px-6 pt-12 pb-20 flex flex-col gap-10">
      <header className="flex flex-col gap-2">
        <Link
          href="/"
          className="text-xs text-muted-foreground hover:text-foreground tracking-tight inline-flex items-center gap-1 self-start"
        >
          <span aria-hidden>←</span> Studio
        </Link>
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-3xl font-semibold tracking-tight leading-[1.05]">Thumbnail</h1>
          <span className="text-xs text-muted-foreground tracking-tight">
            YouTube 1280×720 · gpt-image-2
          </span>
        </div>
      </header>

      <div className="grid gap-10 lg:grid-cols-[minmax(0,400px)_1fr] items-start">
        {/* Input column */}
        <section className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <span className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
              Base image
            </span>
            <label
              className={`relative aspect-video w-full rounded-lg border border-dashed overflow-hidden flex items-center justify-center cursor-pointer transition-colors ${
                sourceUrl ? "border-transparent" : "hover:border-foreground/40"
              }`}
            >
              {sourceUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={sourceUrl} alt="Base" className="absolute inset-0 w-full h-full object-cover" />
              ) : (
                <span className="flex flex-col items-center gap-1.5 text-muted-foreground">
                  <ImagePlus className="size-5" />
                  <span className="text-xs tracking-tight">
                    {uploading ? "Uploading…" : "Drop a render or video frame"}
                  </span>
                </span>
              )}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                disabled={uploading}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onPickFile(f);
                  e.target.value = "";
                }}
              />
            </label>
            {sourceUrl && (
              <span className="text-[10px] text-muted-foreground tracking-tight">
                Click the image to replace it.
              </span>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
              Thumbnail text
            </span>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={120}
              placeholder="10 Interior Styles, One Space"
              className="w-full h-11 rounded-lg border bg-transparent px-4 text-sm focus:border-foreground outline-none"
            />
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
              Art direction (optional)
            </span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              maxLength={300}
              placeholder="Text top-left, warm golden grade, slightly moodier…"
              className="w-full rounded-lg border bg-transparent px-4 py-3 text-sm leading-relaxed focus:border-foreground outline-none resize-none"
            />
          </div>

          <motion.button
            type="button"
            onClick={() => void generate()}
            disabled={loading || uploading || !sourceUrl || text.trim().length === 0}
            whileTap={loading ? undefined : { scale: 0.98 }}
            transition={{ duration: 0.12 }}
            className="inline-flex h-11 items-center justify-center rounded-md bg-foreground text-background text-sm font-medium tracking-tight hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
          >
            {loading
              ? "Generating…"
              : `Generate thumbnail (~${formatCost(GPT_IMAGE_2_THUMBNAIL_USD)})`}
          </motion.button>
        </section>

        {/* Output column */}
        <section className="flex flex-col gap-3">
          <span className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
            Output
          </span>
          <div className="aspect-video w-full overflow-hidden rounded-xl border bg-muted/30 flex items-center justify-center">
            <AnimatePresence mode="wait">
              {loading ? (
                <motion.div
                  key="loading"
                  className="relative w-full h-full bg-gradient-to-br from-muted/40 to-muted/20 flex items-center justify-center"
                  initial={{ opacity: 0 }}
                  animate={{
                    opacity: [0.5, 0.9, 0.5],
                    transition: { duration: 1.4, repeat: Infinity, ease: "easeInOut" },
                  }}
                  exit={{ opacity: 0, transition: { duration: 0.25 } }}
                >
                  <span className="text-xs text-muted-foreground tracking-tight tabular-nums">
                    gpt-image-2 — usually 30-90s
                  </span>
                </motion.div>
              ) : resultUrl ? (
                <motion.div
                  key={resultUrl}
                  className="w-full h-full"
                  initial={{ opacity: 0, scale: 1.02 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.6, ease }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={resultUrl} alt="Thumbnail" className="w-full h-full object-cover" />
                </motion.div>
              ) : (
                <motion.div
                  key="empty"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex flex-col items-center gap-1 text-muted-foreground"
                >
                  <span className="text-xs tracking-tight">
                    Your 1280×720 thumbnail will appear here.
                  </span>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          {resultUrl && (
            <motion.button
              type="button"
              onClick={() => void download(resultUrl)}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease }}
              whileTap={{ scale: 0.97 }}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground self-start tracking-tight"
            >
              <Download className="size-3.5" /> Download 1280×720 JPEG
            </motion.button>
          )}
        </section>
      </div>
    </div>
  );
}
