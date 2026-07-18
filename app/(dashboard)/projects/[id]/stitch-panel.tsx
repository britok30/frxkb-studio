"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Clapperboard, Download, Music } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ease } from "@/lib/motion";

/**
 * One-click assembled deliverable — the CapCut replacement. Stitches the
 * project's clips into a single ready-to-post MP4 via fal's ffmpeg compose
 * (reel: clips in order; before-after: held before still → morph).
 *
 * Audio: every seedance clip carries its own ambient audio, and each
 * segment's ambience DIFFERS. Default keeps them (hard cuts between
 * ambiences); uploading a music file lays one uniform bed across the whole
 * video and replaces the per-clip audio entirely.
 */
export function StitchPanel({
  projectId,
  format,
  finalVideoUrl,
  aspect,
  hasShotstack = true,
}: {
  projectId: string;
  format: string;
  finalVideoUrl: string | null;
  aspect: string;
  /** Whether the signed-in operator has their own Shotstack key. Without
   *  one, stitching uses the fal fallback (hard cuts) and the panel shows
   *  the crossfade opt-in hint. */
  hasShotstack?: boolean;
}) {
  const router = useRouter();
  const [stitching, setStitching] = useState(false);
  const [musicUrl, setMusicUrl] = useState<string | null>(null);
  const [musicName, setMusicName] = useState<string | null>(null);
  const [uploadingMusic, setUploadingMusic] = useState(false);
  const [musicDurationSec, setMusicDurationSec] = useState<number | null>(null);
  const [perStillSec, setPerStillSec] = useState(7);
  const [targetMinutes, setTargetMinutes] = useState(10);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [, startTransition] = useTransition();
  const isSlideshow = format === "style-explorer";

  /** Read the audio file's duration in the browser so the server can tile
   *  the music bed across videos longer than the song. */
  function readAudioDuration(file: File): Promise<number | null> {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const audio = new Audio();
      audio.preload = "metadata";
      audio.onloadedmetadata = () => {
        URL.revokeObjectURL(url);
        resolve(Number.isFinite(audio.duration) ? audio.duration : null);
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      audio.src = url;
    });
  }

  async function uploadMusic(file: File) {
    setUploadingMusic(true);
    const toastId = toast.loading(`Uploading ${file.name}…`);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: form });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { url: string };
      setMusicUrl(data.url);
      setMusicName(file.name);
      setMusicDurationSec(await readAudioDuration(file));
      toast.success("Music ready — it will replace the clips' ambient audio", { id: toastId });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error("Music upload failed", { id: toastId, description: message });
    } finally {
      setUploadingMusic(false);
    }
  }

  async function stitch() {
    if (stitching) return;
    setStitching(true);
    const toastId = toast.loading("Stitching final video…");
    try {
      const res = await fetch(`/api/projects/${projectId}/stitch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(musicUrl ? { musicUrl } : {}),
          ...(musicUrl && musicDurationSec ? { musicDurationSec } : {}),
          ...(isSlideshow ? { perStillSec, targetMinutes } : {}),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      toast.success("Final video ready", { id: toastId });
      startTransition(() => router.refresh());
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error("Couldn't stitch", { id: toastId, description: message });
    } finally {
      setStitching(false);
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
              <CardTitle className="text-base">Final video</CardTitle>
              <CardDescription>
                {format === "before-after"
                  ? "Before still (2.5s) → transformation morph, as one ready-to-post MP4. Stitched automatically when you finalize; re-stitch here to swap in a music bed."
                  : isSlideshow
                    ? "The YouTube long-form, ready to upload: every still held in sequence, looped to your target length, music tiled underneath. Add music — the video is silent without it. Chapters land every " +
                      perStillSec +
                      "s of cycle one."
                    : "All clips as one ready-to-post MP4 with crossfades. Stitched automatically when you finalize (native ambient audio); re-stitch here to swap in a music bed."}
              </CardDescription>
            </div>
            {finalVideoUrl && <Badge>Stitched</Badge>}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!hasShotstack && (
            <p className="rounded-md border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground leading-relaxed">
              Heads up: your videos stitch with simple hard cuts. Add your own
              Shotstack API key (<code className="text-[11px]">SHOTSTACK_KEY_&lt;YOU&gt;</code> in
              the environment — shotstack.io, pay-as-you-go ~$0.30 per rendered
              minute) to get smooth crossfades between clips and gentle motion
              on slideshow stills.
            </p>
          )}
          {finalVideoUrl && (
            <div className="flex flex-col gap-2 max-w-[280px]">
              <video
                src={finalVideoUrl}
                controls
                playsInline
                className="w-full rounded-md border bg-muted/40"
                style={{ aspectRatio: aspect.replace(":", " / ") }}
              />
              <a
                href={finalVideoUrl}
                download
                className="text-xs text-muted-foreground hover:text-foreground tracking-tight inline-flex items-center gap-1.5"
              >
                <Download className="size-3.5" /> Download final.mp4
              </a>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            {isSlideshow && (
              <>
                <label className="inline-flex items-center gap-2 text-xs text-muted-foreground tracking-tight">
                  Seconds per style
                  <input
                    type="number"
                    min={3}
                    max={15}
                    value={perStillSec}
                    onChange={(e) =>
                      setPerStillSec(Math.max(3, Math.min(15, Number(e.target.value) || 7)))
                    }
                    className="w-16 h-9 rounded-md border bg-transparent px-2 text-sm text-foreground focus:border-foreground outline-none"
                  />
                </label>
                <label className="inline-flex items-center gap-2 text-xs text-muted-foreground tracking-tight">
                  Target minutes
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={targetMinutes}
                    onChange={(e) =>
                      setTargetMinutes(Math.max(1, Math.min(20, Number(e.target.value) || 10)))
                    }
                    className="w-16 h-9 rounded-md border bg-transparent px-2 text-sm text-foreground focus:border-foreground outline-none"
                  />
                </label>
              </>
            )}
            <motion.button
              type="button"
              onClick={() => void stitch()}
              disabled={stitching || uploadingMusic}
              whileTap={{ scale: 0.98 }}
              transition={{ duration: 0.12 }}
              className="h-10 rounded-md bg-foreground text-background px-4 text-sm font-medium tracking-tight hover:opacity-90 transition-opacity inline-flex items-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <Clapperboard className="size-3.5" />
              {stitching
                ? "Stitching…"
                : finalVideoUrl
                  ? "Re-stitch"
                  : "Stitch final video"}
            </motion.button>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={stitching || uploadingMusic}
              className="h-10 rounded-md border px-4 text-sm tracking-tight text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors inline-flex items-center gap-2 disabled:opacity-60"
            >
              <Music className="size-3.5" />
              {uploadingMusic
                ? "Uploading…"
                : musicName
                  ? musicName
                  : "Add music (optional)"}
            </button>
            {musicName && (
              <button
                type="button"
                onClick={() => {
                  setMusicUrl(null);
                  setMusicName(null);
                }}
                className="text-xs text-muted-foreground hover:text-foreground tracking-tight"
              >
                Remove music
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="audio/mpeg,audio/mp4,audio/x-m4a,audio/wav"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void uploadMusic(f);
                e.target.value = "";
              }}
            />
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
