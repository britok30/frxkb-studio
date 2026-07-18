import { describe, it, expect } from "vitest";
import {
  LOOKS,
  LookIdSchema,
  applyLookToPrompt,
  getLook,
  looksForWorld,
} from "./looks";

describe("LOOKS catalog", () => {
  it("every look id is unique and covered by LookIdSchema", () => {
    const ids = LOOKS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(LookIdSchema.safeParse(id).success).toBe(true);
    }
    // And the schema has no dead ids pointing at nothing in the catalog.
    for (const id of LookIdSchema.options) {
      expect(ids).toContain(id);
    }
  });

  it("every look commits to concrete photographic language (light + camera/grade), affirmatively", () => {
    for (const l of LOOKS) {
      expect(l.name.length).toBeGreaterThan(2);
      expect(l.tagline.length).toBeGreaterThan(2);
      expect(l.prompt.length).toBeGreaterThan(80);
      expect(l.worlds.length).toBeGreaterThan(0);
      // Affirmative-only rule: nano-banana renders what you NAME, so a look
      // block must never carry "no X" negations.
      expect(l.prompt).not.toMatch(/\bno \w/i);
      expect(l.swatch).toMatch(/^linear-gradient\(/);
    }
  });

  it("looksForWorld filters lane-specific looks", () => {
    const interior = looksForWorld("interior");
    const exterior = looksForWorld("exterior");
    expect(interior.map((l) => l.id)).not.toContain("twilight-hero");
    expect(exterior.map((l) => l.id)).toContain("twilight-hero");
    expect(exterior.map((l) => l.id)).not.toContain("tungsten-evening");
    expect(interior.map((l) => l.id)).toContain("tungsten-evening");
  });
});

describe("getLook", () => {
  it("resolves known ids and returns null for unknown/absent", () => {
    expect(getLook("golden-hour")?.name).toBe("Golden Hour");
    expect(getLook("not-a-look")).toBeNull();
    expect(getLook(null)).toBeNull();
    expect(getLook(undefined)).toBeNull();
  });
});

describe("applyLookToPrompt", () => {
  const base = "Wide establishing shot of a modernist living room.";

  it("returns the prompt unchanged when there is no look", () => {
    expect(applyLookToPrompt(base, null)).toBe(base);
  });

  it("appends the look block after the original prompt as pure photographic language", () => {
    const look = getLook("golden-hour")!;
    const out = applyLookToPrompt(base, look);
    expect(out.startsWith(base)).toBe(true);
    expect(out).toContain(look.prompt);
    // No adjudication prose — an image model renders tokens, it doesn't
    // resolve conflicts, so "this look wins"-style meta-instruction would
    // only inject the conflicting tokens it names.
    expect(out).not.toMatch(/this look wins|different time of day/i);
  });

  it("keeps render-engine / tag-soup tokens out of every look prompt (they prime CGI-plastic output)", () => {
    for (const l of LOOKS) {
      expect(l.prompt).not.toMatch(/\b(8k|4k|denoised|render|archviz|v-?ray|corona style|ultra detailed|masterpiece)\b/i);
    }
  });
});
