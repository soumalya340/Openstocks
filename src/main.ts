import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module.js";
import { env } from "./env.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot(env.DB_PATH)
  );
  app.enableCors();
  app.enableShutdownHooks();

  await app.listen(env.PORT);
  // eslint-disable-next-line no-console
  console.log(`OpenStocks API listening on http://localhost:${env.PORT}`);
  // eslint-disable-next-line no-console
  console.log(`SQLite database: ${env.DB_PATH}`);
}

bootstrap();
