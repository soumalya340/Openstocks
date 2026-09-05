import { describe, it, expect, afterEach } from "vitest";
import { io, type Socket } from "socket.io-client";
import type { AddressInfo } from "node:net";
import { createTestApp } from "./helpers.js";
import type { INestApplication } from "@nestjs/common";
import { setPrice } from "../src/market/index.js";
import type { Db } from "../src/db.js";

describe("WebSocket price streaming", () => {
  let nestApp: INestApplication | undefined;
  let db: Db;
  let socket: Socket | undefined;

  afterEach(async () => {
    socket?.disconnect();
    socket = undefined;
    await nestApp?.close();
    nestApp = undefined;
  });

  it("pushes price updates to connected /prices clients when setPrice runs", async () => {
    const ctx = await createTestApp();
    db = ctx.db;
    nestApp = ctx.nestApp;

    await nestApp.listen(0);
    const address = nestApp.getHttpServer().address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/prices`;

    const message = await new Promise<{ symbol: string; price: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for price event")), 5000);
      socket = io(url, { transports: ["websocket"], forceNew: true });
      socket.on("connect_error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      socket.on("connect", () => {
        setPrice(db, "vSOL", 425.5, "2026-01-02T00:00:00.000Z");
      });
      socket.on("price", (payload: { symbol: string; price: number }) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

    expect(message.symbol).toBe("vSOL");
    expect(message.price).toBe(425.5);
  });
});
