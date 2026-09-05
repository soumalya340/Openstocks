import pg from "pg";
import { toPgParams } from "./sql.js";
import type { Db, PreparedStatement, RunResult } from "./types.js";

const { Pool } = pg;

class PgStatement implements PreparedStatement {
  constructor(
    private readonly pool: pg.Pool,
    private readonly sql: string,
    private readonly client?: pg.PoolClient
  ) {}

  private async query(params: unknown[]): Promise<pg.QueryResult> {
    const text = toPgParams(this.sql);
    if (this.client) return this.client.query(text, params);
    return this.pool.query(text, params);
  }

  async run(...params: unknown[]): Promise<RunResult> {
    const res = await this.query(params);
    return { changes: res.rowCount ?? 0 };
  }

  async get(...params: unknown[]): Promise<unknown> {
    const res = await this.query(params);
    return res.rows[0];
  }

  async all(...params: unknown[]): Promise<unknown[]> {
    const res = await this.query(params);
    return res.rows;
  }
}

export class PostgresAsyncDb implements Db {
  private readonly pool: pg.Pool;
  private readonly ownsPool: boolean;
  private txClient: pg.PoolClient | null = null;
  /** Serialize top-level transactions (avoids lost updates under concurrent HTTP). */
  private writeGate: Promise<void> = Promise.resolve();

  constructor(connectionStringOrPool: string | pg.Pool) {
    if (typeof connectionStringOrPool === "string") {
      this.ownsPool = true;
      this.pool = new Pool({
        connectionString: connectionStringOrPool,
        ssl: /localhost|127\.0\.0\.1/.test(connectionStringOrPool)
          ? undefined
          : { rejectUnauthorized: false },
        max: 10,
      });
    } else {
      this.ownsPool = false;
      this.pool = connectionStringOrPool;
    }
  }

  prepare(sql: string): PreparedStatement {
    return new PgStatement(this.pool, sql, this.txClient ?? undefined);
  }

  async exec(sql: string): Promise<void> {
    const text = toPgParams(sql);
    if (this.txClient) await this.txClient.query(text);
    else await this.pool.query(text);
  }

  async transaction<T>(fn: () => Promise<T> | T): Promise<T> {
    if (this.txClient) {
      return await fn();
    }
    let release!: () => void;
    const prev = this.writeGate;
    this.writeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    const client = await this.pool.connect();
    this.txClient = client;
    try {
      await client.query("BEGIN");
      try {
        const result = await fn();
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    } finally {
      this.txClient = null;
      client.release();
      release();
    }
  }

  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }
}
