import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { functions } from "@/inngest/functions";

export const runtime = "nodejs";
// Inngest invokes this endpoint to drive each function step. Steps inside
// generate/animate can run minutes — give the route headroom; Vercel still
// caps at 300s on Pro per HTTP request, but Inngest splits long work across
// multiple step invocations so each individual call here stays bounded.
export const maxDuration = 300;

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions,
});
