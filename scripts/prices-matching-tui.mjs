#!/usr/bin/env node
/**
 * OpenStocks TUI: WebSocket price stream + GBM ticks + price-time-priority matching.
 *
 * Standalone (default / --demo): in-process Socket.IO /prices hop, GBM advances,
 * multi-user PTP book demo, prints dashboard, exits after N ticks.
 *
 * Remote: node scripts/prices-matching-tui.mjs --url http://host:port
 *
 * Usage:
 *   node scripts/prices-matching-tui.mjs [--demo] [--ticks N] [--url baseUrl]
 */

import { createServer } from "node:http";
import { Server } from "socket.io";
import { io as ioClient } from "socket.io-client";
import { GBM, gbmNextPrice, sampleNormal } from "./lib/gbm.mjs";
import { createBook, placeOrder, bookSnapshot, restingBook } from "./lib/ptp-book.mjs";

const ASSETS = [
  { symbol: "vSOL", name: "Solace AI", price: 420.0 },
  { symbol: "vATL", name: "Atlas Robotics", price: 95.5 },
  { symbol: "vHLX", name: "Helix Biotech", price: 180.25 },
  { symbol: "vVAN", name: "Vantage Defense", price: 310.1 },
];

const DEMO_SYMBOL = "vHLX";

function parseArgs(argv) {
  const out = {
    demo: true,
    ticks: 5,
    url: null,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--demo") out.demo = true;
    else if (a === "--live") out.demo = false;
    else if (a === "--ticks") out.ticks = Math.max(1, Number(argv[++i]) || 5);
    else if (a === "--url") out.url = argv[++i];
    else if (!a.startsWith("-") && !out.url) out.url = a;
  }
  // Explicit remote URL without --live still attaches remotely after local demo unless --live-only
  if (out.url && argv.includes("--live")) out.demo = false;
  return out;
}

function color(code, text) {
  return `\x1b[${code}m${text}\x1b[0m`;
}

function fmt(n, digits = 2) {
  return Number(n).toFixed(digits);
}

function arrow(curr, prev) {
  if (prev === undefined || curr === prev) return " ";
  return curr > prev ? "↑" : "↓";
}

/**
 * @param {{
 *   mode: string,
 *   connected: boolean,
 *   streamLabel: string,
 *   lastEventAt: string|null,
 *   prices: Map<string, {name:string, price:number, prevPrice?:number, updatedAt:string, ticks:number}>,
 *   book: ReturnType<typeof createBook>|null,
 *   symbol: string,
 *   scenarioLines: string[],
 *   tickCount: number,
 *   maxTicks: number
 * }} state
 */
