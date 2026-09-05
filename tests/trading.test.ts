import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { createTestApp, login, auth } from "./helpers.js";
import type { Db } from "../src/db.js";
import type { INestApplication } from "@nestjs/common";
import { setPrice } from "../src/market/index.js";

describe("trading engine", () => {
  let db: Db;
  let nestApp: INestApplication | undefined;

  afterEach(async () => {
    await nestApp?.close();
  });

  it("rejects orders without auth", async () => {
    const ctx = await createTestApp();
    db = ctx.db;
    nestApp = ctx.nestApp;
    await request(ctx.app)
      .post("/orders")
      .set("Idempotency-Key", "k1")
      .send({ symbol: "vSOL", side: "buy", type: "market", quantity: 1 })
      .expect(401);
  });

  it("rejects orders without Idempotency-Key", async () => {
    const ctx = await createTestApp();
    db = ctx.db;
    nestApp = ctx.nestApp;
    const { token } = await login(ctx.app);
    const res = await request(ctx.app)
      .post("/orders")
      .set(auth(token))
      .send({ symbol: "vSOL", side: "buy", type: "market", quantity: 1 })
      .expect(400);
    expect(res.body.error).toMatch(/Idempotency-Key/i);
  });

  it("places a market buy and updates portfolio", async () => {
    const ctx = await createTestApp();
    db = ctx.db;
    nestApp = ctx.nestApp;
    const { token } = await login(ctx.app);
    const res = await request(ctx.app)
      .post("/orders")
      .set(auth(token))
      .set("Idempotency-Key", "mkt-buy-1")
      .send({ symbol: "vSOL", side: "buy", type: "market", quantity: 2 })
      .expect(201);

    expect(res.body.order.status).toBe("filled");
    expect(res.body.order.filledQuantity).toBe(2);

    const portfolio = await request(ctx.app)
      .get("/portfolio")
      .set(auth(token))
      .expect(200);
    expect(portfolio.body.portfolio.cash).toBe(100000 - 2 * 420);
    const holding = portfolio.body.portfolio.holdings.find(
      (h: { symbol: string }) => h.symbol === "vSOL"
    );
    expect(holding.quantity).toBe(2);
    expect(holding.costBasis).toBe(840);
  });

  it("replays identical response for same Idempotency-Key (no double fill)", async () => {
    const ctx = await createTestApp();
    db = ctx.db;
    nestApp = ctx.nestApp;
    const { token } = await login(ctx.app);
    const body = { symbol: "vATL", side: "buy", type: "market", quantity: 1 };
    const a = await request(ctx.app)
      .post("/orders")
      .set(auth(token))
      .set("Idempotency-Key", "idem-1")
      .send(body)
      .expect(201);
    const b = await request(ctx.app)
      .post("/orders")
      .set(auth(token))
      .set("Idempotency-Key", "idem-1")
      .send(body)
      .expect(201);
    expect(b.body.order.id).toBe(a.body.order.id);

    const portfolio = await request(ctx.app)
      .get("/portfolio")
      .set(auth(token))
      .expect(200);
    const holding = portfolio.body.portfolio.holdings.find(
      (h: { symbol: string }) => h.symbol === "vATL"
    );
    expect(holding.quantity).toBe(1);
  });

  it("partially fills a limit order against a counterparty then cancels the remainder", async () => {
    const ctx = await createTestApp();
    db = ctx.db;
    nestApp = ctx.nestApp;
    const buyer = await login(ctx.app, "buyer");
    const seller = await login(ctx.app, "seller");

    // Seller rests 10 @ 400
    const sell = await request(ctx.app)
      .post("/orders")
      .set(auth(seller.token))
      .set("Idempotency-Key", "lim-sell-1")
      .send({
        symbol: "vSOL",
        side: "sell",
        type: "limit",
        quantity: 10,
        limitPrice: 400,
      })
      .expect(201);
    // No shares held → short limit; margin reserved (50% * 10 * 400 = 2000)
    expect(sell.body.order.status).toBe("open");
    expect(sell.body.order.reservedCash).toBe(2000);

    // Buyer takes 4 @ 400 — maker price, partial consume
    const buy = await request(ctx.app)
      .post("/orders")
      .set(auth(buyer.token))
      .set("Idempotency-Key", "lim-buy-1")
      .send({
        symbol: "vSOL",
        side: "buy",
        type: "limit",
        quantity: 4,
        limitPrice: 400,
      })
      .expect(201);
    expect(buy.body.order.status).toBe("filled");
    expect(buy.body.order.filledQuantity).toBe(4);

    const sellAfter = await request(ctx.app)
      .get("/portfolio")
      .set(auth(seller.token))
      .expect(200);
    const sellHolding = sellAfter.body.portfolio.holdings.find(
      (h: { symbol: string }) => h.symbol === "vSOL"
    );
    expect(sellHolding.quantity).toBeCloseTo(-4, 6);
    expect(sellAfter.body.portfolio.cash).toBeCloseTo(100000 + 4 * 400, 2);

    const buyPort = await request(ctx.app)
      .get("/portfolio")
      .set(auth(buyer.token))
      .expect(200);
    const buyHolding = buyPort.body.portfolio.holdings.find(
      (h: { symbol: string }) => h.symbol === "vSOL"
    );
    expect(buyHolding.quantity).toBeCloseTo(4, 6);
    expect(buyPort.body.portfolio.cash).toBeCloseTo(100000 - 4 * 400, 2);

    const cancelled = await request(ctx.app)
      .delete(`/orders/${sell.body.order.id}`)
      .set(auth(seller.token))
      .expect(200);
    expect(cancelled.body.order.status).toBe("cancelled");
    expect(cancelled.body.order.reservedCash).toBe(0);
  });

  it("trips circuit breaker after >15% move in 60s and rejects new orders", async () => {
    const ctx = await createTestApp();
    db = ctx.db;
    nestApp = ctx.nestApp;
    const { token } = await login(ctx.app);

    // Use wall-clock-relative stamps so the 30s halt is still open when we place.
    const t0 = new Date(Date.now() - 20_000).toISOString();
    const t1 = new Date(Date.now() - 5_000).toISOString();
    setPrice(db, "vVAN", 310.1, t0);
    // >15% up from 310.1 → ~356.6+
    setPrice(db, "vVAN", 360, t1);

    const rejected = await request(ctx.app)
      .post("/orders")
      .set(auth(token))
      .set("Idempotency-Key", "cb-1")
      .send({ symbol: "vVAN", side: "buy", type: "market", quantity: 1 })
      .expect(503);
    expect(rejected.body.error).toMatch(/Circuit breaker/i);
  });
});
