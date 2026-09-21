/**
 * Seller settlements — what the platform owes each seller, and when.
 *
 * The shape of the flow, in one place:
 *
 *   payment recorded  → settlement PENDING → ON_HOLD (delivery confirmed)
 *                     → ELIGIBLE (window passed, every check clear)
 *                     → TRANSFER_PENDING → TRANSFERRED → PAID_OUT
 *
 * Two properties this file exists to guarantee:
 *
 *   1. **One writer per transition.** Every state change goes through
 *      `transitionSettlement`, which uses an atomic `updateMany ... WHERE
 *      status IN (from)`. Two workers racing on the same settlement produce
 *      exactly one winner, and the loser is told it lost rather than going on
 *      to create a second transfer.
 *   2. **The ledger, the audit row and the outbox event land with the state
 *      change or not at all.** They are written in the same database
 *      transaction, so there is no state the books disagree with.
 *
 * The seller's balance is derived from these rows, never stored. The mutable
 * counters on SellerWallet duplicated this and drifted from it, so they are no
 * longer read.
 */
import type { Prisma, SettlementStatus } from "@prisma/client";
import { recordAudit } from "../../core/audit.js";
import { AppError } from "../../core/errors/AppError.js";
import { logger } from "../../core/logger.js";
import { toMinorUnits } from "../../core/money.js";
import { enqueueOutboxEvent, TXN_EVENTS, type TxnEventType } from "../../core/outbox.js";
import { type PrismaTransaction, prisma } from "../../core/prisma.js";
import { FeeEngineService } from "../fees/feeEngine.service.js";
import { postTransaction } from "../ledger/ledger.service.js";
import { getSettlementConfig } from "../settings/settlementConfig.service.js";
import {
  ALLOWED_TRANSITIONS,
  type EligibilityCheck,
  SELLER_BALANCE_BUCKETS,
  type SellerBalances,
  type SettlementActor,
  SYSTEM_ACTOR,
} from "./settlement.types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** `SET-2026-12345`, or `SET-TA-…` for TradeAuct's own stock. */
async function generateSettlementNumber(tx: PrismaTransaction, tradeAuctOwned: boolean): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = tradeAuctOwned ? "SET-TA" : "SET";

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = `${prefix}-${year}-${Math.floor(10000 + Math.random() * 90000)}`;
    const taken = await tx.sellerSettlement.findUnique({
      where: { settlementNumber: candidate },
      select: { id: true },
    });
    if (!taken) return candidate;
  }

  return `${prefix}-${year}-${Date.now().toString().slice(-8)}`;
}

export type TransitionInput = {
  settlementId: string;
  /** The states this move is legal from. An empty match means someone else won. */
  from: readonly SettlementStatus[];
  to: SettlementStatus;
  reason: string;
  actor?: SettlementActor;
  /** Extra columns written in the same statement as the status. */
  data?: Prisma.SellerSettlementUncheckedUpdateManyInput;
  /** Emitted alongside SETTLEMENT_STATUS_CHANGED. */
  event?: { type: TxnEventType; payload?: Record<string, unknown> };
  /** Ledger lines to post with the move, if it shifts money between accounts. */
  ledger?: (settlement: SettlementRow) => Parameters<typeof postTransaction>[0] | null;
};

export type SettlementRow = Prisma.SellerSettlementGetPayload<Record<string, never>>;

export type TransitionResult = {
  changed: boolean;
  settlement: SettlementRow | null;
  /** Set when the move was refused rather than lost to a race. */
  refusedReason?: string;
};

/**
 * Move one settlement from one state to another, atomically.
 *
 * Pass `tx` when the caller already owns a transaction — the refund path does,
 * because a refund and a transfer must not interleave.
 */
