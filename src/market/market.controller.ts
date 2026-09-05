import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import type { Db } from "../db.js";
import { DB_CONNECTION } from "../database/database.tokens.js";
import { calculateShares, getAsset, getPriceHistory, listAssets } from "./index.js";

@Controller()
export class MarketController {
  constructor(@Inject(DB_CONNECTION) private readonly db: Db) {}

  @Get("assets")
  listAssets() {
    const assets = listAssets(this.db).map((a) => ({
      ...a,
      history: getPriceHistory(this.db, a.symbol),
    }));
    return { assets };
  }

  @Get("assets/:symbol")
  getAsset(@Param("symbol") symbol: string) {
    const asset = getAsset(this.db, String(symbol));
    if (!asset) {
      throw new NotFoundException("Asset not found");
    }
    return {
      asset,
      history: getPriceHistory(this.db, asset.symbol),
    };
  }

  @Post("calculator")
  @HttpCode(200)
  calculate(@Body() body: { symbol?: unknown; usdAmount?: unknown }) {
    const symbol = String(body?.symbol ?? "");
    const usdAmount = Number(body?.usdAmount);
    const beforeCash = this.db
      .prepare(`SELECT COALESCE(SUM(cash), 0) AS s FROM users`)
      .get() as { s: number };
    const result = calculateShares(this.db, symbol, usdAmount);
    const afterCash = this.db
      .prepare(`SELECT COALESCE(SUM(cash), 0) AS s FROM users`)
      .get() as { s: number };
    if (beforeCash.s !== afterCash.s) {
      throw new InternalServerErrorException("Calculator must not mutate balances");
    }
    if ("error" in result) {
      throw new BadRequestException(result.error);
    }
    return result;
  }
}
