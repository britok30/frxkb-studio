// Publishing a project to a connected Instagram account. The route only
// creates a social_posts row + enqueues; every Instagram call runs in the
// Inngest function (inngest/functions.ts → handlePublish) via these steps.
import sharp from "sharp";
import { nanoid } from "nanoid";
import {
  buildInstagramCaption,
  createCarouselContainer,
  createImageContainer,
  fetchPermalink,
  getContainerStatus,
  IG_MAX_ASPECT,
  IG_MIN_ASPECT,
  publishContainer,
} from "@/lib/instagram";
import { decryptSecret } from "@/lib/social-crypto";
import { selectSocialAccount, selectSocialPost, updateSocialPost } from "@/lib/social-db";
import { getProjectWithScenes } from "@/lib/projects";
import { storeBuffer } from "@/lib/storage";
import { stagingRoleFor } from "@/lib/prompts/types";
import type { Project, Scene } from "@/lib/db";

/**
 * Which stills a project publishes, in carousel order. Staging: the
 * published pair is the (cleared) before + the staged after — same as the
 * export package. Other formats aren't wired yet (v1 = staging on AIVS).
 */
export function publishableImages(project: Project, scenes: Scene[]): { url: string; alt?: string }[] {
  const done = (s: Scene) => !!s.imageUrl && (s.status === "generated" || s.status === "approved");
  if (project.format === "staging") {
    const unfurnish = project.staging?.unfurnish;
    const ordered = [...scenes].sort((a, b) => a.order - b.order);
    const before = ordered.find((s) =>
      unfurnish ? stagingRoleFor(true, s.order) === "cleared" && done(s) : s.order === 1 && !!s.imageUrl
    );
    const after = ordered.find((s) => stagingRoleFor(unfurnish, s.order) === "staged" && done(s));
    if (!before?.imageUrl || !after?.imageUrl) {
      throw new Error("Both the before and the staged after must exist before publishing.");
    }
    const alt = project.metadata?.kind === "staging" ? project.metadata.altText : undefined;
    return [
      { url: before.imageUrl, alt: `${project.staging?.roomType ?? "Room"} before staging` },
      { url: after.imageUrl, alt },
    ];
  }
  throw new Error(`Publishing isn't wired for the ${project.format} format yet.`);
}

/** The default caption for a project (operator can edit before sending). */
export function defaultInstagramCaption(project: Project): string {
  const m = project.metadata;
  if (!m) throw new Error("Finalize the project first — there is no caption yet.");
  switch (m.kind) {
    case "staging":
    case "carousel":
      return buildInstagramCaption(m.instagramCaption, m.instagramHashtags);
    case "reel":
      return buildInstagramCaption(m.instagramCaption, m.instagramHashtags);
    case "youtube":
      throw new Error("YouTube long-forms don't publish to Instagram.");
  }
}

/**
 * Instagram wants JPEG, ≤8MB, aspect between 4:5 and 1.91:1. Re-encode every
 * still as JPEG and letterbox (white) anything outside the band — a listing
 * photo must never be cropped. Re-hosted under exports/ so the URL is stable
 * and public for Instagram's fetch.
 */
