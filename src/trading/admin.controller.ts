import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import type { Db } from "../db.js";
import { DB_CONNECTION } from "../database/database.tokens.js";
import { AuthGuard } from "../auth/auth.guard.js";
import { setPrice } from "../market/index.js";
import { matchOpenLimits } from "./index.js";

@Controller("admin/prices")
@UseGuards(AuthGuard)
export class AdminController {
  constructor(@Inject(DB_CONNECTION) private readonly db: Db) {}

  @Post(":symbol")
  @HttpCode(200)
  setPrice(
    @Param("symbol") symbol: string,
    @Body() body: { price?: unknown; ts?: unknown; fillFraction?: unknown }
  ) {
    try {
      const price = Number(body?.price);
      const now = body?.ts ? String(body.ts) : new Date().toISOString();
      const fraction = body?.fillFraction === undefined ? 1 : Number(body.fillFraction);
      const asset = setPrice(this.db, String(symbol), price, now);
      const filled = matchOpenLimits(this.db, String(symbol), price, now, fraction);
      return { asset, matchedOrders: filled };
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }
}
