import { BadRequestException, Controller, Get, Inject, Query, UseGuards } from "@nestjs/common";
import type { Db } from "../db.js";
import { DB_CONNECTION } from "../database/database.tokens.js";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentUser } from "../auth/current-user.decorator.js";
import type { AuthUser } from "../auth/auth.types.js";
import { getPortfolio, getPortfolioAt } from "./index.js";

@Controller("portfolio")
@UseGuards(AuthGuard)
export class PortfolioController {
  constructor(@Inject(DB_CONNECTION) private readonly db: Db) {}

  @Get()
  getPortfolio(@CurrentUser() user: AuthUser) {
    const portfolio = getPortfolio(this.db, user.userId);
    return { portfolio };
  }

  @Get("history")
  getHistory(@CurrentUser() user: AuthUser, @Query("at") at?: string) {
    const atValue = String(at ?? "");
    if (!atValue) {
      throw new BadRequestException("Query param 'at' (ISO timestamp) is required");
    }
    try {
      const portfolio = getPortfolioAt(this.db, user.userId, atValue);
      return { portfolio, reconstructedFrom: "ledger" };
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }
}