export async function normalizeForInstagram(url: string, projectId: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't fetch ${url} (${res.status})`);
  const input = Buffer.from(await res.arrayBuffer());
  let img = sharp(input).rotate();
  const meta = await img.metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (!w || !h) throw new Error("Couldn't read image dimensions");
  const ratio = w / h;
  if (ratio < IG_MIN_ASPECT) {
    const targetW = Math.ceil(h * IG_MIN_ASPECT);
    const pad = targetW - w;
    img = img.extend({
      left: Math.floor(pad / 2),
      right: Math.ceil(pad / 2),
      background: { r: 255, g: 255, b: 255 },
    });
  } else if (ratio > IG_MAX_ASPECT) {
    const targetH = Math.ceil(w / IG_MAX_ASPECT);
    const pad = targetH - h;
    img = img.extend({
      top: Math.floor(pad / 2),
      bottom: Math.ceil(pad / 2),
      background: { r: 255, g: 255, b: 255 },
    });
  }
  // Long edge ≤ 1440 keeps every file well under 8MB and matches IG's
  // display resolution.
  const buffer = await img
    .resize({ width: 1440, height: 1440, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
  const stored = await storeBuffer({
    buffer,
    kind: "exports",
    projectId,
    filename: `ig-${nanoid(8)}.jpg`,
    contentType: "image/jpeg",
  });
  return stored.url;
}

async function loadPost(postId: string) {
  const post = await selectSocialPost(postId);
  if (!post) throw new Error(`Social post ${postId} not found`);
  const account = await selectSocialAccount(post.accountId);
  if (!account) throw new Error("The Instagram account for this post was disconnected.");
  return { post, account, token: decryptSecret(account.accessTokenEnc) };
}

/** Step 1: mark publishing, normalize the stills, persist the URLs sent. */
export async function preparePublish(postId: string): Promise<{ mediaUrls: string[]; alts: (string | undefined)[] }> {
  const { post } = await loadPost(postId);
  const found = await getProjectWithScenes(post.projectId);
  if (!found) throw new Error(`Project ${post.projectId} not found`);
  await updateSocialPost(postId, { status: "publishing", error: null });
  const images = publishableImages(found.project, found.scenes);
  const mediaUrls: string[] = [];
  for (const img of images) mediaUrls.push(await normalizeForInstagram(img.url, post.projectId));
  await updateSocialPost(postId, { mediaUrls });
  return { mediaUrls, alts: images.map((i) => i.alt) };
}

/** Step 2: child containers + the carousel container. Returns the id to poll. */
export async function createPublishContainer(
  postId: string,
  mediaUrls: string[],
  alts: (string | undefined)[]
): Promise<string> {
  const { post, account, token } = await loadPost(postId);
  const igUserId = account.platformUserId;
  if (mediaUrls.length === 1) {
    return await createImageContainer({
      igUserId,
      token,
      imageUrl: mediaUrls[0],
      caption: post.caption,
      altText: alts[0],
    });
  }
  const childIds: string[] = [];
  for (let i = 0; i < mediaUrls.length; i++) {
    childIds.push(
      await createImageContainer({
        igUserId,
        token,
        imageUrl: mediaUrls[i],
        isCarouselItem: true,
        altText: alts[i],
      })
    );
  }
  return await createCarouselContainer({ igUserId, token, childIds, caption: post.caption });
}

/** Poll helper: "ready" | "wait" | throws on ERROR/EXPIRED. */
export async function checkPublishContainer(postId: string, containerId: string): Promise<"ready" | "wait"> {
  const { token } = await loadPost(postId);
  const { status, detail } = await getContainerStatus({ containerId, token });
  if (status === "FINISHED" || status === "PUBLISHED") return "ready";
  if (status === "ERROR" || status === "EXPIRED") {
    throw new Error(`Instagram rejected the media (${status})${detail ? `: ${detail}` : ""}`);
  }
  return "wait";
}

/** Step 3: publish + record the permalink. */
export async function finishPublish(postId: string, containerId: string): Promise<{ mediaId: string; permalink: string | null }> {
  const { account, token } = await loadPost(postId);
  const mediaId = await publishContainer({ igUserId: account.platformUserId, token, containerId });
  const permalink = await fetchPermalink({ mediaId, token });
  await updateSocialPost(postId, {
    status: "published",
    platformMediaId: mediaId,
    permalink,
    publishedAt: new Date(),
    error: null,
  });
  return { mediaId, permalink };
}

export async function failPublish(postId: string, message: string): Promise<void> {
  await updateSocialPost(postId, { status: "failed", error: message.slice(0, 1000) });
}
