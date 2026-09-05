import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { createTestApp, login, auth } from "./helpers.js";
import type { Db } from "../src/db.js";
import { cancelOrder, placeOrder } from "../src/trading/index.js";

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

  it("history reservedCash matches live after cancelling one of two resting limit buys", async () => {
    const ctx = createTestApp();
    db = ctx.db;
    const { token, userId } = await login(ctx.app, "two-limits");

    const t0 = "2026-07-01T09:00:00.000Z";
    const t1 = "2026-07-01T10:00:00.000Z";
    const t2 = "2026-07-01T10:05:00.000Z";
    const t3 = "2026-07-01T10:10:00.000Z";
    const tAfter = "2026-07-01T10:15:00.000Z";
    db.prepare(`UPDATE ledger SET ts = ? WHERE user_id = ? AND type = 'USER_CREATED'`).run(
      t0,
      userId
    );
    db.prepare(`UPDATE users SET created_at = ? WHERE id = ?`).run(t0, userId);

    // Two resting limit buys below market (vSOL @ 420): reserve 2000 each
    const a = placeOrder(db, {
      userId,
      symbol: "vSOL",
      side: "buy",
      type: "limit",
      quantity: 5,
      limitPrice: 400,
      idempotencyKey: "lim-a",
      now: t1,
    });
    const b = placeOrder(db, {
      userId,
      symbol: "vSOL",
      side: "buy",
      type: "limit",
      quantity: 5,
      limitPrice: 400,
      idempotencyKey: "lim-b",
      now: t2,
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    expect(a.order.reservedCash).toBe(2000);
    expect(b.order.reservedCash).toBe(2000);

    const cancelled = cancelOrder(db, userId, a.order.id, t3);
    expect(cancelled.ok).toBe(true);
    if (cancelled.ok) {
      expect(cancelled.order.status).toBe("cancelled");
    }

    // Assert only one cancel release event was written (no duplicate RESERVATION_RELEASE).
    const cancelEvents = db
      .prepare(
        `SELECT type FROM ledger WHERE user_id = ? AND ts = ? AND type IN ('ORDER_CANCELLED', 'RESERVATION_RELEASE')`
      )
      .all(userId, t3) as Array<{ type: string }>;
    expect(cancelEvents.map((e) => e.type)).toEqual(["ORDER_CANCELLED"]);

    const live = await request(ctx.app)
      .get("/portfolio")
      .set(auth(token))
      .expect(200);
    expect(live.body.portfolio.reservedCash).toBe(2000);

    const hist = await request(ctx.app)
      .get(`/portfolio/history?at=${encodeURIComponent(tAfter)}`)
      .set(auth(token))
      .expect(200);

    expect(hist.body.reconstructedFrom).toBe("ledger");
    expect(hist.body.portfolio.reservedCash).toBe(live.body.portfolio.reservedCash);
    expect(hist.body.portfolio.reservedCash).toBe(2000);
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
