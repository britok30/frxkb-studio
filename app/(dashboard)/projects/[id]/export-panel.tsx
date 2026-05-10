"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Copy, Download } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { ease } from "@/lib/motion";
import { downloadBundle, type BundleData } from "@/lib/zip-bundle";

export type ExportPanelData = {
  projectId: string;
  title: string;
  niche: string;
  format: string;
  thumbnailUrl: string;
  scenes: {
    order: number;
    prompt: string;
    durationSec: number | null;
    imageUrl: string;
    /** Set when scene has been animated (reels). */
    videoUrl?: string | null;
  }[];
  metadata: {
    youtubeTitle: string;
    youtubeTitleAlternates: string[];
    youtubeDescription: string;
    youtubeTags: string[];
    instagramCaption: string;
    hashtags: string[];
    pinnedComment: string;
  };
};

export function ExportPanel({ data }: { data: ExportPanelData }) {
  const { metadata, thumbnailUrl, scenes } = data;
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  async function onDownload() {
    if (downloading) return;
    setDownloading(true);
    setProgress({ done: 0, total: scenes.length + 1 });
    const toastId = toast.loading(`Packing ${scenes.length} scenes…`);
    try {
      const bundle: BundleData = {
        projectId: data.projectId,
        title: data.title,
        niche: data.niche,
        format: data.format,
        thumbnailUrl: data.thumbnailUrl,
        scenes,
        metadata,
      };
      await downloadBundle(bundle, {
        onProgress: (done, total) => setProgress({ done, total }),
      });
      toast.success("Bundle downloaded", { id: toastId });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error("Couldn't pack bundle", { id: toastId, description: message });
    } finally {
      setDownloading(false);
      setProgress(null);
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease }}
    >
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">Export bundle</CardTitle>
              <CardDescription>
                {scenes.length} scenes + thumbnail + metadata, packed as a single zip.
              </CardDescription>
            </div>
            <Badge>Ready</Badge>
          </div>
        </CardHeader>
        <CardContent className="grid gap-6 lg:grid-cols-[260px_1fr]">
          <div className="flex flex-col gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={thumbnailUrl}
              alt="Thumbnail"
              className="w-full rounded-md border bg-muted/40 object-cover"
            />
            <motion.button
              type="button"
              onClick={onDownload}
              disabled={downloading}
              whileTap={{ scale: 0.98 }}
              transition={{ duration: 0.12 }}
              className="w-full h-10 rounded-md bg-foreground text-background text-sm font-medium tracking-tight hover:opacity-90 transition-opacity inline-flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <Download className="size-3.5" />
              {downloading
                ? progress
                  ? `Packing ${progress.done}/${progress.total}…`
                  : "Packing…"
                : "Download bundle"}
            </motion.button>
            <a
              className="text-xs text-muted-foreground hover:text-foreground"
              href={thumbnailUrl}
              target="_blank"
              rel="noreferrer"
            >
              ↗ Open thumbnail
            </a>
          </div>

          <div className="flex flex-col gap-4">
            <CopyField label="YouTube title" value={metadata.youtubeTitle} />
            {metadata.youtubeTitleAlternates.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <div className="text-xs text-muted-foreground">Title alternates</div>
                <div className="flex flex-col gap-1.5">
                  {metadata.youtubeTitleAlternates.map((t, i) => (
                    <CopyField key={i} value={t} small />
                  ))}
                </div>
              </div>
            )}
            <CopyField label="Description" value={metadata.youtubeDescription} multiline />
            <CopyField label="Pinned comment" value={metadata.pinnedComment} multiline />

            <Separator />

            <CopyField label="Instagram caption" value={metadata.instagramCaption} multiline />

            <div className="grid gap-3 sm:grid-cols-2">
              <ChipList label="YouTube tags" items={metadata.youtubeTags} />
              <ChipList label="Hashtags" items={metadata.hashtags.map((h) => `#${h}`)} />
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

function CopyField({
  label,
  value,
  multiline,
  small,
}: {
  label?: string;
  value: string;
  multiline?: boolean;
  small?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success("Copied");
      setTimeout(() => setCopied(false), 1200);
    } catch {
      toast.error("Couldn't copy");
    }
  }
  return (
    <div className="flex flex-col gap-1.5">
      {label && <div className="text-xs text-muted-foreground">{label}</div>}
      <div className="relative">
        <div
          className={`${
            multiline ? "whitespace-pre-line" : "truncate"
          } rounded-md border bg-muted/30 px-3 py-2 ${small ? "text-xs" : "text-sm"} pr-10`}
        >
          {value}
        </div>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy"
          className="absolute right-1.5 top-1.5 size-7 rounded-md inline-flex items-center justify-center hover:bg-accent text-muted-foreground hover:text-foreground"
        >
          <Copy className="size-3.5" />
          {copied && <span className="sr-only">Copied</span>}
        </button>
      </div>
    </div>
  );
}

function ChipList({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((t, i) => (
          <span
            key={i}
            className="text-xs rounded-md border bg-muted/30 px-2 py-0.5 text-muted-foreground"
          >
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}