function render(state) {
  const lines = [];
  lines.push(color("1", "OpenStocks — GBM Prices + Price-Time-Priority Matching (TUI)"));
  lines.push(
    color(
      "2",
      `Mode: ${state.mode}   Stream: ${state.streamLabel}   Status: ${
        state.connected ? color("32", "CONNECTED") : color("31", "DISCONNECTED")
      }   Last tick: ${state.lastEventAt ?? "-"}`
    )
  );
  lines.push(
    color(
      "2",
      `GBM: μ=${GBM.MU} σ=${GBM.SIGMA} Δt=${GBM.DT}   Ticks: ${state.tickCount}/${state.maxTicks}`
    )
  );
  lines.push("");
  lines.push(
    "SYMBOL".padEnd(8) +
      "NAME".padEnd(18) +
      "PRICE".padStart(12) +
      "  " +
      "CHANGE".padStart(9) +
      "  UPDATED"
  );
  lines.push("-".repeat(72));

  const rows = [...state.prices.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [symbol, s] of rows) {
    const dir = arrow(s.price, s.prevPrice);
    const dirColor = dir === "↑" ? "32" : dir === "↓" ? "31" : "0";
    const change =
      s.prevPrice !== undefined
        ? (((s.price - s.prevPrice) / s.prevPrice) * 100).toFixed(2) + "%"
        : "-";
    lines.push(
      symbol.padEnd(8) +
        s.name.padEnd(18) +
        color(dirColor, `${dir} ${fmt(s.price, 4)}`.padStart(12)) +
        "  " +
        change.padStart(9) +
        "  " +
        s.updatedAt
    );
  }

  if (state.book) {
    const snap = bookSnapshot(state.book, state.symbol);
    lines.push("");
    lines.push(color("1", `Order book — ${state.symbol} (price-time priority)`));
    lines.push(
      "SIDE".padEnd(6) +
        "USER".padEnd(12) +
        "PRICE".padStart(10) +
        "QTY".padStart(8) +
        "FILLED".padStart(8) +
        "  STATUS".padEnd(18) +
        "ORDER"
    );
    lines.push("-".repeat(72));
    for (const o of snap.asks) {
      lines.push(
        "ASK".padEnd(6) +
          o.userId.padEnd(12) +
          fmt(o.limitPrice, 2).padStart(10) +
          String(o.quantity).padStart(8) +
          String(o.filledQuantity).padStart(8) +
          `  ${o.status}`.padEnd(18) +
          o.id
      );
    }
    for (const o of snap.bids) {
      lines.push(
        "BID".padEnd(6) +
          o.userId.padEnd(12) +
          fmt(o.limitPrice, 2).padStart(10) +
          String(o.quantity).padStart(8) +
          String(o.filledQuantity).padStart(8) +
          `  ${o.status}`.padEnd(18) +
          o.id
      );
    }
    if (snap.asks.length === 0 && snap.bids.length === 0) {
      lines.push(color("2", "(no resting orders)"));
    }

    lines.push("");
    lines.push(color("1", "Fills (maker limit price)"));
    lines.push(
      "PRICE".padStart(10) +
        "QTY".padStart(8) +
        "  MAKER".padEnd(14) +
        "TAKER".padEnd(12) +
        "  MAKER_OID".padEnd(12) +
        "TAKER_OID"
    );
    lines.push("-".repeat(72));
    for (const f of snap.fills) {
      lines.push(
        fmt(f.price, 2).padStart(10) +
          String(f.quantity).padStart(8) +
          `  ${f.makerUserId}`.padEnd(14) +
          f.takerUserId.padEnd(12) +
          `  ${f.makerOrderId}`.padEnd(14) +
          f.takerOrderId
      );
    }
    if (snap.fills.length === 0) {
      lines.push(color("2", "(no fills yet)"));
    }
  }

  if (state.scenarioLines.length) {
    lines.push("");
    lines.push(color("1", "Matching scenario"));
    for (const L of state.scenarioLines) lines.push(`  ${L}`);
  }

  lines.push("");
  lines.push(
    color(
      "2",
      state.mode.includes("demo")
        ? "Finite demo — exiting after ticks / scenario"
        : "Ctrl+C to exit"
    )
  );

  // Clear + home for redraw (still readable if piped: ANSI ignored by most log captures)
  process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write(lines.join("\n") + "\n");
}

function seedPrices() {
  const prices = new Map();
  const now = new Date().toISOString();
  for (const a of ASSETS) {
    prices.set(a.symbol, {
      name: a.name,
      price: a.price,
      updatedAt: now,
      ticks: 0,
    });
  }
  return prices;
}

/**
 * Run multi-user PTP scenario on DEMO_SYMBOL and return narrative lines.
 * @param {ReturnType<typeof createBook>} book
 */
