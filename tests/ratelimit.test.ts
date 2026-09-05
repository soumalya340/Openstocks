import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { createTestApp } from "./helpers.js";
import type { INestApplication } from "@nestjs/common";

describe("HTTP rate limiting", () => {
  let nestApp: INestApplication | undefined;

  afterEach(async () => {
    await nestApp?.close();
  });

  it("returns 429 after exceeding the configured request budget", async () => {
    const ctx = await createTestApp({ throttleLimit: 3, throttleTtlMs: 60_000 });
    nestApp = ctx.nestApp;

    await request(ctx.app).get("/health").expect(200);
    await request(ctx.app).get("/health").expect(200);
    await request(ctx.app).get("/health").expect(200);

    const limited = await request(ctx.app).get("/health").expect(429);
    expect(limited.body.error).toBeTruthy();
    expect(String(limited.body.error).length).toBeGreaterThan(0);
  });

  it("allows requests under the configured limit", async () => {
    const ctx = await createTestApp({ throttleLimit: 5, throttleTtlMs: 60_000 });
    nestApp = ctx.nestApp;

    const res = await request(ctx.app).get("/health").expect(200);
    expect(res.body).toBeTruthy();
  });

  it("enforces 1 request per minute globally per IP (not per route)", async () => {
    const ctx = await createTestApp({ throttleLimit: 1, throttleTtlMs: 60_000 });
    nestApp = ctx.nestApp;

    await request(ctx.app).get("/health").expect(200);
    // Different path must still be blocked under a global 1 rpm budget.
    const limited = await request(ctx.app).get("/assets").expect(429);
    expect(limited.body.error).toBeTruthy();
  });
});
