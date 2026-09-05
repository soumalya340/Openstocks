import { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import type { Server } from "socket.io";
import { onPriceUpdate } from "./index.js";
import type { Asset } from "../types.js";

@WebSocketGateway({
  cors: { origin: "*" },
  namespace: "/prices",
})
export class PricesGateway implements OnModuleInit, OnModuleDestroy {
  @WebSocketServer()
  server!: Server;

  private unsubscribe: (() => void) | null = null;

  onModuleInit(): void {
    this.unsubscribe = onPriceUpdate((asset: Asset) => {
      this.server?.emit("price", {
        symbol: asset.symbol,
        price: asset.price,
        name: asset.name,
        updatedAt: asset.updatedAt,
      });
    });
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
