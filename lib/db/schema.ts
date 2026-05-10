import { pgTable, text, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    niche: text("niche").notNull(),
    format: text("format", { enum: ["yt-long", "reel", "carousel"] }).notNull(),
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
    }>(),
    /** Kebab-case AI-generated identifier for the project's "world" — used
     *  to detect duplicate concepts. Nullable: legacy rows have null, new
     *  projects always populate it. */
    worldSignature: text("world_signature"),
    /** Canonical lowercase keyword set for fuzzy duplicate detection. */
    worldKeywords: jsonb("world_keywords").$type<string[]>(),
    /** Set during finalize. Populated with the full Metadata blob (title,
     *  description, tags, IG caption, hashtags, pinnedComment). */
    metadata: jsonb("metadata").$type<{
      youtubeTitle: string;
      youtubeTitleAlternates: string[];
      youtubeDescription: string;
      youtubeTags: string[];
      instagramCaption: string;
      hashtags: string[];
      pinnedComment: string;
    }>(),
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
