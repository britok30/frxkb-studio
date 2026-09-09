import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  getDb,
  socialAccounts,
  socialPosts,
  type SocialAccount,
  type SocialPost,
} from "@/lib/db";
import { encryptSecret } from "@/lib/social-crypto";

export async function upsertInstagramAccount(values: {
  operatorEmail: string;
  platformUserId: string;
  username: string;
  accountType?: string | null;
  accessToken: string;
  expiresInSec?: number;
}): Promise<SocialAccount> {
  const db = getDb();
  const accessTokenEnc = encryptSecret(values.accessToken);
  const tokenExpiresAt = values.expiresInSec
    ? new Date(Date.now() + values.expiresInSec * 1000)
    : null;
  const existing = await db
    .select()
    .from(socialAccounts)
    .where(
      and(
        eq(socialAccounts.operatorEmail, values.operatorEmail),
        eq(socialAccounts.platform, "instagram"),
        eq(socialAccounts.platformUserId, values.platformUserId)
      )
    )
    .limit(1);
  if (existing[0]) {
    const [row] = await db
      .update(socialAccounts)
      .set({
        username: values.username,
        accountType: values.accountType ?? null,
        accessTokenEnc,
        tokenExpiresAt,
        updatedAt: new Date(),
      })
      .where(eq(socialAccounts.id, existing[0].id))
      .returning();
    return row;
  }
  const [row] = await db
    .insert(socialAccounts)
    .values({
      id: nanoid(12),
      operatorEmail: values.operatorEmail,
      platform: "instagram",
      platformUserId: values.platformUserId,
      username: values.username,
      accountType: values.accountType ?? null,
      accessTokenEnc,
      tokenExpiresAt,
    })
    .returning();
  return row;
}

export async function listSocialAccounts(operatorEmail: string): Promise<SocialAccount[]> {
  return await getDb()
    .select()
    .from(socialAccounts)
    .where(eq(socialAccounts.operatorEmail, operatorEmail))
    .orderBy(desc(socialAccounts.createdAt));
}

export async function listAllSocialAccounts(): Promise<SocialAccount[]> {
  return await getDb().select().from(socialAccounts);
}

export async function selectSocialAccount(id: string): Promise<SocialAccount | null> {
  const rows = await getDb().select().from(socialAccounts).where(eq(socialAccounts.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function deleteSocialAccount(id: string, operatorEmail: string): Promise<boolean> {
  const rows = await getDb()
    .delete(socialAccounts)
    .where(and(eq(socialAccounts.id, id), eq(socialAccounts.operatorEmail, operatorEmail)))
    .returning({ id: socialAccounts.id });
  return rows.length > 0;
}

export async function updateSocialAccountToken(
  id: string,
  accessToken: string,
  expiresInSec: number
): Promise<void> {
  await getDb()
    .update(socialAccounts)
    .set({
      accessTokenEnc: encryptSecret(accessToken),
      tokenExpiresAt: new Date(Date.now() + expiresInSec * 1000),
      updatedAt: new Date(),
    })
    .where(eq(socialAccounts.id, id));
}

export async function insertSocialPost(values: {
  projectId: string;
  accountId: string;
  caption: string;
}): Promise<SocialPost> {
  const [row] = await getDb()
    .insert(socialPosts)
    .values({ id: nanoid(12), ...values, status: "queued" })
    .returning();
  return row;
}

export async function listSocialPosts(projectId: string): Promise<SocialPost[]> {
  return await getDb()
    .select()
    .from(socialPosts)
    .where(eq(socialPosts.projectId, projectId))
    .orderBy(desc(socialPosts.createdAt));
}

export async function selectSocialPost(id: string): Promise<SocialPost | null> {
  const rows = await getDb().select().from(socialPosts).where(eq(socialPosts.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function updateSocialPost(
  id: string,
  values: Partial<Pick<SocialPost, "status" | "mediaUrls" | "platformMediaId" | "permalink" | "error" | "publishedAt">>
): Promise<void> {
  await getDb().update(socialPosts).set(values).where(eq(socialPosts.id, id));
}
