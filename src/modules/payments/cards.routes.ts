import { type Request, type Response, Router } from "express";
import { z } from "zod";
import { auditContext } from "../../core/audit.js";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { idempotent } from "../../core/idempotency.js";
import { validate } from "../../core/middleware/validate.js";
import type { Security } from "../../core/security/index.js";
import { CardService } from "./payments.cards.service.js";

/**
 * Saved-card endpoints, mounted under /internal/v1.
 *
 * Every mutation carries an Idempotency-Key: a retried "save this card" must
 * not attach it twice, and a retried "remove this card" must not silently
 * detach a second one after the first attempt already succeeded.
 *
 * Every schema is `.strict()`. A body that carries an extra field — a buyerId,
 * say — is rejected rather than ignored, so a caller cannot get into the habit
 * of sending one and expecting it to matter.
 */

const identifier = z
  .string()
  .min(6)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "Identifier contains unsupported characters");

const emptyBody = z.object({}).strict();
const saveCardBody = z.object({ setupIntentId: identifier }).strict();
const defaultCardBody = z.object({ paymentMethodId: identifier }).strict();
const removeCardBody = z.object({ paymentMethodId: identifier.optional() }).strict();

function actorId(req: Request): string {
  return req.actor?.userId as string;
}

export function createCardsRouter(security: Security): Router {
  const router = Router();

  router.post(
    "/setup-intents",
    security.requireActor,
    validate({ body: emptyBody }),
    idempotent({ scope: "setup-intent" }),
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await CardService.createSetupIntent(actorId(req), auditContext(req)));
    }),
  );

  router.get(
    "/payment-methods",
    security.requireActor,
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await CardService.list(actorId(req)));
    }),
  );

  router.post(
    "/payment-methods",
    security.requireActor,
    validate({ body: saveCardBody }),
    idempotent({ scope: "save-payment-method" }),
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await CardService.saveFromSetupIntent(actorId(req), req.body.setupIntentId, auditContext(req)));
    }),
  );

  router.post(
    "/payment-methods/default",
    security.requireActor,
    validate({ body: defaultCardBody }),
    idempotent({ scope: "default-payment-method" }),
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await CardService.setDefault(actorId(req), req.body.paymentMethodId, auditContext(req)));
    }),
  );

  router.delete(
    "/payment-methods",
    security.requireActor,
    validate({ body: removeCardBody }),
    idempotent({ scope: "remove-payment-method" }),
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await CardService.remove(actorId(req), req.body?.paymentMethodId, auditContext(req)));
    }),
  );

  return router;
}
