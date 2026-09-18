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
import { PaymentFinalizationService, type PaymentMetadata } from "../payments/payments.finalize.service.js";
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

const handleChargeRefunded: StripeWebhookHandler = async (event) => {
  const charge = event.data.object as Stripe.Charge;
  const paymentIntentId = paymentIntentIdOf(charge.payment_intent);

  if (!paymentIntentId) {
    return { status: "IGNORED", detail: { reason: "No payment intent on the charge" } };
  }

  await PaymentFinalizationService.recordRefund(charge, paymentIntentId);

  return {
    status: "PROCESSED",
    detail: {
      fullyRefunded: charge.amount_refunded >= charge.amount,
      amountRefundedMinor: charge.amount_refunded,
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

  logger.warn("Dispute opened", { disputeId: dispute.id, paymentIntentId });
  return { status: "PROCESSED", detail: { disputeId: dispute.id } };
};

const handleDisputeClosed: StripeWebhookHandler = async (event) => {
  const dispute = event.data.object as Stripe.Dispute;
  const status = dispute.status === "won" ? "WON" : dispute.status === "lost" ? "LOST" : "CLOSED";

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

  return { status: "PROCESSED", detail: { outcome: dispute.status } };
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
