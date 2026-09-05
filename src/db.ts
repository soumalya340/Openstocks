import { PostgresAsyncDb } from "./db/postgres-async.js";
import { SqliteAsyncDb } from "./db/sqlite-async.js";
import type { Db } from "./db/types.js";

export type { Db, PreparedStatement, RunResult } from "./db/types.js";

export const SEED_ASSETS = [
  { symbol: "vSOL", name: "Solace AI", price: 420.0 },
  { symbol: "vATL", name: "Atlas Robotics", price: 95.5 },
  { symbol: "vHLX", name: "Helix Biotech", price: 180.25 },
  { symbol: "vVAN", name: "Vantage Defense", price: 310.1 },
] as const;

export interface OpenDatabaseOptions {
  /** SQLite path or `:memory:`. Ignored when `databaseUrl` is set. */
  sqlitePath?: string;
  /** Supabase / Postgres connection string. When set, Postgres is used. */
  databaseUrl?: string | null;
}

export async function openDatabase(
  pathOrOpts: string | OpenDatabaseOptions = ":memory:"
): Promise<Db> {
  const opts: OpenDatabaseOptions =
    typeof pathOrOpts === "string"
      ? { sqlitePath: pathOrOpts }
      : pathOrOpts;

  const db: Db = opts.databaseUrl
    ? new PostgresAsyncDb(opts.databaseUrl)
    : new SqliteAsyncDb(opts.sqlitePath ?? ":memory:");

  await migrate(db);
  await seed(db);
  return db;
}

async function migrate(db: Db): Promise<void> {
  if (db.driver === "postgres") {
    await migratePostgres(db);
  } else {
    await migrateSqlite(db);
  }
}

async function migrateSqlite(db: Db): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS assets (
      symbol TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price REAL NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      price REAL NOT NULL,
      ts TEXT NOT NULL,
      FOREIGN KEY (symbol) REFERENCES assets(symbol)
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      cash REAL NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      type TEXT NOT NULL,
      quantity REAL NOT NULL,
      filled_quantity REAL NOT NULL DEFAULT 0,
      limit_price REAL,
      status TEXT NOT NULL,
      reserved_cash REAL NOT NULL DEFAULT 0,
      reserved_shares REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      UNIQUE(user_id, idempotency_key),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS fills (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      quantity REAL NOT NULL,
      price REAL NOT NULL,
      ts TEXT NOT NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE TABLE IF NOT EXISTS holdings (
      user_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      quantity REAL NOT NULL,
      cost_basis REAL NOT NULL,
      margin_reserved REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, symbol),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS trading_halts (
      symbol TEXT PRIMARY KEY,
      halted_at TEXT NOT NULL,
      halted_by TEXT,
      FOREIGN KEY (symbol) REFERENCES assets(symbol)
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

  const holdingCols = (await db.prepare(`PRAGMA table_info(holdings)`).all()) as Array<{
    name: string;
  }>;
  if (!holdingCols.some((c) => c.name === "margin_reserved")) {
    await db.exec(
      `ALTER TABLE holdings ADD COLUMN margin_reserved REAL NOT NULL DEFAULT 0`
    );
  }
}

async function migratePostgres(db: Db): Promise<void> {
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

  // Additive column for older schemas
  const col = await db
    .prepare(
      `SELECT column_name AS name FROM information_schema.columns
       WHERE table_name = 'holdings' AND column_name = 'margin_reserved'`
    )
    .get();
  if (!col) {
    await db.exec(
      `ALTER TABLE holdings ADD COLUMN margin_reserved DOUBLE PRECISION NOT NULL DEFAULT 0`
    );
  }
}

async function seed(db: Db): Promise<void> {
  const now = new Date().toISOString();
  await db.transaction(async () => {
    for (const a of SEED_ASSETS) {
      if (db.driver === "postgres") {
        await db
          .prepare(
            `INSERT INTO assets (symbol, name, price, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (symbol) DO NOTHING`
          )
          .run(a.symbol, a.name, a.price, now);
      } else {
        await db
          .prepare(
            `INSERT OR IGNORE INTO assets (symbol, name, price, updated_at) VALUES (?, ?, ?, ?)`
          )
          .run(a.symbol, a.name, a.price, now);
      }
      const row = (await db
        .prepare(`SELECT COUNT(*) AS c FROM price_history WHERE symbol = ?`)
        .get(a.symbol)) as { c: number | string };
      const count = Number(row.c);
      if (count === 0) {
        await db
          .prepare(`INSERT INTO price_history (symbol, price, ts) VALUES (?, ?, ?)`)
          .run(a.symbol, a.price, now);
      }
    }
  });
}
