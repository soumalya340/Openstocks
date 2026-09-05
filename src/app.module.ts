import { DynamicModule, Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { DatabaseModule } from "./database/database.module.js";
import { HealthModule } from "./health/health.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { MarketModule } from "./market/market.module.js";
import { TradingModule } from "./trading/trading.module.js";
import { PortfolioModule } from "./portfolio/portfolio.module.js";
import { HttpErrorFilter } from "./common/http-error.filter.js";

@Module({})
export class AppModule {
  static forRoot(dbPath?: string): DynamicModule {
    return {
      module: AppModule,
      imports: [
        DatabaseModule.forRoot(dbPath),
        HealthModule,
        AuthModule,
        MarketModule,
        TradingModule,
        PortfolioModule,
      ],
      providers: [{ provide: APP_FILTER, useClass: HttpErrorFilter }],
    };
  }
}
