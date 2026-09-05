import { config as loadDotenv } from "dotenv";
import path from "node:path";

/** Load `.env` once, before any module reads process.env. */
loadDotenv({ path: path.resolve(process.cwd(), ".env"), quiet: true });

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "DATABASE_URL is required (Postgres / Supabase connection string). Set it in .env."
    );
  }
  return url;
}

export const env = {
  PORT: Number(process.env.PORT ?? 3000),
  /** Postgres / Supabase connection string (required for production). Encode `@` in passwords as `%40`. */
  get DATABASE_URL(): string {
    return requireDatabaseUrl();
  },
  SUPABASE_URL: process.env.SUPABASE_URL?.trim() || null,
  JWT_SECRET: process.env.JWT_SECRET ?? "openstocks-dev-secret",
  THROTTLE_TTL_MS: Number(process.env.THROTTLE_TTL_MS ?? 60_000),
  THROTTLE_LIMIT: Number(process.env.THROTTLE_LIMIT ?? 100),
} as const;

export function describeDatabase(databaseUrl?: string): string {
  const url = databaseUrl ?? process.env.DATABASE_URL?.trim();
  if (!url) return "Postgres";
  try {
    const u = new URL(url);
    return `Postgres ${u.hostname}${u.pathname}`;
  } catch {
    return "Postgres";
  }
}
