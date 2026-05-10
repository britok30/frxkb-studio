import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

type DB = ReturnType<typeof drizzle<typeof schema>>;

let _db: DB | null = null;

/**
 * Returns a memoized Drizzle client connected to Neon.
 *
 * Always call inside request handlers / server actions — never at module top
 * level. That keeps DATABASE_URL out of build-time evaluation, so static pages
 * still build cleanly when the env var is missing locally.
 */
export function getDb(): DB {
  if (_db) return _db;
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set. Add it to .env.local and run `npm run db:push`.");
  }
  const sql = neon(process.env.DATABASE_URL);
  _db = drizzle({ client: sql, schema });
  return _db;
}

/** Test-only: reset the memoized client. */
export function __resetDbForTests(): void {
  _db = null;
}

export * from "./schema";