export async function transitionSettlement(input: TransitionInput, tx?: PrismaTransaction): Promise<TransitionResult> {
  const run = async (db: PrismaTransaction): Promise<TransitionResult> => {
    const before = await db.sellerSettlement.findUnique({ where: { id: input.settlementId } });
    if (!before) {
      throw new AppError(404, `Settlement ${input.settlementId} not found`, "SETTLEMENT_NOT_FOUND");
    }

    // Already there. Treated as success so a retried worker is a no-op rather
    // than an error the operator has to look at.
    if (before.settlementStatus === input.to) {
      return { changed: false, settlement: before };
    }

    const legal = ALLOWED_TRANSITIONS[before.settlementStatus] ?? [];
    if (!legal.includes(input.to)) {
      return {
        changed: false,
        settlement: before,
        refusedReason: `${before.settlementStatus} → ${input.to} is not a legal settlement transition`,
      };
    }

    // The claim. Only one caller can match a row still in `from`.
    const claimed = await db.sellerSettlement.updateMany({
      where: { id: input.settlementId, settlementStatus: { in: [...input.from] } },
      data: { ...input.data, settlementStatus: input.to },
    });

    if (claimed.count === 0) {
      return {
        changed: false,
        settlement: before,
        refusedReason: `Settlement is ${before.settlementStatus}, not one of ${input.from.join(", ")}`,
      };
    }

    const after = (await db.sellerSettlement.findUnique({ where: { id: input.settlementId } })) as SettlementRow;

    const lines = input.ledger?.(after) ?? null;
    if (lines) {
      const ledgerTransactionId = await postTransaction(lines, db);
      logger.debug("Settlement ledger posted", { settlementId: after.id, ledgerTransactionId });
    }

    await db.financialAuditLog.create({
      data: {
        action: `SETTLEMENT_${input.to}`,
        entityType: "SETTLEMENT",
        entityId: after.id,
        settlementId: after.id,
        amount: after.netProceeds,
        previousState: { settlementStatus: before.settlementStatus } as never,
        newState: { settlementStatus: after.settlementStatus } as never,
        reason: input.reason,
        performedById: input.actor?.id ?? null,
        performedByRole: input.actor?.type ?? "SYSTEM",
      },
    });

    await enqueueOutboxEvent(db, TXN_EVENTS.SETTLEMENT_STATUS_CHANGED, {
      settlementId: after.id,
      settlementNumber: after.settlementNumber,
      sellerId: after.sellerId,
      fulfillmentOrderId: after.fulfillmentOrderId,
      paymentId: after.paymentId,
      fromStatus: before.settlementStatus,
      toStatus: after.settlementStatus,
      netProceeds: after.netProceeds,
      currency: after.currency,
      reason: input.reason,
    });

    if (input.event) {
      await enqueueOutboxEvent(db, input.event.type, {
        settlementId: after.id,
        sellerId: after.sellerId,
        ...input.event.payload,
      });
    }

    return { changed: true, settlement: after };
  };

  const result = tx ? await run(tx) : await prisma.$transaction(run);

  if (result.changed) {
    logger.info("Settlement transitioned", {
      settlementId: input.settlementId,
      to: input.to,
      reason: input.reason,
    });
    // Outside the transaction: an audit failure must never undo the money.
    await recordAudit({
      action: `SETTLEMENT_${input.to}`,
      entityType: "SETTLEMENT",
      entityId: input.settlementId,
      actorType: input.actor?.type ?? "SYSTEM",
      actorId: input.actor?.id ?? null,
      ip: input.actor?.ip ?? null,
      reason: input.reason,
      after: { status: input.to },
    });
  } else if (result.refusedReason) {
    logger.warn("Settlement transition refused", {
      settlementId: input.settlementId,
      to: input.to,
      reason: result.refusedReason,
    });
  }

  return result;
}

export type CreateSettlementInput = {
  paymentId: string;
  sellerId: string | null;
  listingId: string;
  /** The hammer or Buy Now price. Never the customer total. */
  salePrice: number;
  currency: string;
  /** Shipping the buyer was quoted, used when the seller is the payer. */
  estimatedShipping: number;
};

/**
 * Create the settlement for a payment that has just been recorded as paid.
 *
 * Called from inside payment finalization's own transaction, so a paid order
 * can never exist without one. Keyed on `paymentId`: a re-delivered Stripe
 * event finds the existing row and returns it.
 *
 * The listing's fee snapshot is copied onto the settlement here. That copy is
 * what every later calculation reads, so an admin changing the fee matrix
 * tomorrow cannot move this order.
 */
