import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { createTestApp, login, auth } from "./helpers.js";
import type { Db } from "../src/db.js";
import type { INestApplication } from "@nestjs/common";
import { setPrice } from "../src/market/index.js";

describe("admin halt / resume", () => {
  let db: Db;
  let nestApp: INestApplication | undefined;

  afterEach(async () => {
    await nestApp?.close();
  });

  it("rejects orders while halted and accepts them again after resume", async () => {
    const ctx = await createTestApp();
    db = ctx.db;
    nestApp = ctx.nestApp;
    const { token } = await login(ctx.app, "ops");

    await request(ctx.app)
      .post("/admin/halt/vSOL")
      .set(auth(token))
      .send({})
      .expect(200);

    const rejected = await request(ctx.app)
      .post("/orders")
      .set(auth(token))
      .set("Idempotency-Key", "halted-1")
      .send({ symbol: "vSOL", side: "buy", type: "market", quantity: 1 })
      .expect(503);
    expect(rejected.body.error).toMatch(/halted/i);

    // Other symbols still trade
    await request(ctx.app)
      .post("/orders")
      .set(auth(token))
      .set("Idempotency-Key", "other-ok")
      .send({ symbol: "vATL", side: "buy", type: "market", quantity: 1 })
      .expect(201);

    await request(ctx.app)
      .post("/admin/resume/vSOL")
      .set(auth(token))
      .send({})
      .expect(200);

    await request(ctx.app)
      .post("/orders")
      .set(auth(token))
      .set("Idempotency-Key", "resumed-1")
      .send({ symbol: "vSOL", side: "buy", type: "market", quantity: 1 })
      .expect(201);
  });

  it("keeps the automatic circuit breaker working independently", async () => {
    const ctx = await createTestApp();
    db = ctx.db;
    nestApp = ctx.nestApp;
    const { token } = await login(ctx.app, "cb-ops");

    const t0 = new Date(Date.now() - 20_000).toISOString();
    const t1 = new Date(Date.now() - 5_000).toISOString();
    await setPrice(db, "vVAN", 310.1, t0);
    await setPrice(db, "vVAN", 360, t1);

    const rejected = await request(ctx.app)
      .post("/orders")
      .set(auth(token))
      .set("Idempotency-Key", "cb-still")
      .send({ symbol: "vVAN", side: "buy", type: "market", quantity: 1 })
      .expect(503);
    expect(rejected.body.error).toMatch(/Circuit breaker/i);
  });
});
