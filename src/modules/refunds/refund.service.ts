/**
 * Refunds, and what they do to the seller's settlement.
 *
 * Where the money is decides what happens, so there are three cases and they
 * are genuinely different:
 *
 *   before transfer — nothing has left the platform. A full refund closes the
 *     settlement as REFUNDED; a partial one reduces it by an audited
 *     adjustment. Simple, and by far the common case: the protection period
 *     exists to make it the common case.
 *
 *   transfer in flight — refused with 409. A refund and a transfer must not
 *     interleave, so the caller retries once the transfer resolves (spec §31).
 *
 *   after transfer — the money is the seller's. TradeAuct tries to reverse it
 *     out of their Stripe balance; if the balance has already been paid to
 *     their bank, the reversal fails and the amount becomes a
 *     SettlementRecovery, offset against their next settlements. The PAID_OUT
 *     record is never rewritten (spec §23, §45).
 *
 * The partial-refund split below is the plan's default answer to Q3 and is
 * marked as such: the refund is apportioned pro-rata across the order, and the
 * seller fee is recalculated at the snapshot rate on the reduced sale price.
 * If the client decides differently, `computeSettlementImpact` is the one
 * place to change.
 */
import type Stripe from "stripe";
import { recordAudit } from "../../core/audit.js";
import { AppError } from "../../core/errors/AppError.js";
import { logger } from "../../core/logger.js";
import { fromMinorUnits, toMinorUnits } from "../../core/money.js";
import { enqueueOutboxEvent, TXN_EVENTS } from "../../core/outbox.js";
import { prisma } from "../../core/prisma.js";
import { getStripeClient } from "../gateway/stripe.client.js";
import { hasTransactionFor, postTransaction } from "../ledger/ledger.service.js";
import { stripePayoutProvider, transferIdempotencyKey } from "../payouts/payout.service.js";
import { adjustSettlement, transitionSettlement } from "../settlements/settlement.service.js";
import type { SettlementActor } from "../settlements/settlement.types.js";

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export type RefundRequest = {
  paymentId: string;
  /** Omit for a full refund. */
  amountMinor?: bigint;
  reasonCode: string;
  reasonNote?: string;
  requestedById: string;
  actor: SettlementActor;
};

export type RefundOutcome = {
  refundId: string;
  stripeRefundId: string | null;
  amountMinor: string;
  currency: string;
  fullRefund: boolean;
  settlementOutcome:
    | "NO_SETTLEMENT"
    | "SETTLEMENT_REFUNDED"
    | "SETTLEMENT_ADJUSTED"
    | "TRANSFER_REVERSED"
    | "RECOVERY_OPENED";
};

/**
 * What a refund of `refundMinor` does to the seller's side of the order.
 *
 * The buyer paid the sale price plus the buyer fee, shipping and VAT, so a
 * partial refund is apportioned across all of them; only the sale-price share
 * touches the seller. The seller fee is then recalculated at the snapshot rate
 * on what is left, which is the rate the order actually sold under.
 */
export function computeSettlementImpact(input: {
  refundAmount: number;
  salePrice: number;
  customerTotal: number;
  sellerFeePercent: number;
  currentNet: number;
  otherDeductions: number;
}): { newSaleAmount: number; newSellerFee: number; newNet: number; adjustment: number } {
  const ratio = input.customerTotal > 0 ? input.refundAmount / input.customerTotal : 1;
  const salePortion = round2(input.salePrice * Math.min(1, Math.max(0, ratio)));

  const newSaleAmount = Math.max(0, round2(input.salePrice - salePortion));
  const newSellerFee = round2((newSaleAmount * input.sellerFeePercent) / 100);
  const newNet = Math.max(0, round2(newSaleAmount - newSellerFee - input.otherDeductions));

  return { newSaleAmount, newSellerFee, newNet, adjustment: round2(newNet - input.currentNet) };
}

