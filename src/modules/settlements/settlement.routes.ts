/**
 * Settlement endpoints, mounted under /internal/v1.
 *
 * Two audiences:
 *
 *   - **sellers**, who may read their own settlements and balances. The seller
 *     is resolved from the verified actor token, never from a parameter, so
 *     there is no id a caller could substitute to read someone else's
 *     earnings. There is deliberately no "request withdrawal": payouts are
 *     automatic (decision D3).
 *   - **admins**, who may freeze, unfreeze, adjust and pay manually. Each of
 *     those is permission-gated and audited.
 */
import { type Request, type Response, Router } from "express";
import { z } from "zod";
import { AppError } from "../../core/errors/AppError.js";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { idempotent } from "../../core/idempotency.js";
import { validate } from "../../core/middleware/validate.js";
import { prisma } from "../../core/prisma.js";
import type { Security } from "../../core/security/index.js";
import { recordManualPayout, transferSettlement } from "../payouts/payout.service.js";
import {
  adjustSettlement,
  confirmBuyerReceipt,
  evaluateEligibility,
  freezeSettlement,
  getSellerBalances,
  recordActualShipping,
  releaseIfEligible,
  unfreezeSettlement,
} from "./settlement.service.js";
import { SELLER_BALANCE_BUCKETS, type SettlementActor } from "./settlement.types.js";

export const FINANCE_PERMISSIONS = {
  READ: "finance.settlements.read",
  MANAGE: "finance.settlements.manage",
  PAYOUTS: "finance.payouts.manage",
  SETTINGS: "finance.settings.manage",
} as const;

const identifier = z
  .string()
  .min(6)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "Identifier contains unsupported characters");

const settlementParams = z.object({ settlementId: identifier }).strict();

