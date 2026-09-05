import { describe, it, expect, afterEach } from "vitest";
import { openDatabase, resetDatabase, SEED_ASSETS, type Db } from "../src/db.js";
import { placeOrder } from "../src/trading/index.js";
import { getPortfolio } from "../src/portfolio/index.js";
import { createMemoryPostgresPool, openTestDatabase } from "./helpers.js";

describe("shipped Postgres openDatabase entry", () => {
  let db: Db | undefined;

  afterEach(async () => {
    await db?.close();
    db = undefined;
  });

  it("openDatabase migrates, seeds assets, and supports write+read via placeOrder", async () => {
    const { pool } = createMemoryPostgresPool();
    db = await openDatabase({ pool });

    const assets = await db
      .prepare(`SELECT symbol, price FROM assets ORDER BY symbol`)
      .all() as Array<{ symbol: string; price: number }>;
    expect(assets.map((a) => a.symbol)).toEqual(
      [...SEED_ASSETS].map((a) => a.symbol).sort()
    );
    expect(assets.find((a) => a.symbol === "vSOL")?.price).toBe(420);

    // create user via SQL (ensureUser needs Nest inject) — mirror USER_CREATED ledger
    const userId = "11111111-1111-1111-1111-111111111111";
    await db
      .prepare(
        `INSERT INTO users (id, username, cash, created_at) VALUES (?, ?, ?, ?)`
      )
      .run(userId, "pg-entry-user", 100_000, new Date().toISOString());

    const placed = await placeOrder(db, {
      userId,
      symbol: "vSOL",
      side: "buy",
      type: "market",
      quantity: 1,
      idempotencyKey: "pg-entry-1",
    });
    expect(placed.ok).toBe(true);

    const portfolio = await getPortfolio(db, userId);
    expect(portfolio.cash).toBe(100_000 - 420);
    expect(portfolio.holdings.find((h) => h.symbol === "vSOL")?.quantity).toBe(1);

    await resetDatabase(db);
    const afterReset = await db
      .prepare(`SELECT COUNT(*)::int AS c FROM users`)
      .get() as { c: number };
    expect(Number(afterReset.c)).toBe(0);
    const seeded = await db
      .prepare(`SELECT COUNT(*)::int AS c FROM assets`)
      .get() as { c: number };
    expect(Number(seeded.c)).toBe(4);
  });

  it("openTestDatabase uses the same openDatabase factory", async () => {
    db = await openTestDatabase();
    const row = await db
      .prepare(`SELECT price FROM assets WHERE symbol = ?`)
      .get("vHLX") as { price: number };
    expect(row.price).toBe(180.25);
  });
});
