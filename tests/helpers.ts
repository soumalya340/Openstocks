import "reflect-metadata";
import request from "supertest";
import type { Express } from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { IoAdapter } from "@nestjs/platform-socket.io";
import { AppModule, type AppModuleOptions } from "../src/app.module.js";
import { DB_CONNECTION } from "../src/database/database.tokens.js";
import type { Db } from "../src/db.js";

export async function createTestApp(
  options: AppModuleOptions = {}
): Promise<{
  app: Express;
  db: Db;
  nestApp: INestApplication;
}> {
  // Tests exercise many routes per suite; keep a high budget unless a test
  // explicitly opts into production-like 1 rpm via throttleLimit.
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({
        dbPath: ":memory:",
        databaseUrl: null, // force SQLite in tests even if .env has DATABASE_URL
        throttleLimit: 10_000,
        throttleTtlMs: 60_000,
        ...options,
      }),
    ],
  }).compile();

  const nestApp = moduleRef.createNestApplication();
  nestApp.useWebSocketAdapter(new IoAdapter(nestApp));
  await nestApp.init();

  const db = moduleRef.get<Db>(DB_CONNECTION);
  const app = nestApp.getHttpAdapter().getInstance() as Express;
  return { app, db, nestApp };
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