function runMatchingScenario(book) {
  const lines = [];
  // Price priority: worse ask first (maker-a @ 190), then better ask (maker-b @ 185)
  const worse = placeOrder(book, {
    id: "ask-worse",
    userId: "maker-a",
    symbol: DEMO_SYMBOL,
    side: "sell",
    type: "limit",
    quantity: 5,
    limitPrice: 190,
    createdAt: "2026-03-01T10:00:00.000Z",
  });
  const better = placeOrder(book, {
    id: "ask-better",
    userId: "maker-b",
    symbol: DEMO_SYMBOL,
    side: "sell",
    type: "limit",
    quantity: 5,
    limitPrice: 185,
    createdAt: "2026-03-01T10:00:01.000Z",
  });
  lines.push(
    `Resting asks: ${worse.userId}@${worse.limitPrice} (${worse.id}), ${better.userId}@${better.limitPrice} (${better.id})`
  );

  const takeBest = placeOrder(book, {
    id: "take-best",
    userId: "taker",
    symbol: DEMO_SYMBOL,
    side: "buy",
    type: "limit",
    quantity: 5,
    limitPrice: 200,
    createdAt: "2026-03-01T10:00:02.000Z",
  });
  lines.push(
    `Price priority: taker buy 5 @200 → filled ${takeBest.filledQuantity} @ maker limit 185 (better ask before worse)`
  );

  // Time priority at equal price on vATL
  const early = placeOrder(book, {
    id: "ask-early",
    userId: "early",
    symbol: "vATL",
    side: "sell",
    type: "limit",
    quantity: 4,
    limitPrice: 100,
    createdAt: "2026-03-02T10:00:00.000Z",
  });
  const late = placeOrder(book, {
    id: "ask-late",
    userId: "late",
    symbol: "vATL",
    side: "sell",
    type: "limit",
    quantity: 4,
    limitPrice: 100,
    createdAt: "2026-03-02T10:00:05.000Z",
  });
  const takeTime = placeOrder(book, {
    id: "take-time",
    userId: "time-taker",
    symbol: "vATL",
    side: "buy",
    type: "market",
    quantity: 4,
    createdAt: "2026-03-02T10:00:06.000Z",
  });
  lines.push(
    `Time priority (vATL @100): early=${early.status} late=${late.status}; taker filled ${takeTime.filledQuantity} @ maker 100 (FIFO)`
  );

  // Partial across users on vVAN
  placeOrder(book, {
    id: "ask-3",
    userId: "m1",
    symbol: "vVAN",
    side: "sell",
    type: "limit",
    quantity: 3,
    limitPrice: 300,
    createdAt: "2026-03-03T10:00:00.000Z",
  });
  placeOrder(book, {
    id: "ask-5",
    userId: "m2",
    symbol: "vVAN",
    side: "sell",
    type: "limit",
    quantity: 5,
    limitPrice: 305,
    createdAt: "2026-03-03T10:00:01.000Z",
  });
  const take6 = placeOrder(book, {
    id: "take-6",
    userId: "big-taker",
    symbol: "vVAN",
    side: "buy",
    type: "limit",
    quantity: 6,
    limitPrice: 310,
    createdAt: "2026-03-03T10:00:02.000Z",
  });
  const vanFills = book.fills.filter((f) => f.takerOrderId === "take-6");
  lines.push(
    `Partial multi-user (vVAN): taker filled ${take6.filledQuantity}; fills=${vanFills
      .map((f) => `${f.quantity}@${f.price}(maker ${f.makerUserId})`)
      .join(", ")}`
  );

  return lines;
}

async function listenEphemeral() {
  const httpServer = createServer();
  const io = new Server(httpServer, {
    path: "/socket.io",
    cors: { origin: "*" },
  });
  const nsp = io.of("/prices");

  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = httpServer.address();
  return { httpServer, io, nsp, port };
}