export async function createSettlementForPayment(
  input: CreateSettlementInput,
  tx: PrismaTransaction,
): Promise<SettlementRow | null> {
  const existing = await tx.sellerSettlement.findUnique({ where: { paymentId: input.paymentId } });
  if (existing) return existing;

  const listing = await tx.listing.findUnique({
    where: { id: input.listingId },
    include: { auction: true },
  });

  if (!listing) {
    throw new AppError(404, `Listing ${input.listingId} not found for settlement`, "LISTING_NOT_FOUND");
  }

  const sellerId = input.sellerId ?? listing.sellerId;
  const isTradeAuctOwned = String(listing.ownerType).toUpperCase() === "TRADEAUCT" || !sellerId;

  if (!sellerId) {
    // TradeAuct's own stock with no seller row to settle against. The money
    // stays with the platform; there is nothing to track.
    logger.info("No settlement created: the listing has no seller", { listingId: input.listingId });
    return null;
  }

  const feeConfig = await FeeEngineService.getAuthoritativeFeeConfig();
  // The auction carries the snapshot for an auction sale; the listing for a
  // direct one. resolveListingFeeSnapshot prefers whichever is present.
  const snapshot = FeeEngineService.resolveListingFeeSnapshot(
    listing.auction ? { ...listing.auction, listing } : listing,
    feeConfig,
  );

  const fees = FeeEngineService.calculateOrderFees({
    snapshot,
    salePrice: input.salePrice,
    currency: input.currency,
  });

  const shippingPayer = listing.shippingPayer;
  const payout = FeeEngineService.calculateSellerPayoutBreakdown({
    saleAmount: input.salePrice,
    snapshot,
    shippingPayer,
    estimatedShipping: input.estimatedShipping,
    currency: input.currency,
  });

  // TradeAuct-owned stock settles to itself: the full amount is already in the
  // platform's account, so the settlement exists for the audit trail only and
  // is born paid.
  const netProceeds = isTradeAuctOwned ? 0 : payout.sellerNetPayout;
  const settlementNumber = await generateSettlementNumber(tx, isTradeAuctOwned);

  const settlement = await tx.sellerSettlement.create({
    data: {
      settlementNumber,
      paymentId: input.paymentId,
      sellerId,
      saleAmount: input.salePrice,
      currency: input.currency,

      platformFeeRate: isTradeAuctOwned ? 0 : fees.sellerFeeRate,
      platformFeeType: isTradeAuctOwned ? "TRADEAUCT_OWNED" : fees.sellingMethod,
      platformFee: isTradeAuctOwned ? 0 : fees.sellerFeeAmount,

      feeRuleType: fees.sellingMethod,
      feeConfigurationVersion: fees.feeRuleVersion,
      sellerFeePercent: isTradeAuctOwned ? 0 : fees.sellerFeeRate,
      buyerFeePercent: fees.buyerFeeRate,
      sellerFeeAmount: isTradeAuctOwned ? 0 : fees.sellerFeeAmount,
      buyerFeeAmount: fees.buyerFeeAmount,
      feeCalculatedAt: fees.calculatedAt,

      shippingPayer,
      estimatedShipping: input.estimatedShipping,
      actualShipping: 0,
      actualShippingKnown: false,

      otherDeductions: 0,
      refundAmount: 0,
      adjustmentAmount: 0,
      netProceeds,

      settlementStatus: isTradeAuctOwned ? "PAID_OUT" : "PENDING",
      payoutStatus: isTradeAuctOwned ? "PAID" : "UNPAID",
      ...(isTradeAuctOwned ? { paidOutAt: new Date(), payoutMethod: "TRADEAUCT_OWNED", settledAt: new Date() } : {}),
    },
  });

  // The charge posting credited SELLER_PAYABLE with the whole sale price. The
  // seller's commission is TradeAuct's revenue, so it moves across now; what
  // is left in SELLER_PAYABLE is exactly the sum of settlement net.
  const commissionMinor = toMinorUnits(isTradeAuctOwned ? input.salePrice : fees.sellerFeeAmount, input.currency);
  if (commissionMinor > 0n) {
    await postTransaction(
      {
        kind: "FEE",
        referenceType: "SETTLEMENT",
        referenceId: settlement.id,
        currency: input.currency,
        description: isTradeAuctOwned
          ? `TradeAuct-owned sale ${settlement.settlementNumber}`
          : `Seller commission ${fees.sellerFeeRate}% on ${settlement.settlementNumber}`,
        lines: [
          {
            account: "SELLER_PAYABLE",
            direction: "DEBIT",
            amountMinor: commissionMinor,
            sellerId,
            paymentId: input.paymentId,
          },
          {
            account: "PLATFORM_FEE_REVENUE",
            direction: "CREDIT",
            amountMinor: commissionMinor,
            sellerId,
            paymentId: input.paymentId,
          },
        ],
      },
      tx,
    );
  }

  await tx.financialAuditLog.create({
    data: {
      action: isTradeAuctOwned ? "TRADEAUCT_INVENTORY_SETTLED" : "SETTLEMENT_CREATED",
      entityType: "SETTLEMENT",
      entityId: settlement.id,
      settlementId: settlement.id,
      amount: input.salePrice,
      newState: {
        settlementNumber,
        feeRuleType: fees.sellingMethod,
        feeConfigurationVersion: fees.feeRuleVersion,
        sellerFeePercent: fees.sellerFeeRate,
        sellerFeeAmount: fees.sellerFeeAmount,
        netProceeds,
      } as never,
      reason: `Settlement created for payment ${input.paymentId}`,
      performedById: null,
      performedByRole: "SYSTEM",
    },
  });

  await enqueueOutboxEvent(tx, TXN_EVENTS.SETTLEMENT_CREATED, {
    settlementId: settlement.id,
    settlementNumber,
    sellerId,
    paymentId: input.paymentId,
    listingId: input.listingId,
    saleAmount: input.salePrice,
    netProceeds,
    currency: input.currency,
    feeRuleType: fees.sellingMethod,
    isTradeAuctOwned,
  });

  logger.info("Settlement created", {
    settlementId: settlement.id,
    settlementNumber,
    sellerId,
    netProceeds,
    feeRuleType: fees.sellingMethod,
  });

  return settlement;
}

