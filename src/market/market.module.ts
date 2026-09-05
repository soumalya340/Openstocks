import { Module } from "@nestjs/common";
import { MarketController } from "./market.controller.js";
import { PricesGateway } from "./prices.gateway.js";

@Module({
  controllers: [MarketController],
  providers: [PricesGateway],
})
export class MarketModule {}
