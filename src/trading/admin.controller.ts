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
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
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

@ApiTags("admin")
@ApiBearerAuth()
@Controller("admin")
@UseGuards(AuthGuard)
export class AdminController {
  constructor(@Inject(DB_CONNECTION) private readonly db: Db) {}

  @Post("prices/:symbol")
  @HttpCode(200)
  @ApiOperation({ summary: "Set a symbol's mark price and match the resting book" })
  @ApiParam({ name: "symbol", example: "vSOL" })
  @ApiBody({
    schema: {
      type: "object",
      required: ["price"],
      properties: {
        price: { type: "number", example: 425.5 },
        ts: { type: "string", format: "date-time", nullable: true },
      },
    },
  })
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
  @ApiOperation({ summary: "Manually halt trading on a symbol" })
  @ApiParam({ name: "symbol", example: "vSOL" })
  @ApiBody({
    required: false,
    schema: { type: "object", properties: { ts: { type: "string", format: "date-time" } } },
  })
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
  @ApiOperation({ summary: "Resume trading on a symbol after a manual halt" })
  @ApiParam({ name: "symbol", example: "vSOL" })
  @ApiBody({
    required: false,
    schema: { type: "object", properties: { ts: { type: "string", format: "date-time" } } },
  })
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
