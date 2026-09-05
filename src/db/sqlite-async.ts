import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { Db, PreparedStatement, RunResult } from "./types.js";

class SqliteStatement implements PreparedStatement {
  constructor(private readonly stmt: Database.Statement) {}

  async run(...params: unknown[]): Promise<RunResult> {
    const info = this.stmt.run(...params);
    return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
  }

  async get(...params: unknown[]): Promise<unknown> {
    return this.stmt.get(...params);
  }

  async all(...params: unknown[]): Promise<unknown[]> {
    return this.stmt.all(...params);
  }
}

/**
 * Async facade over better-sqlite3. Uses BEGIN/COMMIT + a mutex so awaited
 * work inside transactions cannot interleave with other requests.
 */
export class SqliteAsyncDb implements Db {
  readonly driver = "sqlite" as const;
  private readonly raw: Database.Database;
  private gate: Promise<void> = Promise.resolve();

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.raw = new Database(dbPath);
    this.raw.pragma("journal_mode = WAL");
    this.raw.pragma("foreign_keys = ON");
  }

  prepare(sql: string): PreparedStatement {
    return new SqliteStatement(this.raw.prepare(sql));
  }

  async exec(sql: string): Promise<void> {
    this.raw.exec(sql);
  }

  async transaction<T>(fn: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const waitFor = this.gate;
    this.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await waitFor;
    try {
      this.raw.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn();
        this.raw.exec("COMMIT");
        return result;
      } catch (err) {
        this.raw.exec("ROLLBACK");
        throw err;
      }
    } finally {
      release();
    }
  }

  async close(): Promise<void> {
    this.raw.close();
  }
}