/**
 * Issue a refund against a payment.
 *
 * Idempotent twice over: the `Refund` row's id seeds the Stripe idempotency
 * key, and the caller's `Idempotency-Key` header stops a double-submitted
 * admin form creating two rows in the first place.
 */
export async function createRefund(request: RefundRequest): Promise<RefundOutcome> {
  const payment = await prisma.payment.findUnique({
    where: { id: request.paymentId },
    select: {
      id: true,
      status: true,
      amountMinor: true,
      amount: true,
      currency: true,
      stripePaymentIntentId: true,
      stripeChargeId: true,
    },
  });

  if (!payment) {
    throw new AppError(404, `Payment ${request.paymentId} not found`, "PAYMENT_NOT_FOUND");
  }

  if (payment.status !== "PAID" && payment.status !== "REFUNDED") {
    throw new AppError(409, `Payment is ${payment.status}; only a paid payment can be refunded`, "PAYMENT_NOT_PAID");
  }

  if (!payment.stripePaymentIntentId) {
    throw new AppError(409, "This payment has no Stripe intent to refund", "PAYMENT_NOT_REFUNDABLE");
  }

  const currency = payment.currency || "AED";
  const capturedMinor = payment.amountMinor ?? toMinorUnits(payment.amount, currency);

  // Everything already refunded against this payment, so a second partial
  // refund cannot take the total past what was captured.
  const priorRefunds = await prisma.refund.aggregate({
    where: { paymentId: payment.id, status: { in: ["SUCCEEDED", "PROCESSING"] } },
    _sum: { amountMinor: true },
  });
  const alreadyRefundedMinor = BigInt(priorRefunds._sum.amountMinor ?? 0);
  const remainingMinor = capturedMinor - alreadyRefundedMinor;

  if (remainingMinor <= 0n) {
    throw new AppError(409, "This payment has already been refunded in full", "PAYMENT_FULLY_REFUNDED");
  }

  const refundMinor = request.amountMinor ?? remainingMinor;
  if (refundMinor <= 0n || refundMinor > remainingMinor) {
    throw new AppError(400, `A refund must be between 1 and ${remainingMinor} minor units`, "REFUND_AMOUNT_INVALID");
  }

  const settlement = await prisma.sellerSettlement.findUnique({ where: { paymentId: payment.id } });

  // A transfer that is mid-flight has an unknown outcome. Refunding now could
  // send the seller money that is simultaneously being returned to the buyer.
  if (settlement?.settlementStatus === "TRANSFER_PENDING") {
    throw new AppError(
      409,
      "A transfer for this order is in flight. Try again once it resolves.",
      "SETTLEMENT_TRANSFER_IN_FLIGHT",
    );
  }

  const refund = await prisma.refund.create({
    data: {
      paymentId: payment.id,
      amountMinor: refundMinor,
      currency,
      reasonCode: request.reasonCode,
      reasonNote: request.reasonNote ?? null,
      status: "PROCESSING",
      requestedById: request.requestedById,
      stripeChargeId: payment.stripeChargeId,
      // Placeholder, replaced below with one derived from the row's own id.
      idempotencyKey: `tradeauct_refund_pending_${payment.id}_${Date.now()}`,
    },
  });

  const idempotencyKey = `tradeauct_refund_${refund.id}`;
  await prisma.refund.update({ where: { id: refund.id }, data: { idempotencyKey } });

  let stripeRefund: Stripe.Refund;
  try {
    stripeRefund = await getStripeClient().refunds.create(
      {
        payment_intent: payment.stripePaymentIntentId,
        amount: Number(refundMinor),
        metadata: { refundId: refund.id, paymentId: payment.id, reasonCode: request.reasonCode },
      },
      { idempotencyKey },
    );
  } catch (error) {
    await prisma.refund.update({
      where: { id: refund.id },
      data: {
        status: "FAILED",
        failureMessage: (error as Error).message.slice(0, 500),
      },
    });
    throw error;
  }

  await prisma.refund.update({
    where: { id: refund.id },
    data: {
      stripeRefundId: stripeRefund.id,
      status: stripeRefund.status === "succeeded" ? "SUCCEEDED" : "PROCESSING",
      approvedById: request.actor.id ?? null,
      approvedAt: new Date(),
    },
  });

  const fullRefund = refundMinor >= remainingMinor;
  const settlementOutcome = settlement
    ? await applyRefundToSettlement({
        settlementId: settlement.id,
        refundMinor,
        currency,
        customerTotalMinor: capturedMinor,
        fullRefund,
        reason: `Refund ${refund.id}: ${request.reasonCode}`,
        actor: request.actor,
      })
    : ("NO_SETTLEMENT" as const);

  await recordAudit({
    action: "REFUND_CREATED",
    entityType: "PAYMENT",
    entityId: payment.id,
    actorType: request.actor.type,
    actorId: request.actor.id ?? null,
    ip: request.actor.ip ?? null,
    amountMinor: refundMinor,
    currency,
    reason: request.reasonNote ?? request.reasonCode,
    after: { refundId: refund.id, stripeRefundId: stripeRefund.id, settlementOutcome },
  });

  logger.info("Refund issued", {
    refundId: refund.id,
    paymentId: payment.id,
    amountMinor: refundMinor.toString(),
    fullRefund,
    settlementOutcome,
  });

  return {
    refundId: refund.id,
    stripeRefundId: stripeRefund.id,
    amountMinor: refundMinor.toString(),
    currency,
    fullRefund,
    settlementOutcome,
  };
}

