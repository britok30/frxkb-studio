"use client";

import Image from "next/image";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Download } from "lucide-react";
import { saveAs } from "file-saver";
import { downloadThumbnailFilename } from "@/lib/filenames";
import { Card } from "@/components/ui/card";
import { ease, staggerDelay } from "@/lib/motion";

/** One finished thumbnail on the dashboard — preview, overlay text, download. */
export function ThumbnailCard({
  thumbnail,
  index,
}: {
  thumbnail: { id: string; url: string; text: string; createdAt: string | Date };
  index: number;
}) {
  async function download() {
    const toastId = toast.loading("Downloading…");
    try {
      const res = await fetch(thumbnail.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      saveAs(await res.blob(), downloadThumbnailFilename(thumbnail.text));
      toast.success("Saved", { id: toastId });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error("Download failed", { id: toastId, description: message });
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease, delay: staggerDelay(index) }}
    >
      <Card className="overflow-hidden p-0 group">
        <div className="relative aspect-video w-full bg-muted/30">
          <Image
            src={thumbnail.url}
            alt={thumbnail.text}
            fill
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
            className="object-cover"
          />
          <button
            type="button"
            onClick={() => void download()}
            title="Download 1280×720 JPEG"
            className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-md bg-black/60 px-2 py-1 text-[10px] text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/80"
          >
            <Download className="size-3" /> Download
          </button>
        </div>
        <div className="px-3 py-2 text-xs tracking-tight text-muted-foreground truncate">
          {thumbnail.text}
        </div>
      </Card>
    </motion.div>
  );
}
