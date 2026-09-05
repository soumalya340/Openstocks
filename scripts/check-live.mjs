#!/usr/bin/env node
/**
 * Live connectivity checker for the OpenStocks Render deployment.
 * Hits every shipped HTTP route and console.logs method/path/status/body (or error).
 *
 * Usage:
 *   yarn check:live
 *   BASE_URL=https://openstocks-2r66.onrender.com yarn check:live
 */

export const DEFAULT_BASE_URL = "https://openstocks-2r66.onrender.com";

const TIMEOUT_MS = Number(process.env.CHECK_TIMEOUT_MS ?? 45_000);

/** @typedef {{ method: string, path: string, status: number | null, body: unknown, error?: string }} CheckResult */

/**
 * @param {string} baseUrl
 * @param {string} method
 * @param {string} path
 * @param {RequestInit & { json?: unknown }} [init]
 * @returns {Promise<CheckResult>}
 */
export async function checkConnection(baseUrl, method, path, init = {}) {
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  const headers = new Headers(init.headers ?? {});
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : body,
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed;
    try {
      parsed = text.length ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    const result = {
      method,
      path,
      status: res.status,
      body: parsed,
    };
    console.log(JSON.stringify(result));
    return result;
  } catch (err) {
    const result = {
      method,
      path,
      status: null,
      body: null,
      error: err instanceof Error ? err.message : String(err),
    };
    console.log(JSON.stringify(result));
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Exercise every shipped API connection against baseUrl.
 * @param {string} [baseUrl]
 * @returns {Promise<{ results: CheckResult[], hardFailures: number }>}
 */
export async function runLiveChecks(baseUrl = DEFAULT_BASE_URL) {
  console.log(
    JSON.stringify({
      event: "live-check-start",
      baseUrl,
      timeoutMs: TIMEOUT_MS,
    })
  );

  /** @type {CheckResult[]} */
  const results = [];

  const record = async (method, path, init) => {
    const r = await checkConnection(baseUrl, method, path, init);
    results.push(r);
    return r;
  };

  // Public routes
  await record("GET", "/health");
  const auth = await record("POST", "/auth/token", {
    json: { username: `live-check-${Date.now()}` },
  });
  await record("GET", "/assets");
  await record("GET", "/assets/vSOL");
  await record("POST", "/calculator", {
    json: { symbol: "vSOL", usdAmount: 840 },
  });

  const token =
    auth &&
    auth.status &&
    auth.status < 400 &&
    auth.body &&
    typeof auth.body === "object" &&
    auth.body !== null &&
    "token" in auth.body
      ? String(/** @type {{ token: string }} */ (auth.body).token)
      : null;

  const authHeaders = token
    ? { Authorization: `Bearer ${token}` }
    : {};

  if (!token) {
    console.log(
      JSON.stringify({
        event: "auth-token-missing",
        note: "Authenticated routes will still be attempted and logged",
      })
    );
  }

  // Authenticated: place a resting limit order so DELETE has a real id when possible
  const idemKey = `live-check-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const orderRes = await record("POST", "/orders", {
    headers: {
      ...authHeaders,
      "Idempotency-Key": idemKey,
    },
    json: {
      symbol: "vSOL",
      side: "buy",
      type: "limit",
      quantity: 1,
      limitPrice: 1,
    },
  });

  await record("GET", "/portfolio", { headers: authHeaders });

  const at = encodeURIComponent(new Date().toISOString());
  await record("GET", `/portfolio/history?at=${at}`, { headers: authHeaders });

  const orderId =
    orderRes &&
    orderRes.body &&
    typeof orderRes.body === "object" &&
    orderRes.body !== null &&
    "order" in orderRes.body &&
    /** @type {{ order?: { id?: string } }} */ (orderRes.body).order?.id
      ? String(/** @type {{ order: { id: string } }} */ (orderRes.body).order.id)
      : "00000000-0000-0000-0000-000000000000";

  await record("DELETE", `/orders/${orderId}`, { headers: authHeaders });

  await record("POST", "/admin/prices/vSOL", {
    headers: authHeaders,
    json: { price: 420, fillFraction: 0 },
  });

  const hardFailures = results.filter((r) => r.status === null).length;

  console.log(
    JSON.stringify({
      event: "live-check-done",
      baseUrl,
      attempted: results.length,
      hardFailures,
      endpoints: results.map((r) => `${r.method} ${r.path}`),
    })
  );

  return { results, hardFailures };
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("check-live.mjs") ||
    process.argv[1].includes("check-live"));

if (isMain) {
  const baseUrl = process.env.BASE_URL ?? DEFAULT_BASE_URL;
  const { hardFailures } = await runLiveChecks(baseUrl);
  // Non-zero only when a connection could not be completed (network/timeout/crash).
  // Application HTTP errors (4xx/5xx) are logged and still count as attempted.
  process.exit(hardFailures > 0 ? 1 : 0);
}
