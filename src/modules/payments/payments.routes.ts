import { type Request, type Response, Router } from "express";
import { z } from "zod";
import { loadEnv } from "../../core/env.js";
import { QUOTE_CURRENCY } from "../quote/quote.service.js";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { validate } from "../../core/middleware/validate.js";
import type { Security } from "../../core/security/index.js";
import { PaymentReadService } from "./payments.read.service.js";

/**
 * Read endpoints, mounted under /internal/v1 by the internal module.
 *
 * All of them are actor-scoped: the transaction server resolves the buyer from
 * the forwarded user token, never from a parameter, so there is no id a caller
 * can substitute to read someone else's payment.
 */

/** Ids we accept: cuid, uuid or a Stripe object id. Anything else is a 400. */
const identifier = z
  .string()
  .min(6)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "Identifier contains unsupported characters");

const paymentParams = z.object({ paymentId: identifier }).strict();
const sessionParams = z.object({ sessionId: identifier }).strict();
const buyerParams = z.object({ userIdOrBuyerId: identifier }).strict();

function actorId(req: Request): string {
  // requireActor has already run, so this is present and verified.
  return req.actor?.userId as string;
}

export function createPaymentReadRouter(security: Security): Router {
  const router = Router();

  /**
   * Public Stripe configuration for the clients.
   *
   * Service-authenticated like everything else here: it is not secret, but
   * there is no reason for anything but the main server to ask this server
   * anything at all.
   */
  router.get(
    "/config",
    asyncHandler(async (_req: Request, res: Response) => {
      const env = loadEnv();
      res.json({
        success: true,
        data: {
          publishableKey: env.STRIPE_PUBLISHABLE_KEY,
          currency: QUOTE_CURRENCY,
          supportedCurrencies: [QUOTE_CURRENCY],
        },
      });
    }),
  );

  router.get(
    "/eligibility",
    security.requireActor,
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await PaymentReadService.getEligibility(actorId(req)));
    }),
  );

  /**
   * Summary form for the bid hot path.
   *
   * Service-authenticated only, because a bid can arrive over a socket where
   * no user token is at hand. It therefore answers with booleans and a reason
   * code and nothing else - no listing, no amounts - so that a service-only
   * call cannot be used to enumerate what somebody is bidding on.
   */
  router.get(
    "/eligibility/:buyerUserId",
    validate({ params: z.object({ buyerUserId: identifier }).strict() }),
    asyncHandler(async (req: Request, res: Response) => {
      const result = await PaymentReadService.getEligibility(String(req.params.buyerUserId));
      res.json({
        success: true,
        canPlaceBid: result.canPlaceBid,
        hasActiveRecovery: result.hasActiveRecovery,
        hasPaymentMethod: result.hasPaymentMethod,
        reason: result.reason,
      });
    }),
  );

  router.get(
    "/checkout/sessions/:sessionId",
    security.requireActor,
    validate({ params: sessionParams }),
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await PaymentReadService.getCheckoutSessionStatus(actorId(req), String(req.params.sessionId)));
    }),
  );

  router.get(
    "/payments/:paymentId/recovery-status",
    security.requireActor,
    validate({ params: paymentParams }),
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await PaymentReadService.getRecoveryStatus(actorId(req), String(req.params.paymentId)));
    }),
  );

  router.get(
    "/payments/:paymentId",
    security.requireActor,
    validate({ params: paymentParams }),
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await PaymentReadService.getPaymentStatus(actorId(req), String(req.params.paymentId)));
    }),
  );

  router.get(
    "/admin/buyers/:userIdOrBuyerId/payment-diagnostic",
    security.requireAdminActor("payments.read"),
    validate({ params: buyerParams }),
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await PaymentReadService.getBuyerDiagnostic(String(req.params.userIdOrBuyerId)));
    }),
  );

  return router;
}
