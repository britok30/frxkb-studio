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
import type { Metadata } from "@/lib/prompts/metadata";

export type ExportPanelData = {
  projectId: string;
  title: string;
  niche: string;
  format: string;
  thumbnailUrl: string;
  /** Stitched final MP4, when the operator ran Stitch — packed into the zip. */
  finalVideoUrl?: string | null;
  scenes: {
    order: number;
    prompt: string;
    durationSec: number | null;
    imageUrl: string;
    /** Set when scene has been animated (reels). */
    videoUrl?: string | null;
    /** Style-explorer card copy. */
    styleName?: string | null;
    styleSubtitle?: string | null;
  }[];
  metadata: Metadata;
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
        finalVideoUrl: data.finalVideoUrl,
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
                {scenes.length} scenes + cover + metadata, packed as a single zip.
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
              alt="Cover"
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
              className="text-xs text-muted-foreground hover:text-foreground tracking-tight"
              href={thumbnailUrl}
              target="_blank"
              rel="noreferrer"
            >
              ↗ Open cover image
            </a>
          </div>

          <MetadataView metadata={metadata} scenes={scenes} />
        </CardContent>
      </Card>
    </motion.div>
  );
}

function MetadataView({
  metadata,
  scenes,
}: {
  metadata: Metadata;
  scenes: ExportPanelData["scenes"];
}) {
  switch (metadata.kind) {
    case "reel":
      return <ReelMetadataView metadata={metadata} />;
    case "carousel":
      return <CarouselMetadataView metadata={metadata} />;
    case "youtube":
      return <YouTubeMetadataView metadata={metadata} scenes={scenes} />;
  }
}

function YouTubeMetadataView({
  metadata,
  scenes,
}: {
  metadata: Extract<Metadata, { kind: "youtube" }>;
  scenes: ExportPanelData["scenes"];
}) {
  const cards = scenes.filter((s) => !!s.styleName);
  return (
    <div className="flex flex-col gap-6">
      <PlatformSection title="YouTube">
        <CopyField label="Title" value={metadata.title} />
        <CopyField label="Thumbnail text (burn into your thumbnail)" value={metadata.thumbnailText} />
        <CopyField label="Description" value={metadata.description} multiline />
        <ChipList label="Tags" items={metadata.tags} />
        <ChipList label="Hashtags" items={metadata.hashtags.map((h) => `#${h}`)} />
      </PlatformSection>
      {cards.length > 0 && (
        <>
          <Separator />
          <PlatformSection title="On-screen card copy (per style)">
            <div className="flex flex-col gap-2">
              {cards.map((s) => (
                <div key={s.order} className="rounded-md border bg-muted/30 px-3 py-2">
                  <div className="text-sm font-medium tracking-tight">{s.styleName}</div>
                  {s.styleSubtitle && (
                    <div className="text-xs text-muted-foreground">{s.styleSubtitle}</div>
                  )}
                </div>
              ))}
            </div>
          </PlatformSection>
        </>
      )}
    </div>
  );
}

function ReelMetadataView({ metadata }: { metadata: Extract<Metadata, { kind: "reel" }> }) {
  return (
    <div className="flex flex-col gap-6">
      <PlatformSection title="TikTok">
        <CopyField label="Caption" value={metadata.tiktokCaption} multiline />
        <ChipList label="Hashtags" items={metadata.tiktokHashtags.map((h) => `#${h}`)} />
      </PlatformSection>
      <Separator />
      <PlatformSection title="Instagram Reels">
        <CopyField label="Caption" value={metadata.instagramCaption} multiline />
        <ChipList label="Hashtags" items={metadata.instagramHashtags.map((h) => `#${h}`)} />
      </PlatformSection>
      <Separator />
      <PlatformSection title="YouTube Shorts">
        <CopyField label="Title" value={metadata.shortsTitle} />
        <CopyField label="Description" value={metadata.shortsDescription} multiline />
        <ChipList label="Hashtags" items={metadata.shortsHashtags.map((h) => `#${h}`)} />
      </PlatformSection>
      <Separator />
      <CopyField label="Pinned comment (reusable across all)" value={metadata.pinnedComment} multiline />
    </div>
  );
}

function CarouselMetadataView({ metadata }: { metadata: Extract<Metadata, { kind: "carousel" }> }) {
  return (
    <div className="flex flex-col gap-4">
      <PlatformSection title="Instagram carousel">
        <CopyField label="Caption" value={metadata.instagramCaption} multiline />
        <ChipList label="Hashtags" items={metadata.instagramHashtags.map((h) => `#${h}`)} />
      </PlatformSection>
    </div>
  );
}

function PlatformSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
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
