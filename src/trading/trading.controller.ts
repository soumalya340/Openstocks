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
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import type { Db } from "../db.js";
import { DB_CONNECTION } from "../database/database.tokens.js";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentUser } from "../auth/current-user.decorator.js";
import type { AuthUser } from "../auth/auth.types.js";
import { HttpErrorFromResult } from "../common/http-error-from-result.js";
import { cancelOrder, getIdempotentResponse, placeOrder } from "./index.js";

@ApiTags("orders")
@ApiBearerAuth()
@Controller("orders")
@UseGuards(AuthGuard)
export class TradingController {
  constructor(@Inject(DB_CONNECTION) private readonly db: Db) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: "Place a market or limit order" })
  @ApiHeader({
    name: "Idempotency-Key",
    description: "Unique key to safely retry without double-placing the order",
    required: true,
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["symbol", "side", "type", "quantity"],
      properties: {
        symbol: { type: "string", example: "vSOL" },
        side: { type: "string", enum: ["buy", "sell"] },
        type: { type: "string", enum: ["market", "limit"] },
        quantity: { type: "number", example: 2 },
        limitPrice: { type: "number", nullable: true, example: 400 },
      },
    },
  })
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
  @ApiOperation({ summary: "Cancel a resting (open/partially filled) order" })
  @ApiParam({ name: "id", description: "Order id" })
  async cancelOrder(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    const result = await cancelOrder(this.db, user.userId, String(id));
    if (!result.ok) {
      throw new HttpErrorFromResult(result.statusCode, result.error);
    }
    return { order: result.order };
  }
}
