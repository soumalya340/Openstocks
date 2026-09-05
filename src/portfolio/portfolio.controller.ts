import { BadRequestException, Controller, Get, Inject, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import type { Db } from "../db.js";
import { DB_CONNECTION } from "../database/database.tokens.js";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentUser } from "../auth/current-user.decorator.js";
import type { AuthUser } from "../auth/auth.types.js";
import { getPortfolio, getPortfolioAt } from "./index.js";

@ApiTags("portfolio")
@ApiBearerAuth()
@Controller("portfolio")
@UseGuards(AuthGuard)
export class PortfolioController {
  constructor(@Inject(DB_CONNECTION) private readonly db: Db) {}

  @Get()
  @ApiOperation({ summary: "Current portfolio: holdings, cost basis, P&L" })
  async getPortfolio(@CurrentUser() user: AuthUser) {
    const portfolio = await getPortfolio(this.db, user.userId);
    return { portfolio };
  }

  @Get("history")
  @ApiOperation({ summary: "Reconstruct the portfolio as of a past timestamp via ledger replay" })
  @ApiQuery({ name: "at", description: "ISO 8601 timestamp", example: "2026-06-01T12:00:00.000Z" })
  async getHistory(@CurrentUser() user: AuthUser, @Query("at") at?: string) {
    const atValue = String(at ?? "");
    if (!atValue) {
      throw new BadRequestException("Query param 'at' (ISO timestamp) is required");
    }
    try {
      const portfolio = await getPortfolioAt(this.db, user.userId, atValue);
      return { portfolio, reconstructedFrom: "ledger" };
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }
}
