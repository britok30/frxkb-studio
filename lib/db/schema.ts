import { pgTable, text, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import type { Metadata } from "@/lib/prompts/metadata";

export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    niche: text("niche").notNull(),
    format: text("format", { enum: ["reel", "carousel", "before-after"] }).notNull(),
    /** Visual lane: interior spaces vs exterior shots. Threaded through every
     *  prompt generator so the world stays on one side for the whole project. */
    worldType: text("world_type", { enum: ["interior", "exterior"] }).notNull(),
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
    /** Public Vercel Blob URL of the upscaled mp4 (for reels — the seedance
     *  output passed through Topaz Proteus). Null for stills/non-reel formats. */
    videoUrl: text("video_url"),
    /** The motion description Claude generated for the seedance pass. Stored
     *  for transparency + so re-animation uses the same direction. */
    motionPrompt: text("motion_prompt"),
    falRequestId: text("fal_request_id"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("scenes_project_order_idx").on(t.projectId, t.order)]
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

export const scenesRelations = relations(scenes, ({ one }) => ({
  project: one(projects, { fields: [scenes.projectId], references: [projects.id] }),
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
export type Asset = typeof assets.$inferSelect;
export type Export = typeof exports_.$inferSelect;
