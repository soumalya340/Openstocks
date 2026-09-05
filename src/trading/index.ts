import { v4 as uuid } from "uuid";
import type { Db } from "../db.js";
import { appendLedger } from "../ledger/index.js";
import {
  getAsset,
  isCircuitOpen,
  isTradingHalted,
} from "../market/index.js";
import type { Order, OrderType, Side } from "../types.js";

/** Initial margin as a fraction of short notional reserved from free cash. */
export const MARGIN = {
  INITIAL_PCT: 0.5,
} as const;

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

function roundShares(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}

function rowToOrder(r: {
  id: string;
  user_id: string;
  symbol: string;
  side: Side;
  type: OrderType;
  quantity: number;
  filled_quantity: number;
  limit_price: number | null;
  status: Order["status"];
  reserved_cash: number;
  reserved_shares: number;
  created_at: string;
  updated_at: string;
  idempotency_key: string;
}): Order {
  return {
    id: r.id,
    userId: r.user_id,
    symbol: r.symbol,
    side: r.side,
    type: r.type,
    quantity: r.quantity,
    filledQuantity: r.filled_quantity,
    limitPrice: r.limit_price,
    status: r.status,
    reservedCash: r.reserved_cash,
    reservedShares: r.reserved_shares,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    idempotencyKey: r.idempotency_key,
  };
}

export async function getOrder(db: Db, orderId: string): Promise<Order | null> {
  const r = (await db.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId)) as
    | Parameters<typeof rowToOrder>[0]
    | undefined;
  return r ? rowToOrder(r) : null;
}

export async function getIdempotentResponse(
  db: Db,
  userId: string,
  key: string
): Promise<{ statusCode: number; body: unknown } | null> {
  const row = (await db
    .prepare(
      `SELECT status_code, body FROM idempotency WHERE user_id = ? AND key = ?`
    )
    .get(userId, key)) as { status_code: number; body: string } | undefined;
  if (!row) return null;
  return { statusCode: row.status_code, body: JSON.parse(row.body) };
}