const listQuery = z
  .object({
    status: z.string().max(40).optional(),
    sellerId: identifier.optional(),
    orderNumber: z.string().max(64).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

const freezeBody = z
  .object({
    reason: z.enum(["ADMIN_HOLD", "RETURN", "BUYER_DISPUTE_CASE", "UNRESOLVED_ISSUE", "RECONCILIATION_EXCEPTION"]),
    note: z.string().min(3).max(500),
  })
  .strict();

const noteBody = z.object({ note: z.string().min(3).max(500) }).strict();

const adjustBody = z
  .object({
    adjustmentAmount: z.number().refine((value) => value !== 0, "An adjustment must be non-zero"),
    reason: z.string().min(3).max(500),
  })
  .strict();

const manualPayoutBody = z
  .object({
    reference: z.string().min(3).max(120),
    note: z.string().max(500).optional(),
  })
  .strict();

const shippingBody = z.object({ actualShipping: z.number().min(0) }).strict();

/** Admin actor, built from the verified token rather than the request body. */
function adminActor(req: Request): SettlementActor {
  return { type: "ADMIN", id: req.actor?.userId ?? null, ip: req.ip ?? null };
}

/** Resolve the seller row for the signed-in user. */
async function resolveSellerId(req: Request): Promise<string> {
  const userId = req.actor?.userId;
  const seller = await prisma.seller.findFirst({
    where: { OR: [{ userId }, { id: userId }] },
    select: { id: true },
  });

  if (!seller) {
    throw new AppError(404, "No seller profile for this account", "SELLER_NOT_FOUND");
  }

  return seller.id;
}

/** The shape both dashboards render. Amounts stay in major units for display. */
function presentSettlement(settlement: Record<string, unknown>): Record<string, unknown> {
  return {
    id: settlement.id,
    settlementNumber: settlement.settlementNumber,
    status: settlement.settlementStatus,
    payoutStatus: settlement.payoutStatus,
    orderId: settlement.fulfillmentOrderId,
    paymentId: settlement.paymentId,
    sellerId: settlement.sellerId,
    currency: settlement.currency,

    saleAmount: settlement.saleAmount,
    netProceeds: settlement.netProceeds,

    feeSnapshot: {
      feeRuleType: settlement.feeRuleType,
      feeConfigurationVersion: settlement.feeConfigurationVersion,
      sellerFeePercent: settlement.sellerFeePercent,
      sellerFeeAmount: settlement.sellerFeeAmount,
      buyerFeePercent: settlement.buyerFeePercent,
      buyerFeeAmount: settlement.buyerFeeAmount,
      calculatedAt: settlement.feeCalculatedAt,
    },

    shipping: {
      payer: settlement.shippingPayer,
      estimated: settlement.estimatedShipping,
      actual: settlement.actualShipping,
      actualKnown: settlement.actualShippingKnown,
    },

    deductions: {
      other: settlement.otherDeductions,
      refund: settlement.refundAmount,
      adjustment: settlement.adjustmentAmount,
    },

    timeline: {
      createdAt: settlement.createdAt,
      deliveredAt: settlement.deliveredAt,
      deliverySource: settlement.deliverySource,
      protectionPeriodDays: settlement.protectionPeriodDays,
      protectionExpiresAt: settlement.protectionExpiresAt,
      eligibleAt: settlement.eligibleAt,
      transferredAt: settlement.transferredAt,
      paidOutAt: settlement.paidOutAt,
    },

    payout: {
      method: settlement.payoutMethod,
      connectedAccountId: settlement.stripeConnectedAccountId,
      transferId: settlement.stripeTransferId,
      transferStatus: settlement.stripeTransferStatus,
      payoutId: settlement.stripePayoutId,
      payoutStatus: settlement.stripePayoutStatus,
      attempts: settlement.transferAttempts,
      failureCode: settlement.transferFailureCode,
      failureMessage: settlement.transferFailureMessage,
    },

    hold: {
      frozenReason: settlement.frozenReason,
      frozenFromStatus: settlement.frozenFromStatus,
      frozenAt: settlement.frozenAt,
      holdReason: settlement.holdReason,
    },

    hasOpenRecovery: settlement.hasOpenRecovery,
  };
}

export function createSettlementRouter(security: Security): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // Seller
  // -------------------------------------------------------------------------

  /** The six balance buckets the seller dashboard shows. */
  router.get(
    "/seller/settlements/balances",
    security.requireActor,
    asyncHandler(async (req: Request, res: Response) => {
      const sellerId = await resolveSellerId(req);
      res.json({ success: true, data: await getSellerBalances(sellerId) });
    }),
  );

  router.get(
    "/seller/settlements",
    security.requireActor,
    validate({ query: listQuery.omit({ sellerId: true }) }),
    asyncHandler(async (req: Request, res: Response) => {
      const sellerId = await resolveSellerId(req);
      const query = req.query as unknown as z.infer<typeof listQuery>;

      const where = {
        sellerId,
        ...(query.status ? { settlementStatus: query.status as never } : {}),
        ...(query.from || query.to
          ? {
              createdAt: {
                ...(query.from ? { gte: new Date(query.from) } : {}),
                ...(query.to ? { lte: new Date(query.to) } : {}),
              },
            }
          : {}),
      };

      const [rows, total] = await Promise.all([
        prisma.sellerSettlement.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          include: { fulfillmentOrder: { select: { orderNumber: true, listingId: true } } },
        }),
        prisma.sellerSettlement.count({ where }),
      ]);

      res.json({
        success: true,
        data: rows.map((row) => ({
          ...presentSettlement(row),
          orderNumber: row.fulfillmentOrder?.orderNumber ?? null,
          listingId: row.fulfillmentOrder?.listingId ?? null,
        })),
        pagination: { page: query.page, pageSize: query.pageSize, total },
      });
    }),
  );

  /**
   * The settlement for one fulfilment order.
   *
   * The order detail page shows the automatic-payout state inline rather than
   * sending the seller to a separate tab to find it. There is no settlement
   * yet for an order whose payment has not been recorded against a
   * fulfilment order (the settlement exists from the moment of payment, but
   * `linkFulfillmentOrder` runs slightly later) - that is a 404, not an
   * error, and the page shows "not yet available" rather than a failure.
   */
  router.get(
    "/seller/settlements/by-order/:fulfillmentOrderId",
    security.requireActor,
    validate({ params: z.object({ fulfillmentOrderId: identifier }).strict() }),
    asyncHandler(async (req: Request, res: Response) => {
      const sellerId = await resolveSellerId(req);
      const settlement = await prisma.sellerSettlement.findFirst({
        where: { fulfillmentOrderId: String(req.params.fulfillmentOrderId), sellerId },
        include: { fulfillmentOrder: { select: { orderNumber: true, listingId: true } } },
      });

      if (!settlement) {
        throw new AppError(404, "No settlement for this order yet", "SETTLEMENT_NOT_FOUND");
      }

      res.json({
        success: true,
        data: {
          ...presentSettlement(settlement),
          orderNumber: settlement.fulfillmentOrder?.orderNumber ?? null,
        },
      });
    }),
  );

  router.get(
    "/seller/settlements/:settlementId",
    security.requireActor,
    validate({ params: settlementParams }),
    asyncHandler(async (req: Request, res: Response) => {
      const sellerId = await resolveSellerId(req);
      const settlement = await prisma.sellerSettlement.findFirst({
        where: { id: String(req.params.settlementId), sellerId },
        include: {
          fulfillmentOrder: { select: { orderNumber: true, listingId: true } },
          adjustments: { orderBy: { createdAt: "desc" } },
        },
      });

      if (!settlement) {
        throw new AppError(404, "Settlement not found", "SETTLEMENT_NOT_FOUND");
      }

      res.json({
        success: true,
        data: {
          ...presentSettlement(settlement),
          orderNumber: settlement.fulfillmentOrder?.orderNumber ?? null,
          adjustments: settlement.adjustments,
        },
      });
    }),
  );

  // -------------------------------------------------------------------------
  // Buyer
  // -------------------------------------------------------------------------

  /**
   * "I have it and it is fine."
   *
   * Recorded, but by default it does not shorten the protection period: the
   * client's rule is seven days after delivery. An admin can opt into early
   * release in the settlement settings.
   */
  router.post(
    "/buyer/orders/:orderId/confirm-receipt",
    security.requireActor,
    validate({ params: z.object({ orderId: identifier }).strict() }),
    idempotent({ scope: "buyer-confirm-receipt" }),
    asyncHandler(async (req: Request, res: Response) => {
      const buyer = await prisma.buyer.findFirst({
        where: { OR: [{ userId: req.actor?.userId }, { id: req.actor?.userId }] },
        select: { id: true },
      });

      if (!buyer) {
        throw new AppError(404, "No buyer profile for this account", "BUYER_NOT_FOUND");
      }

      const result = await confirmBuyerReceipt({
        fulfillmentOrderId: String(req.params.orderId),
        buyerId: buyer.id,
      });

      res.json({ success: true, data: result });
    }),
  );

  // -------------------------------------------------------------------------
  // Admin
  // -------------------------------------------------------------------------

  /** Status totals for the top of the admin settlements page (spec §32). */
  router.get(
    "/admin/settlements/summary",
    security.requireAdminActor(FINANCE_PERMISSIONS.READ),
    asyncHandler(async (_req: Request, res: Response) => {
      const [grouped, openRecoveries, openExceptions] = await Promise.all([
        prisma.sellerSettlement.groupBy({
          by: ["settlementStatus"],
          _sum: { netProceeds: true },
          _count: { _all: true },
        }),
        prisma.settlementRecovery.aggregate({
          where: { status: { in: ["OPEN", "PARTIALLY_RECOVERED"] } },
          _sum: { amountMinor: true, recoveredMinor: true },
          _count: { _all: true },
        }),
        prisma.reconciliationException.count({ where: { status: "OPEN" } }),
      ]);

      const byStatus = Object.fromEntries(
        grouped.map((row) => [row.settlementStatus, { amount: row._sum.netProceeds ?? 0, count: row._count._all }]),
      );

      res.json({
        success: true,
        data: {
          byStatus,
          buckets: SELLER_BALANCE_BUCKETS,
          openRecoveries: {
            count: openRecoveries._count._all,
            outstandingMinor: (
              BigInt(openRecoveries._sum.amountMinor ?? 0) - BigInt(openRecoveries._sum.recoveredMinor ?? 0)
            ).toString(),
          },
          openReconciliationExceptions: openExceptions,
        },
      });
    }),
  );

  router.get(
    "/admin/settlements",
    security.requireAdminActor(FINANCE_PERMISSIONS.READ),
    validate({ query: listQuery }),
    asyncHandler(async (req: Request, res: Response) => {
      const query = req.query as unknown as z.infer<typeof listQuery>;

      const where = {
        ...(query.status ? { settlementStatus: query.status as never } : {}),
        ...(query.sellerId ? { sellerId: query.sellerId } : {}),
        ...(query.orderNumber ? { fulfillmentOrder: { orderNumber: query.orderNumber } } : {}),
        ...(query.from || query.to
          ? {
              createdAt: {
                ...(query.from ? { gte: new Date(query.from) } : {}),
                ...(query.to ? { lte: new Date(query.to) } : {}),
              },
            }
          : {}),
      };

      const [rows, total] = await Promise.all([
        prisma.sellerSettlement.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          include: { fulfillmentOrder: { select: { orderNumber: true } } },
        }),
        prisma.sellerSettlement.count({ where }),
      ]);

      res.json({
        success: true,
        data: rows.map((row) => ({
          ...presentSettlement(row),
          orderNumber: row.fulfillmentOrder?.orderNumber ?? null,
        })),
        pagination: { page: query.page, pageSize: query.pageSize, total },
      });
    }),
  );

  /** Everything about one settlement: fees, ledger, adjustments, audit trail. */
  router.get(
    "/admin/settlements/:settlementId",
    security.requireAdminActor(FINANCE_PERMISSIONS.READ),
    validate({ params: settlementParams }),
    asyncHandler(async (req: Request, res: Response) => {
      const settlementId = String(req.params.settlementId);

      const settlement = await prisma.sellerSettlement.findUnique({
        where: { id: settlementId },
        include: {
          fulfillmentOrder: { select: { orderNumber: true, listingId: true, buyerId: true } },
          adjustments: { orderBy: { createdAt: "desc" } },
          auditLogs: { orderBy: { createdAt: "desc" }, take: 50 },
          recoveries: { orderBy: { createdAt: "desc" } },
        },
      });

      if (!settlement) {
        throw new AppError(404, "Settlement not found", "SETTLEMENT_NOT_FOUND");
      }

      const [ledger, transfer, eligibility] = await Promise.all([
        prisma.ledgerTransaction.findMany({
          where: { referenceType: "SETTLEMENT", referenceId: settlementId },
          include: { entries: true },
          orderBy: { occurredAt: "asc" },
        }),
        prisma.payoutTransfer.findUnique({ where: { settlementId } }),
        evaluateEligibility(settlementId).catch(() => null),
      ]);

      res.json({
        success: true,
        data: {
          ...presentSettlement(settlement),
          orderNumber: settlement.fulfillmentOrder?.orderNumber ?? null,
          adjustments: settlement.adjustments,
          recoveries: settlement.recoveries.map((recovery) => ({
            ...recovery,
            amountMinor: recovery.amountMinor.toString(),
            recoveredMinor: recovery.recoveredMinor.toString(),
          })),
          auditTrail: settlement.auditLogs,
          eligibility,
          transfer: transfer
            ? {
                ...transfer,
                amountMinor: transfer.amountMinor.toString(),
                reversedAmountMinor: transfer.reversedAmountMinor.toString(),
              }
            : null,
          ledger: ledger.map((transaction) => ({
            id: transaction.id,
            kind: transaction.kind,
            description: transaction.description,
            occurredAt: transaction.occurredAt,
            entries: transaction.entries.map((entry) => ({
              account: entry.account,
              direction: entry.direction,
              amountMinor: entry.amountMinor.toString(),
              currency: entry.currency,
            })),
          })),
        },
      });
    }),
  );

  router.post(
    "/admin/settlements/:settlementId/freeze",
    security.requireAdminActor(FINANCE_PERMISSIONS.MANAGE),
    validate({ params: settlementParams, body: freezeBody }),
    idempotent({ scope: "settlement-freeze" }),
    asyncHandler(async (req: Request, res: Response) => {
      const result = await freezeSettlement({
        settlementId: String(req.params.settlementId),
        reason: req.body.reason,
        note: req.body.note,
        actor: adminActor(req),
      });

      res.json({
        success: result.changed,
        data: { status: result.settlement?.settlementStatus, reason: result.refusedReason ?? null },
      });
    }),
  );

  router.post(
    "/admin/settlements/:settlementId/unfreeze",
    security.requireAdminActor(FINANCE_PERMISSIONS.MANAGE),
    validate({ params: settlementParams, body: noteBody }),
    idempotent({ scope: "settlement-unfreeze" }),
    asyncHandler(async (req: Request, res: Response) => {
      const result = await unfreezeSettlement({
        settlementId: String(req.params.settlementId),
        note: req.body.note,
        actor: adminActor(req),
      });

      res.json({
        success: result.changed,
        data: { status: result.settlement?.settlementStatus, reason: result.refusedReason ?? null },
      });
    }),
  );

  /**
   * Release a settlement early, or re-run its checks now.
   *
   * It still has to pass every eligibility check: this skips the wait for the
   * worker, not the rules.
   */
  router.post(
    "/admin/settlements/:settlementId/release",
    security.requireAdminActor(FINANCE_PERMISSIONS.MANAGE),
    validate({ params: settlementParams }),
    idempotent({ scope: "settlement-release" }),
    asyncHandler(async (req: Request, res: Response) => {
      const result = await releaseIfEligible(String(req.params.settlementId));
      res.json({
        success: result.changed,
        data: {
          status: result.settlement?.settlementStatus ?? null,
          eligibility: result.eligibility,
          reason: result.refusedReason ?? null,
        },
      });
    }),
  );

  router.post(
    "/admin/settlements/:settlementId/adjust",
    security.requireAdminActor(FINANCE_PERMISSIONS.MANAGE),
    validate({ params: settlementParams, body: adjustBody }),
    idempotent({ scope: "settlement-adjust" }),
    asyncHandler(async (req: Request, res: Response) => {
      const settlement = await adjustSettlement({
        settlementId: String(req.params.settlementId),
        adjustmentAmount: req.body.adjustmentAmount,
        reason: req.body.reason,
        actor: adminActor(req),
      });

      res.json({ success: true, data: presentSettlement(settlement) });
    }),
  );

  router.post(
    "/admin/settlements/:settlementId/actual-shipping",
    security.requireAdminActor(FINANCE_PERMISSIONS.MANAGE),
    validate({ params: settlementParams, body: shippingBody }),
    idempotent({ scope: "settlement-actual-shipping" }),
    asyncHandler(async (req: Request, res: Response) => {
      const settlement = await recordActualShipping({
        settlementId: String(req.params.settlementId),
        actualShipping: req.body.actualShipping,
        actor: adminActor(req),
      });

      res.json({ success: true, data: presentSettlement(settlement) });
    }),
  );

  /**
   * Force a Stripe transfer now.
   *
   * Bypasses the admin `automaticPayoutEnabled` toggle but not the env flag:
   * an operator can push one settlement through a business-level pause, but
   * nobody can push money through the engineering kill switch.
   */
  router.post(
    "/admin/settlements/:settlementId/transfer",
    security.requireAdminActor(FINANCE_PERMISSIONS.PAYOUTS),
    validate({ params: settlementParams }),
    idempotent({ scope: "settlement-transfer" }),
    asyncHandler(async (req: Request, res: Response) => {
      const result = await transferSettlement(String(req.params.settlementId), {
        actor: adminActor(req),
        force: true,
      });
      res.json({ success: result.status === "TRANSFERRED", data: result });
    }),
  );

  /** The D3 manual override: the seller was paid by bank transfer. */
  router.post(
    "/admin/settlements/:settlementId/manual-payout",
    security.requireAdminActor(FINANCE_PERMISSIONS.PAYOUTS),
    validate({ params: settlementParams, body: manualPayoutBody }),
    idempotent({ scope: "settlement-manual-payout" }),
    asyncHandler(async (req: Request, res: Response) => {
      const result = await recordManualPayout({
        settlementId: String(req.params.settlementId),
        reference: req.body.reference,
        note: req.body.note,
        actor: adminActor(req),
      });

      res.json({ success: result.status === "TRANSFERRED", data: result });
    }),
  );

  /** Why has this not paid out? Answered in full, not as a boolean. */
  router.get(
    "/admin/settlements/:settlementId/eligibility",
    security.requireAdminActor(FINANCE_PERMISSIONS.READ),
    validate({ params: settlementParams }),
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ success: true, data: await evaluateEligibility(String(req.params.settlementId)) });
    }),
  );

  /** Outstanding seller debts, for the finance page. */
  router.get(
    "/admin/settlement-recoveries",
    security.requireAdminActor(FINANCE_PERMISSIONS.READ),
    asyncHandler(async (_req: Request, res: Response) => {
      const rows = await prisma.settlementRecovery.findMany({
        where: { status: { in: ["OPEN", "PARTIALLY_RECOVERED"] } },
        orderBy: { createdAt: "asc" },
        take: 200,
      });

      res.json({
        success: true,
        data: rows.map((row) => ({
          ...row,
          amountMinor: row.amountMinor.toString(),
          recoveredMinor: row.recoveredMinor.toString(),
        })),
      });
    }),
  );

  return router;
}
