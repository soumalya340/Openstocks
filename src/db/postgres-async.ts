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
  readonly driver = "postgres" as const;
  private readonly pool: pg.Pool;
  /** When set, prepare/exec run on this client (inside a transaction). */
  private txClient: pg.PoolClient | null = null;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      ssl: connectionString.includes("localhost")
        ? undefined
        : { rejectUnauthorized: false },
      max: 10,
    });
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
      // Nested: reuse current client (savepoints would be nicer; fine for take-home).
      return await fn();
    }
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
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
