import { type Express, type Request, type Response, Router } from "express";
import type { Env } from "../../core/env.js";
import { logger } from "../../core/logger.js";
import type { Security } from "../../core/security/index.js";
import { createCheckoutRouter } from "../checkout/checkout.routes.js";
import { createCardsRouter } from "../payments/cards.routes.js";
import { createPaymentReadRouter } from "../payments/payments.routes.js";

/**
 * The private API the main server calls.
 *
 * Every route here is behind `requireService`; routes that act for a specific
 * person add `requireActor` on top. Phase 1 exposes only `/ping`, which is
 * what proves the signing scheme works end to end before any money endpoint
 * is moved across.
 */
export function registerInternalModule(app: Express, _env: Env, security: Security): void {
  const router = Router();

  router.use(security.requireService);

  router.get("/ping", (req: Request, res: Response) => {
    logger.info("Internal ping", { service: req.serviceCaller?.service, keyId: req.serviceCaller?.keyId });
    res.json({
      pong: true,
      service: "txn-server",
      caller: req.serviceCaller?.service ?? null,
      receivedAt: new Date().toISOString(),
    });
  });

  /** Same check, but also proves the forwarded end-user token verifies here. */
  router.get("/whoami", security.requireActor, (req: Request, res: Response) => {
    res.json({
      caller: req.serviceCaller?.service ?? null,
      actor: { userId: req.actor?.userId, role: req.actor?.role },
    });
  });

  // Payment reads live in their own module, mounted behind the same
  // service-authentication gate.
  router.use(createPaymentReadRouter(security));
  router.use(createCardsRouter(security));
  router.use(createCheckoutRouter(security));

  app.use("/internal/v1", router);
}
