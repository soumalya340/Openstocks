import { DynamicModule, Global, Module } from "@nestjs/common";
import { openDatabase } from "../db.js";
import { env } from "../env.js";
import { DB_CONNECTION } from "./database.tokens.js";
import { DatabaseService } from "./database.service.js";

const RAW_DB = Symbol("RAW_DB");

@Global()
@Module({})
export class DatabaseModule {
  static forRoot(dbPath: string = env.DB_PATH): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        {
          provide: RAW_DB,
          useFactory: () => openDatabase(dbPath),
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