/** The settlement half of a refund, branching on where the money already is. */
export async function applyRefundToSettlement(input: {
  settlementId: string;
  refundMinor: bigint;
  currency: string;
  customerTotalMinor: bigint;
  fullRefund: boolean;
  reason: string;
  actor: SettlementActor;
}): Promise<RefundOutcome["settlementOutcome"]> {
  const settlement = await prisma.sellerSettlement.findUnique({ where: { id: input.settlementId } });
  if (!settlement) return "NO_SETTLEMENT";

  const refundAmount = fromMinorUnits(input.refundMinor, input.currency);
  const alreadyPaid = ["TRANSFERRED", "PAID_OUT"].includes(settlement.settlementStatus);

  if (alreadyPaid) {
    return recoverFromSeller({
      settlementId: settlement.id,
      amountMinor: input.refundMinor,
      currency: input.currency,
      cause: "REFUND_AFTER_PAYOUT",
      reason: input.reason,
      actor: input.actor,
    });
  }

  if (input.fullRefund) {
    await prisma.$transaction(async (tx) => {
      await transitionSettlement(
        {
          settlementId: settlement.id,
          from: ["PENDING", "ON_HOLD", "ELIGIBLE", "FROZEN", "DISPUTED", "TRANSFER_FAILED"],
          to: "REFUNDED",
          reason: input.reason,
          actor: input.actor,
          data: {
            refundAmount: round2(settlement.refundAmount + refundAmount),
            netProceeds: 0,
            payoutStatus: "UNPAID",
          },
          // The obligation to the seller disappears. The platform's refund
          // expense already hit REFUNDS when the money went back to the buyer.
          ledger: () => {
            const netMinor = toMinorUnits(settlement.netProceeds, settlement.currency);
            if (netMinor <= 0n) return null;
            return {
              kind: "REFUND",
              referenceType: "SETTLEMENT",
              referenceId: settlement.id,
              currency: settlement.currency,
              description: `Settlement cancelled by refund: ${input.reason}`,
              lines: [
                {
                  account: "SELLER_PAYABLE",
                  direction: "DEBIT",
                  amountMinor: netMinor,
                  sellerId: settlement.sellerId,
                  paymentId: settlement.paymentId,
                },
                {
                  account: "REFUNDS",
                  direction: "CREDIT",
                  amountMinor: netMinor,
                  sellerId: settlement.sellerId,
                  paymentId: settlement.paymentId,
                },
              ],
            };
          },
        },
        tx,
      );
    });

    return "SETTLEMENT_REFUNDED";
  }

  const impact = computeSettlementImpact({
    refundAmount,
    salePrice: settlement.saleAmount,
    customerTotal: fromMinorUnits(input.customerTotalMinor, input.currency),
    sellerFeePercent: settlement.sellerFeePercent ?? settlement.platformFeeRate,
    currentNet: settlement.netProceeds,
    otherDeductions: settlement.otherDeductions,
  });

  if (impact.adjustment === 0) return "SETTLEMENT_ADJUSTED";

  await adjustSettlement({
    settlementId: settlement.id,
    adjustmentAmount: impact.adjustment,
    reason: `${input.reason} (partial refund ${refundAmount} ${input.currency})`,
    actor: input.actor,
  });

  await prisma.sellerSettlement.update({
    where: { id: settlement.id },
    data: { refundAmount: round2(settlement.refundAmount + refundAmount) },
  });

  return "SETTLEMENT_ADJUSTED";
}

