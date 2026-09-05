import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { createTestApp, login, auth } from "./helpers.js";
import type { Db } from "../src/db.js";
import type { INestApplication } from "@nestjs/common";
import { placeOrder, getOrder } from "../src/trading/index.js";

describe("price-time-priority matching", () => {
  let db: Db;
  let nestApp: INestApplication | undefined;

  afterEach(async () => {
    await nestApp?.close();
  });

  it("fills better resting price before worse (price priority)", async () => {
    const ctx = await createTestApp();
    db = ctx.db;
    nestApp = ctx.nestApp;
    const a = await login(ctx.app, "maker-a");
    const b = await login(ctx.app, "maker-b");
    const taker = await login(ctx.app, "taker");

    // Worse ask first (higher price), then better ask
    const worse = placeOrder(db, {
      userId: a.userId,
      symbol: "vHLX",
      side: "sell",
      type: "limit",
      quantity: 5,
      limitPrice: 190,
      idempotencyKey: "ask-worse",
      now: "2026-03-01T10:00:00.000Z",
    });
    const better = placeOrder(db, {
      userId: b.userId,
      symbol: "vHLX",
      side: "sell",
      type: "limit",
      quantity: 5,
      limitPrice: 185,
      idempotencyKey: "ask-better",
      now: "2026-03-01T10:00:01.000Z",
    });
    expect(worse.ok && better.ok).toBe(true);

    const buy = await request(ctx.app)
      .post("/orders")
      .set(auth(taker.token))
      .set("Idempotency-Key", "take-best")
      .send({
        symbol: "vHLX",
        side: "buy",
        type: "limit",
        quantity: 5,
        limitPrice: 200,
      })
      .expect(201);

    expect(buy.body.order.status).toBe("filled");
    expect(buy.body.order.filledQuantity).toBe(5);

    // Fill price must be maker's better limit (185), not mid (180.25) or worse (190)
    const fill = db
      .prepare(`SELECT price, quantity FROM fills WHERE order_id = ?`)
      .get(buy.body.order.id) as { price: number; quantity: number };
    expect(fill.price).toBe(185);
    expect(fill.quantity).toBe(5);

    expect(getOrder(db, better.ok ? better.order.id : "")!.status).toBe("filled");
    expect(getOrder(db, worse.ok ? worse.order.id : "")!.status).toBe("open");
  });

  it("fills earlier resting order first at the same price (time priority)", async () => {
    const ctx = await createTestApp();
    db = ctx.db;
    nestApp = ctx.nestApp;
    const early = await login(ctx.app, "early");
    const late = await login(ctx.app, "late");
    const taker = await login(ctx.app, "time-taker");

    const first = placeOrder(db, {
      userId: early.userId,
      symbol: "vATL",
      side: "sell",
      type: "limit",
      quantity: 4,
      limitPrice: 100,
      idempotencyKey: "ask-early",
      now: "2026-03-02T10:00:00.000Z",
    });
    const second = placeOrder(db, {
      userId: late.userId,
      symbol: "vATL",
      side: "sell",
      type: "limit",
      quantity: 4,
      limitPrice: 100,
      idempotencyKey: "ask-late",
      now: "2026-03-02T10:00:05.000Z",
    });
    expect(first.ok && second.ok).toBe(true);

    await request(ctx.app)
      .post("/orders")
      .set(auth(taker.token))
      .set("Idempotency-Key", "take-time")
      .send({
        symbol: "vATL",
        side: "buy",
        type: "market",
        quantity: 4,
      })
      .expect(201);

    expect(getOrder(db, first.ok ? first.order.id : "")!.status).toBe("filled");
    expect(getOrder(db, second.ok ? second.order.id : "")!.status).toBe("open");
  });

  it("partially consumes across multiple resting orders", async () => {
    const ctx = await createTestApp();
    db = ctx.db;
    nestApp = ctx.nestApp;
    const m1 = await login(ctx.app, "m1");
    const m2 = await login(ctx.app, "m2");
    const taker = await login(ctx.app, "big-taker");

    const a = placeOrder(db, {
      userId: m1.userId,
      symbol: "vVAN",
      side: "sell",
      type: "limit",
      quantity: 3,
      limitPrice: 300,
      idempotencyKey: "ask-3",
      now: "2026-03-03T10:00:00.000Z",
    });
    const b = placeOrder(db, {
      userId: m2.userId,
      symbol: "vVAN",
      side: "sell",
      type: "limit",
      quantity: 5,
      limitPrice: 305,
      idempotencyKey: "ask-5",
      now: "2026-03-03T10:00:01.000Z",
    });
    expect(a.ok && b.ok).toBe(true);

    const buy = placeOrder(db, {
      userId: taker.userId,
      symbol: "vVAN",
      side: "buy",
      type: "limit",
      quantity: 6,
      limitPrice: 310,
      idempotencyKey: "take-6",
      now: "2026-03-03T10:00:02.000Z",
    });
    expect(buy.ok).toBe(true);
    if (!buy.ok) return;

    expect(buy.order.status).toBe("filled");
    expect(buy.order.filledQuantity).toBe(6);

    const fills = db
      .prepare(
        `SELECT price, quantity FROM fills WHERE order_id = ? ORDER BY price ASC`
      )
      .all(buy.order.id) as Array<{ price: number; quantity: number }>;

    expect(fills).toEqual([
      { price: 300, quantity: 3 },
      { price: 305, quantity: 3 },
    ]);

    expect(getOrder(db, a.ok ? a.order.id : "")!.status).toBe("filled");
    const bOrder = getOrder(db, b.ok ? b.order.id : "")!;
    expect(bOrder.status).toBe("partially_filled");
    expect(bOrder.filledQuantity).toBe(3);
  });
});
