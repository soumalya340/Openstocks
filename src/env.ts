import { config as loadDotenv } from "dotenv";
import path from "node:path";

/** Load `.env` once, before any module reads process.env. */
loadDotenv({ path: path.resolve(process.cwd(), ".env"), quiet: true });

export const env = {
  PORT: Number(process.env.PORT ?? 3000),
  DB_PATH:
    process.env.DB_PATH ?? path.join(process.cwd(), "data", "openstocks.sqlite"),
  JWT_SECRET: process.env.JWT_SECRET ?? "openstocks-dev-secret",
  /** Sliding window length for HTTP rate limiting (ms). */
  THROTTLE_TTL_MS: Number(process.env.THROTTLE_TTL_MS ?? 60_000),
  /** Max requests per IP per TTL window (global across routes). */
  THROTTLE_LIMIT: Number(process.env.THROTTLE_LIMIT ?? 100),
} as const;
