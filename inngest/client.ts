import { Inngest } from "inngest";
import type { AspectRatio } from "@/lib/prompts/types";

/**
 * Single Inngest client for the studio. Events are typed below so call sites
 * get autocomplete + safety on data shape.
 *
 * Local dev: run `npx inngest-cli@latest dev` alongside `npm run dev` — the
 * dev server auto-discovers the function endpoint at /api/inngest and
 * processes events without any signing/event keys.
 *
 * Prod: requires INNGEST_EVENT_KEY (sender side, set in Vercel env) and
 * INNGEST_SIGNING_KEY (function endpoint verifies incoming requests).
 */
export const inngest = new Inngest({
  id: "frxkb-studio",
  schemas: undefined, // schemas are inferred from event types below
  // In dev, send to the local Inngest CLI without an event key. In prod the
  // Vercel × Inngest integration injects INNGEST_EVENT_KEY + INNGEST_SIGNING_KEY
  // and isDev becomes false. Without this flag the SDK refuses to send.
  isDev: process.env.NODE_ENV !== "production",
});

/** Event types — anything we send through inngest.send() should be here. */
export type StudioEvents = {
  "project/generate.requested": {
    data: {
      projectId: string;
      operatorEmail: string;
      force?: boolean;
      concurrency?: number;
      aspectRatio?: AspectRatio;
    };
  };
  "project/animate.requested": {
    data: {
      projectId: string;
      operatorEmail: string;
      force?: boolean;
      concurrency?: number;
    };
  };
};
