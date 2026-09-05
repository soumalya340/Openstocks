import { DynamicModule, Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { DatabaseModule } from "./database/database.module.js";
import { HealthModule } from "./health/health.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { MarketModule } from "./market/market.module.js";
import { TradingModule } from "./trading/trading.module.js";
import { PortfolioModule } from "./portfolio/portfolio.module.js";
import { HttpErrorFilter } from "./common/http-error.filter.js";
import { env } from "./env.js";

export interface AppModuleOptions {
  dbPath?: string;
  throttleTtlMs?: number;
  throttleLimit?: number;
}

@Module({})
export class AppModule {
  static forRoot(dbPathOrOpts?: string | AppModuleOptions): DynamicModule {
    const opts: AppModuleOptions =
      typeof dbPathOrOpts === "string" || dbPathOrOpts === undefined
        ? { dbPath: dbPathOrOpts }
        : dbPathOrOpts;

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
            // Global per-IP budget (not per-route): 1 rpm means 1 request to the whole API.
            generateKey: (_context, tracker, throttlerName) =>
              `global:${throttlerName}:${tracker}`,
          },
        ]),
        DatabaseModule.forRoot(opts.dbPath),
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
