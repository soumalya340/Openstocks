import { Injectable, OnApplicationShutdown } from "@nestjs/common";
import type { Db } from "../db.js";

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  constructor(private readonly db: Db) {}

  getDb(): Db {
    return this.db;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.db.close();
  }
}
