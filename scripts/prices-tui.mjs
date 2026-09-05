#!/usr/bin/env node
/**
 * Terminal dashboard for the live GBM price stream over WebSocket (/prices namespace).
 * Usage: node scripts/prices-tui.mjs [baseUrl]
 */

import { io } from "socket.io-client";

const BASE_URL = process.argv[2] || "http://62.72.58.104:3004";

const state = new Map(); // symbol -> { name, price, prevPrice, updatedAt, ticks }
let connected = false;
let lastEventAt = null;

function fmt(n, digits = 2) {
  return Number(n).toFixed(digits);
}

function arrow(curr, prev) {
  if (prev === undefined || curr === prev) return " ";
  return curr > prev ? "↑" : "↓";
}

function color(code, text) {
  return `\x1b[${code}m${text}\x1b[0m`;
}

function render() {
  const rows = [...state.entries()].sort(([a], [b]) => a.localeCompare(b));
  const lines = [];

  lines.push(color("1", "OpenStocks — Live GBM Price Stream (WebSocket /prices)"));
  lines.push(color("2", `Server: ${BASE_URL}   Status: ${connected ? color("32", "CONNECTED") : color("31", "DISCONNECTED")}   Last tick: ${lastEventAt ?? "-"}`));
  lines.push("");
  lines.push(
    "SYMBOL".padEnd(8) +
      "NAME".padEnd(18) +
      "PRICE".padStart(12) +
      "  " +
      "CHANGE".padStart(9) +
      "  UPDATED AT"
  );
  lines.push("-".repeat(70));

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
        color(dirColor, `${dir} ${fmt(s.price)}`.padStart(12)) +
        "  " +
        change.padStart(9) +
        "  " +
        s.updatedAt
    );
  }

  lines.push("");
  lines.push(color("2", `Ticks received: ${[...state.values()].reduce((a, s) => a + s.ticks, 0)}   Ctrl+C to exit`));

  process.stdout.write("\x1b[2J\x1b[H"); // clear screen, move cursor home
  process.stdout.write(lines.join("\n") + "\n");
}

function main() {
  const socket = io(`${BASE_URL}/prices`, {
    transports: ["websocket"],
    reconnection: true,
  });

  socket.on("connect", () => {
    connected = true;
    render();
  });

  socket.on("disconnect", () => {
    connected = false;
    render();
  });

  socket.on("connect_error", (err) => {
    connected = false;
    process.stdout.write(`\nConnection error: ${err.message}\n`);
  });

  socket.on("price", (msg) => {
    const prev = state.get(msg.symbol);
    state.set(msg.symbol, {
      name: msg.name,
      price: msg.price,
      prevPrice: prev?.price,
      updatedAt: msg.updatedAt,
      ticks: (prev?.ticks ?? 0) + 1,
    });
    lastEventAt = new Date().toLocaleTimeString();
    render();
  });

  render();

  process.on("SIGINT", () => {
    socket.close();
    process.stdout.write("\n");
    process.exit(0);
  });
}

main();
