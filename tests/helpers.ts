import request from "supertest";
import type { Express } from "express";
import { openDatabase, type Db } from "../src/db.js";
import { createApp } from "../src/app.js";

export function createTestApp(): { app: Express; db: Db } {
  const db = openDatabase(":memory:");
  const app = createApp(db);
  return { app, db };
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
