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
yarn install           # also runs `tsc` via postinstall → dist/src/main.js
cp .env.example .env   # edit secrets/paths as needed
yarn test              # Vitest suite
yarn start             # node dist/src/main.js (http://localhost:$PORT)
yarn dev               # tsx watch for local development
```

### VPS deploy

Run the built app under `tmux` (or any process supervisor of your choice) on your own host:

```bash
yarn install && yarn build
tmux new -s openstocks
node dist/src/main.js
# Ctrl-B then D to detach; `tmux attach -t openstocks` to reattach
```

Environment variables are loaded from `.env` via `dotenv` (`src/env.ts`):

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `./data/openstocks.sqlite` | SQLite file (`:memory:` supported) |
| `JWT_SECRET` | `openstocks-dev-secret` | HS256 signing key |
| `THROTTLE_TTL_MS` | `60000` | Rate-limit window (ms) |
| `THROTTLE_LIMIT` | `1` | Max requests per IP per window (**1 rpm**) |

`.env` is gitignored; commit `.env.example` as the template. Requires Node 20+.

## Quick start

```bash
# 1. Get a token (creates user with $100,000 cash)
curl -s -X POST http://localhost:3000/auth/token \
  -H 'content-type: application/json' \
  -d '{"username":"alice"}'

# 2. List assets
curl -s http://localhost:3000/assets | jq .

# 3. Calculator (no side effects)
curl -s -X POST http://localhost:3000/calculator \
  -H 'content-type: application/json' \
  -d '{"symbol":"vSOL","usdAmount":840}'

# 4. Place a market buy (Idempotency-Key required)
curl -s -X POST http://localhost:3000/orders \
  -H "authorization: Bearer $TOKEN" \
  -H 'idempotency-key: demo-1' \
  -H 'content-type: application/json' \
  -d '{"symbol":"vSOL","side":"buy","type":"market","quantity":2}'

# 5. Portfolio + point-in-time history
curl -s http://localhost:3000/portfolio -H "authorization: Bearer $TOKEN"
curl -s "http://localhost:3000/portfolio/history?at=2026-06-01T12:00:00.000Z" \
  -H "authorization: Bearer $TOKEN"
```

## Architecture decisions

- **NestJS + TypeScript** — modules/controllers/providers around Nest's DI container, running on `@nestjs/platform-express` under the hood.
- **SQLite (`better-sqlite3`)** — Assignment prefers PostgreSQL; `psql` is unavailable here. SQLite keeps relational ledger semantics and zero-ops local runs. Schema is Postgres-portable.
- **Append-only ledger** — `GET /portfolio/history?at=` replays ledger events; live `users`/`holdings` tables are a materialized convenience only.
- **Matching** — Price-time-priority CLOB across users: better prices first, FIFO at a price, maker limit is the trade price, partial book consumption. Residual market size (empty book) still fills at the mark.
- **Short selling** — Sells may open/increase a negative holding when free cash covers **50% initial margin** on the short notional; covers release collateral proportionally.
- **Prices** — Simulated via geometric Brownian motion (`tickPrices`); admin `POST /admin/prices/:symbol` sets the mark and re-matches the book. Updates are pushed on the Socket.IO `/prices` namespace (`price` event).
- **Auth** — Lightweight JWT via `POST /auth/token`, enforced with a Nest `AuthGuard`.
- **Rate limiting** — Global `@nestjs/throttler` guard; excess requests return HTTP 429 `{ error }`.
- **Error shape** — a global `HttpErrorFilter` normalizes every thrown exception to `{ error: string }` so the API contract stays stable regardless of Nest's default exception body shape.

See `deps/Architecture.md`, `deps/Decisions.md`, and `deps/Thinking_Model.md` for deeper rationale.

## API reference

Full OpenAPI document: [`openapi.yaml`](./openapi.yaml).

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | `/auth/token` | — | `{ username }` → JWT |
| GET | `/assets` | — | List + price history |
| GET | `/assets/:symbol` | — | Detail + history |
| POST | `/calculator` | — | USD → shares; no side effects |
| POST | `/orders` | Bearer | Requires `Idempotency-Key` |
| DELETE | `/orders/:id` | Bearer | Cancel resting order |
| GET | `/portfolio` | Bearer | Holdings, cost basis, P&L |
| GET | `/portfolio/history?at=` | Bearer | Ledger replay as-of timestamp |
| POST | `/admin/prices/:symbol` | Bearer | Set mark + match resting book |
| POST | `/admin/halt/:symbol` | Bearer | Manual trading halt (per symbol) |
| POST | `/admin/resume/:symbol` | Bearer | Resume after manual halt |
| GET | `/health` | — | Liveness |
| WS | `/prices` | — | Socket.IO namespace; `price` events on updates |

## Known limitations

- Order book UI is not implemented (stretch goal left out on purpose).
- Price feed is simulated (GBM ticks / explicit admin set), not real market data.
- Margin is a simple 50% initial-collateral rule — no locate, borrow fees, margin calls, or forced liquidation schedules.
- SQLite single-writer; horizontal scale would need Postgres + a real matching service.
- JWT secret is a demo default — rotate via `JWT_SECRET` before any shared deploy.

## Tests

```bash
yarn test
```

Coverage includes: assets/calculator side-effect freedom, market/limit place, partial fill + cancel, idempotent replay, circuit breaker rejection, auth rejection, portfolio ledger history, concurrent order placement, GBM ticks, WebSocket price push, rate-limit 429, short + margin + cover, price-time-priority matching, and admin halt/resume.
