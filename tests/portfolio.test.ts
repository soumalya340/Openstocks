import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { createTestApp, login, auth } from "./helpers.js";
import type { Db } from "../src/db.js";
import { placeOrder } from "../src/trading/index.js";

describe("portfolio + ledger history", () => {
  let db: Db;

  afterEach(() => {
    db?.close();
  });

  it("GET /portfolio requires auth", async () => {
    const ctx = createTestApp();
    db = ctx.db;
    await request(ctx.app).get("/portfolio").expect(401);
  });

  it("reconstructs portfolio at a past timestamp from the ledger", async () => {
    const ctx = createTestApp();
    db = ctx.db;
    const { token, userId } = await login(ctx.app, "historian");

    // Backdate USER_CREATED so it precedes the trade timeline we replay.
    const t0 = "2026-06-01T09:00:00.000Z";
    const t1 = "2026-06-01T10:00:00.000Z";
    const t2 = "2026-06-01T11:00:00.000Z";
    const t3 = "2026-06-01T12:00:00.000Z";
    const tBetween = "2026-06-01T10:30:00.000Z";
    db.prepare(`UPDATE ledger SET ts = ? WHERE user_id = ? AND type = 'USER_CREATED'`).run(
      t0,
      userId
    );
    db.prepare(`UPDATE users SET created_at = ? WHERE id = ?`).run(t0, userId);

    // First buy at t1: 2 vSOL @ 420
    const r1 = placeOrder(db, {
      userId,
      symbol: "vSOL",
      side: "buy",
      type: "market",
      quantity: 2,
      idempotencyKey: "hist-1",
      now: t1,
    });
    expect(r1.ok).toBe(true);

    // Second buy at t2: 1 vATL @ 95.5
    const r2 = placeOrder(db, {
      userId,
      symbol: "vATL",
      side: "buy",
      type: "market",
      quantity: 1,
      idempotencyKey: "hist-2",
      now: t2,
    });
    expect(r2.ok).toBe(true);

    // Between buys: only vSOL position should exist
    const mid = await request(ctx.app)
      .get(`/portfolio/history?at=${encodeURIComponent(tBetween)}`)
      .set(auth(token))
      .expect(200);

    expect(mid.body.reconstructedFrom).toBe("ledger");
    expect(mid.body.portfolio.asOf).toBe(tBetween);
    expect(mid.body.portfolio.cash).toBe(100000 - 2 * 420);
    const midHoldings = mid.body.portfolio.holdings.map(
      (h: { symbol: string }) => h.symbol
    );
    expect(midHoldings).toEqual(["vSOL"]);
    expect(mid.body.portfolio.holdings[0].quantity).toBe(2);
    expect(mid.body.portfolio.holdings[0].costBasis).toBe(840);

    // After both: cash and both holdings
    const later = await request(ctx.app)
      .get(`/portfolio/history?at=${encodeURIComponent(t3)}`)
      .set(auth(token))
      .expect(200);
    expect(later.body.portfolio.cash).toBe(100000 - 2 * 420 - 95.5);
    const symbols = later.body.portfolio.holdings
      .map((h: { symbol: string }) => h.symbol)
      .sort();
    expect(symbols).toEqual(["vATL", "vSOL"]);

    // Live portfolio should match post-t2 state
    const live = await request(ctx.app)
      .get("/portfolio")
      .set(auth(token))
      .expect(200);
    expect(live.body.portfolio.cash).toBe(later.body.portfolio.cash);
  });

  it("history before user creation returns empty portfolio", async () => {
    const ctx = createTestApp();
    db = ctx.db;
    const { token } = await login(ctx.app, "newbie");
    const early = await request(ctx.app)
      .get(`/portfolio/history?at=${encodeURIComponent("2000-01-01T00:00:00.000Z")}`)
      .set(auth(token))
      .expect(200);
    expect(early.body.portfolio.cash).toBe(0);
    expect(early.body.portfolio.holdings).toEqual([]);
    expect(early.body.reconstructedFrom).toBe("ledger");
  });
});
