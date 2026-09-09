import { NextResponse } from "next/server";
import { z } from "zod";
import { getProjectWithScenes } from "@/lib/projects";
import { defaultInstagramCaption, publishableImages } from "@/lib/publish";
import { insertSocialPost, listSocialPosts, selectSocialAccount } from "@/lib/social-db";
import { requireProjectOwnership, withSessionOperator } from "@/lib/route-helpers";
import { currentOperator } from "@/lib/operators";
import { IG_CAPTION_MAX } from "@/lib/instagram";
import { inngest } from "@/inngest/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  accountId: z.string().min(1),
  /** Operator-edited caption; defaults to the finalized caption + hashtags. */
  caption: z.string().min(1).max(IG_CAPTION_MAX).optional(),
});

/** Publish attempts for this project (status + permalinks). */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await ctx.params;
  return withSessionOperator(async () => {
    try {
      return NextResponse.json({ posts: await listSocialPosts(id) });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  });
}

/** Queue a publish. All Instagram calls happen in the background job. */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }

  return withSessionOperator(async () => {
    const denied = await requireProjectOwnership(id);
    if (denied) return denied;
    try {
      const op = currentOperator();
      const account = await selectSocialAccount(parsed.data.accountId);
      if (!account || account.operatorEmail !== op.email) {
        return NextResponse.json({ error: "That Instagram account isn't connected to your studio." }, { status: 404 });
      }
      const found = await getProjectWithScenes(id);
      if (!found) return NextResponse.json({ error: "Project not found" }, { status: 404 });
      // Validate up front so the operator gets the error now, not in a job.
      publishableImages(found.project, found.scenes);
      const caption = parsed.data.caption?.trim() || defaultInstagramCaption(found.project);
      const inFlight = (await listSocialPosts(id)).find(
        (p) => p.accountId === account.id && (p.status === "queued" || p.status === "publishing")
      );
      if (inFlight) {
        return NextResponse.json({ error: "A publish to that account is already in progress." }, { status: 409 });
      }
      const post = await insertSocialPost({ projectId: id, accountId: account.id, caption });
      await inngest.send({
        name: "project/publish.requested",
        data: { postId: post.id, projectId: id, operatorEmail: op.email },
      });
      return NextResponse.json({ post }, { status: 202 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      const status = /finalize|must exist|isn't wired/i.test(message) ? 409 : 500;
      if (status === 500) console.error("[api/projects/[id]/publish] failed:", err);
      return NextResponse.json({ error: message }, { status });
    }
  });
}
