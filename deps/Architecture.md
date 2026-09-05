# Architecture

## Overview

OpenStocks is a simplified tokenized pre-IPO trading API. Users authenticate with a lightweight JWT, view simulated asset prices, convert USD to shares via a pure calculator, place market/limit orders with reservations and idempotency, and inspect portfolio state — including point-in-time reconstruction from an append-only ledger.

```
Client
  │
  ▼
Express HTTP (src/app.ts)
  ├─ Public: /assets, /calculator, /auth/token, /health
  └─ Auth:   /orders, /portfolio, /portfolio/history, /admin/prices
        │
        ▼
Domain services (pure-ish, DB-backed)
  ├─ market/     prices, history, calculator, circuit breaker
  ├─ trading/    place/cancel/match, reservations, idempotency
  ├─ portfolio/  live snapshot + ledger replay
  └─ ledger/     append-only event journal
        │
        ▼
SQLite (better-sqlite3) — assets, users, orders, fills, holdings, ledger
```

## Bounded contexts

1. **Market data** — Four fictional assets (`vSOL`, `vATL`, `vHLX`, `vVAN`) with current price + `price_history`. Circuit breaker watches 60s windows for >15% moves and halts new orders for 30s.
2. **Calculator** — `POST /calculator` divides USD by current price; asserts no cash mutation.
3. **Trading engine** — Market fills at mid; limit orders reserve cash (buys) or shares (sells); `matchOpenLimits` fills when mid crosses; cancel releases reservations; `Idempotency-Key` required.
4. **Portfolio** — Live view from `users`/`holdings`/`orders`. Historical view replays `ledger` events with `ts <= at` — the assignment’s highest-weight requirement.
5. **Auth** — `POST /auth/token` creates/fetches a user ($100k cash) and issues a Bearer JWT.

## Persistence model

| Table | Purpose |
|---|---|
| `assets` / `price_history` | Live mid + tick history |
| `users` / `holdings` | Materialized balances for fast `/portfolio` |
| `orders` / `fills` | Order lifecycle + executions |
| `ledger` | Append-only source of truth for `history?at=` |
| `idempotency` | Replay identical order responses |
| `circuit_breakers` | Per-symbol halt windows |

Materialized tables are convenience; historical correctness comes from ledger replay.

## Request flows (happy path)

**Market buy**
1. Auth → validate Idempotency-Key → check circuit → check available cash → insert order → fill at mid → debit cash / credit holding → ledger `ORDER_PLACED` + `ORDER_FILL`.

**Limit buy then cancel**
1. Reserve `qty * limitPrice` (not deducted from `cash`, tracked on order + portfolio `reservedCash`).
2. Cancel → zero reservations → ledger `ORDER_CANCELLED` + `RESERVATION_RELEASE`.

**Portfolio at time T**
1. Load seed prices as-of T from `price_history`.
2. Replay user + global ledger events with `ts <= T`.
3. Emit cash, reserved cash, holdings, MTM P&L.

## Process entry

`src/index.ts` opens SQLite (`DB_PATH` or `data/openstocks.sqlite`), builds the app via `createApp(db)`, listens on `PORT` (default 3000). Tests call `createApp(openDatabase(":memory:"))` — same handlers, isolated DB.
