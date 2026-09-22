/**
 * Seller Connect onboarding endpoints, mounted under /internal/v1.
 *
 * The seller is resolved from the verified actor token. There is no route that
 * takes a seller id from the caller: onboarding creates an account that will
 * receive money, so the only acceptable answer to "whose account?" is "the
 * one that signed in".
 */
import { type Request, type Response, Router } from "express";
import { z } from "zod";
import { AppError } from "../../core/errors/AppError.js";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { idempotent } from "../../core/idempotency.js";
import { validate } from "../../core/middleware/validate.js";
import { prisma } from "../../core/prisma.js";
import type { Security } from "../../core/security/index.js";
import { FINANCE_PERMISSIONS } from "../settlements/settlement.routes.js";
import {
  createAccountLink,
  createConnectedAccount,
  getConnectedBankAccounts,
  getConnectStatus,
  refreshConnectAccount,
} from "./connect.service.js";

const onboardingBody = z
  .object({
    returnPath: z.string().max(300).optional(),
    refreshPath: z.string().max(300).optional(),
  })
  .strict();

const sellerParams = z
  .object({
    sellerId: z
      .string()
      .min(6)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();

async function resolveSeller(req: Request): Promise<{ id: string; email: string | null }> {
  const userId = req.actor?.userId;
  const seller = await prisma.seller.findFirst({
    where: { OR: [{ userId }, { id: userId }] },
    select: { id: true, user: { select: { email: true } } },
  });

  if (!seller) {
    throw new AppError(404, "No seller profile for this account", "SELLER_NOT_FOUND");
  }

  return { id: seller.id, email: seller.user?.email ?? null };
}

export function createConnectRouter(security: Security): Router {
  const router = Router();

  /** Create the connected account. Idempotent on the seller. */
  router.post(
    "/sellers/stripe/connect",
    security.requireActor,
    idempotent({ scope: "connect-account" }),
    asyncHandler(async (req: Request, res: Response) => {
      const seller = await resolveSeller(req);
      const result = await createConnectedAccount({
        sellerId: seller.id,
        email: seller.email,
        actorId: req.actor?.userId ?? null,
        ip: req.ip ?? null,
      });

      res.json({ success: true, data: { ...result, status: await getConnectStatus(seller.id) } });
    }),
  );

  /**
   * A fresh Stripe-hosted onboarding link.
   *
   * Never idempotent: Account Links are single-use and expire in minutes, so
   * replaying a stored response would hand the seller a dead URL.
   */
  router.post(
    "/sellers/stripe/onboarding",
    security.requireActor,
    validate({ body: onboardingBody }),
    asyncHandler(async (req: Request, res: Response) => {
      const seller = await resolveSeller(req);
      const link = await createAccountLink({
        sellerId: seller.id,
        returnPath: req.body?.returnPath,
        refreshPath: req.body?.refreshPath,
      });

      res.json({ success: true, data: link });
    }),
  );

  router.get(
    "/sellers/stripe/status",
    security.requireActor,
    asyncHandler(async (req: Request, res: Response) => {
      const seller = await resolveSeller(req);
      res.json({
        success: true,
        data: {
          ...(await getConnectStatus(seller.id)),
          // Stripe's UAE Connect rules, stated plainly rather than discovered
          // halfway through onboarding.
          requirementsNotice:
            "A UAE payout account requires a valid UAE trade licence. Individuals without one cannot currently be onboarded; those sellers are paid by manual bank transfer instead.",
        },
      });
    }),
  );

  /**
   * The seller's own bank account, exactly as Stripe holds it.
   *
   * Read-only. There is no matching PUT: a seller who needs to change their
   * bank goes back through `/sellers/stripe/onboarding`, Stripe's own hosted
   * flow, because TradeAuct never takes bank details itself.
   */
  router.get(
    "/sellers/stripe/bank-account",
    security.requireActor,
    asyncHandler(async (req: Request, res: Response) => {
      const seller = await resolveSeller(req);
      const accounts = await getConnectedBankAccounts(seller.id);
      res.json({ success: true, data: accounts });
    }),
  );

  /** Pull the live account from Stripe. Useful when a webhook was missed. */
  router.post(
    "/sellers/stripe/refresh",
    security.requireActor,
    asyncHandler(async (req: Request, res: Response) => {
      const seller = await resolveSeller(req);
      res.json({ success: true, data: await refreshConnectAccount(seller.id) });
    }),
  );

  router.get(
    "/admin/connect/:sellerId",
    security.requireAdminActor(FINANCE_PERMISSIONS.READ),
    validate({ params: sellerParams }),
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ success: true, data: await getConnectStatus(String(req.params.sellerId)) });
    }),
  );

  router.post(
    "/admin/connect/:sellerId/refresh",
    security.requireAdminActor(FINANCE_PERMISSIONS.PAYOUTS),
    validate({ params: sellerParams }),
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ success: true, data: await refreshConnectAccount(String(req.params.sellerId)) });
    }),
  );

  return router;
}
