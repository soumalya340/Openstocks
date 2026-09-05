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
yarn install           # also runs `tsc` via postinstall → dist/src/index.js
cp .env.example .env   # edit secrets/paths as needed
yarn test              # Vitest suite
yarn start             # node dist/src/index.js (http://localhost:$PORT)
yarn dev               # tsx watch for local development
yarn check:live        # hit every API route on Render; console.log each result
```

`yarn check:live` defaults to `https://openstocks-2r66.onrender.com` (override with `BASE_URL`). Each connection prints JSON with `method`, `path`, `status`, and `body` (or `error`).

### Render deploy

Build Command: `yarn --frozen-lockfile install` (postinstall compiles TypeScript)  
Start Command: `node dist/src/index.js`  
Set env vars in the Render dashboard: `JWT_SECRET`, optional `DB_PATH` (Render injects `PORT`).

A `render.yaml` Blueprint is included if you prefer Infrastructure-as-Code.

Environment variables are loaded from `.env` via `dotenv` (`src/env.ts`):

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `./data/openstocks.sqlite` | SQLite file (`:memory:` supported) |
| `JWT_SECRET` | `openstocks-dev-secret` | HS256 signing key |

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

- **Express + TypeScript** — Express was already in the repo; NestJS/Fastify preference noted but not worth a rewrite for this scope.
- **SQLite (`better-sqlite3`)** — Assignment prefers PostgreSQL; `psql` is unavailable here. SQLite keeps relational ledger semantics and zero-ops local runs. Schema is Postgres-portable.
- **Append-only ledger** — `GET /portfolio/history?at=` replays ledger events; live `users`/`holdings` tables are a materialized convenience only.
- **Matching** — Market orders fill at mid; limit orders reserve funds/shares and fill when mid crosses (partial fills supported). Full multi-user CLOB is a stretch goal.
- **Auth** — Lightweight JWT via `POST /auth/token`.

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
| POST | `/admin/prices/:symbol` | Bearer | Deterministic price + match helper |
| GET | `/health` | — | Liveness |

## Known limitations

- Not a production multi-tenant matching engine (no full price-time priority across users).
- Price feed is simulated (random walk / explicit admin set), not real market data.
- SQLite single-writer; horizontal scale would need Postgres + a real matching service.
- JWT secret is a demo default — rotate via `JWT_SECRET` before any shared deploy.
- No WebSocket streaming, UI, rate limiting, short selling, or GBM (stretch goals).

## Tests

```bash
yarn test
```

Coverage includes: assets/calculator side-effect freedom, market/limit place, partial fill + cancel, idempotent replay, circuit breaker rejection, auth rejection, portfolio ledger history, and concurrent order placement.
