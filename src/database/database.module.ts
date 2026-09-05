import { DynamicModule, Global, Module } from "@nestjs/common";
import { openDatabase } from "../db.js";
import { env } from "../env.js";
import { DB_CONNECTION } from "./database.tokens.js";
import { DatabaseService } from "./database.service.js";

const RAW_DB = Symbol("RAW_DB");

export interface DatabaseModuleOptions {
  dbPath?: string;
  databaseUrl?: string | null;
}

@Global()
@Module({})
export class DatabaseModule {
  static forRoot(
    dbPathOrOpts: string | DatabaseModuleOptions = env.DB_PATH
  ): DynamicModule {
    const opts: DatabaseModuleOptions =
      typeof dbPathOrOpts === "string"
        ? { dbPath: dbPathOrOpts, databaseUrl: env.DATABASE_URL }
        : {
            dbPath: dbPathOrOpts.dbPath ?? env.DB_PATH,
            databaseUrl:
              dbPathOrOpts.databaseUrl === undefined
                ? env.DATABASE_URL
                : dbPathOrOpts.databaseUrl,
          };

    return {
      module: DatabaseModule,
      providers: [
        {
          provide: RAW_DB,
          useFactory: async () =>
            openDatabase({
              sqlitePath: opts.dbPath,
              // Tests pass databaseUrl: null to force SQLite :memory:
              databaseUrl: opts.databaseUrl,
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
