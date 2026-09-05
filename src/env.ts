import { config as loadDotenv } from "dotenv";
import path from "node:path";

/** Load `.env` once, before any module reads process.env. */
loadDotenv({ path: path.resolve(process.cwd(), ".env"), quiet: true });

export const env = {
  PORT: Number(process.env.PORT ?? 3000),
  DB_PATH:
    process.env.DB_PATH ?? path.join(process.cwd(), "data", "openstocks.sqlite"),
  JWT_SECRET: process.env.JWT_SECRET ?? "openstocks-dev-secret",
} as const;
