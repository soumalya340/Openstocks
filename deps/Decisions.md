# Decisions

This file records packages, files, and topic-level choices for the OpenStocks take-home.

## 1. Packages

| Package | Why |
|---|---|
| `express` | Already present in the repo; preferred NestJS/Fastify not required when Express is documented. Keeps HTTP surface thin and testable with Supertest. |
| `typescript` + `tsx` | Assignment prefers TypeScript/Node. `tsx` runs/tests without a separate build step for local dev. |
| `vitest` + `supertest` | Fast unit/integration runner; drives real Express handlers (not reimplemented logic). |
| `better-sqlite3` | Assignment prefers PostgreSQL; Postgres client (`psql`) is unavailable in this environment. SQLite preserves relational ledger semantics locally with zero Docker dependency. Schema stays portable to Postgres. |
| `jsonwebtoken` | Lightweight JWT auth as allowed by the assignment (no OAuth/SSO). |
| `uuid` | Order IDs and ledger event IDs. |
| `cors` | Local browser/tooling access during manual checks. |

## 2. Files / layout

| Path | Role |
|---|---|
| `src/index.ts` | Process entry: open DB, seed assets, listen. |
| `src/app.ts` | Express app factory (used by entry + tests). |
| `src/db.ts` | SQLite open/migrate/seed. |
| `src/types.ts` | Shared domain types. |
| `src/auth/` | JWT issue/verify middleware. |
| `src/market/` | Simulated prices, history, calculator. |
| `src/trading/` | Orders, matching, reservations, idempotency, circuit breaker. |
| `src/portfolio/` | Holdings/P&L + ledger replay for `history?at=`. |
| `src/ledger/` | Append-only event journal (source of truth). |
| `tests/` | Happy path, rejections, partial fill/cancel, concurrency. |
| `openapi.yaml` | API reference. |
| `README.md` | Setup, architecture, limitations. |

## 3. Topic decisions (what the LLM chose and why)

| Topic | Choice | Rationale |
|---|---|---|
| HTTP framework | Express (keep existing) | Avoid rewrite tax; document vs Nest/Fastify preference. |
| Persistence | SQLite via `better-sqlite3` | Postgres unavailable; ledger + orders need durable rows for history replay tests. |
| Auth | Bearer JWT (`Authorization: Bearer <token>`) + demo login issuing tokens | Assignment says lightweight JWT/API key — JWT covers both mental models. |
| Matching model | Single-user book vs simulated mid: market orders fill at current mid; limit orders rest with reserved cash/shares and fill when mid crosses limit (partial fills allowed) | Full multi-user price-time priority is a stretch goal; behavior still demonstrates partial fills + reservations. |
| Portfolio history | Replay append-only ledger events with `ts <= at` | Assignment weights this highest; snapshot alone is insufficient. |
| Price simulation | Deterministic random-walk ticks from seed prices, history retained in memory + DB | No real market data; circuit breaker needs timed price moves. |
| Idempotency | Required `Idempotency-Key` on `POST /orders`; stored response replay | Explicit assignment requirement. |
| Circuit breaker | >15% move within 60s → reject new orders on that symbol for 30s | Exact assignment rule. |
| Initial user balance | `$100,000` USD cash on first auth | Needed so trading tests are self-contained. |