/** Attach the fulfilment order once the main server has created it. */
export async function linkFulfillmentOrder(paymentId: string, fulfillmentOrderId: string): Promise<void> {
  const settlement = await prisma.sellerSettlement.findUnique({ where: { paymentId } });
  if (!settlement) {
    logger.warn("No settlement to link to the fulfilment order", { paymentId, fulfillmentOrderId });
    return;
  }

  if (settlement.fulfillmentOrderId === fulfillmentOrderId) return;

  await prisma.sellerSettlement.update({
    where: { id: settlement.id },
    data: { fulfillmentOrderId },
  });

  logger.info("Settlement linked to its fulfilment order", { settlementId: settlement.id, fulfillmentOrderId });
}

/**
 * Delivery confirmed: start the protection window.
 *
 * The configured period is snapshotted onto the settlement here. An admin
 * changing it afterwards therefore cannot move an order that is already
 * counting down, which is the plan's answer to Q2.
 */
export async function recordDelivery(input: {
  fulfillmentOrderId?: string | null;
  paymentId?: string | null;
  deliveredAt: Date;
  source: string;
  actor?: SettlementActor;
}): Promise<TransitionResult> {
  const settlement = await findSettlement(input);
  if (!settlement) {
    throw new AppError(404, "No settlement for this order", "SETTLEMENT_NOT_FOUND");
  }

  const config = await getSettlementConfig();
  const eligibleAt = new Date(input.deliveredAt.getTime() + config.protectionPeriodDays * DAY_MS);

  return prisma.$transaction(async (tx) => {
    /**
     * Record the delivery first, whatever state the settlement is in.
     *
     * This is deliberately separate from the status change. A settlement can
     * already be FROZEN or DISPUTED when the courier delivers - a buyer can
     * open a return before the item arrives, and an admin can hold an
     * undelivered order - and the status change is refused in those cases,
     * correctly, because delivery does not clear a return.
     *
     * But the delivery still happened, and the protection window runs from
     * it. Writing the date only inside the status change meant that a
     * settlement frozen at the moment of delivery lost its delivery date
     * permanently: the command carries `jobId = delivered:<orderId>`, so it
     * never fires again, and the settlement sat in PENDING with no clock,
     * never to be paid.
     *
     * Guarded on `deliveredAt: null` so a replayed command cannot restart a
     * window that is already running.
     */
    await tx.sellerSettlement.updateMany({
      where: { id: settlement.id, deliveredAt: null },
      data: {
        deliveredAt: input.deliveredAt,
        deliverySource: input.source,
        protectionPeriodDays: config.protectionPeriodDays,
        protectionExpiresAt: eligibleAt,
        eligibleAt,
      },
    });

    return transitionSettlement(
      {
        settlementId: settlement.id,
        // Only an undelivered, unencumbered settlement starts its window now.
        // A frozen one keeps its date and moves to ON_HOLD when it is
        // unfrozen; a disputed one when the dispute is won.
        from: ["PENDING"],
        to: "ON_HOLD",
        reason: `Delivery confirmed via ${input.source}; ${config.protectionPeriodDays}-day protection period started`,
        actor: input.actor ?? SYSTEM_ACTOR,
      },
      tx,
    );
  });
}

