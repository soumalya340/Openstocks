import { v4 as uuid } from "uuid";
import type { Db } from "../db.js";
import type { LedgerEvent, LedgerEventType } from "../types.js";

export function appendLedger(
  db: Db,
  input: {
    type: LedgerEventType;
    userId?: string | null;
    symbol?: string | null;
    payload: Record<string, unknown>;
    ts?: string;
  }
): LedgerEvent {
  const event: LedgerEvent = {
    id: uuid(),
    type: input.type,
    userId: input.userId ?? null,
    symbol: input.symbol ?? null,
    payload: input.payload,
    ts: input.ts ?? new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO ledger (id, type, user_id, symbol, payload, ts) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    event.id,
    event.type,
    event.userId,
    event.symbol,
    JSON.stringify(event.payload),
    event.ts
  );
  return event;
}

export function listLedgerUpTo(db: Db, atIso: string, userId?: string): LedgerEvent[] {
  const rows = userId
    ? (db
        .prepare(
          `SELECT id, type, user_id, symbol, payload, ts FROM ledger
           WHERE ts <= ? AND (user_id IS NULL OR user_id = ?)
           ORDER BY ts ASC, id ASC`
        )
        .all(atIso, userId) as Array<{
        id: string;
        type: LedgerEventType;
        user_id: string | null;
        symbol: string | null;
        payload: string;
        ts: string;
      }>)
    : (db
        .prepare(
          `SELECT id, type, user_id, symbol, payload, ts FROM ledger
           WHERE ts <= ?
           ORDER BY ts ASC, id ASC`
        )
        .all(atIso) as Array<{
        id: string;
        type: LedgerEventType;
        user_id: string | null;
        symbol: string | null;
        payload: string;
        ts: string;
      }>);

  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    userId: r.user_id,
    symbol: r.symbol,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
    ts: r.ts,
  }));
}
