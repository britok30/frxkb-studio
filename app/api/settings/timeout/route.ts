import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import {
  ADMIN_EMAIL,
  getTimeoutSetting,
  setTimeoutSetting,
} from "@/lib/app-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PutBody = z.object({
  enabled: z.boolean(),
  message: z.string().max(500),
});

/** Admin-only: any non-admin session gets a 404 so the setting's existence
 *  never leaks to the other operator. */
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
    return NextResponse.json({ setting: await getTimeoutSetting() });
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
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  try {
    await setTimeoutSetting(parsed.data);
    return NextResponse.json({ setting: parsed.data });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
