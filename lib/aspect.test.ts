import { describe, it, expect } from "vitest";
import { detectAspectRatio } from "./aspect";

describe("detectAspectRatio", () => {
  it("snaps common landscape sizes to 16:9", () => {
    expect(detectAspectRatio(1920, 1080)).toBe("16:9");
    expect(detectAspectRatio(3840, 2160)).toBe("16:9");
    expect(detectAspectRatio(1280, 720)).toBe("16:9");
  });

  it("snaps common portrait reel sizes to 9:16", () => {
    expect(detectAspectRatio(1080, 1920)).toBe("9:16");
    expect(detectAspectRatio(720, 1280)).toBe("9:16");
  });

  it("snaps Instagram square to 1:1", () => {
    expect(detectAspectRatio(1080, 1080)).toBe("1:1");
    expect(detectAspectRatio(1024, 1024)).toBe("1:1");
  });

  it("snaps classic 4:3 photographs", () => {
    expect(detectAspectRatio(1600, 1200)).toBe("4:3");
    expect(detectAspectRatio(800, 600)).toBe("4:3");
  });

  it("snaps Instagram-portrait 4:5 ratio to 3:4 (closest enum member)", () => {
    // 1080×1350 = 0.8 ratio; 3:4 = 0.75 is closer than 9:16 (0.5625)
    expect(detectAspectRatio(1080, 1350)).toBe("3:4");
  });

  it("throws on invalid dimensions", () => {
    expect(() => detectAspectRatio(0, 100)).toThrow();
    expect(() => detectAspectRatio(100, 0)).toThrow();
    expect(() => detectAspectRatio(-10, 100)).toThrow();
  });
});