/**
 * Get money back from a seller who has already been paid.
 *
 * First choice is a transfer reversal, which pulls it out of their Stripe
 * balance. When that is not possible — typically because Stripe has already
 * paid their bank — the amount becomes an open recovery and is withheld from
 * their next settlements. The settlement's own status does not change.
 */
export async function recoverFromSeller(input: {
  settlementId: string;
  amountMinor: bigint;
  currency: string;
  cause: "REFUND_AFTER_PAYOUT" | "DISPUTE_LOST_AFTER_PAYOUT" | "CHARGEBACK" | "MANUAL_ADJUSTMENT";
  reason: string;
  actor: SettlementActor;
  sourceType?: string;
  sourceId?: string;
}): Promise<"TRANSFER_REVERSED" | "RECOVERY_OPENED"> {
  const settlement = await prisma.sellerSettlement.findUnique({ where: { id: input.settlementId } });
  if (!settlement) {
    throw new AppError(404, `Settlement ${input.settlementId} not found`, "SETTLEMENT_NOT_FOUND");
  }

  const transfer = await prisma.payoutTransfer.findUnique({ where: { settlementId: input.settlementId } });

  // Never claw back more than actually went out.
  const paidMinor = transfer?.amountMinor ?? toMinorUnits(settlement.netProceeds, settlement.currency);
  const alreadyReversed = transfer?.reversedAmountMinor ?? 0n;
  const recoverable = paidMinor - alreadyReversed;
  const target = input.amountMinor < recoverable ? input.amountMinor : recoverable;

  if (target <= 0n) {
    logger.info("Nothing left to recover on this settlement", { settlementId: input.settlementId });
    return "RECOVERY_OPENED";
  }

  if (transfer?.stripeTransferId && transfer.provider === "STRIPE_CONNECT") {
    const reversal = await stripePayoutProvider.reverseTransfer({
      providerTransferId: transfer.stripeTransferId,
      amountMinor: target,
      idempotencyKey: `${transferIdempotencyKey(input.settlementId)}_reversal_${alreadyReversed}`,
      reason: input.reason,
    });

    if (reversal.status === "SUCCEEDED") {
      const reversedTotal = alreadyReversed + reversal.amountMinor;

      await prisma.$transaction(async (tx) => {
        await tx.payoutTransfer.update({
          where: { id: transfer.id },
          data: {
            reversedAmountMinor: reversedTotal,
            status: reversedTotal >= paidMinor ? "REVERSED" : "PARTIALLY_REVERSED",
          },
        });

        // The money is back with the platform. The seller's payable is not
        // re-credited: the settlement stays PAID_OUT and this simply undoes
        // the cash movement.
        await postTransaction(
          {
            kind: "ADJUSTMENT",
            referenceType: "SETTLEMENT",
            referenceId: settlement.id,
            currency: settlement.currency,
            description: `Transfer reversal: ${input.reason}`,
            lines: [
              {
                account: "STRIPE_CASH",
                direction: "DEBIT",
                amountMinor: reversal.amountMinor,
                sellerId: settlement.sellerId,
              },
              {
                account: "REFUNDS",
                direction: "CREDIT",
                amountMinor: reversal.amountMinor,
                sellerId: settlement.sellerId,
              },
            ],
          },
          tx,
        );
      });

      await recordAudit({
        action: "SETTLEMENT_TRANSFER_REVERSED",
        entityType: "SETTLEMENT",
        entityId: settlement.id,
        actorType: input.actor.type,
        actorId: input.actor.id ?? null,
        amountMinor: reversal.amountMinor,
        currency: settlement.currency,
        reason: input.reason,
      });

      logger.info("Transfer reversed", {
        settlementId: settlement.id,
        reversalId: reversal.reversalId,
        amountMinor: reversal.amountMinor.toString(),
      });

      return "TRANSFER_REVERSED";
    }

    logger.warn("Transfer reversal refused; opening a recovery instead", {
      settlementId: settlement.id,
      reason: reversal.failureMessage,
    });
  }

  await openRecovery({
    settlementId: settlement.id,
    sellerId: settlement.sellerId,
    amountMinor: target,
    currency: settlement.currency,
    cause: input.cause,
    reason: input.reason,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
  });

  return "RECOVERY_OPENED";
}

