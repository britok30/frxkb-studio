import { describe, it, expect, vi, beforeEach } from "vitest";

const neonMock = vi.hoisted(() => vi.fn());
const drizzleMock = vi.hoisted(() => vi.fn());

vi.mock("@neondatabase/serverless", () => ({
  neon: neonMock,
}));

vi.mock("drizzle-orm/neon-http", () => ({
  drizzle: drizzleMock,
}));

import { getDb, __resetDbForTests } from "./index";

beforeEach(() => {
  neonMock.mockReset().mockReturnValue("fake-sql-client");
  drizzleMock.mockReset().mockImplementation(() => ({ id: Math.random() }));
  __resetDbForTests();
  delete process.env.DATABASE_URL;
});

describe("getDb", () => {
  it("throws a helpful error when DATABASE_URL is unset", () => {
    expect(() => getDb()).toThrow(/DATABASE_URL is not set/);
    expect(neonMock).not.toHaveBeenCalled();
    expect(drizzleMock).not.toHaveBeenCalled();
  });

  it("constructs the client from neon + drizzle when DATABASE_URL is set", () => {
    process.env.DATABASE_URL = "postgres://example";

    const db = getDb();

    expect(neonMock).toHaveBeenCalledExactlyOnceWith("postgres://example");
    expect(drizzleMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ client: "fake-sql-client" })
    );
    expect(db).toBeDefined();
  });

  it("memoizes the client across calls", () => {
    process.env.DATABASE_URL = "postgres://example";

    const a = getDb();
    const b = getDb();

    expect(a).toBe(b);
    expect(drizzleMock).toHaveBeenCalledTimes(1);
  });

  it("__resetDbForTests forces a rebuild on next call", () => {
    process.env.DATABASE_URL = "postgres://example";

    const a = getDb();
    __resetDbForTests();
    const b = getDb();

    expect(a).not.toBe(b);
    expect(drizzleMock).toHaveBeenCalledTimes(2);
  });
});
