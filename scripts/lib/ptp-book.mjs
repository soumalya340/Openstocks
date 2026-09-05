/**
 * In-memory price-time-priority limit book (pure, shared by TUI + tests).
 *
 * Rules:
 * - Better prices fill before worse (asks: low→high; bids: high→low).
 * - At equal price, earlier resting orders fill first (FIFO by createdAt, then id).
 * - Trade price is always the resting maker's limit.
 * - Partial fills and multi-user books are supported.
 * - No self-trade (same userId skipped).
 */

function roundShares(n) {
  return Math.round(n * 1e8) / 1e8;
}

/**
 * @typedef {'buy'|'sell'} Side
 * @typedef {'limit'|'market'} OrderType
 * @typedef {{
 *   id: string,
 *   userId: string,
 *   symbol: string,
 *   side: Side,
 *   type: OrderType,
 *   quantity: number,
 *   filledQuantity: number,
 *   limitPrice: number|null,
 *   createdAt: string,
 *   status: 'open'|'partially_filled'|'filled'|'cancelled'
 * }} BookOrder
 * @typedef {{
 *   id: string,
 *   symbol: string,
 *   price: number,
 *   quantity: number,
 *   makerOrderId: string,
 *   takerOrderId: string,
 *   makerUserId: string,
 *   takerUserId: string,
 *   ts: string
 * }} Fill
 * @typedef {{
 *   orders: Map<string, BookOrder>,
 *   fills: Fill[],
 *   nextId: number
 * }} Book
 */

/** @returns {Book} */
export function createBook() {
  return { orders: new Map(), fills: [], nextId: 1 };
}

/**
 * Resting opposite-side limits sorted by price-time priority.
 * @param {Book} book
 * @param {string} symbol
 * @param {Side} side
 * @returns {BookOrder[]}
 */
export function restingBook(book, symbol, side) {
  const list = [...book.orders.values()].filter(
    (o) =>
      o.symbol === symbol &&
      o.side === side &&
      o.type === "limit" &&
      (o.status === "open" || o.status === "partially_filled") &&
      roundShares(o.quantity - o.filledQuantity) > 0
  );
  list.sort((a, b) => {
    if (side === "buy") {
      if (b.limitPrice !== a.limitPrice) return b.limitPrice - a.limitPrice;
    } else {
      if (a.limitPrice !== b.limitPrice) return a.limitPrice - b.limitPrice;
    }
    if (a.createdAt !== b.createdAt) {
      return a.createdAt < b.createdAt ? -1 : 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return list;
}

function pricesCross(takerSide, takerType, takerLimit, makerLimit) {
  if (takerType === "market") return true;
  if (takerSide === "buy") return (takerLimit ?? 0) + 1e-12 >= makerLimit;
  return (takerLimit ?? Infinity) - 1e-12 <= makerLimit;
}

function setStatus(order) {
  const rem = roundShares(order.quantity - order.filledQuantity);
  if (rem <= 0) order.status = "filled";
  else if (order.filledQuantity > 0) order.status = "partially_filled";
  else order.status = "open";
}

/**
 * Record a fill at the maker limit against both sides.
 * @param {Book} book
 * @param {BookOrder} maker
 * @param {BookOrder} taker
 * @param {number} qty
 * @param {number} price
 * @param {string} ts
 */
function recordFill(book, maker, taker, qty, price, ts) {
  const q = roundShares(qty);
  maker.filledQuantity = roundShares(maker.filledQuantity + q);
  taker.filledQuantity = roundShares(taker.filledQuantity + q);
  setStatus(maker);
  setStatus(taker);
  book.fills.push({
    id: `F${book.fills.length + 1}`,
    symbol: taker.symbol,
    price,
    quantity: q,
    makerOrderId: maker.id,
    takerOrderId: taker.id,
    makerUserId: maker.userId,
    takerUserId: taker.userId,
    ts,
  });
}

/**
 * Match a taker against the resting opposite book under price-time priority.
 * @param {Book} book
 * @param {BookOrder} taker
 * @param {string} [now]
 * @returns {number} quantity filled on book
 */
export function matchAgainstBook(book, taker, now = new Date().toISOString()) {
  const opposite = taker.side === "buy" ? "sell" : "buy";
  let filledOnBook = 0;

  while (true) {
    const remaining = roundShares(taker.quantity - taker.filledQuantity);
    if (remaining <= 0) break;

    const makers = restingBook(book, taker.symbol, opposite);
    let matched = false;
    for (const maker of makers) {
      if (maker.userId === taker.userId) continue;
      if (maker.id === taker.id) continue;
      const makerRem = roundShares(maker.quantity - maker.filledQuantity);
      if (makerRem <= 0) continue;
      if (!pricesCross(taker.side, taker.type, taker.limitPrice, maker.limitPrice)) {
        break;
      }
      const tradePrice = maker.limitPrice;
      const fillQty = roundShares(Math.min(remaining, makerRem));
      if (fillQty <= 0) continue;
      recordFill(book, maker, taker, fillQty, tradePrice, now);
      filledOnBook = roundShares(filledOnBook + fillQty);
      matched = true;
      break;
    }
    if (!matched) break;
  }

  return filledOnBook;
}

/**
 * Place an order onto the book and immediately match as taker.
 * @param {Book} book
 * @param {{
 *   userId: string,
 *   symbol: string,
 *   side: Side,
 *   type?: OrderType,
 *   quantity: number,
 *   limitPrice?: number|null,
 *   createdAt?: string,
 *   id?: string
 * }} input
 * @returns {BookOrder}
 */
export function placeOrder(book, input) {
  const id = input.id ?? `O${book.nextId++}`;
  const createdAt = input.createdAt ?? new Date().toISOString();
  const type = input.type ?? (input.limitPrice != null ? "limit" : "market");
  if (type === "limit" && !(input.limitPrice > 0)) {
    throw new Error("limit orders require a positive limitPrice");
  }
  if (!(input.quantity > 0)) {
    throw new Error("quantity must be positive");
  }

  /** @type {BookOrder} */
  const order = {
    id,
    userId: input.userId,
    symbol: input.symbol,
    side: input.side,
    type,
    quantity: roundShares(input.quantity),
    filledQuantity: 0,
    limitPrice: type === "limit" ? Number(input.limitPrice) : null,
    createdAt,
    status: "open",
  };
  book.orders.set(id, order);
  matchAgainstBook(book, order, createdAt);
  return order;
}

/**
 * Snapshot of the visible book for TUI / tests.
 * @param {Book} book
 * @param {string} symbol
 */
export function bookSnapshot(book, symbol) {
  return {
    bids: restingBook(book, symbol, "buy").map((o) => ({ ...o })),
    asks: restingBook(book, symbol, "sell").map((o) => ({ ...o })),
    fills: book.fills.filter((f) => f.symbol === symbol).map((f) => ({ ...f })),
  };
}
