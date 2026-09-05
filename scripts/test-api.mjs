#!/usr/bin/env node
/**
 * End-to-end smoke test for the OpenStocks API.
 * Exercises every route: market data, calculator, auth, trading (market/limit orders,
 * idempotency, cancel, circuit breaker), admin (price/halt/resume), and portfolio
 * (current + historical reconstruction).
 *
 * Usage: node scripts/test-api.mjs [baseUrl]
 * Default baseUrl: http://62.72.58.104:3004
 */

const BASE_URL = process.argv[2] || "http://62.72.58.104:3004";
const SYMBOLS = ["vSOL", "vATL", "vHLX", "vVAN"];

let step = 0;

function header(title) {
  step += 1;
  console.log(`\n${"=".repeat(70)}`);
  console.log(`STEP ${step}: ${title}`);
  console.log("=".repeat(70));
}

async function call(method, path, { body, token, headers = {}, expectFail = false } = {}) {
  const url = `${BASE_URL}${path}`;
  const reqHeaders = { "Content-Type": "application/json", ...headers };
  if (token) reqHeaders["Authorization"] = `Bearer ${token}`;

  const res = await fetch(url, {
    method,
    headers: reqHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let data;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  const tag = expectFail ? (res.ok ? "UNEXPECTED OK" : "EXPECTED FAIL") : res.ok ? "OK" : "FAIL";
  console.log(`\n[${tag}] ${method} ${path} -> ${res.status}`);
  console.log(JSON.stringify(data, null, 2));

  return { status: res.status, ok: res.ok, data };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomKey() {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function main() {
  console.log(`Testing OpenStocks API at ${BASE_URL}`);
  const username = `tester_${Date.now()}`;

  // ---------------------------------------------------------------------
  header("Health check");
  await call("GET", "/health");

  // ---------------------------------------------------------------------
  header("Auth: issue JWT for a new user");
  const authRes = await call("POST", "/auth/token", { body: { username } });
  const token = authRes.data?.token;
  if (!token) {
    console.error("\nFATAL: could not obtain auth token, aborting.");
    process.exit(1);
  }
  console.log(`\n-> Using token for user "${username}"`);

  // Second call with same username should reuse same user (idempotent user creation)
  header("Auth: re-request token for same username (should reuse user)");
  const authRes2 = await call("POST", "/auth/token", { body: { username } });
  console.log(`\n-> userId matches: ${authRes2.data?.userId === authRes.data?.userId}`);

  header("Auth: missing username should fail");
  await call("POST", "/auth/token", { body: {}, expectFail: true });

  // ---------------------------------------------------------------------
  header("Market data: list all assets");
  const assetsRes = await call("GET", "/assets");
  console.log(`\n-> Found ${assetsRes.data?.assets?.length ?? 0} assets`);

  header("Market data: get single asset (vSOL)");
  await call("GET", "/assets/vSOL");

  header("Market data: get unknown asset (should 404)");
  await call("GET", "/assets/NOPE", { expectFail: true });

  // ---------------------------------------------------------------------
  header("Calculator: USD amount -> shares (no side effects)");
  await call("POST", "/calculator", { body: { symbol: "vSOL", usdAmount: 840 } });

  header("Calculator: invalid symbol should fail");
  await call("POST", "/calculator", { body: { symbol: "NOPE", usdAmount: 100 }, expectFail: true });

  // ---------------------------------------------------------------------
  header("Trading: place order without Idempotency-Key (should fail)");
  await call("POST", "/orders", {
    token,
    body: { symbol: "vSOL", side: "buy", type: "market", quantity: 1 },
    expectFail: true,
  });

  header("Trading: place order without auth token (should fail)");
  await call("POST", "/orders", {
    headers: { "Idempotency-Key": randomKey() },
    body: { symbol: "vSOL", side: "buy", type: "market", quantity: 1 },
    expectFail: true,
  });

  header("Trading: place market BUY order (vATL)");
  const buyKey = randomKey();
  const marketBuy = await call("POST", "/orders", {
    token,
    headers: { "Idempotency-Key": buyKey },
    body: { symbol: "vATL", side: "buy", type: "market", quantity: 5 },
  });
  const marketBuyOrderId = marketBuy.data?.order?.id;

  header("Trading: retry same order with same Idempotency-Key (should return cached, not double-fill)");
  await call("POST", "/orders", {
    token,
    headers: { "Idempotency-Key": buyKey },
    body: { symbol: "vATL", side: "buy", type: "market", quantity: 5 },
  });

  header("Trading: place resting LIMIT BUY order (vHLX, below market so it rests)");
  const limitKey = randomKey();
  const limitBuy = await call("POST", "/orders", {
    token,
    headers: { "Idempotency-Key": limitKey },
    body: { symbol: "vHLX", side: "buy", type: "limit", quantity: 3, limitPrice: 100 },
  });
  const limitOrderId = limitBuy.data?.order?.id;

  header("Trading: cancel the resting limit order");
  if (limitOrderId) {
    await call("DELETE", `/orders/${limitOrderId}`, { token });
  } else {
    console.log("\n-> Skipped: no resting order id captured");
  }

  header("Trading: cancel unknown order id (should fail)");
  await call("DELETE", "/orders/00000000-0000-0000-0000-000000000000", { token, expectFail: true });

  header("Trading: place limit SELL order without owning shares first (vVAN) - short sell w/ margin");
  await call("POST", "/orders", {
    token,
    headers: { "Idempotency-Key": randomKey() },
    body: { symbol: "vVAN", side: "sell", type: "limit", quantity: 100, limitPrice: 500 },
  });

  // ---------------------------------------------------------------------
  header("Admin: set price for vSOL (triggers matching of resting book)");
  await call("POST", "/admin/prices/vSOL", { token, body: { price: 425.5 } });

  header("Admin: circuit breaker - move price >15% in <60s, then try placing an order");
  const cbSymbol = "vVAN";
  const cbAsset = await call("GET", `/assets/${cbSymbol}`);
  const basePrice = cbAsset.data?.asset?.currentPrice ?? cbAsset.data?.asset?.price ?? 310.1;
  const spikePrice = Number((basePrice * 1.2).toFixed(2));
  console.log(`\n-> Base price ~${basePrice}, spiking to ${spikePrice} (>15% move)`);
  await call("POST", `/admin/prices/${cbSymbol}`, { token, body: { price: spikePrice } });

  header("Trading: order on halted (circuit-broken) symbol should be rejected");
  await call("POST", "/orders", {
    token,
    headers: { "Idempotency-Key": randomKey() },
    body: { symbol: cbSymbol, side: "buy", type: "market", quantity: 1 },
    expectFail: true,
  });

  header("Admin: manual halt on vATL");
  await call("POST", "/admin/halt/vATL", { token, body: {} });

  header("Trading: order on manually halted symbol should be rejected");
  await call("POST", "/orders", {
    token,
    headers: { "Idempotency-Key": randomKey() },
    body: { symbol: "vATL", side: "buy", type: "market", quantity: 1 },
    expectFail: true,
  });

  header("Admin: resume vATL");
  await call("POST", "/admin/resume/vATL", { token, body: {} });

  header("Trading: order on resumed symbol should succeed again");
  await call("POST", "/orders", {
    token,
    headers: { "Idempotency-Key": randomKey() },
    body: { symbol: "vATL", side: "buy", type: "market", quantity: 1 },
  });

  // ---------------------------------------------------------------------
  const beforeHistoryTs = new Date().toISOString();
  await sleep(1000);

  header("Trading: place a couple more orders to build ledger history");
  await call("POST", "/orders", {
    token,
    headers: { "Idempotency-Key": randomKey() },
    body: { symbol: "vHLX", side: "buy", type: "market", quantity: 2 },
  });
  await sleep(500);
  await call("POST", "/orders", {
    token,
    headers: { "Idempotency-Key": randomKey() },
    body: { symbol: "vSOL", side: "buy", type: "market", quantity: 1 },
  });

  // ---------------------------------------------------------------------
  header("Portfolio: current holdings, cost basis, P&L");
  await call("GET", "/portfolio", { token });

  header("Portfolio: historical reconstruction at a past timestamp (before recent trades)");
  await call("GET", `/portfolio/history?at=${encodeURIComponent(beforeHistoryTs)}`, { token });

  header("Portfolio: historical reconstruction right now");
  await call("GET", `/portfolio/history?at=${encodeURIComponent(new Date().toISOString())}`, { token });

  header("Portfolio: missing 'at' query param (should fail)");
  await call("GET", "/portfolio/history", { token, expectFail: true });

  header("Portfolio: without auth (should fail)");
  await call("GET", "/portfolio", { expectFail: true });

  // ---------------------------------------------------------------------
  console.log(`\n${"=".repeat(70)}`);
  console.log(`DONE — ${step} steps executed against ${BASE_URL}`);
  console.log("=".repeat(70));
}

main().catch((err) => {
  console.error("\nSCRIPT ERROR:", err);
  process.exit(1);
});
