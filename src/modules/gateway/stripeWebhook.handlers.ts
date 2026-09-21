/**
 * One handler per Stripe event type.
 *
 * Handlers run in the worker, never in the HTTP request, so they may take as
 * long as they need. Anything they throw marks the event FAILED and leaves it
 * replayable — which means every handler must be safe to run twice.
 */
import type Stripe from "stripe";
import { logger } from "../../core/logger.js";
import { enqueueOutboxEvent, TXN_EVENTS } from "../../core/outbox.js";
import { prisma } from "../../core/prisma.js";
import { syncConnectAccount } from "../connect/connect.service.js";
import {
  onCardDisputeClosed,
  onCardDisputeOpened,
  onDisputeFundsReinstated,
  onDisputeFundsWithdrawn,
} from "../disputes/dispute.service.js";
import { PaymentFinalizationService, type PaymentMetadata } from "../payments/payments.finalize.service.js";
import { attributePayout, recordPayoutFailure } from "../payouts/payout.service.js";
import { recordStripeRefundEvent } from "../refunds/refund.service.js";
import type { StripeWebhookHandler, StripeWebhookHandlerResult } from "./stripeWebhook.types.js";

function paymentIntentIdOf(value: string | Stripe.PaymentIntent | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

const handlePaymentIntentSucceeded: StripeWebhookHandler = async (event) => {
  const intent = event.data.object as Stripe.PaymentIntent;
  const result = await PaymentFinalizationService.settlePaidIntent(
    intent.id,
    intent.metadata as PaymentMetadata,
    `stripe:${event.id}`,
  );

  return { status: "PROCESSED", detail: { ...result } };
};

const handleCheckoutSessionCompleted: StripeWebhookHandler = async (event) => {
  const session = event.data.object as Stripe.Checkout.Session;
  const paymentIntentId = paymentIntentIdOf(session.payment_intent);

  if (!paymentIntentId) {
    return { status: "IGNORED", detail: { reason: "No payment intent on the checkout session" } };
  }

  // An async payment method can complete the session while the money is still
  // pending. Fulfilling then would ship against a payment that may yet fail.
  if (session.payment_status && session.payment_status !== "paid" && session.payment_status !== "no_payment_required") {
    return { status: "IGNORED", detail: { reason: `Session payment_status is ${session.payment_status}` } };
  }

  const result = await PaymentFinalizationService.settlePaidIntent(
    paymentIntentId,
    (session.metadata ?? undefined) as PaymentMetadata | undefined,
    `stripe:${event.id}`,
  );

  return { status: "PROCESSED", detail: { ...result } };
};

const handlePaymentIntentFailed: StripeWebhookHandler = async (event) => {
  const intent = event.data.object as Stripe.PaymentIntent;
  await PaymentFinalizationService.recordFailure(intent);

  return {
    status: "PROCESSED",
    detail: { failureCode: intent.last_payment_error?.code ?? "payment_failed" },
  };
};

const handlePaymentIntentCanceled: StripeWebhookHandler = async (event) => {
  const intent = event.data.object as Stripe.PaymentIntent;

  await prisma.$transaction(async (tx) => {
    await tx.payment.updateMany({
      where: {
        OR: [{ stripePaymentIntentId: intent.id }, { gatewayTransactionId: intent.id }],
        status: { not: "PAID" },
      },
      // PaymentStatus has no CANCELLED member, so a cancelled intent is a
      // terminal failed attempt. Recovery fields are left alone on purpose:
      // a cancellation is not a decline and must not start a 24h window.
      data: {
        status: "FAILED",
        failureReason: intent.cancellation_reason || "Stripe PaymentIntent canceled",
        lastFailureCode: "payment_intent_canceled",
        lastFailureMessage: intent.cancellation_reason || "Payment was canceled before completion",
      },
    });

    await enqueueOutboxEvent(tx, TXN_EVENTS.PAYMENT_CANCELED, {
      paymentIntentId: intent.id,
      listingId: intent.metadata?.listingId ?? null,
      auctionId: intent.metadata?.auctionId ?? null,
    });
  });

  return { status: "PROCESSED" };
};

/**
 * A refund happened - possibly in the Stripe dashboard rather than here.
 *
 * Each individual refund is posted at its own amount, keyed by its Stripe id,
 * and carried through to the seller's settlement. The previous implementation
 * posted `charge.amount_refunded`, which is cumulative, so a second partial
 * refund re-posted the first one's amount as well as its own.
 */
const handleChargeRefunded: StripeWebhookHandler = async (event) => {
  const charge = event.data.object as Stripe.Charge;
  const paymentIntentId = paymentIntentIdOf(charge.payment_intent);

  if (!paymentIntentId) {
    return { status: "IGNORED", detail: { reason: "No payment intent on the charge" } };
  }

  const result = await recordStripeRefundEvent(charge);

  return {
    status: "PROCESSED",
    detail: {
      refundsPosted: result.posted,
      fullyRefunded: charge.amount_refunded >= charge.amount,
    },
  };
};

/**
 * A dispute is money leaving the account on someone else's say-so, so it is
 * recorded and announced rather than merely logged.
 */
const handleDisputeCreated: StripeWebhookHandler = async (event) => {
  const dispute = event.data.object as Stripe.Dispute;
  const paymentIntentId = paymentIntentIdOf(dispute.payment_intent);

  const payment = paymentIntentId
    ? await prisma.payment.findFirst({
        where: { OR: [{ stripePaymentIntentId: paymentIntentId }, { gatewayTransactionId: paymentIntentId }] },
        select: { id: true },
      })
    : null;

  await prisma.$transaction(async (tx) => {
    await tx.stripeDispute.upsert({
      where: { stripeDisputeId: dispute.id },
      update: {
        status: "NEEDS_RESPONSE",
        evidenceDueBy: dispute.evidence_details?.due_by ? new Date(dispute.evidence_details.due_by * 1000) : null,
      },
      create: {
        stripeDisputeId: dispute.id,
        stripeChargeId: typeof dispute.charge === "string" ? dispute.charge : dispute.charge.id,
        paymentId: payment?.id ?? null,
        amountMinor: BigInt(dispute.amount ?? 0),
        currency: (dispute.currency || "aed").toUpperCase(),
        reason: dispute.reason ?? "unknown",
        status: "NEEDS_RESPONSE",
        evidenceDueBy: dispute.evidence_details?.due_by ? new Date(dispute.evidence_details.due_by * 1000) : null,
      },
    });

    await enqueueOutboxEvent(tx, TXN_EVENTS.DISPUTE_OPENED, {
      stripeDisputeId: dispute.id,
      paymentId: payment?.id ?? null,
      paymentIntentId,
      amountMinor: String(dispute.amount ?? 0),
      currency: (dispute.currency || "aed").toUpperCase(),
      reason: dispute.reason ?? "unknown",
    });
  });

  // The seller's settlement must stop moving while this is open.
  const settlementOutcome = await onCardDisputeOpened({
    paymentId: payment?.id ?? null,
    stripeDisputeId: dispute.id,
    amountMinor: BigInt(dispute.amount ?? 0),
    currency: (dispute.currency || "aed").toUpperCase(),
    reason: dispute.reason ?? "unknown",
  });

  logger.warn("Dispute opened", { disputeId: dispute.id, paymentIntentId, settlementOutcome });
  return { status: "PROCESSED", detail: { disputeId: dispute.id, settlement: settlementOutcome } };
};

const handleDisputeClosed: StripeWebhookHandler = async (event) => {
  const dispute = event.data.object as Stripe.Dispute;
  const status = dispute.status === "won" ? "WON" : dispute.status === "lost" ? "LOST" : "CLOSED";
  const local = await prisma.stripeDispute.findUnique({ where: { stripeDisputeId: dispute.id } });

  await prisma.$transaction(async (tx) => {
    await tx.stripeDispute.updateMany({
      where: { stripeDisputeId: dispute.id },
      data: { status, outcome: dispute.status, closedAt: new Date() },
    });

    await enqueueOutboxEvent(tx, TXN_EVENTS.DISPUTE_CLOSED, {
      stripeDisputeId: dispute.id,
      outcome: dispute.status,
    });
  });

  // Won: the settlement goes back where it was and is re-evaluated. Lost: the
  // money is gone, so either the settlement is written off or - if the seller
  // has already been paid - a recovery is opened against them.
  const settlementOutcome = await onCardDisputeClosed({
    paymentId: local?.paymentId ?? null,
    stripeDisputeId: dispute.id,
    outcome: dispute.status,
    amountMinor: BigInt(dispute.amount ?? 0),
    currency: (dispute.currency || "aed").toUpperCase(),
  });

  logger.info("Dispute closed", { disputeId: dispute.id, outcome: dispute.status, settlementOutcome });
  return { status: "PROCESSED", detail: { outcome: dispute.status, settlement: settlementOutcome } };
};

/** Stripe debited the platform for a dispute. Recorded, not acted on. */
const handleDisputeFundsWithdrawn: StripeWebhookHandler = async (event) => {
  const dispute = event.data.object as Stripe.Dispute;
  await onDisputeFundsWithdrawn({
    stripeDisputeId: dispute.id,
    amountMinor: BigInt(dispute.amount ?? 0),
    currency: (dispute.currency || "aed").toUpperCase(),
  });
  return { status: "PROCESSED", detail: { disputeId: dispute.id } };
};

const handleDisputeFundsReinstated: StripeWebhookHandler = async (event) => {
  const dispute = event.data.object as Stripe.Dispute;
  await onDisputeFundsReinstated({ stripeDisputeId: dispute.id });
  return { status: "PROCESSED", detail: { disputeId: dispute.id } };
};

/**
 * A connected account changed - usually because the seller submitted
 * something, or Stripe finished verifying it.
 *
 * This is how `payoutsEnabled` becomes true, which is what lets the transfer
 * worker pick that seller's settlements up.
 */
const handleAccountUpdated: StripeWebhookHandler = async (event) => {
  const account = event.data.object as Stripe.Account;
  await syncConnectAccount(account);
  return {
    status: "PROCESSED",
    detail: { accountId: account.id, payoutsEnabled: Boolean(account.payouts_enabled) },
  };
};

/**
 * Transfer lifecycle, for reconciliation.
 *
 * The transfer itself is created synchronously by the payout service, so this
 * does not create anything. What it does catch is a reversal, which can be
 * initiated from the Stripe dashboard as well as from here.
 */
const handleTransferEvent: StripeWebhookHandler = async (event) => {
  const transfer = event.data.object as Stripe.Transfer;
  const settlementId = transfer.metadata?.settlementId;

  await prisma.payoutTransfer.updateMany({
    where: { stripeTransferId: transfer.id },
    data: {
      reversedAmountMinor: BigInt(transfer.amount_reversed ?? 0),
      ...(transfer.reversed ? { status: "REVERSED" as const } : {}),
    },
  });

  if (settlementId) {
    await prisma.sellerSettlement.updateMany({
      where: { id: settlementId },
      data: { stripeTransferStatus: transfer.reversed ? "reversed" : "created" },
    });
  }

  return {
    status: "PROCESSED",
    detail: { transferId: transfer.id, reversed: transfer.reversed, settlementId: settlementId ?? null },
  };
};

/**
 * A bank payout on a connected account: the last hop, seller balance to seller
 * bank.
 *
 * `event.account` is what makes this a Connect event. Without it the payout is
 * TradeAuct paying itself, which is not a seller settlement and must not be
 * attributed to one.
 */
const handlePayoutEvent: StripeWebhookHandler = async (event) => {
  const payout = event.data.object as Stripe.Payout;
  const connectedAccountId = event.account;

  if (!connectedAccountId) {
    return { status: "IGNORED", detail: { reason: "Platform payout, not a connected account" } };
  }

  if (event.type === "payout.failed") {
    await recordPayoutFailure({
      payoutId: payout.id,
      connectedAccountId,
      failureCode: payout.failure_code ?? null,
      failureMessage: payout.failure_message ?? null,
    });
    return { status: "PROCESSED", detail: { payoutId: payout.id, outcome: "failed" } };
  }

  const result = await attributePayout({
    payoutId: payout.id,
    connectedAccountId,
    status: payout.status,
    arrivalDate: payout.arrival_date ? new Date(payout.arrival_date * 1000) : null,
  });

  return { status: "PROCESSED", detail: { payoutId: payout.id, status: payout.status, matched: result.matched } };
};

/** An expired session is a checkout the buyer walked away from. */
const handleCheckoutSessionExpired: StripeWebhookHandler = async (event) => {
  const session = event.data.object as Stripe.Checkout.Session;
  const listingId = session.metadata?.listingId;

  if (!listingId) {
    return { status: "IGNORED", detail: { reason: "No listing on the expired session" } };
  }

  await prisma.payment.updateMany({
    where: { listingId, status: { in: ["PENDING", "PROCESSING"] } },
    data: { status: "FAILED", lastFailureCode: "checkout_session_expired" },
  });

  return { status: "PROCESSED", detail: { listingId } };
};

const HANDLERS: Record<string, StripeWebhookHandler> = {
  "payment_intent.succeeded": handlePaymentIntentSucceeded,
  "checkout.session.completed": handleCheckoutSessionCompleted,
  "checkout.session.expired": handleCheckoutSessionExpired,
  "payment_intent.payment_failed": handlePaymentIntentFailed,
  "payment_intent.canceled": handlePaymentIntentCanceled,
  "charge.refunded": handleChargeRefunded,
  "charge.dispute.created": handleDisputeCreated,
  "charge.dispute.closed": handleDisputeClosed,
  "charge.dispute.funds_withdrawn": handleDisputeFundsWithdrawn,
  "charge.dispute.funds_reinstated": handleDisputeFundsReinstated,

  // Connect. These arrive on /webhooks/stripe/connect with event.account set.
  "account.updated": handleAccountUpdated,
  "transfer.created": handleTransferEvent,
  "transfer.updated": handleTransferEvent,
  "transfer.reversed": handleTransferEvent,
  "payout.created": handlePayoutEvent,
  "payout.paid": handlePayoutEvent,
  "payout.failed": handlePayoutEvent,
};

export function getStripeWebhookHandler(eventType: string): StripeWebhookHandler | null {
  return HANDLERS[eventType] ?? null;
}

export function isHandledStripeEvent(eventType: string): boolean {
  return Boolean(HANDLERS[eventType]);
}

export async function handleStripeEvent(event: Stripe.Event): Promise<StripeWebhookHandlerResult> {
  const handler = getStripeWebhookHandler(event.type);
  if (!handler) {
    return { status: "IGNORED", detail: { reason: `No handler registered for ${event.type}` } };
  }
  return handler(event);
}