/**
 * Every condition from spec §14, evaluated together.
 *
 * Returns the reasons as well as the verdict: an admin asking "why has this
 * not paid out" should get an answer, not a boolean.
 */
export async function evaluateEligibility(settlementId: string): Promise<EligibilityCheck> {
  const settlement = await prisma.sellerSettlement.findUnique({
    where: { id: settlementId },
    include: {
      fulfillmentOrder: { include: { disputeCase: true } },
    },
  });

  if (!settlement) {
    throw new AppError(404, `Settlement ${settlementId} not found`, "SETTLEMENT_NOT_FOUND");
  }

  const config = await getSettlementConfig();
  const payment = settlement.paymentId
    ? await prisma.payment.findUnique({ where: { id: settlement.paymentId }, select: { status: true } })
    : null;

  const now = Date.now();
  const disputeCase = settlement.fulfillmentOrder?.disputeCase ?? null;

  const cardDispute = settlement.paymentId
    ? await prisma.stripeDispute.findFirst({
        where: { paymentId: settlement.paymentId, status: { notIn: ["WON", "CLOSED"] } },
        select: { id: true },
      })
    : null;

  const checks = {
    paymentSucceeded: payment ? payment.status === "PAID" : Boolean(settlement.deliveredAt),
    deliveryConfirmed: Boolean(settlement.deliveredAt),
    protectionPeriodCompleted: Boolean(settlement.eligibleAt && settlement.eligibleAt.getTime() <= now),
    noActiveReturn: settlement.frozenReason !== "RETURN",
    noActiveDispute:
      settlement.settlementStatus !== "DISPUTED" && !cardDispute && (!disputeCase || disputeCase.status === "RESOLVED"),
    noUnresolvedIssue: settlement.settlementStatus !== "FROZEN",
    notAlreadyTransferred: !["TRANSFER_PENDING", "TRANSFERRED", "PAID_OUT"].includes(settlement.settlementStatus),
    automaticSettlementEnabled: config.automaticSettlementEnabled,
  };

  // An early release is allowed only when the admin has turned it on. The
  // client's rule is 7 days after delivery, full stop.
  if (
    !checks.protectionPeriodCompleted &&
    config.allowEarlyReleaseOnBuyerConfirmation &&
    settlement.receiptConfirmedAt
  ) {
    checks.protectionPeriodCompleted = true;
  }

  const reasons: string[] = [];
  if (!checks.paymentSucceeded) reasons.push("The buyer's payment is not settled");
  if (!checks.deliveryConfirmed) reasons.push("Delivery has not been confirmed");
  if (!checks.protectionPeriodCompleted) {
    reasons.push(
      settlement.eligibleAt
        ? `The protection period runs until ${settlement.eligibleAt.toISOString()}`
        : "The protection period has not started",
    );
  }
  if (!checks.noActiveReturn) reasons.push("A return is in progress");
  if (!checks.noActiveDispute) reasons.push("A dispute is open");
  if (!checks.noUnresolvedIssue) reasons.push(`Frozen: ${settlement.frozenReason ?? "unresolved issue"}`);
  if (!checks.notAlreadyTransferred) reasons.push(`Already ${settlement.settlementStatus}`);
  if (!checks.automaticSettlementEnabled) reasons.push("Automatic settlement is switched off");

  return { eligible: reasons.length === 0, reasons, checks };
}

/**
 * Promote one settlement to ELIGIBLE if everything checks out.
 *
 * The check runs immediately before the move, not when the job was queued: a
 * dispute that opened in between must still stop it.
 */
export async function releaseIfEligible(
  settlementId: string,
): Promise<TransitionResult & { eligibility: EligibilityCheck }> {
  const eligibility = await evaluateEligibility(settlementId);

  if (!eligibility.eligible) {
    return { changed: false, settlement: null, refusedReason: eligibility.reasons.join("; "), eligibility };
  }

  const result = await transitionSettlement({
    settlementId,
    from: ["ON_HOLD"],
    to: "ELIGIBLE",
    reason: "Protection period completed with no return, dispute or unresolved issue",
    actor: SYSTEM_ACTOR,
    data: { settledAt: new Date() },
    event: { type: TXN_EVENTS.SETTLEMENT_ELIGIBLE },
  });

  return { ...result, eligibility };
}

