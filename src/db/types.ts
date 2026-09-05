export interface RunResult {
  changes: number;
  lastInsertRowid?: number | bigint;
}

export interface PreparedStatement {
  run(...params: unknown[]): Promise<RunResult>;
  get(...params: unknown[]): Promise<unknown>;
  all(...params: unknown[]): Promise<unknown[]>;
}

export interface Db {
  readonly driver: "sqlite" | "postgres";
  prepare(sql: string): PreparedStatement;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: () => Promise<T> | T): Promise<T>;
  close(): Promise<void>;
}