async function runDemo(ticks) {
  const { httpServer, io, nsp, port } = await listenEphemeral();
  const base = `http://127.0.0.1:${port}`;
  const book = createBook();
  const scenarioLines = runMatchingScenario(book);

  const ui = {
    mode: "standalone-demo (in-process WS)",
    connected: false,
    streamLabel: `${base}/prices`,
    lastEventAt: null,
    prices: seedPrices(),
    book,
    symbol: DEMO_SYMBOL,
    scenarioLines,
    tickCount: 0,
    maxTicks: ticks,
  };

  // Emit seed snapshot to any subscriber
  nsp.on("connection", (socket) => {
    for (const [symbol, s] of ui.prices) {
      socket.emit("price", {
        symbol,
        name: s.name,
        price: s.price,
        updatedAt: s.updatedAt,
      });
    }
  });

  const socket = ioClient(`${base}/prices`, {
    transports: ["websocket"],
    reconnection: false,
  });

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("WS connect timeout")), 5000);
    socket.on("connect", () => {
      clearTimeout(t);
      ui.connected = true;
      resolve();
    });
    socket.on("connect_error", (err) => {
      clearTimeout(t);
      reject(err);
    });
  });

  socket.on("price", (msg) => {
    const prev = ui.prices.get(msg.symbol);
    ui.prices.set(msg.symbol, {
      name: msg.name,
      price: msg.price,
      prevPrice: prev?.price,
      updatedAt: msg.updatedAt,
      ticks: (prev?.ticks ?? 0) + 1,
    });
    ui.lastEventAt = new Date().toLocaleTimeString();
    render(ui);
  });

  render(ui);

  // Advance GBM and broadcast over the real WS hop
  for (let i = 0; i < ticks; i++) {
    await new Promise((r) => setTimeout(r, 40));
    const now = new Date().toISOString();
    for (const [symbol, s] of ui.prices) {
      const Z = sampleNormal();
      const next = gbmNextPrice(s.price, Z);
      // Server pushes; client handler updates UI (real WS path)
      nsp.emit("price", {
        symbol,
        name: s.name,
        price: next,
        updatedAt: now,
        z: Z,
      });
    }
    ui.tickCount = i + 1;
  }

  // Final redraw ensuring book/fills visible after last tick
  await new Promise((r) => setTimeout(r, 80));
  render(ui);

  // Also print a plain summary block (survives clear-screen in logs)
  const asks = restingBook(book, DEMO_SYMBOL, "sell");
  process.stdout.write("\n--- demo summary ---\n");
  process.stdout.write(`stream: ${ui.streamLabel} connected=${ui.connected}\n`);
  process.stdout.write(
    `prices: ${[...ui.prices.entries()]
      .map(([sym, s]) => `${sym}=${s.price}`)
      .join(" ")}\n`
  );
  process.stdout.write(
    `book ${DEMO_SYMBOL} resting asks: ${asks
      .map((o) => `${o.userId}@${o.limitPrice}(${o.status})`)
      .join(", ") || "(none)"}\n`
  );
  process.stdout.write(
    `fills: ${book.fills
      .map(
        (f) =>
          `${f.quantity}@${f.price} maker=${f.makerUserId} taker=${f.takerUserId}`
      )
      .join("; ")}\n`
  );
  for (const L of scenarioLines) process.stdout.write(`scenario: ${L}\n`);
  process.stdout.write("--- end demo ---\n");

  socket.close();
  await new Promise((resolve) => io.close(() => resolve()));
  await new Promise((resolve) => httpServer.close(() => resolve()));
}

async function runLive(url, maxTicks) {
  const base = url.replace(/\/$/, "");
  const ui = {
    mode: "live remote /prices",
    connected: false,
    streamLabel: `${base}/prices`,
    lastEventAt: null,
    prices: new Map(),
    book: null,
    symbol: DEMO_SYMBOL,
    scenarioLines: [],
    tickCount: 0,
    maxTicks: maxTicks ?? Infinity,
  };

  const socket = ioClient(`${base}/prices`, {
    transports: ["websocket"],
    reconnection: true,
  });

  socket.on("connect", () => {
    ui.connected = true;
    render(ui);
  });
  socket.on("disconnect", () => {
    ui.connected = false;
    render(ui);
  });
  socket.on("connect_error", (err) => {
    ui.connected = false;
    process.stdout.write(`\nConnection error: ${err.message}\n`);
  });
  socket.on("price", (msg) => {
    const prev = ui.prices.get(msg.symbol);
    ui.prices.set(msg.symbol, {
      name: msg.name,
      price: msg.price,
      prevPrice: prev?.price,
      updatedAt: msg.updatedAt,
      ticks: (prev?.ticks ?? 0) + 1,
    });
    ui.lastEventAt = new Date().toLocaleTimeString();
    ui.tickCount += 1;
    render(ui);
    if (Number.isFinite(ui.maxTicks) && ui.tickCount >= ui.maxTicks) {
      socket.close();
      process.exit(0);
    }
  });

  render(ui);
  process.on("SIGINT", () => {
    socket.close();
    process.stdout.write("\n");
    process.exit(0);
  });
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(
      `Usage: node scripts/prices-matching-tui.mjs [--demo] [--ticks N] [--live --url URL]\n`
    );
    process.exit(0);
  }

  if (args.demo || !args.url) {
    await runDemo(args.ticks);
    return;
  }
  await runLive(args.url, args.ticks);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