/**
 * The buyer says the item arrived and is fine.
 *
 * By default this does not release anything: the client's rule is seven days
 * after delivery, full stop (plan Q1). The timestamp is recorded because an
 * admin may switch `allowEarlyReleaseOnBuyerConfirmation` on, and because it
 * is useful evidence if the order is disputed later.
 */
export async function confirmBuyerReceipt(input: {
  fulfillmentOrderId: string;
  buyerId: string;
}): Promise<{ settlementId: string; releasedEarly: boolean; status: SettlementStatus }> {
  const settlement = await prisma.sellerSettlement.findUnique({
    where: { fulfillmentOrderId: input.fulfillmentOrderId },
    include: { fulfillmentOrder: { include: { disputeCase: true } } },
  });

  if (!settlement) {
    throw new AppError(404, "No settlement for this order", "SETTLEMENT_NOT_FOUND");
  }

  if (settlement.fulfillmentOrder?.buyerId !== input.buyerId) {
    throw new AppError(403, "This is not your order", "NOT_YOUR_ORDER");
  }

  const disputeCase = settlement.fulfillmentOrder?.disputeCase;
  if (disputeCase && disputeCase.status !== "RESOLVED") {
    throw new AppError(400, "There is an open dispute on this order", "ACTIVE_DISPUTE");
  }

  await prisma.sellerSettlement.update({
    where: { id: settlement.id },
    data: { receiptConfirmedAt: new Date() },
  });

  const config = await getSettlementConfig();
  if (!config.allowEarlyReleaseOnBuyerConfirmation) {
    return { settlementId: settlement.id, releasedEarly: false, status: settlement.settlementStatus };
  }

  const released = await releaseIfEligible(settlement.id);
  return {
    settlementId: settlement.id,
    releasedEarly: released.changed,
    status: released.settlement?.settlementStatus ?? settlement.settlementStatus,
  };
}

/** Candidates for the release worker: delivered, window passed, still held. */
export async function findReleaseCandidates(limit = 100): Promise<string[]> {
  const rows = await prisma.sellerSettlement.findMany({
    where: {
      settlementStatus: "ON_HOLD",
      eligibleAt: { lte: new Date() },
    },
    orderBy: { eligibleAt: "asc" },
    take: limit,
    select: { id: true },
  });

  return rows.map((row) => row.id);
}

/** Admin hold. Remembers where the settlement came from so it can go back. */
export async function freezeSettlement(input: {
  settlementId: string;
  reason: "ADMIN_HOLD" | "RETURN" | "BUYER_DISPUTE_CASE" | "UNRESOLVED_ISSUE" | "RECONCILIATION_EXCEPTION";
  note: string;
  actor: SettlementActor;
}): Promise<TransitionResult> {
  const settlement = await prisma.sellerSettlement.findUnique({ where: { id: input.settlementId } });
  if (!settlement) {
    throw new AppError(404, `Settlement ${input.settlementId} not found`, "SETTLEMENT_NOT_FOUND");
  }

  return transitionSettlement({
    settlementId: input.settlementId,
    from: ["PENDING", "ON_HOLD", "ELIGIBLE", "TRANSFER_FAILED"],
    to: "FROZEN",
    reason: input.note,
    actor: input.actor,
    data: {
      frozenReason: input.reason,
      frozenFromStatus: settlement.settlementStatus,
      frozenAt: new Date(),
      holdReason: input.note,
      holdPlacedById: input.actor.id ?? null,
      holdPlacedAt: new Date(),
    },
    event: { type: TXN_EVENTS.SETTLEMENT_FROZEN, payload: { frozenReason: input.reason, note: input.note } },
  });
}

/**
 * Lift a freeze.
 *
 * The settlement returns to the state it was frozen from and is then
 * re-evaluated, so a window that expired while it was held pays out on the
 * next worker pass rather than immediately.
 */
