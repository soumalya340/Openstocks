import { DynamicModule, Global, Module } from "@nestjs/common";
import type pg from "pg";
import { openDatabase } from "../db.js";
import { env } from "../env.js";
import { DB_CONNECTION } from "./database.tokens.js";
import { DatabaseService } from "./database.service.js";

const RAW_DB = Symbol("RAW_DB");

export interface DatabaseModuleOptions {
  databaseUrl?: string;
  pool?: pg.Pool;
}

@Global()
@Module({})
export class DatabaseModule {
  static forRoot(opts: DatabaseModuleOptions = {}): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        {
          provide: RAW_DB,
          useFactory: async () =>
            openDatabase({
              databaseUrl: opts.pool ? undefined : opts.databaseUrl ?? env.DATABASE_URL,
              pool: opts.pool,
            }),
        },
        {
          provide: DatabaseService,
          useFactory: (db) => new DatabaseService(db),
          inject: [RAW_DB],
        },
        {
          provide: DB_CONNECTION,
          useFactory: (svc: DatabaseService) => svc.getDb(),
          inject: [DatabaseService],
        },
      ],
      exports: [DB_CONNECTION],
    };
  }
}
