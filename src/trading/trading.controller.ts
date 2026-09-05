import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import type { Db } from "../db.js";
import { DB_CONNECTION } from "../database/database.tokens.js";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentUser } from "../auth/current-user.decorator.js";
import type { AuthUser } from "../auth/auth.types.js";
import { HttpErrorFromResult } from "../common/http-error-from-result.js";
import { cancelOrder, getIdempotentResponse, placeOrder } from "./index.js";

@Controller("orders")
@UseGuards(AuthGuard)
export class TradingController {
  constructor(@Inject(DB_CONNECTION) private readonly db: Db) {}

  @Post()
  @HttpCode(201)
  async placeOrder(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Body()
    body: {
      symbol?: unknown;
      side?: unknown;
      type?: unknown;
      quantity?: unknown;
      limitPrice?: unknown;
    }
  ) {
    const idempotencyKey = req.header("Idempotency-Key")?.trim() ?? "";
    if (!idempotencyKey) {
      throw new BadRequestException("Idempotency-Key header is required");
    }

    const cached = await getIdempotentResponse(this.db, user.userId, idempotencyKey);
    if (cached) {
      return cached.body;
    }

    const result = await placeOrder(this.db, {
      userId: user.userId,
      symbol: String(body?.symbol ?? ""),
      side: body?.side as "buy" | "sell",
      type: body?.type as "market" | "limit",
      quantity: Number(body?.quantity),
      limitPrice:
        body?.limitPrice === undefined || body?.limitPrice === null
          ? null
          : Number(body.limitPrice),
      idempotencyKey,
    });

    if (!result.ok) {
      throw new HttpErrorFromResult(result.statusCode, result.error);
    }

    return { order: result.order };
  }

  @Delete(":id")
  async cancelOrder(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    const result = await cancelOrder(this.db, user.userId, String(id));
    if (!result.ok) {
      throw new HttpErrorFromResult(result.statusCode, result.error);
    }
    return { order: result.order };
  }
}