export async function unfreezeSettlement(input: {
  settlementId: string;
  note: string;
  actor: SettlementActor;
}): Promise<TransitionResult> {
  const settlement = await prisma.sellerSettlement.findUnique({ where: { id: input.settlementId } });
  if (!settlement) {
    throw new AppError(404, `Settlement ${input.settlementId} not found`, "SETTLEMENT_NOT_FOUND");
  }

  if (settlement.settlementStatus !== "FROZEN") {
    throw new AppError(409, `Settlement is ${settlement.settlementStatus}, not frozen`, "SETTLEMENT_NOT_FROZEN");
  }

  /**
   * Where it goes back to depends on whether the item has been delivered, not
   * on where it was frozen from.
   *
   * An order frozen before delivery and delivered while frozen belongs in
   * ON_HOLD with its window running - keying off `frozenFromStatus` would send
   * it back to PENDING, where nothing would ever move it again.
   *
   * Nothing returns straight to ELIGIBLE: whatever caused the freeze means
   * every check runs again from the top.
   */
  const restoreTo: SettlementStatus = settlement.deliveredAt ? "ON_HOLD" : "PENDING";

  return transitionSettlement({
    settlementId: input.settlementId,
    from: ["FROZEN"],
    to: restoreTo,
    reason: input.note,
    actor: input.actor,
    data: {
      frozenReason: null,
      frozenFromStatus: null,
      frozenAt: null,
      holdReason: null,
      holdPlacedById: null,
      holdPlacedAt: null,
    },
  });
}

/**
 * Change the net amount by an explicit, audited adjustment.
 *
 * Never a bare update: the previous and new net are both recorded, and the
 * ledger moves the difference, so the books still reconcile afterwards.
 */
export async function adjustSettlement(input: {
  settlementId: string;
  adjustmentAmount: number;
  reason: string;
  actor: SettlementActor;
}): Promise<SettlementRow> {
  if (!Number.isFinite(input.adjustmentAmount) || input.adjustmentAmount === 0) {
    throw new AppError(400, "An adjustment must be a non-zero amount", "ADJUSTMENT_INVALID");
  }

  return prisma.$transaction(async (tx) => {
    const settlement = await tx.sellerSettlement.findUnique({ where: { id: input.settlementId } });
    if (!settlement) {
      throw new AppError(404, `Settlement ${input.settlementId} not found`, "SETTLEMENT_NOT_FOUND");
    }

    if (["TRANSFER_PENDING", "TRANSFERRED", "PAID_OUT"].includes(settlement.settlementStatus)) {
      throw new AppError(
        409,
        `Settlement is ${settlement.settlementStatus}; adjust it with a recovery instead`,
        "SETTLEMENT_ALREADY_TRANSFERRED",
      );
    }

    const previousNet = settlement.netProceeds;
    const newNet = Math.max(0, round2(previousNet + input.adjustmentAmount));
    const deltaMinor = toMinorUnits(Math.abs(round2(newNet - previousNet)), settlement.currency);

    const updated = await tx.sellerSettlement.update({
      where: { id: settlement.id },
      data: {
        netProceeds: newNet,
        adjustmentAmount: round2(settlement.adjustmentAmount + input.adjustmentAmount),
      },
    });

    await tx.settlementAdjustment.create({
      data: {
        settlementId: settlement.id,
        adminId: input.actor.id ?? "SYSTEM",
        previousNet,
        adjustmentAmount: input.adjustmentAmount,
        newNet,
        reason: input.reason,
      },
    });

    if (deltaMinor > 0n) {
      const sellerGains = newNet > previousNet;
      await postTransaction(
        {
          kind: "ADJUSTMENT",
          referenceType: "SETTLEMENT",
          referenceId: settlement.id,
          currency: settlement.currency,
          description: `Settlement adjustment: ${input.reason}`,
          lines: sellerGains
            ? [
                {
                  account: "PLATFORM_FEE_REVENUE",
                  direction: "DEBIT",
                  amountMinor: deltaMinor,
                  sellerId: settlement.sellerId,
                },
                {
                  account: "SELLER_PAYABLE",
                  direction: "CREDIT",
                  amountMinor: deltaMinor,
                  sellerId: settlement.sellerId,
                },
              ]
            : [
                {
                  account: "SELLER_PAYABLE",
                  direction: "DEBIT",
                  amountMinor: deltaMinor,
                  sellerId: settlement.sellerId,
                },
                {
                  account: "PLATFORM_FEE_REVENUE",
                  direction: "CREDIT",
                  amountMinor: deltaMinor,
                  sellerId: settlement.sellerId,
                },
              ],
        },
        tx,
      );
    }

    await tx.financialAuditLog.create({
      data: {
        action: "SETTLEMENT_ADJUSTED",
        entityType: "SETTLEMENT",
        entityId: settlement.id,
        settlementId: settlement.id,
        amount: input.adjustmentAmount,
        previousState: { netProceeds: previousNet } as never,
        newState: { netProceeds: newNet } as never,
        reason: input.reason,
        performedById: input.actor.id ?? null,
        performedByRole: input.actor.type,
      },
    });

    return updated;
  });
}

