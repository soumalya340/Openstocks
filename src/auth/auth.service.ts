import { Inject, Injectable } from "@nestjs/common";
import jwt from "jsonwebtoken";
import { v4 as uuid } from "uuid";
import type { Db } from "../db.js";
import { appendLedger } from "../ledger/index.js";
import { DB_CONNECTION } from "../database/database.tokens.js";
import { INITIAL_CASH, JWT_SECRET } from "./auth.constants.js";
import type { AuthUser } from "./auth.types.js";

@Injectable()
export class AuthService {
  constructor(@Inject(DB_CONNECTION) private readonly db: Db) {}

  async ensureUser(username: string): Promise<AuthUser> {
    const existing = (await this.db
      .prepare(`SELECT id, username FROM users WHERE username = ?`)
      .get(username)) as { id: string; username: string } | undefined;
    if (existing) {
      return { userId: existing.id, username: existing.username };
    }
    const userId = uuid();
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO users (id, username, cash, created_at) VALUES (?, ?, ?, ?)`
      )
      .run(userId, username, INITIAL_CASH, now);
    await appendLedger(this.db, {
      type: "USER_CREATED",
      userId,
      payload: { username, cash: INITIAL_CASH },
      ts: now,
    });
    return { userId, username };
  }

  issueToken(user: AuthUser): string {
    return jwt.sign({ sub: user.userId, username: user.username }, JWT_SECRET, {
      expiresIn: "7d",
    });
  }
}
