import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { createTestApp, login, auth } from "./helpers.js";
import type { Db } from "../src/db.js";
import type { INestApplication } from "@nestjs/common";
import { placeOrder, MARGIN, requiredMargin } from "../src/trading/index.js";
import { getPortfolio, getPortfolioAt } from "../src/portfolio/index.js";

describe("short selling with margin", () => {
  let db: Db;
  let nestApp: INestApplication | undefined;

  afterEach(async () => {
    await nestApp?.close();
  });

  it("opens a short with no prior long and reserves 50% margin", async () => {
    const ctx = await createTestApp();
    db = ctx.db;
    nestApp = ctx.nestApp;
    const { token, userId } = await login(ctx.app, "shorty");

    const qty = 10;
    const price = 420;
    const margin = requiredMargin(qty, price);
    expect(margin).toBe(qty * price * MARGIN.INITIAL_PCT);

    const res = await request(ctx.app)
      .post("/orders")
      .set(auth(token))
      .set("Idempotency-Key", "short-1")
      .send({ symbol: "vSOL", side: "sell", type: "market", quantity: qty })
      .expect(201);

    expect(res.body.order.status).toBe("filled");

    const portfolio = await request(ctx.app)
      .get("/portfolio")
      .set(auth(token))
      .expect(200);

    const holding = portfolio.body.portfolio.holdings.find(
      (h: { symbol: string }) => h.symbol === "vSOL"
    );
    expect(holding.quantity).toBe(-qty);
    expect(holding.costBasis).toBeCloseTo(-qty * price, 2);
    expect(holding.marginReserved).toBe(margin);
    expect(portfolio.body.portfolio.cash).toBeCloseTo(100000 + qty * price, 2);
    expect(portfolio.body.portfolio.reservedCash).toBe(margin);
    // Short P&L at unchanged mark is ~0
    expect(holding.unrealizedPnl).toBeCloseTo(0, 2);

    // Ledger replay agrees
    const at = new Date().toISOString();
    const hist = await getPortfolioAt(db, userId, at);
    const histHolding = hist.holdings.find((h) => h.symbol === "vSOL");
    expect(histHolding?.quantity).toBe(-qty);
    expect(hist.reservedCash).toBe(margin);
    expect(hist.cash).toBeCloseTo(portfolio.body.portfolio.cash, 2);
  });

  it("rejects a short when free cash cannot cover margin", async () => {
    const ctx = await createTestApp();
    db = ctx.db;
    nestApp = ctx.nestApp;
    const { token, userId } = await login(ctx.app, "broke");

    // Drain cash so free cash < margin for a large short
    await db.prepare(`UPDATE users SET cash = ? WHERE id = ?`).run(100, userId);

    const res = await request(ctx.app)
      .post("/orders")
      .set(auth(token))
      .set("Idempotency-Key", "short-reject")
      .send({ symbol: "vSOL", side: "sell", type: "market", quantity: 10 })
      .expect(400);

    expect(res.body.error).toMatch(/margin/i);

    const portfolio = await getPortfolio(db, userId);
    expect(portfolio.holdings).toEqual([]);
    expect(portfolio.cash).toBe(100);
  });

  it("buy-to-cover reduces the short and releases margin", async () => {
    const ctx = await createTestApp();
    db = ctx.db;
    nestApp = ctx.nestApp;
    const { token, userId } = await login(ctx.app, "cover");

    const open = await placeOrder(db, {
      userId,
      symbol: "vATL",
      side: "sell",
      type: "market",
      quantity: 10,
      idempotencyKey: "open-short",
    });
    expect(open.ok).toBe(true);

    const afterShort = await getPortfolio(db, userId);
    const shortH = afterShort.holdings.find((h) => h.symbol === "vATL")!;
    expect(shortH.quantity).toBe(-10);
    const marginBefore = shortH.marginReserved;
    expect(marginBefore).toBe(requiredMargin(10, 95.5));

    const cover = await request(ctx.app)
      .post("/orders")
      .set(auth(token))
      .set("Idempotency-Key", "cover-5")
      .send({ symbol: "vATL", side: "buy", type: "market", quantity: 5 })
      .expect(201);
    expect(cover.body.order.status).toBe("filled");

    const afterCover = await request(ctx.app)
      .get("/portfolio")
      .set(auth(token))
      .expect(200);
    const h = afterCover.body.portfolio.holdings.find(
      (x: { symbol: string }) => x.symbol === "vATL"
    );
    expect(h.quantity).toBe(-5);
    expect(h.marginReserved).toBeCloseTo(marginBefore / 2, 2);
    expect(afterCover.body.portfolio.reservedCash).toBeCloseTo(marginBefore / 2, 2);

    // Full cover
    await request(ctx.app)
      .post("/orders")
      .set(auth(token))
      .set("Idempotency-Key", "cover-rest")
      .send({ symbol: "vATL", side: "buy", type: "market", quantity: 5 })
      .expect(201);

    const flat = await getPortfolio(db, userId);
    expect(flat.holdings.find((x) => x.symbol === "vATL")).toBeUndefined();
    expect(flat.reservedCash).toBe(0);
  });
});
