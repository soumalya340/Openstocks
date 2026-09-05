import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import type { Db } from "./db.js";
import { authRequired, ensureUser, issueToken } from "./auth/index.js";
import {
  calculateShares,
  getAsset,
  getPriceHistory,
  listAssets,
  setPrice,
} from "./market/index.js";
import {
  cancelOrder,
  getIdempotentResponse,
  matchOpenLimits,
  placeOrder,
} from "./trading/index.js";
import { getPortfolio, getPortfolioAt } from "./portfolio/index.js";

export function createApp(db: Db): Express {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.use((req, _res, next) => {
    req.db = db;
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  /** Demo auth: POST /auth/token { username } → JWT */
  app.post("/auth/token", (req: Request, res: Response) => {
    const username = String(req.body?.username ?? "").trim();
    if (!username) {
      res.status(400).json({ error: "username is required" });
      return;
    }
    const user = ensureUser(db, username);
    const token = issueToken(user);
    res.status(201).json({
      token,
      userId: user.userId,
      username: user.username,
      tokenType: "Bearer",
    });
  });

  app.get("/assets", (_req, res) => {
    const assets = listAssets(db).map((a) => ({
      ...a,
      history: getPriceHistory(db, a.symbol),
    }));
    res.json({ assets });
  });

  app.get("/assets/:symbol", (req, res) => {
    const symbol = String(req.params.symbol);
    const asset = getAsset(db, symbol);
    if (!asset) {
      res.status(404).json({ error: "Asset not found" });
      return;
    }
    res.json({
      asset,
      history: getPriceHistory(db, asset.symbol),
    });
  });

  /** Pure calculator — no side effects on balances or orders. */
  app.post("/calculator", (req, res) => {
    const symbol = String(req.body?.symbol ?? "");
    const usdAmount = Number(req.body?.usdAmount);
    const beforeCash = db
      .prepare(`SELECT COALESCE(SUM(cash), 0) AS s FROM users`)
      .get() as { s: number };
    const result = calculateShares(db, symbol, usdAmount);
    const afterCash = db
      .prepare(`SELECT COALESCE(SUM(cash), 0) AS s FROM users`)
      .get() as { s: number };
    if (beforeCash.s !== afterCash.s) {
      res.status(500).json({ error: "Calculator must not mutate balances" });
      return;
    }
    if ("error" in result) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  });

  app.post("/orders", authRequired, (req, res) => {
    const userId = req.user!.userId;
    const idempotencyKey = req.header("Idempotency-Key")?.trim() ?? "";
    if (!idempotencyKey) {
      res.status(400).json({ error: "Idempotency-Key header is required" });
      return;
    }

    const cached = getIdempotentResponse(db, userId, idempotencyKey);
    if (cached) {
      res.status(cached.statusCode).json(cached.body);
      return;
    }

    const result = placeOrder(db, {
      userId,
      symbol: String(req.body?.symbol ?? ""),
      side: req.body?.side,
      type: req.body?.type,
      quantity: Number(req.body?.quantity),
      limitPrice:
        req.body?.limitPrice === undefined || req.body?.limitPrice === null
          ? null
          : Number(req.body.limitPrice),
      idempotencyKey,
    });

    if (!result.ok) {
      res.status(result.statusCode).json({ error: result.error });
      return;
    }

    res.status(result.statusCode).json({ order: result.order });
  });

  app.delete("/orders/:id", authRequired, (req, res) => {
    const result = cancelOrder(db, req.user!.userId, String(req.params.id));
    if (!result.ok) {
      res.status(result.statusCode).json({ error: result.error });
      return;
    }
    res.json({ order: result.order });
  });

  app.get("/portfolio", authRequired, (req, res) => {
    const portfolio = getPortfolio(db, req.user!.userId);
    res.json({ portfolio });
  });

  app.get("/portfolio/history", authRequired, (req, res) => {
    const at = String(req.query.at ?? "");
    if (!at) {
      res.status(400).json({ error: "Query param 'at' (ISO timestamp) is required" });
      return;
    }
    try {
      const portfolio = getPortfolioAt(db, req.user!.userId, at);
      res.json({ portfolio, reconstructedFrom: "ledger" });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  /** Test/admin helper: set simulated price and match resting limits. */
  app.post("/admin/prices/:symbol", authRequired, (req, res) => {
    try {
      const symbol = String(req.params.symbol);
      const price = Number(req.body?.price);
      const now = req.body?.ts ? String(req.body.ts) : new Date().toISOString();
      const fraction =
        req.body?.fillFraction === undefined ? 1 : Number(req.body.fillFraction);
      const asset = setPrice(db, symbol, price, now);
      const filled = matchOpenLimits(db, symbol, price, now, fraction);
      res.json({ asset, matchedOrders: filled });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  return app;
}
