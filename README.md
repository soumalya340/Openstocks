# OpenStocks — Tokenized Pre-IPO Trading API

Take-home implementation of a simplified platform where users trade tokenized shares of fictional pre-IPO companies against a USD stablecoin balance.

## Assets

| Symbol | Company | Seed price |
|--------|---------|------------|
| vSOL | Solace AI | $420.00 |
| vATL | Atlas Robotics | $95.50 |
| vHLX | Helix Biotech | $180.25 |
| vVAN | Vantage Defense | $310.10 |

## Setup

```bash
npm install            # also runs `tsc` via postinstall → dist/src/main.js
# or: yarn install
cp .env.example .env   # edit secrets/paths as needed
npm test               # Vitest suite
npm start              # builds then runs node dist/src/main.js
npm run dev            # tsx watch for local development
```

### VPS deploy (tmux)

`dist/` is **not** in git — you must install + build on the server before start:

```bash
cd ~/Openstocks
git pull
npm install            # installs deps + postinstall compiles TypeScript
cp -n .env.example .env && nano .env   # first time only
npm start              # runs `prestart` → build, then node dist/src/main.js

# or explicitly:
npm run build && npm run start:prod

tmux new -s openstocks
npm start
# Ctrl-B then D to detach; `tmux attach -t openstocks` to reattach
```

If you see `Cannot find module '.../dist/src/main.js'`, run `npm run build` once and retry.

Environment variables are loaded from `.env` via `dotenv` (`src/env.ts`):

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `3000` | HTTP port |
| `DATABASE_URL` | **required** | Postgres / Supabase connection string. Encode `@` in passwords as `%40`. |
| `SUPABASE_URL` | _(empty)_ | Optional; REST client URL (SQL uses `DATABASE_URL`) |
| `SUPABASE_SERVICE_ROLE_KEY` | _(empty)_ | Optional; not required for direct SQL via `pg` |
| `JWT_SECRET` | `openstocks-dev-secret` | HS256 signing key |
| `THROTTLE_TTL_MS` | `60000` | Rate-limit window (ms) |
| `THROTTLE_LIMIT` | `100` | Max requests per IP per window |

`.env` is gitignored; commit `.env.example` as the template. Requires Node 20+.

## Routes (HTTP + WebSocket)

| Method | Path | Auth | Body / notes |
|--------|------|------|----------------|
| `GET` | `/health` | — | Liveness `{ ok: true }` |
| `POST` | `/auth/token` | — | `{ "username": "alice" }` → JWT |
| `GET` | `/assets` | — | All assets + price history |
| `GET` | `/assets/:symbol` | — | One asset + history (`vSOL`, `vATL`, `vHLX`, `vVAN`) |
| `POST` | `/calculator` | — | `{ "symbol", "usdAmount" }` → shares (no side effects) |
| `POST` | `/orders` | Bearer | Headers: `Idempotency-Key`. Body: `{ "symbol", "side", "type", "quantity", "limitPrice?" }` |
| `DELETE` | `/orders/:id` | Bearer | Cancel a resting order |
| `GET` | `/portfolio` | Bearer | Holdings, cost basis, P&L, margin |
| `GET` | `/portfolio/history?at=` | Bearer | Query `at` = ISO timestamp; ledger replay |
| `POST` | `/admin/prices/:symbol` | Bearer | `{ "price", "ts?" }` set mark + rematch book |
| `POST` | `/admin/halt/:symbol` | Bearer | Manual trading halt |
| `POST` | `/admin/resume/:symbol` | Bearer | Resume after halt |
| `WS` | `/prices` | — | Socket.IO namespace; server emits `price` on updates |

All HTTP routes share a **global 1 request/minute per IP** budget (`THROTTLE_LIMIT=1`) and return `429 { "error": "..." }` when exceeded. Full OpenAPI: [`openapi.yaml`](./openapi.yaml).

## Quick start

> Tip: with the default **1 rpm** limit, run these one at a time (or raise `THROTTLE_LIMIT` in `.env` for local demos).

