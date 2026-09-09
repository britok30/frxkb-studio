// Instagram publishing — the "Instagram API with Instagram Login" flavour
// (graph.instagram.com). No Facebook Page required: the operator signs in
// with the Instagram professional account itself. Scopes:
// instagram_business_basic + instagram_business_content_publish.
//
// Publishing is a two-step container flow: create a media container from a
// PUBLIC image/video URL, wait for status FINISHED, then media_publish it.
// Carousels = child containers (is_carousel_item) + a CAROUSEL parent.
// https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login
import { createHmac, timingSafeEqual } from "node:crypto";

export const IG_GRAPH_VERSION = process.env.INSTAGRAM_GRAPH_VERSION ?? "v23.0";
const GRAPH = `https://graph.instagram.com/${IG_GRAPH_VERSION}`;

export const IG_SCOPES = ["instagram_business_basic", "instagram_business_content_publish"];

/** Carousel cap on the publishing API (the app allows 20; the API doesn't). */
export const IG_CAROUSEL_MAX_ITEMS = 10;
/** Feed images must sit between 4:5 (0.8) and 1.91:1. */
export const IG_MIN_ASPECT = 0.8;
export const IG_MAX_ASPECT = 1.91;
export const IG_CAPTION_MAX = 2200;

function appId(): string {
  const v = process.env.INSTAGRAM_APP_ID;
  if (!v) throw new Error("INSTAGRAM_APP_ID is not set.");
  return v;
}
function appSecret(): string {
  const v = process.env.INSTAGRAM_APP_SECRET;
  if (!v) throw new Error("INSTAGRAM_APP_SECRET is not set.");
  return v;
}
function stateSecret(): string {
  const v = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!v) throw new Error("AUTH_SECRET is not set (needed to sign the OAuth state).");
  return v;
}

// ── OAuth state (HMAC-signed, 10-minute window) ─────────────────────────────

export function signState(payload: { email: string }): string {
  const body = Buffer.from(JSON.stringify({ ...payload, ts: Date.now() })).toString("base64url");
  const sig = createHmac("sha256", stateSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyState(state: string, maxAgeMs = 10 * 60 * 1000): { email: string } | null {
  const [body, sig] = state.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", stateSecret()).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      email?: string;
      ts?: number;
    };
    if (!parsed.email || !parsed.ts || Date.now() - parsed.ts > maxAgeMs) return null;
    return { email: parsed.email };
  } catch {
    return null;
  }
}

// ── OAuth ───────────────────────────────────────────────────────────────────

export function buildAuthorizeUrl(opts: { redirectUri: string; state: string }): string {
  const u = new URL("https://www.instagram.com/oauth/authorize");
  u.searchParams.set("enable_fb_login", "0");
  u.searchParams.set("force_authentication", "1");
  u.searchParams.set("client_id", appId());
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", IG_SCOPES.join(","));
  u.searchParams.set("state", opts.state);
  return u.toString();
}

async function igJson<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = (data as { error?: { message?: string; error_user_msg?: string }; error_message?: string } | null);
    const msg =
      err?.error?.error_user_msg ?? err?.error?.message ?? err?.error_message ?? text.slice(0, 300);
    throw new Error(`Instagram ${what} failed (${res.status}): ${msg}`);
  }
  return data as T;
}

/** code → short-lived token (+ the account's id). */
export async function exchangeCode(opts: { code: string; redirectUri: string }) {
  const form = new URLSearchParams({
    client_id: appId(),
    client_secret: appSecret(),
    grant_type: "authorization_code",
    redirect_uri: opts.redirectUri,
    code: opts.code,
  });
  const res = await fetch("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  return await igJson<{ access_token: string; user_id: string | number; permissions?: string[] }>(
    res,
    "code exchange"
  );
}

/** short-lived → long-lived (60 days). */
export async function exchangeForLongLived(shortToken: string) {
  const u = new URL("https://graph.instagram.com/access_token");
  u.searchParams.set("grant_type", "ig_exchange_token");
  u.searchParams.set("client_secret", appSecret());
  u.searchParams.set("access_token", shortToken);
  return await igJson<{ access_token: string; token_type: string; expires_in: number }>(
    await fetch(u),
    "long-lived exchange"
  );
}

