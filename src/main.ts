import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module.js";
import { describeDatabase, env } from "./env.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot({
      databaseUrl: env.DATABASE_URL,
    })
  );
  app.enableCors();
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle("OpenStocks API")
    .setDescription(
      "Tokenized pre-IPO trading platform. Get a Bearer token from POST /auth/token, " +
        'click "Authorize" above, then try any endpoint from this page.'
    )
    .setVersion("1.0.0")
    .addBearerAuth()
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup("docs", app, swaggerDocument);

  await app.listen(env.PORT);
  // eslint-disable-next-line no-console
  console.log(`OpenStocks API listening on http://localhost:${env.PORT}`);
  // eslint-disable-next-line no-console
  console.log(`API docs: http://localhost:${env.PORT}/docs`);
  // eslint-disable-next-line no-console
  console.log(`Database: ${describeDatabase()}`);
}

bootstrap();
