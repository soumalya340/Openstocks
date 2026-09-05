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
import { ApiBody, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import type { Db } from "../db.js";
import { DB_CONNECTION } from "../database/database.tokens.js";
import { calculateShares, getAsset, getPriceHistory, listAssets } from "./index.js";

@ApiTags("market")
@Controller()
export class MarketController {
  constructor(@Inject(DB_CONNECTION) private readonly db: Db) {}

  @Get("assets")
  @ApiOperation({ summary: "List all simulated assets with price history" })
  async listAssets() {
    const listed = await listAssets(this.db);
    const assets = await Promise.all(
      listed.map(async (a) => ({
        ...a,
        history: await getPriceHistory(this.db, a.symbol),
      }))
    );
    return { assets };
  }

  @Get("assets/:symbol")
  @ApiOperation({ summary: "Get one asset's detail and price history" })
  @ApiParam({ name: "symbol", example: "vSOL" })
  async getAsset(@Param("symbol") symbol: string) {
    const asset = await getAsset(this.db, String(symbol));
    if (!asset) {
      throw new NotFoundException("Asset not found");
    }
    return {
      asset,
      history: await getPriceHistory(this.db, asset.symbol),
    };
  }

  @Post("calculator")
  @HttpCode(200)
  @ApiOperation({ summary: "Convert a USD amount to shares (no side effects)" })
  @ApiBody({
    schema: {
      type: "object",
      required: ["symbol", "usdAmount"],
      properties: {
        symbol: { type: "string", example: "vSOL" },
        usdAmount: { type: "number", example: 840 },
      },
    },
  })
  async calculate(@Body() body: { symbol?: unknown; usdAmount?: unknown }) {
    const symbol = String(body?.symbol ?? "");
    const usdAmount = Number(body?.usdAmount);
    const beforeCash = (await this.db
      .prepare(`SELECT COALESCE(SUM(cash), 0) AS s FROM users`)
      .get()) as { s: number };
    const result = await calculateShares(this.db, symbol, usdAmount);
    const afterCash = (await this.db
      .prepare(`SELECT COALESCE(SUM(cash), 0) AS s FROM users`)
      .get()) as { s: number };
    if (beforeCash.s !== afterCash.s) {
      throw new InternalServerErrorException("Calculator must not mutate balances");
    }
    if ("error" in result) {
      throw new BadRequestException(result.error);
    }
    return result;
  }
}
