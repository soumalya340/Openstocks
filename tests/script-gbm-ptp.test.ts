import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GBM, gbmNextPrice } from "../scripts/lib/gbm.mjs";
import {
  createBook,
  placeOrder,
  restingBook,
  bookSnapshot,
} from "../scripts/lib/ptp-book.mjs";

describe("scripts/lib GBM (shipped TUI helper)", () => {
  it("gbmNextPrice matches S * exp((μ - σ²/2)Δt + σ√Δt * Z) and stays > 0", () => {
    const S = 420;
    const Z = 0.5;
    const { MU: mu, SIGMA: sigma, DT: dt } = GBM;
    const analytic =
      S * Math.exp((mu - (sigma * sigma) / 2) * dt + sigma * Math.sqrt(dt) * Z);
    const expected = Math.max(0.01, Number(analytic.toFixed(4)));
    expect(gbmNextPrice(S, Z)).toBe(expected);
    expect(gbmNextPrice(S, Z)).toBeGreaterThan(0);
    expect(gbmNextPrice(420, -50)).toBeGreaterThan(0);
  });
});

describe("scripts/lib PTP book (shipped TUI helper)", () => {
  it("does not fill a worse resting ask before a better ask from another user", () => {
    const book = createBook();
    const worse = placeOrder(book, {
      id: "ask-worse",
      userId: "maker-a",
      symbol: "vHLX",
      side: "sell",
      type: "limit",
      quantity: 5,
      limitPrice: 190,
      createdAt: "2026-03-01T10:00:00.000Z",
    });
    const better = placeOrder(book, {
      id: "ask-better",
      userId: "maker-b",
      symbol: "vHLX",
      side: "sell",
      type: "limit",
      quantity: 5,
      limitPrice: 185,
      createdAt: "2026-03-01T10:00:01.000Z",
    });

    const taker = placeOrder(book, {
      id: "take-best",
      userId: "taker",
      symbol: "vHLX",
      side: "buy",
      type: "limit",
      quantity: 5,
      limitPrice: 200,
      createdAt: "2026-03-01T10:00:02.000Z",
    });

    expect(taker.status).toBe("filled");
    expect(taker.filledQuantity).toBe(5);
    expect(better.status).toBe("filled");
    expect(worse.status).toBe("open");

    const fill = book.fills.find((f) => f.takerOrderId === "take-best");
    expect(fill).toBeDefined();
    expect(fill!.price).toBe(185);
    expect(fill!.makerUserId).toBe("maker-b");
    expect(fill!.quantity).toBe(5);
  });

  it("at equal price fills the earlier resting order before the later one (FIFO)", () => {
    const book = createBook();
    const early = placeOrder(book, {
      id: "ask-early",
      userId: "early",
      symbol: "vATL",
      side: "sell",
      type: "limit",
      quantity: 4,
      limitPrice: 100,
      createdAt: "2026-03-02T10:00:00.000Z",
    });
    const late = placeOrder(book, {
      id: "ask-late",
      userId: "late",
      symbol: "vATL",
      side: "sell",
      type: "limit",
      quantity: 4,
      limitPrice: 100,
      createdAt: "2026-03-02T10:00:05.000Z",
    });

    placeOrder(book, {
      id: "take-time",
      userId: "time-taker",
      symbol: "vATL",
      side: "buy",
      type: "market",
      quantity: 4,
      createdAt: "2026-03-02T10:00:06.000Z",
    });

    expect(early.status).toBe("filled");
    expect(late.status).toBe("open");
    const fill = book.fills.find((f) => f.takerOrderId === "take-time");
    expect(fill!.price).toBe(100);
    expect(fill!.makerOrderId).toBe("ask-early");
    expect(fill!.makerUserId).toBe("early");
  });

  it("trade price equals the maker limit; supports partial fills across users", () => {
    const book = createBook();
    placeOrder(book, {
      id: "ask-3",
      userId: "m1",
      symbol: "vVAN",
      side: "sell",
      type: "limit",
      quantity: 3,
      limitPrice: 300,
      createdAt: "2026-03-03T10:00:00.000Z",
    });
    placeOrder(book, {
      id: "ask-5",
      userId: "m2",
      symbol: "vVAN",
      side: "sell",
      type: "limit",
      quantity: 5,
      limitPrice: 305,
      createdAt: "2026-03-03T10:00:01.000Z",
    });

    const taker = placeOrder(book, {
      id: "take-6",
      userId: "big-taker",
      symbol: "vVAN",
      side: "buy",
      type: "limit",
      quantity: 6,
      limitPrice: 310,
      createdAt: "2026-03-03T10:00:02.000Z",
    });

    expect(taker.status).toBe("filled");
    expect(taker.filledQuantity).toBe(6);

    const fills = book.fills
      .filter((f) => f.takerOrderId === "take-6")
      .sort((a, b) => a.price - b.price);
    expect(fills).toEqual([
      expect.objectContaining({
        price: 300,
        quantity: 3,
        makerUserId: "m1",
      }),
      expect.objectContaining({
        price: 305,
        quantity: 3,
        makerUserId: "m2",
      }),
    ]);

    expect(book.orders.get("ask-3")!.status).toBe("filled");
    expect(book.orders.get("ask-5")!.status).toBe("partially_filled");
    expect(book.orders.get("ask-5")!.filledQuantity).toBe(3);

    const snap = bookSnapshot(book, "vVAN");
    expect(restingBook(book, "vVAN", "sell").map((o) => o.id)).toEqual(["ask-5"]);
    expect(snap.asks[0].quantity - snap.asks[0].filledQuantity).toBe(2);
  });
});

describe("scripts/prices-matching-tui.mjs structural wiring", () => {
  it("ships WS + GBM + PTP imports and a finite demo path", () => {
    const src = readFileSync(
      join(process.cwd(), "scripts/prices-matching-tui.mjs"),
      "utf8"
    );
    expect(src).toMatch(/socket\.io/);
    expect(src).toMatch(/from ["']\.\/lib\/gbm\.mjs["']/);
    expect(src).toMatch(/from ["']\.\/lib\/ptp-book\.mjs["']/);
    expect(src).toMatch(/gbmNextPrice/);
    expect(src).toMatch(/--demo|--ticks|runDemo/);
    expect(src).toMatch(/\/prices/);
  });
});
