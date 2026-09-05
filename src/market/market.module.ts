import { Module } from "@nestjs/common";
import { MarketController } from "./market.controller.js";

@Module({
  controllers: [MarketController],
})
export class MarketModule {}
