import { z } from "zod";
import type { WorldType } from "./types";

// ── Look presets ─────────────────────────────────────────────────────────────
//
// A "look" is a curated photographic treatment — lighting scenario + camera/
// lens + film stock/grade — that the operator picks up front, Higgsfield-style.
// Looks are orthogonal to the niche and the design style: any world can be
// shot in any look. They fight the dull-image failure mode by committing HARD
// to one specific quality of light instead of letting the model average into
// its generic default.
//
// A look rides the pipeline in two places:
//   1. Scene scripting — buildScenesUser tells GPT-5.5 to write every scene's
//      light/camera/register inside the committed look.
//   2. Image generation — applyLookToPrompt appends the look block to the
//      prompt sent to fal (same deterministic-suffix idea as
//      ARCHITECTURE_LOCK), so regens and legacy prompts get it too.
//
// Prompt language is affirmative-only — nano-banana-pro renders what you NAME.

export const LookIdSchema = z.enum([
  "golden-hour",
  "overcast-softbox",
  "twilight-hero",
  "editorial-classic",
  "kinfolk-film",
  "cereal-minimal",
  "corona-clean",
  "vray-showcase",
  "tungsten-evening",
  "gallery-spotlight",
  "coastal-morning",
  "noir-evening",
  "hard-light-graphic",
  "morning-mist",
]);
export type LookId = z.infer<typeof LookIdSchema>;

export type Look = {
  id: LookId;
  /** Display name — Title Case, the on-card headline. */
  name: string;
  /** One short line of card copy under the name (a few words, no period). */
  tagline: string;
  /** Which visual lanes the look suits. Drives filtering in the picker. */
  worlds: WorldType[];
  /** The photographic block appended to every image prompt. Lighting scenario
   *  + camera/lens + grade, in photographer's language, affirmative only. */
  prompt: string;
  /** CSS gradient for the picker swatch — a visual stand-in until each look
   *  has real example thumbnails. */
  swatch: string;
};