/** Record a debt owed back, and flag the settlement so admins can see it. */
export async function openRecovery(input: {
  settlementId: string;
  sellerId: string;
  amountMinor: bigint;
  currency: string;
  cause: "REFUND_AFTER_PAYOUT" | "DISPUTE_LOST_AFTER_PAYOUT" | "CHARGEBACK" | "MANUAL_ADJUSTMENT";
  reason: string;
  sourceType?: string;
  sourceId?: string;
}): Promise<string> {
  const recoveryId = await prisma.$transaction(async (tx) => {
    const recovery = await tx.settlementRecovery.create({
      data: {
        settlementId: input.settlementId,
        sellerId: input.sellerId,
        cause: input.cause,
        amountMinor: input.amountMinor,
        currency: input.currency,
        notes: input.reason,
        sourceType: input.sourceType ?? null,
        sourceId: input.sourceId ?? null,
      },
    });

    await tx.sellerSettlement.update({
      where: { id: input.settlementId },
      data: { hasOpenRecovery: true },
    });

    // The platform expects this money back, so the expense already booked to
    // REFUNDS is offset by a receivable from the seller.
    await postTransaction(
      {
        kind: "ADJUSTMENT",
        referenceType: "SETTLEMENT_RECOVERY",
        referenceId: recovery.id,
        currency: input.currency,
        description: `Recovery opened: ${input.reason}`,
        lines: [
          {
            account: "SELLER_RECOVERABLE",
            direction: "DEBIT",
            amountMinor: input.amountMinor,
            sellerId: input.sellerId,
          },
          { account: "REFUNDS", direction: "CREDIT", amountMinor: input.amountMinor, sellerId: input.sellerId },
        ],
      },
      tx,
    );

    await enqueueOutboxEvent(tx, TXN_EVENTS.SETTLEMENT_RECOVERY_OPENED, {
      recoveryId: recovery.id,
      settlementId: input.settlementId,
      sellerId: input.sellerId,
      amountMinor: input.amountMinor.toString(),
      currency: input.currency,
      cause: input.cause,
      reason: input.reason,
    });

    return recovery.id;
  });

  logger.warn("Settlement recovery opened", {
    recoveryId,
    settlementId: input.settlementId,
    sellerId: input.sellerId,
    amountMinor: input.amountMinor.toString(),
    cause: input.cause,
  });

  return recoveryId;
}

