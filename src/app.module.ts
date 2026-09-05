import { DynamicModule, Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import type pg from "pg";
import { DatabaseModule } from "./database/database.module.js";
import { HealthModule } from "./health/health.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { MarketModule } from "./market/market.module.js";
import { TradingModule } from "./trading/trading.module.js";
import { PortfolioModule } from "./portfolio/portfolio.module.js";
import { HttpErrorFilter } from "./common/http-error.filter.js";
import { env } from "./env.js";

export interface AppModuleOptions {
  databaseUrl?: string;
  pool?: pg.Pool;
  throttleTtlMs?: number;
  throttleLimit?: number;
}

@Module({})
export class AppModule {
  static forRoot(opts: AppModuleOptions = {}): DynamicModule {
    const ttl = opts.throttleTtlMs ?? env.THROTTLE_TTL_MS;
    const limit = opts.throttleLimit ?? env.THROTTLE_LIMIT;

    return {
      module: AppModule,
      imports: [
        ThrottlerModule.forRoot([
          {
            name: "default",
            ttl,
            limit,
            generateKey: (_context, tracker, throttlerName) =>
              `global:${throttlerName}:${tracker}`,
          },
        ]),
        DatabaseModule.forRoot({
          databaseUrl: opts.databaseUrl,
          pool: opts.pool,
        }),
        HealthModule,
        AuthModule,
        MarketModule,
        TradingModule,
        PortfolioModule,
      ],
      providers: [
        { provide: APP_FILTER, useClass: HttpErrorFilter },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
      ],
    };
  }
}
