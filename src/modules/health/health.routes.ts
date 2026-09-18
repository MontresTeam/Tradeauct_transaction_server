import { type Express, type Request, type Response, Router } from "express";
import type { Env } from "../../core/env.js";
import { prisma } from "../../core/prisma.js";
import { isRedisConnected } from "../../core/queue.js";
import { getStripeClient } from "../gateway/stripe.client.js";

/**
 * Liveness and readiness.
 *
 * Neither endpoint requires a signature — they are reachable only on the
 * private interface — and neither reports anything an attacker could use:
 * component names and up/down, no versions, no connection strings.
 */
export function registerHealthModule(app: Express, _env: Env): void {
  const router = Router();

  router.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", service: "txn-server" });
  });

  router.get("/ready", async (_req: Request, res: Response) => {
    const checks: Record<string, boolean> = { database: false, redis: false, stripe: false };

    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.database = true;
    } catch {
      checks.database = false;
    }

    checks.redis = isRedisConnected();

    try {
      // Cheapest authenticated call Stripe offers: confirms the key works
      // without creating anything.
      await getStripeClient().balance.retrieve();
      checks.stripe = true;
    } catch {
      checks.stripe = false;
    }

    const ready = Object.values(checks).every(Boolean);
    res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "degraded", checks });
  });

  app.use(router);
}
