import { type Express, type Request, type Response, Router } from "express";
import type { Env } from "../../core/env.js";
import { logger } from "../../core/logger.js";
import type { Security } from "../../core/security/index.js";
import { createCheckoutRouter } from "../checkout/checkout.routes.js";
import { createConnectRouter } from "../connect/connect.routes.js";
import { createFeesRouter } from "../fees/fees.routes.js";
import { createCardsRouter } from "../payments/cards.routes.js";
import { createPaymentReadRouter } from "../payments/payments.routes.js";
import { createReconciliationRouter } from "../reconciliation/reconciliation.routes.js";
import { createRefundRouter } from "../refunds/refund.routes.js";
import { createSettingsRouter } from "../settings/settings.routes.js";
import { createSettlementRouter } from "../settlements/settlement.routes.js";

/**
 * The private API the main server calls.
 *
 * Every route here is behind `requireService`; routes that act for a specific
 * person add `requireActor` on top, and admin routes add `requireAdminActor`
 * with the permission the operation needs. `/ping` stays because it is what
 * proves the signing scheme works end to end, independently of any money
 * endpoint.
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

  // The financial domain: fees, settlements, payouts, refunds and the books
  // that have to agree with Stripe afterwards.
  router.use(createFeesRouter(security));
  router.use(createSettlementRouter(security));
  router.use(createConnectRouter(security));
  router.use(createSettingsRouter(security));
  router.use(createRefundRouter(security));
  router.use(createReconciliationRouter(security));

  app.use("/internal/v1", router);
}
