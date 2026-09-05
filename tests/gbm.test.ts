import { describe, it, expect, afterEach } from "vitest";
import type { Db } from "../src/db.js";
import {
  GBM,
  gbmNextPrice,
  getAsset,
  tickPrices,
} from "../src/market/index.js";
import { openTestDatabase } from "./helpers.js";

describe("GBM price process", () => {
  let db: Db | undefined;

  afterEach(async () => {
    await db?.close();
    db = undefined;
  });

  it("gbmNextPrice matches S * exp((μ - σ²/2)Δt + σ√Δt * Z)", () => {
    const S = 420;
    const Z = 0.5;
    const { MU: mu, SIGMA: sigma, DT: dt } = GBM;
    const expected = S * Math.exp((mu - (sigma * sigma) / 2) * dt + sigma * Math.sqrt(dt) * Z);
    const rounded = Math.max(0.01, Number(expected.toFixed(4)));
    expect(gbmNextPrice(S, Z)).toBe(rounded);
    expect(gbmNextPrice(S, Z)).toBeGreaterThan(0);
  });

  it("tickPrices applies GBM with injected normals, not uniform ±0.5% walk", async () => {
    db = await openTestDatabase();
    const before = (await getAsset(db, "vSOL"))!.price;
    expect(before).toBe(420);

    const Z = 0;
    const expectedFactor = Math.exp(
      (GBM.MU - (GBM.SIGMA * GBM.SIGMA) / 2) * GBM.DT + GBM.SIGMA * Math.sqrt(GBM.DT) * Z
    );
    const expected = Math.max(0.01, Number((before * expectedFactor).toFixed(4)));

    await tickPrices(db, "2026-01-01T00:00:00.000Z", () => Z);

    const after = (await getAsset(db, "vSOL"))!.price;
    expect(after).toBe(expected);
    expect(after).toBe(gbmNextPrice(before, Z));

    const bigZ = 3;
    const spot = (await getAsset(db, "vATL"))!.price;
    const gbmBig = gbmNextPrice(spot, bigZ);
    const maxOldWalk = Number((spot * 1.005).toFixed(4));
    expect(gbmBig).toBeGreaterThan(maxOldWalk);
  });

  it("prices remain positive under large negative shocks", () => {
    expect(gbmNextPrice(420, -50)).toBeGreaterThan(0);
    expect(gbmNextPrice(0.02, -100)).toBe(0.01);
  });
});
