import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { v4 as uuid } from "uuid";
import type { Db } from "../db.js";
import { appendLedger } from "../ledger/index.js";

export const JWT_SECRET = process.env.JWT_SECRET ?? "openstocks-dev-secret";
export const INITIAL_CASH = 100_000;

export interface AuthUser {
  userId: string;
  username: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      db?: Db;
    }
  }
}

export function ensureUser(db: Db, username: string): AuthUser {
  const existing = db
    .prepare(`SELECT id, username FROM users WHERE username = ?`)
    .get(username) as { id: string; username: string } | undefined;
  if (existing) {
    return { userId: existing.id, username: existing.username };
  }
  const userId = uuid();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, username, cash, created_at) VALUES (?, ?, ?, ?)`
  ).run(userId, username, INITIAL_CASH, now);
  appendLedger(db, {
    type: "USER_CREATED",
    userId,
    payload: { username, cash: INITIAL_CASH },
    ts: now,
  });
  return { userId, username };
}

export function issueToken(user: AuthUser): string {
  return jwt.sign(
    { sub: user.userId, username: user.username },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

export function authRequired(req: Request, res: Response, next: NextFunction): void {
  const header = req.header("authorization") ?? req.header("Authorization");
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization Bearer token" });
    return;
  }
  const token = header.slice("Bearer ".length).trim();
  try {
    const payload = jwt.verify(token, JWT_SECRET) as {
      sub: string;
      username: string;
    };
    req.user = { userId: payload.sub, username: payload.username };
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}
