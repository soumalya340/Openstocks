import type { Db } from "../db.js";
import { appendLedger } from "../ledger/index.js";
import type { Asset, CalculatorResult, PricePoint } from "../types.js";

const CIRCUIT_MOVE_PCT = 0.15;
const CIRCUIT_LOOKBACK_MS = 60_000;
const CIRCUIT_HALT_MS = 30_000;

/** GBM parameters for simulated price ticks (per-tick Δt = 1). */
export const GBM = {
  MU: 0,
  SIGMA: 0.02,
  DT: 1,
} as const;

export type NormalSampler = () => number;

type PriceListener = (asset: Asset) => void;
const priceListeners = new Set<PriceListener>();

/** Subscribe to price updates (used by the WebSocket gateway). */
export function onPriceUpdate(listener: PriceListener): () => void {
  priceListeners.add(listener);
  return () => {
    priceListeners.delete(listener);
  };
}

function notifyPriceUpdate(asset: Asset): void {
  for (const listener of priceListeners) {
    listener(asset);
  }
}

/** Box–Muller standard normal sample. */
export function sampleNormal(): number {
  let u1 = 0;
  let u2 = 0;
  // Avoid log(0)
  while (u1 === 0) u1 = Math.random();
  while (u2 === 0) u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * One GBM step: S' = S * exp((μ − σ²/2)Δt + σ√Δt · Z).
 * Prices stay positive (floored at 0.01 after rounding).
 */
export function gbmNextPrice(
  S: number,
  Z: number,
  mu: number = GBM.MU,
  sigma: number = GBM.SIGMA,
  dt: number = GBM.DT
): number {
  if (!(S > 0) || !Number.isFinite(S)) {
    throw new Error("spot must be positive");
  }
  const drift = (mu - (sigma * sigma) / 2) * dt;
  const diffusion = sigma * Math.sqrt(dt) * Z;
  const next = S * Math.exp(drift + diffusion);
  return Math.max(0.01, Number(next.toFixed(4)));
}

export async function listAssets(db: Db): Promise<Asset[]> {
  const rows = (await db
    .prepare(`SELECT symbol, name, price, updated_at FROM assets ORDER BY symbol`)
    .all()) as Array<{
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

export async function getAsset(db: Db, symbol: string): Promise<Asset | null> {
  const r = (await db
    .prepare(`SELECT symbol, name, price, updated_at FROM assets WHERE symbol = ?`)
    .get(symbol)) as
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

export async function getPriceHistory(db: Db, symbol: string): Promise<PricePoint[]> {
  const rows = (await db
    .prepare(
      `SELECT symbol, price, ts FROM price_history WHERE symbol = ? ORDER BY ts ASC`
    )
    .all(symbol)) as Array<{ symbol: string; price: number; ts: string }>;
  return rows.map((r) => ({ symbol: r.symbol, price: r.price, ts: r.ts }));
}

export async function calculateShares(
  db: Db,
  symbol: string,
  usdAmount: number
): Promise<CalculatorResult | { error: string }> {
  if (!(usdAmount > 0) || !Number.isFinite(usdAmount)) {
    return { error: "usdAmount must be a positive number" };
  }
  const asset = await getAsset(db, symbol);
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
export async function setPrice(
  db: Db,
  symbol: string,
  price: number,
  ts: string = new Date().toISOString()
): Promise<Asset> {
  if (!(price > 0) || !Number.isFinite(price)) {
    throw new Error("price must be positive");
  }
  const asset = await getAsset(db, symbol);
  if (!asset) throw new Error(`Unknown symbol: ${symbol}`);

  const previous = asset.price;
  await db
    .prepare(`UPDATE assets SET price = ?, updated_at = ? WHERE symbol = ?`)
    .run(price, ts, symbol);
  await db
    .prepare(`INSERT INTO price_history (symbol, price, ts) VALUES (?, ?, ?)`)
    .run(symbol, price, ts);
  await appendLedger(db, {
    type: "PRICE_TICK",
    symbol,
    payload: { price, previous },
    ts,
  });

  await maybeTripCircuitBreaker(db, symbol, ts);
  const updated = (await getAsset(db, symbol))!;
  notifyPriceUpdate(updated);
  return updated;
}

/**
 * Advance simulated prices with one geometric Brownian motion step per asset.
 * Pass `sample` to inject deterministic normals in tests.
 */
export async function tickPrices(
  db: Db,
  now: string = new Date().toISOString(),
  sample: NormalSampler = sampleNormal
): Promise<Asset[]> {
  const assets = await listAssets(db);
  for (const a of assets) {
    const next = gbmNextPrice(a.price, sample());
    await setPrice(db, a.symbol, next, now);
  }
  return listAssets(db);
}

async function maybeTripCircuitBreaker(
  db: Db,
  symbol: string,
  nowIso: string
): Promise<void> {
  const now = Date.parse(nowIso);
  const since = new Date(now - CIRCUIT_LOOKBACK_MS).toISOString();
  const rows = (await db
    .prepare(
      `SELECT price, ts FROM price_history WHERE symbol = ? AND ts >= ? ORDER BY ts ASC`
    )
    .all(symbol, since)) as Array<{ price: number; ts: string }>;
  if (rows.length < 2) return;

  const min = Math.min(...rows.map((r) => r.price));
  const max = Math.max(...rows.map((r) => r.price));
  const base = min > 0 ? min : rows[0].price;
  const move = (max - min) / base;
  if (move > CIRCUIT_MOVE_PCT) {
    const until = new Date(now + CIRCUIT_HALT_MS).toISOString();
    await db
      .prepare(
        `INSERT INTO circuit_breakers (symbol, tripped_at, until_ts)
       VALUES (?, ?, ?)
       ON CONFLICT(symbol) DO UPDATE SET tripped_at = excluded.tripped_at, until_ts = excluded.until_ts`
      )
      .run(symbol, nowIso, until);
  }
}

export async function isCircuitOpen(
  db: Db,
  symbol: string,
  nowIso: string = new Date().toISOString()
): Promise<{ open: boolean; until?: string }> {
  const row = (await db
    .prepare(`SELECT until_ts FROM circuit_breakers WHERE symbol = ?`)
    .get(symbol)) as { until_ts: string } | undefined;
  if (!row) return { open: false };
  if (Date.parse(row.until_ts) > Date.parse(nowIso)) {
    return { open: true, until: row.until_ts };
  }
  return { open: false };
}

/** Manual admin halt — independent of the automatic circuit breaker. */
export async function haltTrading(
  db: Db,
  symbol: string,
  nowIso: string = new Date().toISOString(),
  haltedBy: string | null = null
): Promise<void> {
  const asset = await getAsset(db, symbol);
  if (!asset) throw new Error(`Unknown symbol: ${symbol}`);
  await db
    .prepare(
      `INSERT INTO trading_halts (symbol, halted_at, halted_by)
     VALUES (?, ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET halted_at = excluded.halted_at, halted_by = excluded.halted_by`
    )
    .run(symbol, nowIso, haltedBy);
  await appendLedger(db, {
    type: "TRADING_HALTED",
    symbol,
    payload: { haltedBy },
    ts: nowIso,
  });
}

export async function resumeTrading(
  db: Db,
  symbol: string,
  nowIso: string = new Date().toISOString()
): Promise<void> {
  const asset = await getAsset(db, symbol);
  if (!asset) throw new Error(`Unknown symbol: ${symbol}`);
  await db.prepare(`DELETE FROM trading_halts WHERE symbol = ?`).run(symbol);
  await appendLedger(db, {
    type: "TRADING_RESUMED",
    symbol,
    payload: {},
    ts: nowIso,
  });
}

export async function isTradingHalted(db: Db, symbol: string): Promise<boolean> {
  const row = (await db
    .prepare(`SELECT symbol FROM trading_halts WHERE symbol = ?`)
    .get(symbol)) as { symbol: string } | undefined;
  return Boolean(row);
}

export const CIRCUIT = {
  MOVE_PCT: CIRCUIT_MOVE_PCT,
  LOOKBACK_MS: CIRCUIT_LOOKBACK_MS,
  HALT_MS: CIRCUIT_HALT_MS,
};
