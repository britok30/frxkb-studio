/**
 * Client-safe download filename helpers. Every stitched final used to save
 * as "final.mp4" — a Downloads folder full of final (7).mp4 with no way to
 * tell which listing is which. Name downloads after the project instead.
 */

function slugify(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics the normalize exposed
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

/** "Sunlit Brazilian Modernism" → "sunlit-brazilian-modernism.mp4".
 *  Falls back to final.mp4 when the title slugs away to nothing. */
export function downloadVideoFilename(title: string | null | undefined): string {
  const slug = slugify(title);
  return slug ? `${slug}.mp4` : "final.mp4";
}

/** Thumbnail download named after its burned-in hook text:
 *  "SAME ROOM, 12 STYLES" → "thumb-same-room-12-styles.jpg". */
export function downloadThumbnailFilename(text: string | null | undefined): string {
  const slug = slugify(text);
  return slug ? `thumb-${slug}.jpg` : "thumbnail.jpg";
}
