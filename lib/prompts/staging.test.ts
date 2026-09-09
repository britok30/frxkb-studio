import { describe, it, expect, vi, beforeEach } from "vitest";

const llmMocks = vi.hoisted(() => ({ generateJSON: vi.fn() }));
vi.mock("@/lib/llm", () => ({ generateJSON: llmMocks.generateJSON }));

import {
  buildStagingEditPrompt,
  buildStagingBriefUser,
  buildStagingMetadataSystem,
  ensureBlurbDisclosure,
  generateStagingBrief,
  generateStagingMetadata,
  UNFURNISH_PROMPT,
  STAGING_DISCLOSURE,
  STAGING_LOCK,
  STAGING_LOCK_CLOSE,
} from "./staging";

beforeEach(() => {
  llmMocks.generateJSON.mockReset();
});

const brief = {
  roomType: "Living room",
  workingTitle: "Sunlit Oak-Floor Living Room",
  hook: "A quiet, warm room a young family sees themselves in.",
  roomRead:
    "A roughly 14 by 18 foot living room with wide-plank white oak floors, warm white walls, a nine-foot ceiling and two double-hung windows on the long wall pouring in soft south light. The focal wall is opposite the windows, blank and ready for art.",
  styleName: "Warm Transitional",
  styleSubtitle: "Oatmeal linen, white oak, brushed brass",
  furniturePlan: [
    "Oatmeal linen three-seat sofa — centred on the focal wall facing the windows",
    "Pair of white-oak-legged armchairs in cream bouclé — angled at the window end",
    "Round white oak coffee table — centred on the rug",
    "9x12 flatweave rug in warm ivory — anchoring the seating",
    "Brass arc floor lamp — behind the sofa's left arm",
    "Large abstract canvas in ochre and cream — centred above the sofa",
    "Olive tree in a stone planter — in the corner by the windows",
  ],
  stagingPrompt:
    "Furnish this living room as a Warm Transitional space: an oatmeal linen three-seat sofa centred on the focal wall facing the windows, a pair of cream bouclé armchairs with white oak legs angled at the window end, a round white oak coffee table on a 9x12 warm ivory flatweave rug, a brass arc floor lamp behind the sofa, one large abstract canvas in ochre and cream above the sofa, and an olive tree in a stone planter by the windows. The finished room feels calm, warm, and ready for a family.",
  notes: "keep the window wall clear",
};

