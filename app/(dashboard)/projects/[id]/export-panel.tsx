"use client";

import Image from "next/image";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Check, Copy, FileArchive, Film, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { downloadVideoFilename } from "@/lib/filenames";
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
  /** Generated YouTube thumbnail (style-explorer) — previewed in the panel
   *  and packed into the zip as youtube-thumbnail-1280x720.jpg. */
  youtubeThumbnailUrl?: string | null;
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

export function ExportPanel({
  data,
  canDownload = true,
  canGenerateThumbnail = false,
}: {
  data: ExportPanelData;
  /** Everyone can VIEW the export; only the owner (and the admin) can pull
   *  the bundle or open source files. */
  canDownload?: boolean;
  /** Owner-only: the gpt-image-2 thumbnail generate/regenerate button. */
  canGenerateThumbnail?: boolean;
}) {
  const { metadata, thumbnailUrl, scenes } = data;
  const [downloading, setDownloading] = useState(false);
  const [downloadingVideo, setDownloadingVideo] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  // Downloads unlock only when the deliverable is COMPLETE: video formats
  // need the stitched final; YouTube long-forms additionally need the
  // generated thumbnail. Stills-only formats have no gates.
  const needsVideo = data.format === "reel" || data.format === "style-explorer";
  const needsThumbnail = data.format === "style-explorer";
  const checklist: Array<{ label: string; done: boolean }> = [
    ...(needsVideo
      ? [{ label: "Stitch the final video (Final video panel above)", done: !!data.finalVideoUrl }]
      : []),
    ...(needsThumbnail
      ? [{ label: "Generate the YouTube thumbnail (below)", done: !!data.youtubeThumbnailUrl }]
      : []),
  ];
  const ready = checklist.every((c) => c.done);

  const videoFilename = downloadVideoFilename(data.title);

  async function downloadVideo() {
    if (!data.finalVideoUrl || downloadingVideo) return;
    setDownloadingVideo(true);
    const toastId = toast.loading(`Downloading ${videoFilename}…`);
    try {
      const res = await fetch(data.finalVideoUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { saveAs } = await import("file-saver");
      saveAs(await res.blob(), videoFilename);
      toast.success("Video downloaded", { id: toastId });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error("Video download failed", { id: toastId, description: message });
    } finally {
      setDownloadingVideo(false);
    }
  }

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
        youtubeThumbnailUrl: data.youtubeThumbnailUrl,
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
            <Image
              src={thumbnailUrl}
              alt="Cover"
              width={600}
              height={400}
              sizes="260px"
              className="w-full h-auto rounded-md border bg-muted/40 object-cover"
            />
            {canDownload ? (
              <>
                {/* Two distinguishable deliverables: the zip of assets+copy,
                    and the final video by itself (gigabyte-class files can't
                    live inside a browser-built zip). Both unlock together
                    when the checklist is complete. */}
                <motion.button
                  type="button"
                  onClick={onDownload}
                  disabled={downloading || !ready}
                  whileTap={{ scale: 0.98 }}
                  transition={{ duration: 0.12 }}
                  className="w-full h-10 rounded-md bg-foreground text-background text-sm font-medium tracking-tight hover:opacity-90 transition-opacity inline-flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <FileArchive className="size-3.5" />
                  {downloading
                    ? progress
                      ? `Packing ${progress.done}/${progress.total}…`
                      : "Packing…"
                    : "Bundle — stills · thumbnails · copy"}
                </motion.button>
                {needsVideo && (
                  <motion.button
                    type="button"
                    onClick={() => void downloadVideo()}
                    disabled={downloadingVideo || !ready}
                    whileTap={{ scale: 0.98 }}
                    transition={{ duration: 0.12 }}
                    className="w-full h-10 rounded-md border text-sm font-medium tracking-tight hover:border-foreground/40 transition-colors inline-flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Film className="size-3.5" />
                    {downloadingVideo ? "Downloading…" : `Video — ${videoFilename}`}
                  </motion.button>
                )}
                {!ready && (
                  <div className="flex flex-col gap-1 rounded-md border border-dashed bg-muted/30 px-3 py-2">
                    <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                      To unlock downloads
                    </span>
                    {checklist.map((c) => (
                      <span
                        key={c.label}
                        className={`inline-flex items-center gap-1.5 text-xs tracking-tight ${
                          c.done ? "text-muted-foreground line-through" : ""
                        }`}
                      >
                        {c.done ? (
                          <Check className="size-3 text-green-600" />
                        ) : (
                          <X className="size-3 text-destructive" />
                        )}
                        {c.label}
                      </span>
                    ))}
                  </div>
                )}
                <a
                  className="text-xs text-muted-foreground hover:text-foreground tracking-tight"
                  href={thumbnailUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  ↗ Open cover image
                </a>
              </>
            ) : (
              <p className="text-xs text-muted-foreground tracking-tight leading-relaxed">
                View only — downloads belong to this project&apos;s owner.
              </p>
            )}
          </div>

          <MetadataView
            metadata={metadata}
            scenes={scenes}
            projectId={data.projectId}
            youtubeThumbnailUrl={data.youtubeThumbnailUrl}
            canGenerateThumbnail={canGenerateThumbnail}
          />
        </CardContent>
      </Card>
    </motion.div>
  );
}

function MetadataView({
  metadata,
  scenes,
  projectId,
  youtubeThumbnailUrl,
  canGenerateThumbnail,
}: {
  metadata: Metadata;
  scenes: ExportPanelData["scenes"];
  projectId: string;
  youtubeThumbnailUrl?: string | null;
  canGenerateThumbnail: boolean;
}) {
  switch (metadata.kind) {
    case "reel":
      return <ReelMetadataView metadata={metadata} />;
    case "carousel":
      return <CarouselMetadataView metadata={metadata} />;
    case "youtube":
      return (
        <YouTubeMetadataView
          metadata={metadata}
          scenes={scenes}
          projectId={projectId}
          youtubeThumbnailUrl={youtubeThumbnailUrl}
          canGenerateThumbnail={canGenerateThumbnail}
        />
      );
  }
}

function YouTubeMetadataView({
  metadata,
  scenes,
  projectId,
  youtubeThumbnailUrl,
  canGenerateThumbnail,
}: {
  metadata: Extract<Metadata, { kind: "youtube" }>;
  scenes: ExportPanelData["scenes"];
  projectId: string;
  youtubeThumbnailUrl?: string | null;
  canGenerateThumbnail: boolean;
}) {
  const cards = scenes.filter((s) => !!s.styleName);
  return (
    <div className="flex flex-col gap-6">
      <PlatformSection title="YouTube">
        <CopyField label="Title" value={metadata.title} />
        <CopyField label="Thumbnail text (burn into your thumbnail)" value={metadata.thumbnailText} />
        <CopyField label="Description" value={metadata.description} multiline />
        <ChipList label="Tags" items={metadata.tags} copyValue={metadata.tags.join(", ")} />
        <ChipList label="Hashtags" items={metadata.hashtags.map((h) => `#${h}`)} copyValue={metadata.hashtags.map((h) => `#${h}`).join(" ")} />
      </PlatformSection>
      <Separator />
      <YouTubeThumbnailSection
        projectId={projectId}
        defaultText={metadata.thumbnailText}
        thumbnailUrl={youtubeThumbnailUrl ?? null}
        canGenerate={canGenerateThumbnail}
      />
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

/** Caption with its hashtags appended — one copy grabs the whole paste. */
function withTags(caption: string, tags: string[]): string {
  if (tags.length === 0) return caption;
  return `${caption}\n\n${tags.map((t) => `#${t}`).join(" ")}`;
}

function ReelMetadataView({ metadata }: { metadata: Extract<Metadata, { kind: "reel" }> }) {
  return (
    <div className="flex flex-col gap-6">
      <PlatformSection title="TikTok">
        <CopyField
          label="Caption + hashtags"
          value={withTags(metadata.tiktokCaption, metadata.tiktokHashtags)}
          multiline
        />
      </PlatformSection>
      <Separator />
      <PlatformSection title="Instagram Reels">
        <CopyField
          label="Caption + hashtags"
          value={withTags(metadata.instagramCaption, metadata.instagramHashtags)}
          multiline
        />
      </PlatformSection>
      <Separator />
      <PlatformSection title="YouTube Shorts">
        <CopyField label="Title" value={metadata.shortsTitle} />
        <CopyField
          label="Description + hashtags"
          value={withTags(metadata.shortsDescription, metadata.shortsHashtags)}
          multiline
        />
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
        <CopyField
          label="Caption + hashtags"
          value={withTags(metadata.instagramCaption, metadata.instagramHashtags)}
          multiline
        />
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

function ChipList({
  label,
  items,
  copyValue,
}: {
  label: string;
  items: string[];
  /** Paste-ready string behind the one-click copy (e.g. comma-separated
   *  tags for YouTube's tag box, space-separated #hashtags for captions). */
  copyValue?: string;
}) {
  async function copy() {
    if (!copyValue) return;
    try {
      await navigator.clipboard.writeText(copyValue);
      toast.success("Copied — paste straight into the field");
    } catch {
      toast.error("Couldn't copy");
    }
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <div className="text-xs text-muted-foreground">{label}</div>
        {copyValue && (
          <button
            type="button"
            onClick={() => void copy()}
            title={`Copy: ${copyValue.slice(0, 80)}`}
            className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground tracking-tight transition-colors"
          >
            <Copy className="size-3" /> Copy all
          </button>
        )}
      </div>
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

/** In-project YouTube thumbnail generator: base still + the finalize-written
 *  thumbnailText → gpt-image-2 → 1280×720, persisted on the project and
 *  packed into the bundle as youtube-thumbnail-1280x720.jpg. */
function YouTubeThumbnailSection({
  projectId,
  defaultText,
  thumbnailUrl,
  canGenerate,
}: {
  projectId: string;
  defaultText: string;
  thumbnailUrl: string | null;
  canGenerate: boolean;
}) {
  const router = useRouter();
  const [text, setText] = useState(defaultText);
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  async function generate() {
    if (busy || text.trim().length === 0) return;
    setBusy(true);
    const toastId = toast.loading("Generating thumbnail — usually 30-90s…");
    try {
      const res = await fetch(`/api/projects/${projectId}/thumbnail`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.trim() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      toast.success("Thumbnail ready — it ships in the bundle", { id: toastId });
      startTransition(() => router.refresh());
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error("Couldn't generate thumbnail", { id: toastId, description: message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <PlatformSection title="Thumbnail (1280×720)">
      <div className="flex flex-col gap-3">
        {thumbnailUrl ? (
          <div className="relative aspect-video w-full max-w-[420px] overflow-hidden rounded-md border bg-muted/30">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={thumbnailUrl}
              alt="YouTube thumbnail"
              className="absolute inset-0 w-full h-full object-cover"
            />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground tracking-tight">
            No thumbnail yet — generate one from the base still + your thumbnail text.
          </p>
        )}
        {canGenerate && (
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={120}
              className="h-9 w-64 rounded-md border bg-transparent px-3 text-sm focus:border-foreground outline-none"
            />
            <button
              type="button"
              onClick={() => void generate()}
              disabled={busy || text.trim().length === 0}
              className="h-9 rounded-md border px-3 text-sm tracking-tight hover:border-foreground/40 transition-colors disabled:opacity-50"
            >
              {busy ? "Generating…" : thumbnailUrl ? "Regenerate (~$0.20)" : "Generate (~$0.20)"}
            </button>
          </div>
        )}
        {thumbnailUrl && (
          <p className="text-[10px] text-muted-foreground tracking-tight">
            Packed into the bundle as youtube-thumbnail-1280x720.jpg.
          </p>
        )}
      </div>
    </PlatformSection>
  );
}
