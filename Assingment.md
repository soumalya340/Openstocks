Here's the take-home assignment.

_Build a Tokenized Pre-IPO Trading Platform_

_Background_
You're building a simplified version of a platform where users trade tokenized shares of private, pre-IPO companies against a stablecoin balance — similar in spirit to real products like OpenStocks. We use fictional companies/tickers so there's no dependency on real market data.

_Assets (fictional)_
• vSOL — Solace AI — $420.00
• vATL — Atlas Robotics — $95.50
• vHLX — Helix Biotech — $180.25
• vVAN — Vantage Defense — $310.10

_What to build_
1️⃣ Market data — live (simulated) prices with history, GET /assets, GET /assets/:symbol
2️⃣ Price calculator — POST /calculator (USD amount → shares, no side effects)
3️⃣ Trading engine:
• Market + limit orders, with partial fills
• Reserved funds/shares for resting limit orders
• Idempotency-Key header required on order placement
• DELETE /orders/:id to cancel a resting order
• Circuit breaker: >15% price move in 60s → reject new orders on that asset for 30s
4️⃣ Portfolio:
• GET /portfolio — holdings, cost basis, P&L
• GET /portfolio/history?at=<timestamp> — reconstruct portfolio at any past point in time from the ledger (this is the hardest and most heavily weighted part)
5️⃣ Lightweight auth (JWT/API key) — don't over-invest here

_Stack (preferred,)_
TypeScript/Node.js, NestJS/Fastify, PostgreSQL (Supabase is fine) , Jest/Vitest.

_Deliverables_
• Git repo with incremental commits
• README: setup, key architecture decisions, known limitations
• API reference (OpenAPI/Postman/README table)
• Tests: happy path + rejections, partial fill + cancellation, and a concurrency test

_Stretch goals _
WebSocket price streaming, order book UI, rate limiting, GBM price process, short selling w/ margin, full price-time-priority matching across users, admin halt/resume endpoint.

_Submission_
Send back the repo link/zip + README + any trade-offs you want to flag. If anything's ambiguous, state your assumption and move on — we care more about how you handle ambiguity than guessing our exact intent.

Let me know if anything's unclear before you start 🙂
