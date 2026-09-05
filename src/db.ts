import type pg from "pg";
import { PostgresAsyncDb } from "./db/postgres-async.js";
import type { Db } from "./db/types.js";

export type { Db, PreparedStatement, RunResult } from "./db/types.js";

export const SEED_ASSETS = [
  { symbol: "vSOL", name: "Solace AI", price: 420.0 },
  { symbol: "vATL", name: "Atlas Robotics", price: 95.5 },
  { symbol: "vHLX", name: "Helix Biotech", price: 180.25 },
  { symbol: "vVAN", name: "Vantage Defense", price: 310.1 },
] as const;

export interface OpenDatabaseOptions {
  /** Postgres / Supabase connection string. Required unless `pool` is provided. */
  databaseUrl?: string;
  /** Existing `pg.Pool` (e.g. pg-mem adapter in tests). */
  pool?: pg.Pool;
}

export async function openDatabase(
  opts: string | OpenDatabaseOptions
): Promise<Db> {
  const options: OpenDatabaseOptions =
    typeof opts === "string" ? { databaseUrl: opts } : opts;

  let db: Db;
  if (options.pool) {
    db = new PostgresAsyncDb(options.pool);
  } else {
    const databaseUrl = options.databaseUrl?.trim();
    if (!databaseUrl) {
      throw new Error(
        "DATABASE_URL is required (Postgres / Supabase connection string)"
      );
    }
    db = new PostgresAsyncDb(databaseUrl);
  }

  await migrate(db);
  await seed(db);
  return db;
}

/** Wipe app tables and re-seed assets — used by the test helper for isolation. */
export async function resetDatabase(db: Db): Promise<void> {
  // Delete per-table (compatible with pg-mem; avoids multi-table TRUNCATE).
  for (const table of [
    "fills",
    "orders",
    "holdings",
    "ledger",
    "idempotency",
    "circuit_breakers",
    "trading_halts",
    "price_history",
    "users",
    "assets",
  ]) {
    await db.exec(`DELETE FROM ${table}`);
  }
  await seed(db);
}

async function migrate(db: Db): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS assets (
      symbol TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price DOUBLE PRECISION NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS price_history (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL REFERENCES assets(symbol),
      price DOUBLE PRECISION NOT NULL,
      ts TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      cash DOUBLE PRECISION NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      type TEXT NOT NULL,
      quantity DOUBLE PRECISION NOT NULL,
      filled_quantity DOUBLE PRECISION NOT NULL DEFAULT 0,
      limit_price DOUBLE PRECISION,
      status TEXT NOT NULL,
      reserved_cash DOUBLE PRECISION NOT NULL DEFAULT 0,
      reserved_shares DOUBLE PRECISION NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      UNIQUE(user_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS fills (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id),
      user_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      quantity DOUBLE PRECISION NOT NULL,
      price DOUBLE PRECISION NOT NULL,
      ts TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS holdings (
      user_id TEXT NOT NULL REFERENCES users(id),
      symbol TEXT NOT NULL,
      quantity DOUBLE PRECISION NOT NULL,
      cost_basis DOUBLE PRECISION NOT NULL,
      margin_reserved DOUBLE PRECISION NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, symbol)
    );

    CREATE TABLE IF NOT EXISTS trading_halts (
      symbol TEXT PRIMARY KEY REFERENCES assets(symbol),
      halted_at TEXT NOT NULL,
      halted_by TEXT
    );

    CREATE TABLE IF NOT EXISTS ledger (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      user_id TEXT,
      symbol TEXT,
      payload TEXT NOT NULL,
      ts TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS idempotency (
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, key)
    );

    CREATE TABLE IF NOT EXISTS circuit_breakers (
      symbol TEXT PRIMARY KEY,
      tripped_at TEXT NOT NULL,
      until_ts TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ledger_ts ON ledger(ts);
    CREATE INDEX IF NOT EXISTS idx_price_history_symbol_ts ON price_history(symbol, ts);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  `);

  try {
    const col = await db
      .prepare(
        `SELECT column_name AS name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'holdings' AND column_name = 'margin_reserved'`
      )
      .get();
    if (!col) {
      await db.exec(
        `ALTER TABLE holdings ADD COLUMN margin_reserved DOUBLE PRECISION NOT NULL DEFAULT 0`
      );
    }
  } catch {
    // Fresh schemas already include margin_reserved on CREATE TABLE.
  }
}

async function seed(db: Db): Promise<void> {
  const now = new Date().toISOString();
  await db.transaction(async () => {
    for (const a of SEED_ASSETS) {
      await db
        .prepare(
          `INSERT INTO assets (symbol, name, price, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (symbol) DO NOTHING`
        )
        .run(a.symbol, a.name, a.price, now);
      const row = (await db
        .prepare(`SELECT COUNT(*) AS c FROM price_history WHERE symbol = ?`)
        .get(a.symbol)) as { c: number | string };
      if (Number(row.c) === 0) {
        await db
          .prepare(
            `INSERT INTO price_history (symbol, price, ts) VALUES (?, ?, ?)`
          )
          .run(a.symbol, a.price, now);
      }
    }
  });
}