export const LOOKS: Look[] = [
  {
    id: "golden-hour",
    name: "Golden Hour",
    tagline: "Low warm sun, long raking shadows",
    worlds: ["interior", "exterior"],
    prompt:
      "Late-afternoon golden-hour sunlight streams in low from the west, raking long warm shadows across every surface and edge-lighting the architecture; visible sunbeams and warm sunlit haze in the air. Warm amber grade with glowing highlights. Shot on 35mm, editorial architectural photography.",
    swatch: "linear-gradient(135deg, #f6c66d 0%, #e08e45 55%, #8a4a2b 100%)",
  },
  {
    id: "overcast-softbox",
    name: "Overcast Softbox",
    tagline: "Shadowless wrap light, true color",
    worlds: ["interior", "exterior"],
    prompt:
      "Soft overcast daylight floods the space like a giant softbox — gentle, shadowless, wrapping light that renders every material's true saturated color. Ambient daylight only, every lamp off. High dynamic range, crisp neutral grade, editorial interiors-magazine photography.",
    swatch: "linear-gradient(135deg, #dfe4e8 0%, #b9c2c9 55%, #8b969e 100%)",
  },
  {
    id: "twilight-hero",
    name: "Twilight Hero",
    tagline: "Indigo dusk, glowing glass",
    worlds: ["exterior"],
    prompt:
      "Blue-hour twilight: a deep indigo gradient sky, every interior light glowing warm through the glazing, warm-tungsten-against-cool-dusk contrast, landscape and path lighting on. Tripod long-exposure clarity, 24mm, luxury real-estate hero shot.",
    swatch: "linear-gradient(135deg, #22335f 0%, #40538c 50%, #e9a95c 100%)",
  },
  {
    id: "editorial-classic",
    name: "Magazine Editorial",
    tagline: "Tilt-shift verticals, styled vignettes",
    worlds: ["interior", "exterior"],
    prompt:
      "Architectural Digest-grade editorial photograph: 24mm tilt-shift with perfectly vertical lines, f/8 deep focus, balanced ambient daylight, impeccably styled vignettes with fresh flowers and layered textiles. Medium-format sharpness, crisp neutral grade.",
    swatch: "linear-gradient(135deg, #f2ede4 0%, #cfc4b2 55%, #97836a 100%)",
  },
  {
    id: "kinfolk-film",
    name: "Kinfolk Film",
    tagline: "Portra grain, quiet analog warmth",
    worlds: ["interior"],
    prompt:
      "Quiet slow-living film photograph: muted earthy palette, soft window light blooming into gently blown highlights, Kodak Portra 400 grain and analog warmth, matte natural textures, calm negative space and unhurried stillness.",
    swatch: "linear-gradient(135deg, #e8ded0 0%, #c9b8a3 55%, #9a8570 100%)",
  },
  {
    id: "cereal-minimal",
    name: "Cereal Minimal",
    tagline: "Cool negative space, gallery calm",
    worlds: ["interior", "exterior"],
    prompt:
      "Pared-back minimalist frame in the style of Cereal magazine: expansive negative space, desaturated cool-neutral grade, calm diffuse light, gallery-like stillness, precise wide composition with generous breathing room.",
    swatch: "linear-gradient(135deg, #eceff0 0%, #ccd3d6 55%, #a3adb2 100%)",
  },
  {
    id: "corona-clean",
    name: "Corona Clean",
    tagline: "Soft GI, pristine archviz light",
    worlds: ["interior"],
    prompt:
      "Pristine archviz render in the Corona style: soft natural global illumination pouring through the openings, immaculate physically-based materials, bright Scandinavian daylight, clean white balance, flawless denoised 8k clarity.",
    swatch: "linear-gradient(135deg, #f7f8f7 0%, #dde4e6 55%, #b9c6ca 100%)",
  },
  {
    id: "vray-showcase",
    name: "V-Ray Showcase",
    tagline: "Accurate bounce, dramatic sun patch",
    worlds: ["interior", "exterior"],
    prompt:
      "High-end V-Ray archviz showcase: physically accurate light bounce, a dramatic patch of direct sunlight thrown across the floor, glossy accurate reflections, rich contrast, competition-grade rendering polish.",
    swatch: "linear-gradient(135deg, #f3e9d2 0%, #d9b98a 55%, #6f7d8c 100%)",
  },
  {
    id: "tungsten-evening",
    name: "Tungsten Evening",
    tagline: "Amber lamp pools, night outside",
    worlds: ["interior"],
    prompt:
      "Evening interior lit only by warm tungsten lamps — pools of 3200K amber light, soft layered shadows, a cozy glow held against dark windows, moody boutique-hospitality photography with deep inviting warmth.",
    swatch: "linear-gradient(135deg, #e7a95e 0%, #9c5f2e 55%, #2c2118 100%)",
  },
  {
    id: "gallery-spotlight",
    name: "Gallery Spotlight",
    tagline: "Single-beam drama, dark falloff",
    worlds: ["interior"],
    prompt:
      "Museum-grade spotlighting: single-beam accent lights sculpting the furniture and art, dramatic falloff into shadow around each pool of light, high-contrast minimalism, precise and theatrical, crisp cool-neutral grade.",
    swatch: "linear-gradient(135deg, #f5f5f4 0%, #7d7d7b 45%, #1d1d1c 100%)",
  },
  {
    id: "coastal-morning",
    name: "Coastal Morning",
    tagline: "Airy highlights, linen and sea light",
    worlds: ["interior", "exterior"],
    prompt:
      "Bright coastal morning light: airy gently-overexposed window highlights, white linen curtains breathing in a sea breeze, salt-white and driftwood palette, fresh weightless atmosphere, summer-editorial glow.",
    swatch: "linear-gradient(135deg, #fbfaf5 0%, #cfe0e4 55%, #8fb4bd 100%)",
  },
  {
    id: "noir-evening",
    name: "Noir Evening",
    tagline: "One lamp, rain, cinematic teal",
    worlds: ["interior"],
    prompt:
      "Low-key cinematic night interior: a single warm floor lamp glowing against deep shadow, rain-streaked windows, teal-and-charcoal cinematic grade, anamorphic feel, boutique-hotel noir mood.",
    swatch: "linear-gradient(135deg, #24343a 0%, #16232b 55%, #d59a4f 100%)",
  },
  {
    id: "hard-light-graphic",
    name: "Hard Light Graphic",
    tagline: "Razor shadows, Ando geometry",
    worlds: ["interior", "exterior"],
    prompt:
      "Hard direct sunlight through the openings casting razor-edged graphic shadows, light-and-shadow geometry in the Tadao Ando tradition, monolithic contrast, sculptural minimal grade, bold and architectural.",
    swatch: "linear-gradient(115deg, #f5f1e8 0%, #f5f1e8 48%, #35322c 52%, #35322c 100%)",
  },
  {
    id: "morning-mist",
    name: "Morning Mist",
    tagline: "Fog, dew, large-format quiet",
    worlds: ["exterior"],
    prompt:
      "Early-morning mist wrapping the site: soft atmospheric depth between planes, pale diffused sun just breaking through, dew on every surface, quiet muted grade, serene large-format landscape photography.",
    swatch: "linear-gradient(135deg, #e9ecea 0%, #c3ccc7 55%, #93a29b 100%)",
  },
];

const LOOKS_BY_ID = new Map(LOOKS.map((l) => [l.id, l]));

export function getLook(id: string | null | undefined): Look | null {
  if (!id) return null;
  return LOOKS_BY_ID.get(id as LookId) ?? null;
}

export function looksForWorld(worldType: WorldType): Look[] {
  return LOOKS.filter((l) => l.worlds.includes(worldType));
}

/**
 * Deterministically append a look's photographic block to an image prompt
 * bound for fal. Same philosophy as ARCHITECTURE_LOCK: taste-critical
 * direction is never left to per-scene GPT-5.5 wording. The closing sentence
 * resolves conflicts in the look's favor so a scene prompt that named its own
 * time of day (written before the look, or by a legacy project) still lands
 * on the committed light.
 */
export function applyLookToPrompt(prompt: string, look: Look | null): string {
  if (!look) return prompt;
  return `${prompt}\n\nCommitted photographic look — ${look.name}: ${look.prompt} Commit fully to this lighting, camera, and grade; where anything above names a different time of day, light source, or mood, this look wins.`;
}
