import { Inject, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import type { Server } from "socket.io";
import { onPriceUpdate, tickPrices } from "./index.js";
import { DB_CONNECTION } from "../database/database.tokens.js";
import type { Db } from "../db.js";
import type { Asset } from "../types.js";

const TICK_INTERVAL_MS = 2000;

@WebSocketGateway({
  cors: { origin: "*" },
  namespace: "/prices",
})
export class PricesGateway implements OnModuleInit, OnModuleDestroy {
  @WebSocketServer()
  server!: Server;

  private unsubscribe: (() => void) | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  constructor(@Inject(DB_CONNECTION) private readonly db: Db) {}

  onModuleInit(): void {
    this.unsubscribe = onPriceUpdate((asset: Asset) => {
      this.server?.emit("price", {
        symbol: asset.symbol,
        price: asset.price,
        name: asset.name,
        updatedAt: asset.updatedAt,
      });
    });

    this.tickTimer = setInterval(() => {
      tickPrices(this.db).catch((err) => {
        console.error("GBM price tick failed:", err);
      });
    }, TICK_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }
}
