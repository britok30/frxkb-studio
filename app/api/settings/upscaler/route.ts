import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import {
  ADMIN_EMAIL,
  getUpscalerSetting,
  setUpscalerSetting,
} from "@/lib/app-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PutBody = z.object({
  model: z.enum(["topaz", "seedvr2"]),
});

/** Admin-only: non-admin sessions get a 404 (same policy as the other
 *  settings endpoints — the endpoint's existence never leaks). */
async function requireAdmin(): Promise<Response | null> {
  const session = await auth();
  if (session?.user?.email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return null;
}

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;
  try {
    return NextResponse.json({ model: await getUpscalerSetting() });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = PutBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  try {
    await setUpscalerSetting(parsed.data.model);
    return NextResponse.json({ model: parsed.data.model });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