/**
 * Post a refund Stripe told us about, exactly once, at its own amount.
 *
 * The previous implementation posted `charge.amount_refunded`, which is
 * cumulative — so a second partial refund posted the first one's amount again
 * and the ledger over-counted. Keying on the refund's own id fixes both
 * halves of that: the right amount, posted once.
 */
export async function recordStripeRefundEvent(charge: Stripe.Charge): Promise<{ posted: number }> {
  const currency = (charge.currency || "aed").toUpperCase();
  const paymentIntentId =
    typeof charge.payment_intent === "string" ? charge.payment_intent : (charge.payment_intent?.id ?? null);

  if (!paymentIntentId) return { posted: 0 };

  const payment = await prisma.payment.findFirst({
    where: { OR: [{ stripePaymentIntentId: paymentIntentId }, { gatewayTransactionId: paymentIntentId }] },
    select: { id: true, buyerId: true, amountMinor: true, amount: true, currency: true },
  });

  if (!payment) {
    logger.warn("Refund for a payment TradeAuct does not know", { paymentIntentId });
    return { posted: 0 };
  }

  const refunds = charge.refunds?.data ?? [];
  const fullyRefunded = charge.amount_refunded >= charge.amount;
  let posted = 0;

  for (const stripeRefund of refunds) {
    if (stripeRefund.status !== "succeeded") continue;

    // Each refund is its own ledger transaction, keyed by its Stripe id, so a
    // re-delivered charge.refunded cannot post it twice.
    if (await hasTransactionFor("REFUND", stripeRefund.id, "REFUND")) continue;

    const refundMinor = BigInt(stripeRefund.amount);

    await prisma.$transaction(async (tx) => {
      await tx.refund.upsert({
        where: { stripeRefundId: stripeRefund.id },
        update: { status: "SUCCEEDED" },
        create: {
          paymentId: payment.id,
          stripeRefundId: stripeRefund.id,
          stripeChargeId: charge.id,
          amountMinor: refundMinor,
          currency,
          reasonCode: stripeRefund.reason ?? "stripe_dashboard",
          status: "SUCCEEDED",
          requestedById: "STRIPE",
          idempotencyKey: `tradeauct_refund_stripe_${stripeRefund.id}`,
        },
      });

      await postTransaction(
        {
          kind: "REFUND",
          referenceType: "REFUND",
          referenceId: stripeRefund.id,
          currency,
          description: `Stripe refund ${stripeRefund.id}`,
          lines: [
            { account: "REFUNDS", direction: "DEBIT", amountMinor: refundMinor, paymentId: payment.id },
            { account: "STRIPE_CASH", direction: "CREDIT", amountMinor: refundMinor, paymentId: payment.id },
          ],
        },
        tx,
      );

      await tx.payment.update({
        where: { id: payment.id },
        data: { status: fullyRefunded ? "REFUNDED" : "PAID" },
      });

      await enqueueOutboxEvent(tx, TXN_EVENTS.REFUND_SUCCEEDED, {
        paymentId: payment.id,
        paymentIntentId,
        stripeRefundId: stripeRefund.id,
        amountMinor: refundMinor.toString(),
        currency,
        fullyRefunded,
      });
    });

    posted += 1;

    // A refund created in the Stripe dashboard rather than through TradeAuct
    // still has to reach the seller's settlement.
    const settlement = await prisma.sellerSettlement.findUnique({ where: { paymentId: payment.id } });
    if (settlement) {
      await applyRefundToSettlement({
        settlementId: settlement.id,
        refundMinor,
        currency,
        customerTotalMinor: payment.amountMinor ?? toMinorUnits(payment.amount, payment.currency || currency),
        fullRefund: fullyRefunded,
        reason: `Stripe refund ${stripeRefund.id}`,
        actor: { type: "SYSTEM" },
      });
    }
  }

  return { posted };
}