describe("buildStagingEditPrompt", () => {
  it("wraps the plan in the add-only preservation lock, front and back", () => {
    const out = buildStagingEditPrompt({ plan: brief.stagingPrompt, furnitureReferenceCount: 0 });
    expect(out.startsWith(STAGING_LOCK)).toBe(true);
    expect(out.endsWith(STAGING_LOCK_CLOSE)).toBe(true);
    expect(out).toContain(brief.stagingPrompt);
    expect(out).not.toMatch(/client's own furniture/);
  });

  it("names the furniture references when the client supplied pieces", () => {
    const out = buildStagingEditPrompt({ plan: brief.stagingPrompt, furnitureReferenceCount: 3 });
    expect(out).toMatch(/additional attached 3 images are the client's own furniture/);
    expect(out).toMatch(/reproduce those exact pieces/);
  });

  it("layers the operator's regen direction after the plan, never above the lock", () => {
    const out = buildStagingEditPrompt({
      plan: brief.stagingPrompt,
      furnitureReferenceCount: 0,
      direction: "swap the sofa for a sectional",
    });
    const lockIdx = out.indexOf(STAGING_LOCK);
    const planIdx = out.indexOf(brief.stagingPrompt);
    const dirIdx = out.indexOf("swap the sofa for a sectional");
    expect(lockIdx).toBe(0);
    expect(planIdx).toBeGreaterThan(lockIdx);
    expect(dirIdx).toBeGreaterThan(planIdx);
    expect(out).toMatch(/never overrides the preservation rules/);
  });

  it("ignores blank directions", () => {
    const a = buildStagingEditPrompt({ plan: "Furnish it.", furnitureReferenceCount: 0 });
    const b = buildStagingEditPrompt({ plan: "Furnish it.", furnitureReferenceCount: 0, direction: "   " });
    expect(b).toBe(a);
  });
});

describe("buildStagingBriefUser", () => {
  it("treats an operator-chosen room + style as hard constraints and counts furniture refs", () => {
    const out = buildStagingBriefUser({
      beforeImageUrl: "https://blob.example/room.jpg",
      roomType: "Home office",
      styleId: "japandi",
      brief: "Desk stays on the window wall.",
      furnitureReferenceUrls: ["https://blob.example/desk.jpg", "https://blob.example/chair.jpg"],
    });
    expect(out).toMatch(/Room type \(operator's choice[^)]*\): Home office/);
    expect(out).toMatch(/Style \(operator's choice[^)]*\): Japandi/);
    expect(out).toMatch(/THE BRIEF[\s\S]*Desk stays on the window wall/);
    expect(out).toMatch(/Images 2-3 are the client's OWN furniture \(2 pieces\)/);
  });

  it("asks the stager to identify the room + pick the style when both are auto", () => {
    const out = buildStagingBriefUser({ beforeImageUrl: "https://blob.example/room.jpg" });
    expect(out).toMatch(/identify it from the photo/);
    expect(out).toMatch(/Style: your call/);
    expect(out).not.toMatch(/client's OWN furniture/);
  });
});

describe("generateStagingBrief", () => {
  it("sends the room photo first, then every furniture ref, as vision inputs", async () => {
    llmMocks.generateJSON.mockResolvedValue(brief);
    const out = await generateStagingBrief({
      beforeImageUrl: "https://blob.example/room.jpg",
      furnitureReferenceUrls: ["https://blob.example/sofa.jpg"],
    });
    expect(out.roomType).toBe("Living room");
    const args = llmMocks.generateJSON.mock.calls[0][0];
    expect(args.images).toEqual(["https://blob.example/room.jpg", "https://blob.example/sofa.jpg"]);
    expect(args.toolName).toBe("submit_staging_brief");
  });

  it("clips overshooting prose instead of failing creation", async () => {
    llmMocks.generateJSON.mockResolvedValue({
      ...brief,
      roomRead: "x".repeat(2000),
      furniturePlan: [...brief.furniturePlan, "y".repeat(400)],
    });
    const out = await generateStagingBrief({ beforeImageUrl: "https://blob.example/room.jpg" });
    expect(out.roomRead.length).toBeLessThanOrEqual(1500);
    expect(out.furniturePlan.every((p) => p.length <= 160)).toBe(true);
  });
});

describe("generateStagingMetadata", () => {
  const raw = {
    instagramCaption:
      "Empty, the room read as a hallway with two windows.\nStaged in Warm Transitional: oatmeal linen sofa on the focal wall, white oak table on an ivory rug, a brass arc lamp in the south light.\nSwipe — would you keep the olive tree by the windows? {APP_LINK}",
    instagramHashtags: ["livingroom", "homestaging", "warmtransitional"],
    tiktokCaption: "Same living room, same oak floors — now a family sees the sofa wall. Keep the brass lamp?",
    tiktokHashtags: ["livingroom", "homestaging", "listingphotos"],
    listingBlurb:
      "Light-filled living room with wide-plank white oak floors and south-facing windows; the staged layout shows a full seating group with room to spare.",
    clientNote:
      "Hi — attached are the before and the virtually staged after for the living room, staged Warm Transitional to suit the oak floors and south light. Please publish the after with a virtually staged label wherever it appears.",
    altText: "Living room with oatmeal sofa, white oak coffee table, brass arc lamp and olive tree in soft daylight",
  };

  it("sees BOTH images and stamps the deterministic disclosure + MLS sentence", async () => {
    llmMocks.generateJSON.mockResolvedValue(raw);
    const out = await generateStagingMetadata({
      beforeImageUrl: "https://blob.example/before.jpg",
      afterImageUrl: "https://blob.example/after.jpg",
      roomType: "Living room",
      styleName: "Warm Transitional",
      roomRead: brief.roomRead,
      furniturePlan: brief.furniturePlan,
      appNames: ["ArchitectGPT"],
    });
    const args = llmMocks.generateJSON.mock.calls[0][0];
    expect(args.images).toEqual(["https://blob.example/before.jpg", "https://blob.example/after.jpg"]);
    expect(out.kind).toBe("staging");
    expect(out.disclosure).toBe(STAGING_DISCLOSURE);
    expect(out.listingBlurb.endsWith("Photo virtually staged.")).toBe(true);
    expect(out.instagramCaption).toContain("{APP_LINK}");
  });

  it("system prompt forbids the app CTA when no app is configured", () => {
    expect(buildStagingMetadataSystem([])).toMatch(/Never write "\{APP_LINK\}"/);
    expect(buildStagingMetadataSystem(["InteriorGPT"])).toMatch(/InteriorGPT/);
  });
});

describe("ensureBlurbDisclosure", () => {
  it("leaves a compliant blurb alone and appends the sentence otherwise", () => {
    expect(ensureBlurbDisclosure("Great room. Photo virtually staged.")).toBe(
      "Great room. Photo virtually staged."
    );
    expect(ensureBlurbDisclosure("Great room.  ")).toBe("Great room. Photo virtually staged.");
  });
});

describe("unfurnish", () => {
  it("the clear prompt removes freestanding items and keeps the property", () => {
    expect(UNFURNISH_PROMPT).toMatch(/Remove ALL furniture/);
    expect(UNFURNISH_PROMPT).toMatch(/KEEP everything that is part of the property/);
    expect(UNFURNISH_PROMPT).toMatch(/reconstruct the floor, wall, baseboard/);
  });

  it("brief user prompt tells the stager the photo is furnished and to ignore what's in it", () => {
    const out = buildStagingBriefUser({ beforeImageUrl: "https://blob.example/room.jpg", furnished: true });
    expect(out).toMatch(/currently FURNISHED/);
    expect(out).toMatch(/plan the furniture from scratch/);
  });

  it("metadata sees before → cleared → staged when a cleared image exists", async () => {
    llmMocks.generateJSON.mockResolvedValue({
      instagramCaption: "Cleared, then restaged for the buyer.\nOak table, brass lamp on the window wall.\nKeep it? {APP_LINK}",
      instagramHashtags: ["livingroom", "homestaging", "virtualstaging"],
      tiktokCaption: "Cleared then restaged — same oak floors. Keep the lamp?",
      tiktokHashtags: ["livingroom", "homestaging", "virtualstaging"],
      listingBlurb: "Bright living room with oak floors; the restaged layout shows the full seating group. Photo virtually staged.",
      clientNote: "Attached are the original, the cleared room, and the restaged after for the living room. Please label the after as virtually staged wherever it appears.",
      altText: "Living room with oak table and brass lamp",
    });
    await generateStagingMetadata({
      beforeImageUrl: "https://blob.example/furnished.jpg",
      clearedImageUrl: "https://blob.example/cleared.jpg",
      afterImageUrl: "https://blob.example/staged.jpg",
      roomType: "Living room",
      styleName: "Warm Transitional",
      roomRead: "r",
      furniturePlan: ["Oak table — centred"],
      appNames: [],
    });
    const args = llmMocks.generateJSON.mock.calls[0][0];
    expect(args.images).toEqual([
      "https://blob.example/furnished.jpg",
      "https://blob.example/cleared.jpg",
      "https://blob.example/staged.jpg",
    ]);
    expect(args.user).toMatch(/RESTAGE/);
  });
});
