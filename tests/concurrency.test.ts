import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { createTestApp, login, auth } from "./helpers.js";
import type { Db } from "../src/db.js";

describe("concurrency", () => {
  let db: Db;

  afterEach(() => {
    db?.close();
  });

  it("handles concurrent distinct order placements without corrupting cash/holdings", async () => {
    const ctx = createTestApp();
    db = ctx.db;
    const { token } = await login(ctx.app, "racer");

    // 10 concurrent market buys of 1 vATL each @ 95.5 → total cost 955
    const jobs = Array.from({ length: 10 }, (_, i) =>
      request(ctx.app)
        .post("/orders")
        .set(auth(token))
        .set("Idempotency-Key", `race-${i}`)
        .send({
          symbol: "vATL",
          side: "buy",
          type: "market",
          quantity: 1,
        })
    );

    const results = await Promise.all(jobs);
    for (const res of results) {
      expect(res.status).toBe(201);
      expect(res.body.order.status).toBe("filled");
    }

    const orderIds = new Set(results.map((r) => r.body.order.id));
    expect(orderIds.size).toBe(10);

    const portfolio = await request(ctx.app)
      .get("/portfolio")
      .set(auth(token))
      .expect(200);

    expect(portfolio.body.portfolio.cash).toBeCloseTo(100000 - 10 * 95.5, 2);
    const holding = portfolio.body.portfolio.holdings.find(
      (h: { symbol: string }) => h.symbol === "vATL"
    );
    expect(holding.quantity).toBe(10);
    expect(holding.costBasis).toBeCloseTo(955, 2);
  });

  it("concurrent replays of the same Idempotency-Key do not double-fill", async () => {
    const ctx = createTestApp();
    db = ctx.db;
    const { token } = await login(ctx.app, "idem-racer");

    const jobs = Array.from({ length: 8 }, () =>
      request(ctx.app)
        .post("/orders")
        .set(auth(token))
        .set("Idempotency-Key", "same-key")
        .send({
          symbol: "vHLX",
          side: "buy",
          type: "market",
          quantity: 1,
        })
    );

    const results = await Promise.all(jobs);
    for (const res of results) {
      expect(res.status).toBe(201);
    }
    const ids = new Set(results.map((r) => r.body.order.id));
    expect(ids.size).toBe(1);

    const portfolio = await request(ctx.app)
      .get("/portfolio")
      .set(auth(token))
      .expect(200);
    const holding = portfolio.body.portfolio.holdings.find(
      (h: { symbol: string }) => h.symbol === "vHLX"
    );
    expect(holding.quantity).toBe(1);
    expect(portfolio.body.portfolio.cash).toBeCloseTo(100000 - 180.25, 2);
  });
});
