import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { PortfolioController } from "./portfolio.controller.js";

@Module({
  imports: [AuthModule],
  controllers: [PortfolioController],
})
export class PortfolioModule {}
