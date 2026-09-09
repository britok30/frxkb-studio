import { describe, it, expect, beforeEach } from "vitest";
import {
  buildAuthorizeUrl,
  buildInstagramCaption,
  IG_CAPTION_MAX,
  signState,
  verifyState,
} from "./instagram";

beforeEach(() => {
  process.env.INSTAGRAM_APP_ID = "app123";
  process.env.INSTAGRAM_APP_SECRET = "shh";
  process.env.AUTH_SECRET = "state-secret";
});

describe("OAuth state", () => {
  it("round-trips the operator email and rejects tampering", () => {
    const state = signState({ email: "britok30@gmail.com" });
    expect(verifyState(state)).toEqual({ email: "britok30@gmail.com" });
    const [body, sig] = state.split(".");
    expect(verifyState(`${body}.${sig.slice(0, -2)}xx`)).toBeNull();
    const forged = Buffer.from(JSON.stringify({ email: "x@y.z", ts: Date.now() })).toString("base64url");
    expect(verifyState(`${forged}.${sig}`)).toBeNull();
  });

  it("expires", () => {
    const state = signState({ email: "britok30@gmail.com" });
    expect(verifyState(state, -1)).toBeNull();
  });
});

describe("buildAuthorizeUrl", () => {
  it("targets Instagram Login with the publish scopes", () => {
    const u = new URL(buildAuthorizeUrl({ redirectUri: "https://studio.example/cb", state: "s" }));
    expect(u.origin + u.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe("app123");
    expect(u.searchParams.get("redirect_uri")).toBe("https://studio.example/cb");
    expect(u.searchParams.get("scope")).toBe("instagram_business_basic,instagram_business_content_publish");
    expect(u.searchParams.get("enable_fb_login")).toBe("0");
  });
});

describe("buildInstagramCaption", () => {
  it("appends the hashtag block and caps at 2200", () => {
    expect(buildInstagramCaption("Hello.", ["a", "#b"])).toBe("Hello.\n\n#a #b");
    expect(buildInstagramCaption("x".repeat(3000), ["a"]).length).toBe(IG_CAPTION_MAX);
  });
});