```bash
BASE=http://localhost:3000

# GET /health
curl -s "$BASE/health"

# POST /auth/token
TOKEN=$(curl -s -X POST "$BASE/auth/token" \
  -H 'content-type: application/json' \
  -d '{"username":"alice"}' | jq -r .token)

# GET /assets  and  GET /assets/:symbol
curl -s "$BASE/assets" | jq .
curl -s "$BASE/assets/vSOL" | jq .

# POST /calculator
curl -s -X POST "$BASE/calculator" \
  -H 'content-type: application/json' \
  -d '{"symbol":"vSOL","usdAmount":840}' | jq .

# POST /orders  (Idempotency-Key required)
curl -s -X POST "$BASE/orders" \
  -H "authorization: Bearer $TOKEN" \
  -H 'idempotency-key: demo-1' \
  -H 'content-type: application/json' \
  -d '{"symbol":"vSOL","side":"buy","type":"market","quantity":2}' | jq .

# GET /portfolio  and  GET /portfolio/history?at=
curl -s "$BASE/portfolio" -H "authorization: Bearer $TOKEN" | jq .
curl -s "$BASE/portfolio/history?at=2026-06-01T12:00:00.000Z" \
  -H "authorization: Bearer $TOKEN" | jq .

# DELETE /orders/:id  (use a real resting limit order id)
curl -s -X DELETE "$BASE/orders/ORDER_ID" \
  -H "authorization: Bearer $TOKEN" | jq .

# POST /admin/prices/:symbol
curl -s -X POST "$BASE/admin/prices/vSOL" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"price":420}' | jq .

# POST /admin/halt/:symbol  and  POST /admin/resume/:symbol
curl -s -X POST "$BASE/admin/halt/vSOL" -H "authorization: Bearer $TOKEN" | jq .
curl -s -X POST "$BASE/admin/resume/vSOL" -H "authorization: Bearer $TOKEN" | jq .

# WS /prices  (Socket.IO) — e.g. with a client connecting to namespace "/prices"
```

## Architecture decisions

- **NestJS + TypeScript** — modules/controllers/providers around Nest's DI container, running on `@nestjs/platform-express` under the hood.
- **Postgres via `DATABASE_URL`** — required; typically Supabase. Uses `pg`. `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are optional (REST only).
- **Append-only ledger** — `GET /portfolio/history?at=` replays ledger events; live `users`/`holdings` tables are a materialized convenience only.
- **Matching** — Price-time-priority CLOB across users: better prices first, FIFO at a price, maker limit is the trade price, partial book consumption. Residual market size (empty book) still fills at the mark.
- **Short selling** — Sells may open/increase a negative holding when free cash covers **50% initial margin** on the short notional; covers release collateral proportionally.
- **Prices** — Simulated via geometric Brownian motion (`tickPrices`); admin `POST /admin/prices/:symbol` sets the mark and re-matches the book. Updates are pushed on the Socket.IO `/prices` namespace (`price` event).
- **Auth** — Lightweight JWT via `POST /auth/token`, enforced with a Nest `AuthGuard`.
- **Rate limiting** — Global `@nestjs/throttler` guard; excess requests return HTTP 429 `{ error }`.
- **Error shape** — a global `HttpErrorFilter` normalizes every thrown exception to `{ error: string }` so the API contract stays stable regardless of Nest's default exception body shape.

See `deps/Architecture.md`, `deps/Decisions.md`, and `deps/Thinking_Model.md` for deeper rationale.

## Known limitations

- Order book UI is not implemented (stretch goal left out on purpose).
- Price feed is simulated (GBM ticks / explicit admin set), not real market data.
- Margin is a simple 50% initial-collateral rule — no locate, borrow fees, margin calls, or forced liquidation schedules.
- JWT secret is a demo default — rotate via `JWT_SECRET` before any shared deploy.

## Tests

```bash
yarn test
```

Coverage includes: assets/calculator side-effect freedom, market/limit place, partial fill + cancel, idempotent replay, circuit breaker rejection, auth rejection, portfolio ledger history, concurrent order placement, GBM ticks, WebSocket price push, rate-limit 429, short + margin + cover, price-time-priority matching, and admin halt/resume.
