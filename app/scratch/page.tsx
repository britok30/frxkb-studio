"use client";

import { useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import { Download } from "lucide-react";
import { saveAs } from "file-saver";
import { ease } from "@/lib/motion";
import { estimateImageBatch, formatCost } from "@/lib/pricing";

type Aspect = "16:9" | "9:16" | "1:1";

const ASPECTS: { value: Aspect; label: string; hint: string; aspectClass: string }[] = [
  { value: "16:9", label: "16:9", hint: "Long-form", aspectClass: "aspect-video" },
  { value: "9:16", label: "9:16", hint: "Reels", aspectClass: "aspect-[9/16]" },
  { value: "1:1", label: "1:1", hint: "Square", aspectClass: "aspect-square" },
];

const PRESETS = [
  "Sun-drenched modernist living room with floor-to-ceiling glass, travertine floors, low-slung linen sofa, warm afternoon light raking across the space, cinematic.",
  "Mediterranean villa exterior at golden hour, terracotta roof, climbing bougainvillea, stone steps, soft hazy light, architectural photography.",
  "Minimalist Japanese tea room interior, tatami mats, shoji screens, single ikebana arrangement, diffuse morning light.",
  "Brutalist concrete house in a tropical jungle clearing, monstera leaves, late afternoon haze, photographic.",
];

export default function ScratchPage() {
  const [prompt, setPrompt] = useState(PRESETS[0]);
  const [aspect, setAspect] = useState<Aspect>("16:9");
  const [loading, setLoading] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  /**
   * Vercel Blob serves with Content-Disposition: inline, and the <a download>
   * attribute is ignored cross-origin — so we have to fetch the bytes
   * ourselves and trigger the save programmatically.
   */
  async function downloadImage(url: string) {
    const toastId = toast.loading("Downloading…");
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      // Pull a sensible filename from the URL ("/images/scratch/abc123.jpg" → "abc123.jpg")
      const filename = url.split("/").pop()?.split("?")[0] || "scratch.jpg";
      saveAs(blob, filename);
      toast.success("Saved", { id: toastId });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error("Download failed", { id: toastId, description: message });
    }
  }

  async function generate() {
    setLoading(true);
    setImageUrl(null);
    try {
      const res = await fetch("/api/generate/image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, aspectRatio: aspect }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      setImageUrl(data.url);
      toast.success("Generated");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error("Generation failed", { description: message });
    } finally {
      setLoading(false);
    }
  }

  const aspectClass = ASPECTS.find((a) => a.value === aspect)!.aspectClass;

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
          <h1 className="text-3xl font-semibold tracking-tight leading-[1.05]">Scratch</h1>
          <span className="text-xs text-muted-foreground tracking-tight">
            One-off image. Not saved to a project.
          </span>
        </div>
      </header>

      <div className="grid gap-10 lg:grid-cols-[minmax(0,400px)_1fr] items-start">
        {/* Prompt column */}
        <section className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <span className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
              Aspect
            </span>
            <div className="flex gap-2">
              {ASPECTS.map((a) => (
                <motion.button
                  key={a.value}
                  type="button"
                  onClick={() => setAspect(a.value)}
                  whileTap={{ scale: 0.97 }}
                  transition={{ duration: 0.12 }}
                  className={`flex-1 rounded-lg border py-3 px-2 flex flex-col items-center gap-2 transition-colors ${
                    aspect === a.value
                      ? "border-foreground bg-foreground/[0.03]"
                      : "hover:border-foreground/30"
                  }`}
                >
                  <div
                    className={`${a.aspectClass} h-7 rounded border-2 transition-colors ${
                      aspect === a.value ? "border-foreground bg-foreground" : "border-foreground/30"
                    }`}
                  />
                  <div className="flex flex-col items-center gap-0.5">
                    <span className="text-xs font-medium tabular-nums">{a.label}</span>
                    <span className="text-[10px] text-muted-foreground">{a.hint}</span>
                  </div>
                </motion.button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
              Prompt
            </span>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={9}
              placeholder="Describe the scene…"
              className="w-full rounded-lg border bg-transparent px-4 py-3 text-sm leading-relaxed focus:border-foreground outline-none resize-none"
            />
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
              Try one
            </span>
            <div className="flex flex-col">
              {PRESETS.map((p, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setPrompt(p)}
                  className={`text-left text-xs py-2 leading-relaxed border-b last:border-b-0 transition-colors ${
                    prompt === p
                      ? "text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <span className="line-clamp-2">{p}</span>
                </button>
              ))}
            </div>
          </div>

          <motion.button
            type="button"
            onClick={generate}
            disabled={loading || prompt.trim().length < 3}
            whileTap={loading ? undefined : { scale: 0.98 }}
            transition={{ duration: 0.12 }}
            className="inline-flex h-11 items-center justify-center rounded-md bg-foreground text-background text-sm font-medium tracking-tight hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
          >
            {loading ? "Generating…" : `Generate image (~${formatCost(estimateImageBatch(1))})`}
          </motion.button>
        </section>

        {/* Output column */}
        <section className="flex flex-col gap-3">
          <span className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
            Output
          </span>
          <div
            className={`${aspectClass} w-full overflow-hidden rounded-xl border bg-muted/30 flex items-center justify-center`}
          >
            <AnimatePresence mode="wait">
              {loading ? (
                <motion.div
                  key="loading"
                  className="relative w-full h-full bg-gradient-to-br from-muted/40 to-muted/20 flex items-center justify-center"
                  initial={{ opacity: 0 }}
                  animate={{
                    opacity: [0.5, 0.9, 0.5],
                    // Loop transition is scoped INSIDE animate so it doesn't
                    // bleed into exit. Otherwise repeat:Infinity hangs the exit
                    // and AnimatePresence mode="wait" never mounts the next.
                    transition: { duration: 1.4, repeat: Infinity, ease: "easeInOut" },
                  }}
                  exit={{ opacity: 0, transition: { duration: 0.25 } }}
                >
                  <span className="text-xs text-muted-foreground tracking-tight tabular-nums">
                    Pro at 2K — usually 20-40s
                  </span>
                </motion.div>
              ) : imageUrl ? (
                <motion.div
                  key={imageUrl}
                  className="w-full h-full"
                  initial={{ opacity: 0, scale: 1.02 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.6, ease }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={imageUrl}
                    alt="Generated"
                    className="w-full h-full object-cover"
                    onError={() => {
                      toast.error("Image failed to load", { description: imageUrl });
                    }}
                  />
                </motion.div>
              ) : (
                <motion.div
                  key="empty"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex flex-col items-center gap-1 text-muted-foreground"
                >
                  <span className="text-xs tracking-tight">Image will appear here.</span>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          {imageUrl && (
            <motion.button
              type="button"
              onClick={() => void downloadImage(imageUrl)}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease }}
              whileTap={{ scale: 0.97 }}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground self-start tracking-tight"
            >
              <Download className="size-3.5" /> Download
            </motion.button>
          )}
        </section>
      </div>
    </div>
  );
}
