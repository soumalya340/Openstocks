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
import { CurrentUser } from "../auth/current-user.decorator.js";
import type { AuthUser } from "../auth/auth.types.js";
import {
  haltTrading,
  resumeTrading,
  setPrice,
} from "../market/index.js";
import { matchOpenLimits } from "./index.js";

@Controller("admin")
@UseGuards(AuthGuard)
export class AdminController {
  constructor(@Inject(DB_CONNECTION) private readonly db: Db) {}

  @Post("prices/:symbol")
  @HttpCode(200)
  async setPrice(
    @Param("symbol") symbol: string,
    @Body() body: { price?: unknown; ts?: unknown; fillFraction?: unknown }
  ) {
    try {
      const price = Number(body?.price);
      const now = body?.ts ? String(body.ts) : new Date().toISOString();
      const asset = await setPrice(this.db, String(symbol), price, now);
      // Match resting book under price-time priority (fillFraction ignored).
      const filled = await matchOpenLimits(this.db, String(symbol), price, now);
      return { asset, matchedOrders: filled };
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  @Post("halt/:symbol")
  @HttpCode(200)
  async halt(
    @Param("symbol") symbol: string,
    @CurrentUser() user: AuthUser,
    @Body() body: { ts?: unknown }
  ) {
    try {
      const now = body?.ts ? String(body.ts) : new Date().toISOString();
      await haltTrading(this.db, String(symbol), now, user.userId);
      return { symbol: String(symbol), halted: true, at: now };
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  @Post("resume/:symbol")
  @HttpCode(200)
  async resume(
    @Param("symbol") symbol: string,
    @Body() body: { ts?: unknown }
  ) {
    try {
      const now = body?.ts ? String(body.ts) : new Date().toISOString();
      await resumeTrading(this.db, String(symbol), now);
      return { symbol: String(symbol), halted: false, at: now };
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }
}
