/**
 * Client-safe download filename helpers. Every stitched final used to save
 * as "final.mp4" — a Downloads folder full of final (7).mp4 with no way to
 * tell which listing is which. Name downloads after the project instead.
 */

/** "Sunlit Brazilian Modernism" → "sunlit-brazilian-modernism.mp4".
 *  Falls back to final.mp4 when the title slugs away to nothing. */
export function downloadVideoFilename(title: string | null | undefined): string {
  const slug = (title ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics the normalize exposed
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug ? `${slug}.mp4` : "final.mp4";
}
