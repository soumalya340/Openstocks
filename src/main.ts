import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module.js";
import { describeDatabase, env } from "./env.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot({
      dbPath: env.DB_PATH,
      databaseUrl: env.DATABASE_URL,
    })
  );
  app.enableCors();
  app.enableShutdownHooks();

  await app.listen(env.PORT);
  // eslint-disable-next-line no-console
  console.log(`OpenStocks API listening on http://localhost:${env.PORT}`);
  // eslint-disable-next-line no-console
  console.log(`Database: ${describeDatabase()}`);
}

bootstrap();
