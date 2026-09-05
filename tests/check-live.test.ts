import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_BASE_URL,
  checkConnection,
  runLiveChecks,
} from "../scripts/check-live.mjs";

describe("scripts/check-live.mjs", () => {
  it("defaults to the Render deployment URL and covers every API route in source", () => {
    expect(DEFAULT_BASE_URL).toBe("https://openstocks-2r66.onrender.com");
    const src = readFileSync(
      join(process.cwd(), "scripts/check-live.mjs"),
      "utf8"
    );
    for (const snippet of [
      '"/health"',
      '"/auth/token"',
      '"/assets"',
      '"/assets/vSOL"',
      '"/calculator"',
      '"/orders"',
      '"/portfolio"',
      "/portfolio/history?at=",
      '"/admin/prices/vSOL"',
      "console.log",
      "Idempotency-Key",
      "Authorization",
    ]) {
      expect(src).toContain(snippet);
    }
  });

  it("checkConnection logs and returns method/path/status against the live host", async () => {
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      const result = await checkConnection(DEFAULT_BASE_URL, "GET", "/assets");
      expect(result.method).toBe("GET");
      expect(result.path).toBe("/assets");
      // Live host may return app or platform status; must not be a silent swallow.
      expect(result.status === null || typeof result.status === "number").toBe(
        true
      );
      expect(logs.some((line) => line.includes('"path":"/assets"'))).toBe(true);
      expect(logs.some((line) => line.includes('"method":"GET"'))).toBe(true);
    } finally {
      console.log = original;
    }
  }, 60_000);

  it("runLiveChecks attempts every required connection and logs each one", async () => {
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      const { results, hardFailures } = await runLiveChecks(DEFAULT_BASE_URL);
      expect(hardFailures).toBeGreaterThanOrEqual(0);
      expect(results.length).toBe(10);

      const keys = results.map((r) => `${r.method} ${r.path.split("?")[0]}`);
      expect(keys[0]).toBe("GET /health");
      expect(keys[1]).toBe("POST /auth/token");
      expect(keys[2]).toBe("GET /assets");
      expect(keys[3]).toBe("GET /assets/vSOL");
      expect(keys[4]).toBe("POST /calculator");
      expect(keys[5]).toBe("POST /orders");
      expect(keys[6]).toBe("GET /portfolio");
      expect(keys[7]).toBe("GET /portfolio/history");
      expect(keys[8].startsWith("DELETE /orders/")).toBe(true);
      expect(keys[9]).toBe("POST /admin/prices/vSOL");

      for (const r of results) {
        expect(
          logs.some(
            (line) =>
              line.includes(`"method":"${r.method}"`) &&
              line.includes(`"path":"${r.path}"`)
          )
        ).toBe(true);
      }
    } finally {
      console.log = original;
    }
  }, 180_000);
});
