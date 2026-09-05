import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type Db = Database.Database;

const SEED_ASSETS = [
  { symbol: "vSOL", name: "Solace AI", price: 420.0 },
  { symbol: "vATL", name: "Atlas Robotics", price: 95.5 },
  { symbol: "vHLX", name: "Helix Biotech", price: 180.25 },
  { symbol: "vVAN", name: "Vantage Defense", price: 310.1 },
] as const;

export function openDatabase(dbPath: string = ":memory:"): Db {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  seed(db);
  return db;
}

function migrate(db: Db): void {
  db.exec(`
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

  // Additive migration for DBs created before margin_reserved existed.
  const holdingCols = db
    .prepare(`PRAGMA table_info(holdings)`)
    .all() as Array<{ name: string }>;
  if (!holdingCols.some((c) => c.name === "margin_reserved")) {
    db.exec(
      `ALTER TABLE holdings ADD COLUMN margin_reserved REAL NOT NULL DEFAULT 0`
    );
  }
}

function seed(db: Db): void {
  const now = new Date().toISOString();
  const insertAsset = db.prepare(
    `INSERT OR IGNORE INTO assets (symbol, name, price, updated_at) VALUES (?, ?, ?, ?)`
  );
  const insertHistory = db.prepare(
    `INSERT INTO price_history (symbol, price, ts) VALUES (?, ?, ?)`
  );
  const hasHistory = db.prepare(
    `SELECT COUNT(*) AS c FROM price_history WHERE symbol = ?`
  );

  const tx = db.transaction(() => {
    for (const a of SEED_ASSETS) {
      insertAsset.run(a.symbol, a.name, a.price, now);
      const row = hasHistory.get(a.symbol) as { c: number };
      if (row.c === 0) {
        insertHistory.run(a.symbol, a.price, now);
      }
    }
  });
  tx();
}

export { SEED_ASSETS };
