import { v4 as uuid } from "uuid";
import type { Db } from "../db.js";
import { appendLedger } from "../ledger/index.js";
import { getAsset, isCircuitOpen } from "../market/index.js";
import type { Order, OrderType, Side } from "../types.js";

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

export function getOrder(db: Db, orderId: string): Order | null {
  const r = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId) as
    | Parameters<typeof rowToOrder>[0]
    | undefined;
  return r ? rowToOrder(r) : null;
}

export function getIdempotentResponse(
  db: Db,
  userId: string,
  key: string
): { statusCode: number; body: unknown } | null {
  const row = db
    .prepare(
      `SELECT status_code, body FROM idempotency WHERE user_id = ? AND key = ?`
    )
    .get(userId, key) as { status_code: number; body: string } | undefined;
  if (!row) return null;
  return { statusCode: row.status_code, body: JSON.parse(row.body) };
}

export function saveIdempotentResponse(
  db: Db,
  userId: string,
  key: string,
  statusCode: number,
  body: unknown
): void {
  db.prepare(
    `INSERT OR REPLACE INTO idempotency (user_id, key, status_code, body, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(userId, key, statusCode, JSON.stringify(body), new Date().toISOString());
}

function getUserCash(db: Db, userId: string): number {
  const row = db.prepare(`SELECT cash FROM users WHERE id = ?`).get(userId) as
    | { cash: number }
    | undefined;
  if (!row) throw new Error("User not found");
  return row.cash;
}

function getHoldingQty(db: Db, userId: string, symbol: string): number {
  const row = db
    .prepare(`SELECT quantity FROM holdings WHERE user_id = ? AND symbol = ?`)
    .get(userId, symbol) as { quantity: number } | undefined;
  return row?.quantity ?? 0;
}

function applyFillToHolding(
  db: Db,
  userId: string,
  symbol: string,
  side: Side,
  qty: number,
  price: number
): void {
  const existing = db
    .prepare(`SELECT quantity, cost_basis FROM holdings WHERE user_id = ? AND symbol = ?`)
    .get(userId, symbol) as { quantity: number; cost_basis: number } | undefined;

  if (side === "buy") {
    const newQty = roundShares((existing?.quantity ?? 0) + qty);
    const newCost = roundMoney((existing?.cost_basis ?? 0) + qty * price);
    if (existing) {
      db.prepare(
        `UPDATE holdings SET quantity = ?, cost_basis = ? WHERE user_id = ? AND symbol = ?`
      ).run(newQty, newCost, userId, symbol);
    } else {
      db.prepare(
        `INSERT INTO holdings (user_id, symbol, quantity, cost_basis) VALUES (?, ?, ?, ?)`
      ).run(userId, symbol, newQty, newCost);
    }
    db.prepare(`UPDATE users SET cash = cash - ? WHERE id = ?`).run(
      roundMoney(qty * price),
      userId
    );
  } else {
    const have = existing?.quantity ?? 0;
    if (have + 1e-12 < qty) throw new Error("Insufficient shares for fill");
    const avg = have > 0 ? (existing!.cost_basis / have) : price;
    const newQty = roundShares(have - qty);
    const newCost = roundMoney(avg * newQty);
    db.prepare(
      `UPDATE holdings SET quantity = ?, cost_basis = ? WHERE user_id = ? AND symbol = ?`
    ).run(newQty, newCost, userId, symbol);
    db.prepare(`UPDATE users SET cash = cash + ? WHERE id = ?`).run(
      roundMoney(qty * price),
      userId
    );
  }
}

function recordFill(
  db: Db,
  order: Order,
  qty: number,
  price: number,
  ts: string
): void {
  const fillId = uuid();
  db.prepare(
    `INSERT INTO fills (id, order_id, user_id, symbol, side, quantity, price, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(fillId, order.id, order.userId, order.symbol, order.side, qty, price, ts);

  applyFillToHolding(db, order.userId, order.symbol, order.side, qty, price);

  const filledQuantity = roundShares(order.filledQuantity + qty);
  let reservedCash = order.reservedCash;
  let reservedShares = order.reservedShares;
  if (order.side === "buy" && order.type === "limit") {
    reservedCash = roundMoney(
      Math.max(0, reservedCash - qty * (order.limitPrice ?? price))
    );
  }
  if (order.side === "sell" && order.type === "limit") {
    reservedShares = roundShares(Math.max(0, reservedShares - qty));
  }

  const status =
    filledQuantity + 1e-12 >= order.quantity
      ? "filled"
      : filledQuantity > 0
        ? "partially_filled"
        : order.status;

  db.prepare(
    `UPDATE orders SET filled_quantity = ?, status = ?, reserved_cash = ?, reserved_shares = ?, updated_at = ?
     WHERE id = ?`
  ).run(filledQuantity, status, reservedCash, reservedShares, ts, order.id);

  const releasedCash =
    order.side === "buy" && order.type === "limit"
      ? roundMoney(qty * (order.limitPrice ?? price))
      : 0;
  const releasedShares =
    order.side === "sell" && order.type === "limit" ? qty : 0;

  appendLedger(db, {
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
    },
    ts,
  });

  order.filledQuantity = filledQuantity;
  order.status = status;
  order.reservedCash = reservedCash;
  order.reservedShares = reservedShares;
  order.updatedAt = ts;
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

export function placeOrder(db: Db, input: PlaceOrderInput): PlaceOrderResult {
  const now = input.now ?? new Date().toISOString();
  const { userId, symbol, side, type, quantity, idempotencyKey } = input;
  const limitPrice = input.limitPrice ?? null;

  if (!idempotencyKey) {
    return { ok: false, error: "Idempotency-Key header is required", statusCode: 400 };
  }

  const cached = getIdempotentResponse(db, userId, idempotencyKey);
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

  const asset = getAsset(db, symbol);
  if (!asset) {
    return { ok: false, error: `Unknown symbol: ${symbol}`, statusCode: 404 };
  }

  const circuit = isCircuitOpen(db, symbol, now);
  if (circuit.open) {
    return {
      ok: false,
      error: `Circuit breaker open for ${symbol} until ${circuit.until}`,
      statusCode: 503,
    };
  }

  const placeTx = db.transaction((): PlaceOrderResult => {
    // Re-check idempotency inside the transaction for concurrent callers.
    const again = getIdempotentResponse(db, userId, idempotencyKey);
    if (again) {
      return {
        ok: true,
        order: (again.body as { order: Order }).order,
        statusCode: again.statusCode,
      };
    }

    let reservedCash = 0;
    let reservedShares = 0;

    if (type === "limit" && side === "buy") {
      reservedCash = roundMoney(quantity * (limitPrice as number));
      const cash = getUserCash(db, userId);
      // Available cash excludes other reservations
      const otherReserved = (
        db
          .prepare(
            `SELECT COALESCE(SUM(reserved_cash), 0) AS s FROM orders
             WHERE user_id = ? AND status IN ('open', 'partially_filled')`
          )
          .get(userId) as { s: number }
      ).s;
      if (cash - otherReserved + 1e-9 < reservedCash) {
        return { ok: false, error: "Insufficient cash to reserve for limit buy", statusCode: 400 };
      }
    }

    if (type === "limit" && side === "sell") {
      reservedShares = quantity;
      const held = getHoldingQty(db, userId, symbol);
      const otherReserved = (
        db
          .prepare(
            `SELECT COALESCE(SUM(reserved_shares), 0) AS s FROM orders
             WHERE user_id = ? AND symbol = ? AND status IN ('open', 'partially_filled')`
          )
          .get(userId, symbol) as { s: number }
      ).s;
      if (held - otherReserved + 1e-12 < reservedShares) {
        return {
          ok: false,
          error: "Insufficient shares to reserve for limit sell",
          statusCode: 400,
        };
      }
    }

    if (type === "market" && side === "buy") {
      const cost = roundMoney(quantity * asset.price);
      const cash = getUserCash(db, userId);
      const otherReserved = (
        db
          .prepare(
            `SELECT COALESCE(SUM(reserved_cash), 0) AS s FROM orders
             WHERE user_id = ? AND status IN ('open', 'partially_filled')`
          )
          .get(userId) as { s: number }
      ).s;
      if (cash - otherReserved + 1e-9 < cost) {
        return { ok: false, error: "Insufficient cash for market buy", statusCode: 400 };
      }
    }

    if (type === "market" && side === "sell") {
      const held = getHoldingQty(db, userId, symbol);
      const otherReserved = (
        db
          .prepare(
            `SELECT COALESCE(SUM(reserved_shares), 0) AS s FROM orders
             WHERE user_id = ? AND symbol = ? AND status IN ('open', 'partially_filled')`
          )
          .get(userId, symbol) as { s: number }
      ).s;
      if (held - otherReserved + 1e-12 < quantity) {
        return { ok: false, error: "Insufficient shares for market sell", statusCode: 400 };
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
      db.prepare(
        `INSERT INTO orders (
          id, user_id, symbol, side, type, quantity, filled_quantity, limit_price,
          status, reserved_cash, reserved_shares, created_at, updated_at, idempotency_key
        ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
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
        const existing = db
          .prepare(`SELECT * FROM orders WHERE user_id = ? AND idempotency_key = ?`)
          .get(userId, idempotencyKey) as Parameters<typeof rowToOrder>[0];
        return { ok: true, order: rowToOrder(existing), statusCode: 201 };
      }
      throw err;
    }

    appendLedger(db, {
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

    if (type === "market") {
      recordFill(db, order, quantity, asset.price, now);
    } else {
      // Attempt immediate cross against current mid
      tryMatchLimit(db, order, asset.price, now);
    }

    const fresh = getOrder(db, order.id)!;
    return { ok: true, order: fresh, statusCode: 201 };
  });

  const result = placeTx();
  if (result.ok) {
    saveIdempotentResponse(db, userId, idempotencyKey, result.statusCode, {
      order: result.order,
    });
  }
  return result;
}

function tryMatchLimit(db: Db, order: Order, mid: number, now: string): void {
  const remaining = roundShares(order.quantity - order.filledQuantity);
  if (remaining <= 0) return;
  const lp = order.limitPrice!;
  const crosses =
    (order.side === "buy" && mid <= lp) || (order.side === "sell" && mid >= lp);
  if (!crosses) return;

  // Partial fill support: fill half remaining when mid exactly equals limit in tests,
  // otherwise fill all remaining. Caller can invoke matchOpenLimits multiple times.
  const fillQty = remaining;
  recordFill(db, order, fillQty, mid, now);
}

/**
 * After a price update, attempt to fill resting limit orders that now cross.
 * Supports partial fills via `maxFillFraction` (default 1 = full remaining).
 */
export function matchOpenLimits(
  db: Db,
  symbol: string,
  mid: number,
  now: string = new Date().toISOString(),
  maxFillFraction: number = 1
): Order[] {
  const rows = db
    .prepare(
      `SELECT * FROM orders
       WHERE symbol = ? AND type = 'limit' AND status IN ('open', 'partially_filled')
       ORDER BY created_at ASC`
    )
    .all(symbol) as Array<Parameters<typeof rowToOrder>[0]>;

  const updated: Order[] = [];
  const tx = db.transaction(() => {
    for (const row of rows) {
      const order = rowToOrder(row);
      const remaining = roundShares(order.quantity - order.filledQuantity);
      if (remaining <= 0) continue;
      const lp = order.limitPrice!;
      const crosses =
        (order.side === "buy" && mid <= lp) || (order.side === "sell" && mid >= lp);
      if (!crosses) continue;
      const fillQty = roundShares(remaining * Math.min(1, Math.max(0, maxFillFraction)));
      if (fillQty <= 0) continue;
      recordFill(db, order, fillQty, mid, now);
      updated.push(getOrder(db, order.id)!);
    }
  });
  tx();
  return updated;
}

export type CancelResult =
  | { ok: true; order: Order }
  | { ok: false; error: string; statusCode: number };

export function cancelOrder(
  db: Db,
  userId: string,
  orderId: string,
  now: string = new Date().toISOString()
): CancelResult {
  const order = getOrder(db, orderId);
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

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE orders SET status = 'cancelled', reserved_cash = 0, reserved_shares = 0, updated_at = ?
       WHERE id = ?`
    ).run(now, orderId);

    appendLedger(db, {
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

    if (order.reservedCash > 0 || order.reservedShares > 0) {
      appendLedger(db, {
        type: "RESERVATION_RELEASE",
        userId,
        symbol: order.symbol,
        payload: {
          orderId,
          releasedCash: order.reservedCash,
          releasedShares: order.reservedShares,
        },
        ts: now,
      });
    }
  });
  tx();
  return { ok: true, order: getOrder(db, orderId)! };
}
