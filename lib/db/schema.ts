import { pgTable, text, integer, real, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import type { Metadata } from "@/lib/prompts/metadata";

export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    niche: text("niche").notNull(),
    format: text("format", {
      enum: ["reel", "carousel", "before-after", "style-explorer"],
    }).notNull(),
    /** Visual lane: interior spaces vs exterior shots. Threaded through every
     *  prompt generator so the world stays on one side for the whole project. */
    worldType: text("world_type", { enum: ["interior", "exterior"] }).notNull(),
    /** Program axis, orthogonal to worldType. residential = homes; commercial =
     *  offices/retail/restaurants/hospitality. Defaults to residential so every
     *  pre-existing row reads correctly without a backfill. */
    propertyType: text("property_type", { enum: ["residential", "commercial"] })
      .notNull()
      .default("residential"),
    /** Aspect ratio for downstream image generation. Reel/carousel default
     *  by format (9:16 / 1:1); before-after derives from the uploaded "before"
     *  image's actual dimensions and stores it here. Nullable — readers should
     *  fall back to defaultsForFormat(format).aspectRatio. */
    aspectRatio: text("aspect_ratio", {
      enum: ["16:9", "9:16", "1:1", "4:3", "3:4"],
    }),
    status: text("status", {
      enum: ["draft", "scripting", "generating", "ready", "finalizing", "exported"],
    })
      .notNull()
      .default("draft"),
    /** Committed photographic look (lighting + camera + grade) picked at
     *  creation — an id from lib/prompts/looks.ts. Applied to every image
     *  prompt at generation time via applyLookToPrompt. Nullable: legacy
     *  projects and "let GPT-5.5 decide" projects have no look. */
    lookId: text("look_id"),
    /** Moodboard / photo references uploaded at creation (reel/carousel,
     *  1-5 Blob URLs). When present, every scene renders via /edit
     *  conditioned on them — the refs steer materials, palette, and mood
     *  while the prompt supplies the room. Null = text-born project. */
    referenceImageUrls: jsonb("reference_image_urls").$type<string[]>(),
    /** Render-quality tier. standard = 2K stills + native 1080p video (the
     *  Reels delivery ceiling). hero = 4K stills + Topaz 4K60 video pass —
     *  for YouTube/portfolio work where viewers zoom or the platform serves
     *  true 4K. Drives resolution + upscale decisions in lib/projects.ts. */
    quality: text("quality", { enum: ["standard", "hero"] })
      .notNull()
      .default("standard"),
    targetDurationSec: integer("target_duration_sec"),
    concept: jsonb("concept").$type<{
      workingTitle: string;
      hook: string;
      vibe: string;
      notes: string;
      /** Per-piece commitment to 8-15 lineage-specific objects that drive
       *  scene generation. Optional in the type because pre-2026-05 rows
       *  don't have it; downstream consumers default to []. */
      objectSet?: string[];
    }>(),
    /** Kebab-case AI-generated identifier for the project's "world" — used
     *  to detect duplicate concepts. Nullable: legacy rows have null, new
     *  projects always populate it. */
    worldSignature: text("world_signature"),
    /** Canonical lowercase keyword set for fuzzy duplicate detection. */
    worldKeywords: jsonb("world_keywords").$type<string[]>(),
    /** Set during finalize. Discriminated union — see `kind` field for the
     *  variant (reel | carousel). Each variant carries the platform-tailored
     *  copy for that format. */
    metadata: jsonb("metadata").$type<Metadata>(),
    /** Public Vercel Blob URL of the rendered thumbnail. */
    thumbnailUrl: text("thumbnail_url"),
    /** Public Blob URL of the stitched, ready-to-post final video (reel:
     *  concatenated clips; before-after: held before still → morph clip),
     *  produced by fal ffmpeg compose. Null until the operator stitches.
     *  Re-stitching (e.g. with a music bed) overwrites. */
    finalVideoUrl: text("final_video_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("projects_world_signature_idx").on(t.worldSignature)]
);

export const scenes = pgTable(
  "scenes",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    order: integer("order").notNull(),
    prompt: text("prompt").notNull(),
    durationSec: integer("duration_sec").notNull().default(4),
    seed: integer("seed"),
    status: text("status", {
      enum: ["pending", "generating", "generated", "approved", "rejected"],
    })
      .notNull()
      .default("pending"),
    /** Public Vercel Blob URL of the generated image. Stored in DB; the file
     *  itself lives in Blob, not on the function filesystem. */
    imageUrl: text("image_url"),
    /** URL of the anchor image this scene was conditioned on via
     *  nano-banana-pro/edit. Null for the anchor scene itself (text-to-image).
     *  Frozen at first generation so per-scene regen stays consistent with
     *  the rest of the sequence even if the anchor is later regenerated. */
    referenceImageUrl: text("reference_image_url"),
    /** Style-explorer only: the on-screen card TITLE for this scene's style
     *  (e.g. "Japandi", "Industrial Loft"). Null for every other format.
     *  Carried into the export so the operator can add cards in CapCut. */
    styleName: text("style_name"),
    /** Style-explorer only: the on-screen card SUBTITLE — a one-line descriptor
     *  that sits under styleName (e.g. "Warm minimalism in oak and linen").
     *  Null for every other format. */
    styleSubtitle: text("style_subtitle"),
    /** Public Vercel Blob URL of the upscaled mp4 (for reels — the seedance
     *  output passed through Topaz Proteus). Null for stills/non-reel formats. */
    videoUrl: text("video_url"),
    /** The motion description GPT-5.5 generated for the seedance pass. Stored
     *  for transparency + so re-animation uses the same direction. */
    motionPrompt: text("motion_prompt"),
    /** Operator-locked camera move (an id from CAMERA_MOVES in
     *  lib/prompts/motion.ts). When set, the motion prompt for this scene
     *  must lead with this exact move; GPT only writes the subject motion.
     *  Null = GPT picks the move. */
    motionPreset: text("motion_preset"),
    falRequestId: text("fal_request_id"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("scenes_project_order_idx").on(t.projectId, t.order)]
);

/** Variant history for a scene's stills. Every time a regen (or batch regen)
 *  is about to overwrite scene.imageUrl, the outgoing render is snapshotted
 *  here first — so rerolls are never destructive and the operator can restore
 *  any earlier take. The CURRENT render lives on scenes.imageUrl; rows here
 *  are the non-active takes. */
export const sceneVersions = pgTable(
  "scene_versions",
  {
    id: text("id").primaryKey(),
    sceneId: text("scene_id")
      .notNull()
      .references(() => scenes.id, { onDelete: "cascade" }),
    imageUrl: text("image_url").notNull(),
    /** The exact prompt that produced this render (post look/direction
     *  augmentation), for transparency + reproducibility. */
    prompt: text("prompt"),
    seed: integer("seed"),
    /** Operator free-text direction used for this take, if any. */
    designDirection: text("design_direction"),
    /** One-off look override used for this take, if any. */
    lookId: text("look_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("scene_versions_scene_idx").on(t.sceneId, t.createdAt)]
);

/** Actual-spend ledger. One row per billable vendor call (fal image/video/
 *  upscale/compose, LLM calls), written fire-and-forget at the call site
 *  with the USD amount computed from the verified rates in lib/pricing.ts.
 *  Powers the per-project spend readout, the operator daily/monthly totals,
 *  and the daily budget gate. */
export const spendEvents = pgTable(
  "spend_events",
  {
    id: text("id").primaryKey(),
    /** Nullable: some spend (e.g. niche suggestions) isn't tied to a project. */
    projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
    operatorEmail: text("operator_email").notNull(),
    kind: text("kind", {
      enum: ["image", "image-edit", "video", "upscale", "compose", "llm"],
    }).notNull(),
    amountUsd: real("amount_usd").notNull(),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("spend_events_operator_created_idx").on(t.operatorEmail, t.createdAt),
    index("spend_events_project_idx").on(t.projectId),
  ]
);

export const assets = pgTable(
  "assets",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["image", "video", "thumbnail", "final", "audio"] }).notNull(),
    path: text("path").notNull(),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("assets_project_kind_idx").on(t.projectId, t.kind)]
);

