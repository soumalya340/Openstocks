import "reflect-metadata";
import request from "supertest";
import type { Express } from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { IoAdapter } from "@nestjs/platform-socket.io";
import { newDb, type IMemoryDb } from "pg-mem";
import type pg from "pg";
import { AppModule, type AppModuleOptions } from "../src/app.module.js";
import { DB_CONNECTION } from "../src/database/database.tokens.js";
import { openDatabase, resetDatabase, type Db } from "../src/db.js";

/** Build an in-process Postgres-compatible pool via pg-mem. */
export function createMemoryPostgresPool(): {
  mem: IMemoryDb;
  pool: pg.Pool;
} {
  const mem = newDb({ autoCreateForeignKeySchema: true });
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool() as unknown as pg.Pool;
  return { mem, pool };
}

export async function createTestApp(
  options: Omit<AppModuleOptions, "pool" | "databaseUrl"> & {
    pool?: pg.Pool;
  } = {}
): Promise<{
  app: Express;
  db: Db;
  nestApp: INestApplication;
  pool: pg.Pool;
}> {
  const { pool: defaultPool } = createMemoryPostgresPool();
  const pool = options.pool ?? defaultPool;
  const { pool: _ignored, ...rest } = options;

  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({
        throttleLimit: 10_000,
        throttleTtlMs: 60_000,
        ...rest,
        pool,
      }),
    ],
  }).compile();

  const nestApp = moduleRef.createNestApplication();
  nestApp.useWebSocketAdapter(new IoAdapter(nestApp));
  await nestApp.init();

  const db = moduleRef.get<Db>(DB_CONNECTION);
  await resetDatabase(db);
  const app = nestApp.getHttpAdapter().getInstance() as Express;
  return { app, db, nestApp, pool };
}

/** Open the shipped Postgres DB entry against an in-process pg-mem pool. */
export async function openTestDatabase(): Promise<Db> {
  const { pool } = createMemoryPostgresPool();
  return openDatabase({ pool });
}

export async function login(
  app: Express,
  username = "alice"
): Promise<{ token: string; userId: string }> {
  const res = await request(app)
    .post("/auth/token")
    .send({ username })
    .expect(201);
  return { token: res.body.token as string, userId: res.body.userId as string };
}

export function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}