/**
 * Record what shipping actually cost, once DHL has billed it.
 *
 * Only matters when the seller is the payer — otherwise the buyer already paid
 * it and the seller's net does not move.
 */
export async function recordActualShipping(input: {
  settlementId: string;
  actualShipping: number;
  actor: SettlementActor;
}): Promise<SettlementRow> {
  const settlement = await prisma.sellerSettlement.findUnique({ where: { id: input.settlementId } });
  if (!settlement) {
    throw new AppError(404, `Settlement ${input.settlementId} not found`, "SETTLEMENT_NOT_FOUND");
  }

  if (settlement.shippingPayer !== "SELLER") {
    // Recorded for the statement, but it changes nothing the seller receives.
    return prisma.sellerSettlement.update({
      where: { id: settlement.id },
      data: { actualShipping: input.actualShipping, actualShippingKnown: true },
    });
  }

  const delta = round2(input.actualShipping - settlement.estimatedShipping);
  await prisma.sellerSettlement.update({
    where: { id: settlement.id },
    data: { actualShipping: input.actualShipping, actualShippingKnown: true },
  });

  if (delta === 0) {
    return (await prisma.sellerSettlement.findUnique({ where: { id: settlement.id } })) as SettlementRow;
  }

  return adjustSettlement({
    settlementId: settlement.id,
    adjustmentAmount: -delta,
    reason: `Actual shipping ${input.actualShipping} replaces the estimate ${settlement.estimatedShipping}`,
    actor: input.actor,
  });
}

/** The seller dashboard's buckets, summed straight from the settlements. */
export async function getSellerBalances(sellerId: string): Promise<SellerBalances> {
  const [grouped, recoveries] = await Promise.all([
    prisma.sellerSettlement.groupBy({
      by: ["settlementStatus"],
      where: { sellerId },
      _sum: { netProceeds: true },
      _count: { _all: true },
    }),
    prisma.settlementRecovery.aggregate({
      where: { sellerId, status: { in: ["OPEN", "PARTIALLY_RECOVERED"] } },
      _sum: { amountMinor: true, recoveredMinor: true },
    }),
  ]);

  const byStatus = new Map(grouped.map((row) => [row.settlementStatus, row]));

  const buckets = Object.fromEntries(
    Object.entries(SELLER_BALANCE_BUCKETS).map(([bucket, states]) => {
      let amount = 0;
      let count = 0;
      for (const state of states) {
        const row = byStatus.get(state);
        amount += row?._sum.netProceeds ?? 0;
        count += row?._count._all ?? 0;
      }
      return [bucket, { amount: round2(amount), count }];
    }),
  ) as Omit<SellerBalances, "currency" | "openRecoveryAmount">;

  const outstandingMinor = BigInt(recoveries._sum.amountMinor ?? 0) - BigInt(recoveries._sum.recoveredMinor ?? 0);

  return {
    ...buckets,
    currency: "AED",
    openRecoveryAmount: round2(Number(outstandingMinor > 0n ? outstandingMinor : 0n) / 100),
  };
}

/** Find a settlement by whichever key the caller happens to hold. */
export async function findSettlement(input: {
  settlementId?: string | null;
  fulfillmentOrderId?: string | null;
  paymentId?: string | null;
}): Promise<SettlementRow | null> {
  if (input.settlementId) {
    return prisma.sellerSettlement.findUnique({ where: { id: input.settlementId } });
  }
  if (input.paymentId) {
    const bySettlementPayment = await prisma.sellerSettlement.findUnique({ where: { paymentId: input.paymentId } });
    if (bySettlementPayment) return bySettlementPayment;
  }
  if (input.fulfillmentOrderId) {
    return prisma.sellerSettlement.findUnique({ where: { fulfillmentOrderId: input.fulfillmentOrderId } });
  }
  return null;
}
