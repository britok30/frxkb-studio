import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/storage", () => ({ storeBuffer: vi.fn() }));
vi.mock("@/lib/social-db", () => ({}));
vi.mock("@/lib/projects", () => ({}));

import { defaultInstagramCaption, publishableImages } from "./publish";
import type { Project, Scene } from "@/lib/db";

const scene = (o: Partial<Scene>): Scene =>
  ({ id: "s", projectId: "p", order: 1, prompt: "", durationSec: 0, seed: null, status: "generated", imageUrl: null, referenceImageUrl: null, styleName: null, styleSubtitle: null, videoUrl: null, previousVideoUrl: null, motionPrompt: null, motionPreset: null, falRequestId: null, error: null, createdAt: new Date(), updatedAt: new Date(), ...o }) as Scene;

const base = {
  format: "staging",
  staging: { roomType: "Living room", styleName: "Warm", brief: null, roomRead: "r", furnitureReferenceCount: 0 },
  metadata: {
    kind: "staging",
    instagramCaption: "Cleared, then staged.",
    instagramHashtags: ["virtualstaging", "realestate"],
    tiktokCaption: "t",
    tiktokHashtags: ["a", "b", "c"],
    listingBlurb: "b. Photo virtually staged.",
    clientNote: "n",
    altText: "Living room with sofa",
    disclosure: "d",
  },
} as unknown as Project;

describe("publishableImages — staging", () => {
  it("empty upload: before + staged after, alt text from the finalize copy", () => {
    const out = publishableImages(base, [
      scene({ order: 1, imageUrl: "https://b/before.jpg" }),
      scene({ order: 2, imageUrl: "https://b/after.jpg", referenceImageUrl: "https://b/before.jpg" }),
    ]);
    expect(out.map((i) => i.url)).toEqual(["https://b/before.jpg", "https://b/after.jpg"]);
    expect(out[1].alt).toBe("Living room with sofa");
  });

  it("unfurnish: the CLEARED room is the before, never the furnished original", () => {
    const p = { ...base, staging: { ...base.staging, unfurnish: true } } as Project;
    const out = publishableImages(p, [
      scene({ order: 1, imageUrl: "https://b/furnished.jpg" }),
      scene({ order: 2, imageUrl: "https://b/cleared.jpg", referenceImageUrl: "https://b/furnished.jpg" }),
      scene({ order: 3, imageUrl: "https://b/staged.jpg", referenceImageUrl: "https://b/cleared.jpg" }),
    ]);
    expect(out.map((i) => i.url)).toEqual(["https://b/cleared.jpg", "https://b/staged.jpg"]);
  });

  it("refuses before the after exists", () => {
    expect(() =>
      publishableImages(base, [
        scene({ order: 1, imageUrl: "https://b/before.jpg" }),
        scene({ order: 2, status: "pending", referenceImageUrl: "https://b/before.jpg" }),
      ])
    ).toThrow(/must exist/);
  });
});

describe("defaultInstagramCaption", () => {
  it("caption + hashtag block; refuses unfinalized projects", () => {
    expect(defaultInstagramCaption(base)).toBe("Cleared, then staged.\n\n#virtualstaging #realestate");
    expect(() => defaultInstagramCaption({ ...base, metadata: null } as Project)).toThrow(/Finalize/);
  });
});
