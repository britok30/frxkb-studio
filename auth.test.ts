import { describe, it, expect, vi } from "vitest";

// Auth.js's NextAuth() factory pulls in env vars at import time. Stub it so
// we can isolate the allowlist logic without booting the whole framework.
vi.mock("next-auth", () => ({
  default: () => ({
    handlers: {},
    signIn: vi.fn(),
    signOut: vi.fn(),
    auth: vi.fn(),
  }),
}));
vi.mock("next-auth/providers/google", () => ({ default: () => ({}) }));

import { isAllowedEmail, ALLOWED_EMAILS } from "./auth";

describe("ALLOWED_EMAILS", () => {
  it("contains both operator emails — and only those", () => {
    expect(ALLOWED_EMAILS.size).toBe(2);
    expect(ALLOWED_EMAILS.has("britok30@gmail.com")).toBe(true);
    expect(ALLOWED_EMAILS.has("fremyrosso1@gmail.com")).toBe(true);
  });
});

describe("isAllowedEmail", () => {
  it("allows the two operator emails", () => {
    expect(isAllowedEmail("britok30@gmail.com")).toBe(true);
    expect(isAllowedEmail("fremyrosso1@gmail.com")).toBe(true);
  });

  it("rejects anyone else", () => {
    expect(isAllowedEmail("attacker@gmail.com")).toBe(false);
    expect(isAllowedEmail("britok31@gmail.com")).toBe(false);
    expect(isAllowedEmail("britok30@example.com")).toBe(false);
  });

  it("rejects empty / null / undefined", () => {
    expect(isAllowedEmail(undefined)).toBe(false);
    expect(isAllowedEmail(null)).toBe(false);
    expect(isAllowedEmail("")).toBe(false);
  });

  it("is case-insensitive (Google sometimes sends mixed case)", () => {
    expect(isAllowedEmail("BritoK30@gmail.com")).toBe(true);
    expect(isAllowedEmail("FREMYROSSO1@GMAIL.COM")).toBe(true);
  });

  it("doesn't match on substring (no homoglyph slip)", () => {
    expect(isAllowedEmail(" britok30@gmail.com")).toBe(false);
    expect(isAllowedEmail("britok30@gmail.com.evil.com")).toBe(false);
    expect(isAllowedEmail("xbritok30@gmail.com")).toBe(false);
  });
});
