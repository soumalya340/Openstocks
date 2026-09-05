import type { Db } from "../db.js";
import { appendLedger } from "../ledger/index.js";
import type { Asset, CalculatorResult, PricePoint } from "../types.js";

const CIRCUIT_MOVE_PCT = 0.15;
const CIRCUIT_LOOKBACK_MS = 60_000;
const CIRCUIT_HALT_MS = 30_000;

export function listAssets(db: Db): Asset[] {
  const rows = db
    .prepare(`SELECT symbol, name, price, updated_at FROM assets ORDER BY symbol`)
    .all() as Array<{
    symbol: string;
    name: string;
    price: number;
    updated_at: string;
  }>;
  return rows.map((r) => ({
    symbol: r.symbol,
    name: r.name,
    price: r.price,
    updatedAt: r.updated_at,
  }));
}

export function getAsset(db: Db, symbol: string): Asset | null {
  const r = db
    .prepare(`SELECT symbol, name, price, updated_at FROM assets WHERE symbol = ?`)
    .get(symbol) as
    | { symbol: string; name: string; price: number; updated_at: string }
    | undefined;
  if (!r) return null;
  return {
    symbol: r.symbol,
    name: r.name,
    price: r.price,
    updatedAt: r.updated_at,
  };
}

export function getPriceHistory(db: Db, symbol: string): PricePoint[] {
  const rows = db
    .prepare(
      `SELECT symbol, price, ts FROM price_history WHERE symbol = ? ORDER BY ts ASC`
    )
    .all(symbol) as Array<{ symbol: string; price: number; ts: string }>;
  return rows.map((r) => ({ symbol: r.symbol, price: r.price, ts: r.ts }));
}

export function calculateShares(
  db: Db,
  symbol: string,
  usdAmount: number
): CalculatorResult | { error: string } {
  if (!(usdAmount > 0) || !Number.isFinite(usdAmount)) {
    return { error: "usdAmount must be a positive number" };
  }
  const asset = getAsset(db, symbol);
  if (!asset) return { error: `Unknown symbol: ${symbol}` };
  const shares = usdAmount / asset.price;
  return {
    symbol: asset.symbol,
    usdAmount,
    price: asset.price,
    shares,
  };
}

/** Set price explicitly (tests / circuit breaker scenarios). */
export function setPrice(
  db: Db,
  symbol: string,
  price: number,
  ts: string = new Date().toISOString()
): Asset {
  if (!(price > 0) || !Number.isFinite(price)) {
    throw new Error("price must be positive");
  }
  const asset = getAsset(db, symbol);
  if (!asset) throw new Error(`Unknown symbol: ${symbol}`);

  const previous = asset.price;
  db.prepare(`UPDATE assets SET price = ?, updated_at = ? WHERE symbol = ?`).run(
    price,
    ts,
    symbol
  );
  db.prepare(`INSERT INTO price_history (symbol, price, ts) VALUES (?, ?, ?)`).run(
    symbol,
    price,
    ts
  );
  appendLedger(db, {
    type: "PRICE_TICK",
    symbol,
    payload: { price, previous },
    ts,
  });

  maybeTripCircuitBreaker(db, symbol, ts);
  return getAsset(db, symbol)!;
}

/**
 * Advance simulated prices with a small random walk.
 * Exposed for demos; tests prefer setPrice for determinism.
 */
export function tickPrices(db: Db, now: string = new Date().toISOString()): Asset[] {
  const assets = listAssets(db);
  for (const a of assets) {
    const delta = (Math.random() - 0.5) * 0.01; // ±0.5%
    const next = Math.max(0.01, Number((a.price * (1 + delta)).toFixed(4)));
    setPrice(db, a.symbol, next, now);
  }
  return listAssets(db);
}

function maybeTripCircuitBreaker(db: Db, symbol: string, nowIso: string): void {
  const now = Date.parse(nowIso);
  const since = new Date(now - CIRCUIT_LOOKBACK_MS).toISOString();
  const rows = db
    .prepare(
      `SELECT price, ts FROM price_history WHERE symbol = ? AND ts >= ? ORDER BY ts ASC`
    )
    .all(symbol, since) as Array<{ price: number; ts: string }>;
  if (rows.length < 2) return;

  const min = Math.min(...rows.map((r) => r.price));
  const max = Math.max(...rows.map((r) => r.price));
  const base = min > 0 ? min : rows[0].price;
  const move = (max - min) / base;
  if (move > CIRCUIT_MOVE_PCT) {
    const until = new Date(now + CIRCUIT_HALT_MS).toISOString();
    db.prepare(
      `INSERT INTO circuit_breakers (symbol, tripped_at, until_ts)
       VALUES (?, ?, ?)
       ON CONFLICT(symbol) DO UPDATE SET tripped_at = excluded.tripped_at, until_ts = excluded.until_ts`
    ).run(symbol, nowIso, until);
  }
}

export function isCircuitOpen(
  db: Db,
  symbol: string,
  nowIso: string = new Date().toISOString()
): { open: boolean; until?: string } {
  const row = db
    .prepare(`SELECT until_ts FROM circuit_breakers WHERE symbol = ?`)
    .get(symbol) as { until_ts: string } | undefined;
  if (!row) return { open: false };
  if (Date.parse(row.until_ts) > Date.parse(nowIso)) {
    return { open: true, until: row.until_ts };
  }
  return { open: false };
}

export const CIRCUIT = {
  MOVE_PCT: CIRCUIT_MOVE_PCT,
  LOOKBACK_MS: CIRCUIT_LOOKBACK_MS,
  HALT_MS: CIRCUIT_HALT_MS,
};
