# Thinking Model — why and what we chose

## Problem framing

The assignment is a mini exchange for fictional pre-IPO tokens. The graders care less about pixel-perfect OpenStocks cloning and more about:

1. Clear handling of ambiguity (state assumptions, move on).
2. A real trading lifecycle: market/limit, partial fills, reservations, idempotency, cancel, circuit breaker.
3. **Ledger-based portfolio history** — reconstruct state at arbitrary past time, not a cached snapshot.

## Why Express instead of NestJS/Fastify

The repo already depended on Express. Nest would add modules/DI ceremony without improving the domain story in a take-home window. Fastify is fine but a swap mid-scaffold wastes time. Decision: keep Express, document the deviation in `Decisions.md`.

## Why SQLite instead of PostgreSQL

Preferred stack lists PostgreSQL/Supabase. This environment has Docker but no local `psql`, and requiring a live Postgres container would make the dual-launch gating fragile. SQLite via `better-sqlite3` gives:

- Relational schema close to what Postgres would be.
- Synchronous transactions that make concurrency tests deterministic.
- Zero external process for `vitest` and for launching `src/index.ts`.

Assumption (flagged for reviewers): production would map the same schema to Postgres; API behavior is identical.

## Why an append-only ledger (and why replay beats snapshots)

`GET /portfolio/history?at=` is the hardest requirement. Options considered:

| Approach | Pros | Cons |
|---|---|---|
| Periodic snapshots only | Fast reads | Cannot answer arbitrary `at`; fails the brief |
| Snapshots + diffs | Faster than full replay | More code; still need events |
| **Append-only ledger + replay** | Exact point-in-time; auditable; matches “from the ledger” | O(n) replay (fine at take-home scale) |

We keep materialized `users`/`holdings` for live `/portfolio`, but history **always** replays ledger events with `ts <= at`. Live tables are never the historical source of truth.

Ledger event types: `USER_CREATED`, `ORDER_PLACED`, `ORDER_FILL`, `ORDER_CANCELLED`, `RESERVATION_RELEASE`, `PRICE_TICK`.

## Matching model (what we intentionally simplified)

Full multi-user price-time-priority matching is listed as a stretch goal. We implement:

- Market orders fill immediately at current mid (simulated infinite liquidity at mid).
- Limit orders rest with reserved cash/shares; when mid crosses the limit (via price updates / admin helper), they fill — optionally partially via `fillFraction`.

This still exercises partial fills, reservations, cancel, and ledger fill events without building a full CLOB.

## Circuit breaker

Exact rule: >15% move in a 60s lookback → reject new orders on that asset for 30s. Implemented in `market` on each `setPrice`, checked in `placeOrder`.

## Auth investment level

Assignment: “don’t over-invest.” We issue HS256 JWTs from `POST /auth/token` with a demo secret. No refresh rotation, no OAuth. Trading/portfolio routes use `authRequired`.

## Testing philosophy

Tests drive the **real** Express app (`createApp` + in-memory SQLite) through Supertest — not a reimplementation of calculator/matching math inside the test. Coverage includes happy paths, auth rejection, missing idempotency key, partial fill + cancel, circuit breaker, portfolio history after a known ledger sequence, and concurrent order placement.

## Known trade-offs we accept

- Single-process SQLite, not horizontally scaled matching.
- Price process is a simple random walk / explicit `setPrice` (not GBM — stretch).
- No WebSocket streaming, no UI order book, no short selling.
- Admin price endpoint exists for deterministic tests/demos; not a production market-data feed.