export async function saveIdempotentResponse(
  db: Db,
  userId: string,
  key: string,
  statusCode: number,
  body: unknown
): Promise<void> {
  const createdAt = new Date().toISOString();
  const json = JSON.stringify(body);
  if (db.driver === "postgres") {
    await db
      .prepare(
        `INSERT INTO idempotency (user_id, key, status_code, body, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_id, key) DO UPDATE SET status_code = EXCLUDED.status_code, body = EXCLUDED.body, created_at = EXCLUDED.created_at`
      )
      .run(userId, key, statusCode, json, createdAt);
  } else {
    await db
      .prepare(
        `INSERT OR REPLACE INTO idempotency (user_id, key, status_code, body, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(userId, key, statusCode, json, createdAt);
  }
}

async function getUserCash(db: Db, userId: string): Promise<number> {
  const row = (await db.prepare(`SELECT cash FROM users WHERE id = ?`).get(userId)) as
    | { cash: number }
    | undefined;
  if (!row) throw new Error("User not found");
  return row.cash;
}

async function getHoldingRow(
  db: Db,
  userId: string,
  symbol: string
): Promise<{ quantity: number; cost_basis: number; margin_reserved: number } | undefined> {
  return (await db
    .prepare(
      `SELECT quantity, cost_basis, margin_reserved FROM holdings WHERE user_id = ? AND symbol = ?`
    )
    .get(userId, symbol)) as
    | { quantity: number; cost_basis: number; margin_reserved: number }
    | undefined;
}

async function getHoldingQty(db: Db, userId: string, symbol: string): Promise<number> {
  return (await getHoldingRow(db, userId, symbol))?.quantity ?? 0;
}

async function sumOrderReservedCash(db: Db, userId: string): Promise<number> {
  return (
    (await db
      .prepare(
        `SELECT COALESCE(SUM(reserved_cash), 0) AS s FROM orders
         WHERE user_id = ? AND status IN ('open', 'partially_filled')`
      )
      .get(userId)) as { s: number }
  ).s;
}

async function sumHoldingsMargin(db: Db, userId: string): Promise<number> {
  return (
    (await db
      .prepare(
        `SELECT COALESCE(SUM(margin_reserved), 0) AS s FROM holdings WHERE user_id = ?`
      )
      .get(userId)) as { s: number }
  ).s;
}

/** Cash available after limit-buy reservations and posted short margin. */
export async function getFreeCash(db: Db, userId: string): Promise<number> {
  return roundMoney(
    (await getUserCash(db, userId)) -
      (await sumOrderReservedCash(db, userId)) -
      (await sumHoldingsMargin(db, userId))
  );
}

export function requiredMargin(shortQty: number, price: number): number {
  if (shortQty <= 0) return 0;
  return roundMoney(shortQty * price * MARGIN.INITIAL_PCT);
}

async function upsertHolding(
  db: Db,
  userId: string,
  symbol: string,
  quantity: number,
  costBasis: number,
  marginReserved: number
): Promise<void> {
  const existing = await getHoldingRow(db, userId, symbol);
  if (existing) {
    await db
      .prepare(
        `UPDATE holdings SET quantity = ?, cost_basis = ?, margin_reserved = ?
       WHERE user_id = ? AND symbol = ?`
      )
      .run(quantity, costBasis, marginReserved, userId, symbol);
  } else {
    await db
      .prepare(
        `INSERT INTO holdings (user_id, symbol, quantity, cost_basis, margin_reserved)
       VALUES (?, ?, ?, ?, ?)`
      )
      .run(userId, symbol, quantity, costBasis, marginReserved);
  }
}

/**
 * Apply a fill to holdings/cash. Supports long, short, and cover paths.
 * Returns the change in posted short margin (positive = more collateral reserved).
 */
async function applyFillToHolding(
  db: Db,
  userId: string,
  symbol: string,
  side: Side,
  qty: number,
  price: number
): Promise<{ marginDelta: number }> {
  const existing = await getHoldingRow(db, userId, symbol);
  const have = existing?.quantity ?? 0;
  const cost = existing?.cost_basis ?? 0;
  const margin = existing?.margin_reserved ?? 0;
  let marginDelta = 0;

  if (side === "buy") {
    if (have >= 0) {
      const newQty = roundShares(have + qty);
      const newCost = roundMoney(cost + qty * price);
      await upsertHolding(db, userId, symbol, newQty, newCost, margin);
    } else {
      const shortQty = -have;
      if (qty + 1e-12 < shortQty) {
        const avg = cost / have;
        const newQty = roundShares(have + qty);
        const newCost = roundMoney(avg * newQty);
        const release = roundMoney(margin * (qty / shortQty));
        marginDelta = -release;
        await upsertHolding(
          db,
          userId,
          symbol,
          newQty,
          newCost,
          roundMoney(Math.max(0, margin - release))
        );
      } else if (Math.abs(qty - shortQty) <= 1e-12) {
        marginDelta = -margin;
        await upsertHolding(db, userId, symbol, 0, 0, 0);
      } else {
        const longQty = roundShares(qty - shortQty);
        marginDelta = -margin;
        await upsertHolding(db, userId, symbol, longQty, roundMoney(longQty * price), 0);
      }
    }
    await db
      .prepare(`UPDATE users SET cash = cash - ? WHERE id = ?`)
      .run(roundMoney(qty * price), userId);
  } else {
    if (have + 1e-12 >= qty) {
      const avg = have > 0 ? cost / have : price;
      const newQty = roundShares(have - qty);
      const newCost = roundMoney(avg * newQty);
      await upsertHolding(db, userId, symbol, newQty, newCost, margin);
    } else if (have > 0) {
      const shortOpened = roundShares(qty - have);
      const addMargin = requiredMargin(shortOpened, price);
      marginDelta = addMargin;
      await upsertHolding(
        db,
        userId,
        symbol,
        roundShares(-shortOpened),
        roundMoney(-shortOpened * price),
        roundMoney(margin + addMargin)
      );
    } else {
      const shortOpened = qty;
      const addMargin = requiredMargin(shortOpened, price);
      marginDelta = addMargin;
      const newQty = roundShares(have - qty);
      const newCost = roundMoney(cost - qty * price);
      await upsertHolding(
        db,
        userId,
        symbol,
        newQty,
        newCost,
        roundMoney(margin + addMargin)
      );
    }
    await db
      .prepare(`UPDATE users SET cash = cash + ? WHERE id = ?`)
      .run(roundMoney(qty * price), userId);
  }

  return { marginDelta };
}

async function recordFill(
  db: Db,
  order: Order,
  qty: number,
  price: number,
  ts: string
): Promise<void> {
  const fillId = uuid();
  await db
    .prepare(
      `INSERT INTO fills (id, order_id, user_id, symbol, side, quantity, price, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(fillId, order.id, order.userId, order.symbol, order.side, qty, price, ts);

  const { marginDelta } = await applyFillToHolding(
    db,
    order.userId,
    order.symbol,
    order.side,
    qty,
    price
  );

  const filledQuantity = roundShares(order.filledQuantity + qty);
  let reservedCash = order.reservedCash;
  let reservedShares = order.reservedShares;
  if (order.side === "buy" && order.type === "limit") {
    reservedCash = roundMoney(
      Math.max(0, reservedCash - qty * (order.limitPrice ?? price))
    );
  }
  if (order.side === "sell" && order.type === "limit") {
    // Release share reservation for the long portion that filled.
    const releaseShares = Math.min(reservedShares, qty);
    reservedShares = roundShares(Math.max(0, reservedShares - releaseShares));
    // Margin reserved on the order for the short portion transfers to holdings on fill
    // (applyFillToHolding already posted holdings margin); drop proportional order reserve.
    if (order.reservedCash > 0 && qty > releaseShares) {
      const shortFilled = roundShares(qty - releaseShares);
      const shortPlanned = roundShares(
        order.quantity - order.reservedShares - order.filledQuantity > 0
          ? Math.max(0, order.quantity - (order.reservedShares + order.filledQuantity))
          : shortFilled
      );
      // Simpler: reduce order reservedCash by margin on the short-filled slice at limit.
      const marginSlice = requiredMargin(shortFilled, order.limitPrice ?? price);
      reservedCash = roundMoney(Math.max(0, reservedCash - marginSlice));
      void shortPlanned; // kept for the planned-vs-filled short slice comment above
    }
  }

  const status =
    filledQuantity + 1e-12 >= order.quantity
      ? "filled"
      : filledQuantity > 0
        ? "partially_filled"
        : order.status;

  await db
    .prepare(
      `UPDATE orders SET filled_quantity = ?, status = ?, reserved_cash = ?, reserved_shares = ?, updated_at = ?
     WHERE id = ?`
    )
    .run(filledQuantity, status, reservedCash, reservedShares, ts, order.id);

  const releasedCash =
    order.side === "buy" && order.type === "limit"
      ? roundMoney(qty * (order.limitPrice ?? price))
      : 0;
  const releasedShares =
    order.side === "sell" && order.type === "limit"
      ? Math.min(order.reservedShares, qty)
      : 0;

  await appendLedger(db, {
    type: "ORDER_FILL",
    userId: order.userId,
    symbol: order.symbol,
    payload: {
      fillId,
      orderId: order.id,
      side: order.side,
      type: order.type,
      quantity: qty,
      price,
      filledQuantity,
      status,
      releasedCash,
      releasedShares,
      marginDelta,
    },
    ts,
  });

  order.filledQuantity = filledQuantity;
  order.status = status;
  order.reservedCash = reservedCash;
  order.reservedShares = reservedShares;
  order.updatedAt = ts;
}

/** Resting opposite-side limits sorted by price-time priority. */
async function loadRestingBook(
  db: Db,
  symbol: string,
  side: Side
): Promise<Order[]> {
  const orderBy =
    side === "buy"
      ? `limit_price DESC, created_at ASC, id ASC`
      : `limit_price ASC, created_at ASC, id ASC`;
  const rows = (await db
    .prepare(
      `SELECT * FROM orders
       WHERE symbol = ? AND side = ? AND type = 'limit'
         AND status IN ('open', 'partially_filled')
       ORDER BY ${orderBy}`
    )
    .all(symbol, side)) as Array<Parameters<typeof rowToOrder>[0]>;
  return rows.map(rowToOrder);
}

function pricesCross(
  takerSide: Side,
  takerType: OrderType,
  takerLimit: number | null,
  makerLimit: number
): boolean {
  if (takerType === "market") return true;
  if (takerSide === "buy") return (takerLimit ?? 0) + 1e-12 >= makerLimit;
  return (takerLimit ?? Infinity) - 1e-12 <= makerLimit;
}

/**
 * Cost to buy `qty` by walking resting asks (maker prices), then any residual at `mid`.
 * Skips makers from `excludeUserId` (self-trade prevention), matching matchAgainstBook.
 */
export async function estimateMarketBuyCost(
  db: Db,
  symbol: string,
  qty: number,
  mid: number,
  excludeUserId?: string
): Promise<number> {
  let remaining = roundShares(qty);
  let cost = 0;
  const asks = await loadRestingBook(db, symbol, "sell");
  for (const ask of asks) {
    if (excludeUserId && ask.userId === excludeUserId) continue;
    const avail = roundShares(ask.quantity - ask.filledQuantity);
    if (avail <= 0) continue;
    const take = roundShares(Math.min(remaining, avail));
    cost = roundMoney(cost + take * (ask.limitPrice as number));
    remaining = roundShares(remaining - take);
    if (remaining <= 0) break;
  }
  if (remaining > 0) {
    cost = roundMoney(cost + remaining * mid);
  }
  return cost;
}

/** Largest qty affordable at `price` given current free cash (share precision). */
async function affordableBuyQty(
  db: Db,
  userId: string,
  price: number,
  maxQty: number
): Promise<number> {
  if (!(price > 0) || maxQty <= 0) return 0;
  const free = await getFreeCash(db, userId);
  if (free + 1e-9 < price * Math.min(maxQty, 1e-8)) return 0;
  const raw = free / price;
  const qty = roundShares(Math.min(maxQty, raw));
  // Guard float dust that would still overspend after roundMoney(qty * price).
  if (roundMoney(qty * price) > free + 1e-9) {
    return roundShares(Math.max(0, qty - 1e-8));
  }
  return qty;
}

/**
 * Match a taker against the resting opposite book under price-time priority.
 * Fill price is always the resting (maker) limit. Returns total qty filled on book.
 * Buys never fill more than free cash can pay at the maker price.
 */
async function matchAgainstBook(db: Db, taker: Order, now: string): Promise<number> {
  const opposite: Side = taker.side === "buy" ? "sell" : "buy";
  let filledOnBook = 0;

  // Re-load book each pass so partial maker updates are visible; break when no cross.
  while (true) {
    const takerFresh = await getOrder(db, taker.id);
    if (!takerFresh) break;
    Object.assign(taker, takerFresh);
    const remaining = roundShares(taker.quantity - taker.filledQuantity);
    if (remaining <= 0) break;

    const book = await loadRestingBook(db, taker.symbol, opposite);
    let matched = false;
    for (const maker of book) {
      if (maker.userId === taker.userId) continue; // no self-trade
      if (maker.id === taker.id) continue;
      const makerRem = roundShares(maker.quantity - maker.filledQuantity);
      if (makerRem <= 0) continue;
      if (!pricesCross(taker.side, taker.type, taker.limitPrice, maker.limitPrice!)) {
        // Book is sorted by price priority — later makers cannot be better.
        break;
      }
      const tradePrice = maker.limitPrice!;
      let fillQty = roundShares(Math.min(remaining, makerRem));
      if (taker.side === "buy") {
        fillQty = await affordableBuyQty(db, taker.userId, tradePrice, fillQty);
      }
      if (fillQty <= 0) {
        if (taker.side === "buy") return filledOnBook;
        continue;
      }
      await recordFill(db, maker, fillQty, tradePrice, now);
      await recordFill(db, taker, fillQty, tradePrice, now);
      filledOnBook = roundShares(filledOnBook + fillQty);
      matched = true;
      break; // restart with refreshed book/taker
    }
    if (!matched) break;
  }

  return filledOnBook;
}

/**
 * Match resting bids against resting asks while best bid >= best ask.
 * Used after mark-price updates; does not fill at mid without a counterparty.
 */
export async function matchBook(
  db: Db,
  symbol: string,
  now: string = new Date().toISOString()
): Promise<Order[]> {
  const touched = new Set<string>();
  await db.transaction(async () => {
    while (true) {
      const bids = await loadRestingBook(db, symbol, "buy");
      const asks = await loadRestingBook(db, symbol, "sell");
      if (bids.length === 0 || asks.length === 0) break;

      let pair: { bid: Order; ask: Order } | null = null;
      for (const bid of bids) {
        for (const ask of asks) {
          if (bid.userId === ask.userId) continue;
          if (bid.limitPrice! + 1e-12 < ask.limitPrice!) continue;
          pair = { bid, ask };
          break;
        }
        if (pair) break;
      }
      if (!pair) break;

      const bidRem = roundShares(pair.bid.quantity - pair.bid.filledQuantity);
      const askRem = roundShares(pair.ask.quantity - pair.ask.filledQuantity);
      const fillQty = roundShares(Math.min(bidRem, askRem));
      if (fillQty <= 0) break;

      // Maker is the earlier resting order; trade at maker's price.
      const bidFirst =
        pair.bid.createdAt < pair.ask.createdAt ||
        (pair.bid.createdAt === pair.ask.createdAt && pair.bid.id < pair.ask.id);
      const tradePrice = bidFirst ? pair.bid.limitPrice! : pair.ask.limitPrice!;

      await recordFill(db, pair.bid, fillQty, tradePrice, now);
      await recordFill(db, pair.ask, fillQty, tradePrice, now);
      touched.add(pair.bid.id);
      touched.add(pair.ask.id);
    }
  });
  const orders: Order[] = [];
  for (const id of touched) {
    const o = await getOrder(db, id);
    if (o) orders.push(o);
  }
  return orders;
}

/**
 * After a price update, match the resting book (price-time priority).
 * `mid` / `maxFillFraction` are retained for call-site compatibility but do not
 * force mid-print fills — quantity is consumed across opposing resting orders.
 */
export async function matchOpenLimits(
  db: Db,
  symbol: string,
  _mid?: number,
  now: string = new Date().toISOString(),
  _maxFillFraction: number = 1
): Promise<Order[]> {
  return matchBook(db, symbol, now);
}

export interface PlaceOrderInput {
  userId: string;
  symbol: string;
  side: Side;
  type: OrderType;
  quantity: number;
  limitPrice?: number | null;
  idempotencyKey: string;
  now?: string;
}

export type PlaceOrderResult =
  | { ok: true; order: Order; statusCode: number }
  | { ok: false; error: string; statusCode: number };

export async function placeOrder(db: Db, input: PlaceOrderInput): Promise<PlaceOrderResult> {
  const now = input.now ?? new Date().toISOString();
  const { userId, symbol, side, type, quantity, idempotencyKey } = input;
  const limitPrice = input.limitPrice ?? null;

  if (!idempotencyKey) {
    return { ok: false, error: "Idempotency-Key header is required", statusCode: 400 };
  }

  const cached = await getIdempotentResponse(db, userId, idempotencyKey);
  if (cached) {
    return {
      ok: true,
      order: (cached.body as { order: Order }).order,
      statusCode: cached.statusCode,
    };
  }

  if (!(quantity > 0) || !Number.isFinite(quantity)) {
    return { ok: false, error: "quantity must be a positive number", statusCode: 400 };
  }
  if (side !== "buy" && side !== "sell") {
    return { ok: false, error: "side must be buy or sell", statusCode: 400 };
  }
  if (type !== "market" && type !== "limit") {
    return { ok: false, error: "type must be market or limit", statusCode: 400 };
  }
  if (type === "limit" && (!(limitPrice != null && limitPrice > 0))) {
    return { ok: false, error: "limitPrice required for limit orders", statusCode: 400 };
  }

  const asset = await getAsset(db, symbol);
  if (!asset) {
    return { ok: false, error: `Unknown symbol: ${symbol}`, statusCode: 404 };
  }

  if (await isTradingHalted(db, symbol)) {
    return {
      ok: false,
      error: `Trading halted for ${symbol}`,
      statusCode: 503,
    };
  }

  const circuit = await isCircuitOpen(db, symbol, now);
  if (circuit.open) {
    return {
      ok: false,
      error: `Circuit breaker open for ${symbol} until ${circuit.until}`,
      statusCode: 503,
    };
  }

  const result = await db.transaction(async (): Promise<PlaceOrderResult> => {
    const again = await getIdempotentResponse(db, userId, idempotencyKey);
    if (again) {
      return {
        ok: true,
        order: (again.body as { order: Order }).order,
        statusCode: again.statusCode,
      };
    }

    let reservedCash = 0;
    let reservedShares = 0;

    const otherReservedShares = (
      (await db
        .prepare(
          `SELECT COALESCE(SUM(reserved_shares), 0) AS s FROM orders
           WHERE user_id = ? AND symbol = ? AND status IN ('open', 'partially_filled')`
        )
        .get(userId, symbol)) as { s: number }
    ).s;
    const held = await getHoldingQty(db, userId, symbol);
    const availableLong = Math.max(0, held - otherReservedShares);

    if (type === "limit" && side === "buy") {
      reservedCash = roundMoney(quantity * (limitPrice as number));
      if ((await getFreeCash(db, userId)) + 1e-9 < reservedCash) {
        return { ok: false, error: "Insufficient cash to reserve for limit buy", statusCode: 400 };
      }
    }

    if (type === "limit" && side === "sell") {
      const longPortion = Math.min(quantity, availableLong);
      const shortPortion = roundShares(quantity - longPortion);
      reservedShares = longPortion;
      if (shortPortion > 0) {
        reservedCash = requiredMargin(shortPortion, limitPrice as number);
        if ((await getFreeCash(db, userId)) + 1e-9 < reservedCash) {
          return {
            ok: false,
            error: "Insufficient margin for short limit sell",
            statusCode: 400,
          };
        }
      }
    }

    if (type === "market" && side === "buy") {
      // Walk the ask book at maker prices, then residual at mid — not mark * qty.
      const cost = await estimateMarketBuyCost(
        db,
        symbol,
        quantity,
        asset.price,
        userId
      );
      if ((await getFreeCash(db, userId)) + 1e-9 < cost) {
        return { ok: false, error: "Insufficient cash for market buy", statusCode: 400 };
      }
    }

    if (type === "market" && side === "sell") {
      const shortPortion = roundShares(Math.max(0, quantity - availableLong));
      if (shortPortion > 0) {
        const margin = requiredMargin(shortPortion, asset.price);
        if ((await getFreeCash(db, userId)) + 1e-9 < margin) {
          return {
            ok: false,
            error: "Insufficient margin for short sell",
            statusCode: 400,
          };
        }
      }
    }

    const orderId = uuid();
    const order: Order = {
      id: orderId,
      userId,
      symbol,
      side,
      type,
      quantity,
      filledQuantity: 0,
      limitPrice,
      status: "open",
      reservedCash,
      reservedShares,
      createdAt: now,
      updatedAt: now,
      idempotencyKey,
    };

    try {
      await db
        .prepare(
          `INSERT INTO orders (
          id, user_id, symbol, side, type, quantity, filled_quantity, limit_price,
          status, reserved_cash, reserved_shares, created_at, updated_at, idempotency_key
        ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          order.id,
          order.userId,
          order.symbol,
          order.side,
          order.type,
          order.quantity,
          order.limitPrice,
          order.status,
          order.reservedCash,
          order.reservedShares,
          order.createdAt,
          order.updatedAt,
          order.idempotencyKey
        );
    } catch (err) {
      const msg = String((err as Error).message ?? err);
      if (msg.includes("UNIQUE") && msg.includes("idempotency")) {
        const existing = (await db
          .prepare(`SELECT * FROM orders WHERE user_id = ? AND idempotency_key = ?`)
          .get(userId, idempotencyKey)) as Parameters<typeof rowToOrder>[0];
        return { ok: true, order: rowToOrder(existing), statusCode: 201 };
      }
      throw err;
    }

    await appendLedger(db, {
      type: "ORDER_PLACED",
      userId,
      symbol,
      payload: {
        orderId: order.id,
        side,
        type,
        quantity,
        limitPrice,
        reservedCash,
        reservedShares,
      },
      ts: now,
    });

    // Price-time match against resting opposite book first.
    await matchAgainstBook(db, order, now);
    const afterBook = (await getOrder(db, order.id))!;
    Object.assign(order, afterBook);

    let remaining = roundShares(order.quantity - order.filledQuantity);
    if (remaining > 0 && type === "market") {
      if (side === "buy") {
        remaining = await affordableBuyQty(db, userId, asset.price, remaining);
      }
      if (remaining > 0) {
        // Residual market quantity lifts/hits synthetic mid liquidity (single-asset mark).
        await recordFill(db, order, remaining, asset.price, now);
      }
    }

    const fresh = (await getOrder(db, order.id))!;
    return { ok: true, order: fresh, statusCode: 201 };
  });

  if (result.ok) {
    await saveIdempotentResponse(db, userId, idempotencyKey, result.statusCode, {
      order: result.order,
    });
  }
  return result;
}

export type CancelResult =
  | { ok: true; order: Order }
  | { ok: false; error: string; statusCode: number };

export async function cancelOrder(
  db: Db,
  userId: string,
  orderId: string,
  now: string = new Date().toISOString()
): Promise<CancelResult> {
  const order = await getOrder(db, orderId);
  if (!order) return { ok: false, error: "Order not found", statusCode: 404 };
  if (order.userId !== userId) {
    return { ok: false, error: "Order not found", statusCode: 404 };
  }
  if (order.status === "filled" || order.status === "cancelled") {
    return {
      ok: false,
      error: `Cannot cancel order in status ${order.status}`,
      statusCode: 400,
    };
  }

  await db.transaction(async () => {
    await db
      .prepare(
        `UPDATE orders SET status = 'cancelled', reserved_cash = 0, reserved_shares = 0, updated_at = ?
       WHERE id = ?`
      )
      .run(now, orderId);

    await appendLedger(db, {
      type: "ORDER_CANCELLED",
      userId,
      symbol: order.symbol,
      payload: {
        orderId,
        releasedCash: order.reservedCash,
        releasedShares: order.reservedShares,
        filledQuantity: order.filledQuantity,
      },
      ts: now,
    });
  });
  return { ok: true, order: (await getOrder(db, orderId))! };
}
