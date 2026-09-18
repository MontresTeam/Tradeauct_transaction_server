import { type Request, type Response, Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { z } from "zod";
import { auditContext } from "../../core/audit.js";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { idempotent } from "../../core/idempotency.js";
import { validate } from "../../core/middleware/validate.js";
import type { Security } from "../../core/security/index.js";
import { ChargeService } from "../charges/charges.service.js";
import { CheckoutService } from "./checkout.service.js";

/**
 * Checkout and charge endpoints, mounted under /internal/v1.
 *
 * Note what the schemas do not contain: no price, no total, no buyer id. The
 * amount is derived from the listing on this side, and the buyer comes from
 * the verified actor token — so there is no field a client could tamper with
 * to change what it pays.
 */

const identifier = z
  .string()
  .min(6)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "Identifier contains unsupported characters");

const addressSchema = z
  .object({
    fullName: z.string().min(1).max(200),
    phoneNumber: z.string().max(40).optional(),
    email: z.string().email().max(200).optional(),
    streetAddress: z.string().max(300).optional(),
    addressLine1: z.string().max(300).optional(),
    addressLine2: z.string().max(300).optional(),
    apartment: z.string().max(100).optional(),
    city: z.string().min(1).max(120),
    state: z.string().max(120).optional(),
    postalCode: z.string().max(40).optional(),
    country: z.string().min(2).max(120),
  })
  .strict();

const purchaseType = z.enum(["AUCTION", "BUY_NOW", "OFFER"]).optional();

const intentBody = z
  .object({
    listingId: identifier,
    shippingAddress: addressSchema,
    purchaseType,
    storageSelected: z.boolean().optional(),
  })
  .strict();

const sessionBody = intentBody.extend({
  successUrl: z.string().url().max(2000),
  cancelUrl: z.string().url().max(2000),
});

const confirmBody = z
  .object({
    paymentIntentId: identifier,
    listingId: identifier,
  })
  .strict();

const retryBody = z
  .object({
    paymentMethodId: identifier.optional(),
  })
  .strict();

function actorId(req: Request): string {
  return req.actor?.userId as string;
}

export function createCheckoutRouter(security: Security): Router {
  const router = Router();

  // A charge attempt is expensive and rate-limiting it protects the buyer as
  // much as the platform: a loop that keeps retrying a declined card gets the
  // account flagged by the issuer.
  const chargeLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => req.actor?.userId ?? ipKeyGenerator(req.ip ?? "unknown"),
    message: { error: { code: "RATE_LIMITED", message: "Too many payment attempts; please wait" } },
  });

  router.post(
    "/payment-intents",
    security.requireActor,
    chargeLimiter,
    validate({ body: intentBody }),
    idempotent({ scope: "payment-intent" }),
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await CheckoutService.createPaymentIntent(actorId(req), req.body, auditContext(req)));
    }),
  );

  router.post(
    "/checkout/sessions",
    security.requireActor,
    chargeLimiter,
    validate({ body: sessionBody }),
    idempotent({ scope: "checkout-session" }),
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await CheckoutService.createCheckoutSession(actorId(req), req.body, auditContext(req)));
    }),
  );

  router.post(
    "/payments/confirm",
    security.requireActor,
    chargeLimiter,
    validate({ body: confirmBody }),
    idempotent({ scope: "payment-confirm" }),
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await CheckoutService.confirmPayment(actorId(req), req.body, auditContext(req)));
    }),
  );

  router.post(
    "/payments/:paymentId/retry",
    security.requireActor,
    chargeLimiter,
    validate({ params: z.object({ paymentId: identifier }).strict(), body: retryBody }),
    idempotent({ scope: "payment-retry" }),
    asyncHandler(async (req: Request, res: Response) => {
      res.json(
        await ChargeService.retryPayment(
          actorId(req),
          String(req.params.paymentId),
          req.body?.paymentMethodId,
          auditContext(req),
        ),
      );
    }),
  );

  return router;
}