/** Refresh a long-lived token (must be ≥24h old and unexpired). */
export async function refreshLongLived(token: string) {
  const u = new URL("https://graph.instagram.com/refresh_access_token");
  u.searchParams.set("grant_type", "ig_refresh_token");
  u.searchParams.set("access_token", token);
  return await igJson<{ access_token: string; token_type: string; expires_in: number }>(
    await fetch(u),
    "token refresh"
  );
}

export async function fetchProfile(token: string) {
  const u = new URL(`${GRAPH}/me`);
  u.searchParams.set("fields", "user_id,username,account_type");
  u.searchParams.set("access_token", token);
  return await igJson<{ user_id: string; username: string; account_type?: string }>(
    await fetch(u),
    "profile fetch"
  );
}

// ── Publishing ──────────────────────────────────────────────────────────────

async function postForm<T>(path: string, params: Record<string, string>, what: string): Promise<T> {
  const res = await fetch(`${GRAPH}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  return await igJson<T>(res, what);
}

export async function createImageContainer(opts: {
  igUserId: string;
  token: string;
  imageUrl: string;
  caption?: string;
  isCarouselItem?: boolean;
  altText?: string;
}): Promise<string> {
  const params: Record<string, string> = {
    image_url: opts.imageUrl,
    access_token: opts.token,
  };
  if (opts.isCarouselItem) params.is_carousel_item = "true";
  if (opts.caption) params.caption = opts.caption;
  if (opts.altText) params.alt_text = opts.altText.slice(0, 1000);
  const out = await postForm<{ id: string }>(`${opts.igUserId}/media`, params, "image container");
  return out.id;
}

export async function createCarouselContainer(opts: {
  igUserId: string;
  token: string;
  childIds: string[];
  caption: string;
}): Promise<string> {
  if (opts.childIds.length < 2 || opts.childIds.length > IG_CAROUSEL_MAX_ITEMS) {
    throw new Error(`Instagram carousels take 2-${IG_CAROUSEL_MAX_ITEMS} items, got ${opts.childIds.length}.`);
  }
  const out = await postForm<{ id: string }>(
    `${opts.igUserId}/media`,
    {
      media_type: "CAROUSEL",
      children: opts.childIds.join(","),
      caption: opts.caption.slice(0, IG_CAPTION_MAX),
      access_token: opts.token,
    },
    "carousel container"
  );
  return out.id;
}

export type ContainerStatus = "EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED";

export async function getContainerStatus(opts: {
  containerId: string;
  token: string;
}): Promise<{ status: ContainerStatus; detail?: string }> {
  const u = new URL(`${GRAPH}/${opts.containerId}`);
  u.searchParams.set("fields", "status_code,status");
  u.searchParams.set("access_token", opts.token);
  const out = await igJson<{ status_code: ContainerStatus; status?: string }>(
    await fetch(u),
    "container status"
  );
  return { status: out.status_code, detail: out.status };
}

export async function publishContainer(opts: {
  igUserId: string;
  token: string;
  containerId: string;
}): Promise<string> {
  const out = await postForm<{ id: string }>(
    `${opts.igUserId}/media_publish`,
    { creation_id: opts.containerId, access_token: opts.token },
    "publish"
  );
  return out.id;
}

export async function fetchPermalink(opts: { mediaId: string; token: string }): Promise<string | null> {
  const u = new URL(`${GRAPH}/${opts.mediaId}`);
  u.searchParams.set("fields", "permalink");
  u.searchParams.set("access_token", opts.token);
  try {
    const out = await igJson<{ permalink?: string }>(await fetch(u), "permalink fetch");
    return out.permalink ?? null;
  } catch {
    return null;
  }
}

/** Caption + hashtag block as one paste, capped to Instagram's limit. */
export function buildInstagramCaption(caption: string, hashtags: string[]): string {
  const tags = hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ");
  const full = tags ? `${caption.trim()}\n\n${tags}` : caption.trim();
  return full.length > IG_CAPTION_MAX ? full.slice(0, IG_CAPTION_MAX - 1) + "…" : full;
}
