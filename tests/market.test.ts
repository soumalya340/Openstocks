import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { createTestApp, login, auth } from "./helpers.js";
import type { Db } from "../src/db.js";

describe("market data + calculator", () => {
  let db: Db;

  afterEach(() => {
    db?.close();
  });

  it("GET /assets returns the four seed assets with expected prices", async () => {
    const ctx = createTestApp();
    db = ctx.db;
    const res = await request(ctx.app).get("/assets").expect(200);
    const symbols = res.body.assets.map((a: { symbol: string }) => a.symbol).sort();
    expect(symbols).toEqual(["vATL", "vHLX", "vSOL", "vVAN"]);
    const bySym = Object.fromEntries(
      res.body.assets.map((a: { symbol: string; price: number; name: string }) => [
        a.symbol,
        a,
      ])
    );
    expect(bySym.vSOL.price).toBe(420);
    expect(bySym.vATL.price).toBe(95.5);
    expect(bySym.vHLX.price).toBe(180.25);
    expect(bySym.vVAN.price).toBe(310.1);
    expect(bySym.vSOL.name).toBe("Solace AI");
    expect(bySym.vSOL.history.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /assets/:symbol returns detail + history", async () => {
    const ctx = createTestApp();
    db = ctx.db;
    const res = await request(ctx.app).get("/assets/vHLX").expect(200);
    expect(res.body.asset.symbol).toBe("vHLX");
    expect(res.body.asset.price).toBe(180.25);
    expect(Array.isArray(res.body.history)).toBe(true);
  });

  it("GET /assets/:symbol 404s unknown", async () => {
    const ctx = createTestApp();
    db = ctx.db;
    await request(ctx.app).get("/assets/NOPE").expect(404);
  });

  it("POST /calculator converts USD to shares with no side effects", async () => {
    const ctx = createTestApp();
    db = ctx.db;
    const { token } = await login(ctx.app);
    // Ensure a user exists so we can detect cash mutation
    const before = await request(ctx.app)
      .get("/portfolio")
      .set(auth(token))
      .expect(200);

    const res = await request(ctx.app)
      .post("/calculator")
      .send({ symbol: "vSOL", usdAmount: 840 })
      .expect(200);

    expect(res.body.symbol).toBe("vSOL");
    expect(res.body.price).toBe(420);
    expect(res.body.shares).toBeCloseTo(2, 10);
    expect(res.body.usdAmount).toBe(840);

    const after = await request(ctx.app)
      .get("/portfolio")
      .set(auth(token))
      .expect(200);
    expect(after.body.portfolio.cash).toBe(before.body.portfolio.cash);
    expect(after.body.portfolio.holdings).toEqual(before.body.portfolio.holdings);
  });

  it("POST /calculator rejects bad input", async () => {
    const ctx = createTestApp();
    db = ctx.db;
    await request(ctx.app)
      .post("/calculator")
      .send({ symbol: "vSOL", usdAmount: -1 })
      .expect(400);
  });
});
