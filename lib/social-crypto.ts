// AES-256-GCM for social access tokens at rest. Key = SOCIAL_TOKEN_KEY
// (base64, 32 bytes). Rotating the key invalidates stored tokens — operators
// simply reconnect.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function key(): Buffer {
  const raw = process.env.SOCIAL_TOKEN_KEY;
  if (!raw) {
    throw new Error(
      "SOCIAL_TOKEN_KEY is not set. Generate one with `openssl rand -base64 32` and add it to the environment before connecting social accounts."
    );
  }
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("SOCIAL_TOKEN_KEY must decode to exactly 32 bytes.");
  return buf;
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map((b) => b.toString("base64")).join(":");
}

export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, encB64] = payload.split(":");
  if (!ivB64 || !tagB64 || !encB64) throw new Error("Malformed encrypted secret");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