export const exports_ = pgTable("exports", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  tags: jsonb("tags").$type<string[]>(),
  hashtags: jsonb("hashtags").$type<string[]>(),
  videoPath: text("video_path"),
  thumbnailPath: text("thumbnail_path"),
  metadataPath: text("metadata_path"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projectsRelations = relations(projects, ({ many }) => ({
  scenes: many(scenes),
  assets: many(assets),
  exports: many(exports_),
}));

export const scenesRelations = relations(scenes, ({ one, many }) => ({
  project: one(projects, { fields: [scenes.projectId], references: [projects.id] }),
  versions: many(sceneVersions),
}));

export const sceneVersionsRelations = relations(sceneVersions, ({ one }) => ({
  scene: one(scenes, { fields: [sceneVersions.sceneId], references: [scenes.id] }),
}));

export const assetsRelations = relations(assets, ({ one }) => ({
  project: one(projects, { fields: [assets.projectId], references: [projects.id] }),
}));

export const exportsRelations = relations(exports_, ({ one }) => ({
  project: one(projects, { fields: [exports_.projectId], references: [projects.id] }),
}));

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type Scene = typeof scenes.$inferSelect;
export type NewScene = typeof scenes.$inferInsert;
export type SceneVersion = typeof sceneVersions.$inferSelect;
export type NewSceneVersion = typeof sceneVersions.$inferInsert;
export type SpendEvent = typeof spendEvents.$inferSelect;
export type NewSpendEvent = typeof spendEvents.$inferInsert;
export type Asset = typeof assets.$inferSelect;
export type Export = typeof exports_.$inferSelect;
