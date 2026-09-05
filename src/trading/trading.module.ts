import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { TradingController } from "./trading.controller.js";
import { AdminController } from "./admin.controller.js";

@Module({
  imports: [AuthModule],
  controllers: [TradingController, AdminController],
})
export class TradingModule {}
