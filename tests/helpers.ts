import "reflect-metadata";
import request from "supertest";
import type { Express } from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { AppModule } from "../src/app.module.js";
import { DB_CONNECTION } from "../src/database/database.tokens.js";
import type { Db } from "../src/db.js";

export async function createTestApp(): Promise<{
  app: Express;
  db: Db;
  nestApp: INestApplication;
}> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot(":memory:")],
  }).compile();

  const nestApp = moduleRef.createNestApplication();
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
