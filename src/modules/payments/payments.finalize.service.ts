/**
 * What happens when Stripe says money moved.
 *
 * This is the split the whole migration turns on. The transaction server
 * records the money — the Payment row, the attempt, the ledger — and then
 * announces it. It does **not** create the order, schedule the pickup or mark
 * the listing sold: those tables belong to the main server, which does that
 * work when it receives `PAYMENT_SUCCEEDED`.
 *
 * Nothing is announced until the amount has been reconciled. A payment whose
 * captured amount does not match the quote is quarantined and raised, never
 * fulfilled: metadata is a label the client once influenced, whereas
 * `amount_received` is the money that actually arrived.
 */
import type Stripe from "stripe";
import { recordAudit } from "../../core/audit.js";
import { AppError } from "../../core/errors/AppError.js";
import { logger } from "../../core/logger.js";
import { currencyExponent, toMinorUnits } from "../../core/money.js";
import { enqueueOutboxEvent, TXN_EVENTS } from "../../core/outbox.js";
import { type PrismaTransaction, prisma } from "../../core/prisma.js";
import { getStripeClient } from "../gateway/stripe.client.js";
import { postTransaction } from "../ledger/ledger.service.js";

const RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

export type PaymentMetadata = Record<string, string | number | boolean | null | undefined>;

export type SettleResult = {
  status: "SETTLED" | "ALREADY_SETTLED" | "QUARANTINED";
  paymentId?: string;
  orderNumber?: string;
  reason?: string;
};

/** The money breakdown a charge is expected to consist of, in minor units. */
type Breakdown = {
  currency: string;
  purchasePriceMinor: bigint;
  buyerFeeMinor: bigint;
  shippingMinor: bigint;
  storageMinor: bigint;
  vatMinor: bigint;
  totalMinor: bigint;
};

function metaNumber(meta: PaymentMetadata, key: string): number {
  const value = Number(meta[key]);
  return Number.isFinite(value) ? value : 0;
}

function buildBreakdown(meta: PaymentMetadata, currency: string): Breakdown {
  const purchasePrice = metaNumber(meta, "purchasePrice");
  const buyerFee = metaNumber(meta, "buyerFee");
  const shipping = metaNumber(meta, "shippingCost");
  const storage = metaNumber(meta, "storageFee");
  const vat = metaNumber(meta, "vat");

  const parts = {
    purchasePriceMinor: toMinorUnits(purchasePrice, currency),
    buyerFeeMinor: toMinorUnits(buyerFee, currency),
    shippingMinor: toMinorUnits(shipping, currency),
    storageMinor: toMinorUnits(storage, currency),
    vatMinor: toMinorUnits(vat, currency),
  };

  return {
    currency,
    ...parts,
    totalMinor:
      parts.purchasePriceMinor + parts.buyerFeeMinor + parts.shippingMinor + parts.storageMinor + parts.vatMinor,
  };
}

export class PaymentFinalizationService {
  /** Metadata travels on the intent; fall back to Stripe when it is absent. */
  private static async resolveMetadata(
    paymentIntentId: string,
    provided?: PaymentMetadata,
  ): Promise<{ meta: PaymentMetadata; intent: Stripe.PaymentIntent }> {
    const intent = await getStripeClient().paymentIntents.retrieve(paymentIntentId);
    const meta = provided && provided.listingId ? provided : ((intent.metadata ?? {}) as PaymentMetadata);

    if (!meta.listingId) {
      throw new AppError(
        400,
        `Cannot settle payment intent ${paymentIntentId}: no listing in its metadata.`,
        "PAYMENT_METADATA_MISSING",
      );
    }

    return { meta, intent };
  }

  /**
   * Record a successful charge and announce it.
   *
   * Safe to run twice: Stripe re-delivers events, and the worker retries. The
   * PaymentIntent id is the natural key throughout.
   */
  static async settlePaidIntent(
    paymentIntentId: string,
    providedMeta?: PaymentMetadata,
    source = "stripe-webhook",
  ): Promise<SettleResult> {
    const { meta, intent } = await PaymentFinalizationService.resolveMetadata(paymentIntentId, providedMeta);

    const existing = await prisma.payment.findFirst({
      where: {
        OR: [{ stripePaymentIntentId: paymentIntentId }, { gatewayTransactionId: paymentIntentId }],
      },
      select: { id: true, status: true, listingId: true },
    });

    if (existing?.status === "PAID") {
      return { status: "ALREADY_SETTLED", paymentId: existing.id };
    }

    const currency = (intent.currency || "aed").toUpperCase();
    const capturedMinor = BigInt(intent.amount_received ?? 0);
    const breakdown = buildBreakdown(meta, currency);

    // The one check that must never be skipped. Metadata is a label; this is
    // the money. If they disagree, something upstream is wrong and fulfilling
    // would ship goods against an amount nobody verified.
    if (capturedMinor !== breakdown.totalMinor) {
      return PaymentFinalizationService.quarantine({
        paymentIntentId,
        listingId: String(meta.listingId),
        capturedMinor,
        expectedMinor: breakdown.totalMinor,
        currency,
      });
    }

    const listingId = String(meta.listingId);
    const buyer = await prisma.buyer.findFirst({
      where: {
        OR: [
          ...(meta.buyerUserId ? [{ userId: String(meta.buyerUserId) }] : []),
          ...(meta.buyerId ? [{ id: String(meta.buyerId) }] : []),
        ],
      },
      select: { id: true },
    });

    if (!buyer) {
      throw new AppError(404, `No buyer profile for payment ${paymentIntentId}`, "BUYER_NOT_FOUND");
    }

    const listing = await prisma.listing.findUnique({
      where: { id: listingId },
      select: { id: true, sellerId: true, saleType: true },
    });

    if (!listing) {
      throw new AppError(404, `Listing ${listingId} not found for payment ${paymentIntentId}`, "LISTING_NOT_FOUND");
    }

    const orderNumber = meta.orderNumber ? String(meta.orderNumber) : await generateOrderNumber();
    const total = Number(breakdown.totalMinor) / 10 ** currencyExponent(currency);

    const paymentId = await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.upsert({
        where: { listingId },
        update: {
          status: "PAID",
          buyerId: buyer.id,
          amount: total,
          amountMinor: breakdown.totalMinor,
          currency,
          currencyExponent: currencyExponent(currency),
          gateway: "STRIPE",
          stripePaymentIntentId: paymentIntentId,
          gatewayTransactionId: paymentIntentId,
          paymentRecoveryStatus: "RECOVERED",
          paidAt: new Date(),
        },
        create: {
          listingId,
          buyerId: buyer.id,
          auctionId: meta.auctionId ? String(meta.auctionId) : null,
          amount: total,
          amountMinor: breakdown.totalMinor,
          currency,
          currencyExponent: currencyExponent(currency),
          gateway: "STRIPE",
          status: "PAID",
          stripePaymentIntentId: paymentIntentId,
          gatewayTransactionId: paymentIntentId,
          paidAt: new Date(),
        },
      });

      const attemptNo = await nextAttemptNumber(tx, payment.id);
      await tx.paymentAttempt.upsert({
        where: { idempotencyKey: `settle:${paymentIntentId}` },
        update: { status: "SUCCEEDED", amountMinor: breakdown.totalMinor, currency },
        create: {
          paymentId: payment.id,
          attemptNo,
          stripePaymentIntentId: paymentIntentId,
          status: "SUCCEEDED",
          amountMinor: breakdown.totalMinor,
          currency,
          idempotencyKey: `settle:${paymentIntentId}`,
        },
      });

      // Cash in, obligations out. Debits equal credits by construction,
      // because the components were just checked to sum to the captured
      // amount.
      await postTransaction(
        {
          kind: "CHARGE",
          referenceType: "PAYMENT",
          referenceId: payment.id,
          currency,
          description: `Stripe charge ${paymentIntentId}`,
          lines: [
            { account: "STRIPE_CASH", direction: "DEBIT", amountMinor: breakdown.totalMinor, paymentId: payment.id },
            ...(breakdown.purchasePriceMinor > 0n
              ? [
                  {
                    account: "SELLER_PAYABLE" as const,
                    direction: "CREDIT" as const,
                    amountMinor: breakdown.purchasePriceMinor,
                    sellerId: listing.sellerId,
                    paymentId: payment.id,
                  },
                ]
              : []),
            ...(breakdown.buyerFeeMinor > 0n
              ? [
                  {
                    account: "PLATFORM_FEE_REVENUE" as const,
                    direction: "CREDIT" as const,
                    amountMinor: breakdown.buyerFeeMinor,
                    paymentId: payment.id,
                  },
                ]
              : []),
            ...(breakdown.shippingMinor + breakdown.storageMinor > 0n
              ? [
                  {
                    account: "SHIPPING_REVENUE" as const,
                    direction: "CREDIT" as const,
                    amountMinor: breakdown.shippingMinor + breakdown.storageMinor,
                    paymentId: payment.id,
                  },
                ]
              : []),
            ...(breakdown.vatMinor > 0n
              ? [
                  {
                    account: "VAT_PAYABLE" as const,
                    direction: "CREDIT" as const,
                    amountMinor: breakdown.vatMinor,
                    paymentId: payment.id,
                  },
                ]
              : []),
          ],
        },
        tx,
      );

      // Written in the same transaction as the money, so the main server can
      // never be told about a payment that was rolled back.
      await enqueueOutboxEvent(tx, TXN_EVENTS.PAYMENT_SUCCEEDED, {
        paymentId: payment.id,
        paymentIntentId,
        listingId,
        auctionId: meta.auctionId ? String(meta.auctionId) : null,
        buyerId: buyer.id,
        buyerUserId: meta.buyerUserId ? String(meta.buyerUserId) : null,
        sellerId: listing.sellerId,
        orderNumber,
        currency,
        amountMinor: breakdown.totalMinor.toString(),
        // The fulfilment half of the old finalizeSuccessfulPayment needs the
        // same numbers, so they travel with the event rather than being
        // re-derived from metadata on the other side.
        breakdown: {
          purchasePrice: minorToMajor(breakdown.purchasePriceMinor, currency),
          buyerFee: minorToMajor(breakdown.buyerFeeMinor, currency),
          shippingCost: minorToMajor(breakdown.shippingMinor, currency),
          storageFee: minorToMajor(breakdown.storageMinor, currency),
          taxAmount: minorToMajor(breakdown.vatMinor, currency),
          totalAmount: total,
        },
        purchaseType: meta.purchaseType ? String(meta.purchaseType) : listing.saleType,
        storageSelected: meta.storageSelected === "true" || meta.storageSelected === true,
        destinationCountry: meta.destinationCountry ? String(meta.destinationCountry) : null,
        shippingAddress: parseAddress(meta.shippingAddress),
        source,
      });

      return payment.id;
    });

    await recordAudit({
      actorType: "SYSTEM",
      action: "PAYMENT_SETTLED",
      entityType: "PAYMENT",
      entityId: paymentId,
      amountMinor: breakdown.totalMinor,
      currency,
      reason: source,
      after: { status: "PAID", paymentIntentId },
    });

    logger.info("Payment settled", { paymentId, paymentIntentId, orderNumber });
    return { status: "SETTLED", paymentId, orderNumber };
  }

  /**
   * Hold a payment whose captured amount does not match its quote.
   *
   * Deliberately not an exception: the event has been handled correctly, and
   * the right outcome is a payment nobody fulfils until a human has looked.
   */
  private static async quarantine(input: {
    paymentIntentId: string;
    listingId: string;
    capturedMinor: bigint;
    expectedMinor: bigint;
    currency: string;
  }): Promise<SettleResult> {
    const reason = `Captured ${input.capturedMinor} ${input.currency} but the quote totals ${input.expectedMinor}`;

    logger.error("Payment amount mismatch; quarantined", {
      paymentIntentId: input.paymentIntentId,
      listingId: input.listingId,
      capturedMinor: input.capturedMinor.toString(),
      expectedMinor: input.expectedMinor.toString(),
    });

    await prisma.$transaction(async (tx) => {
      await tx.payment.updateMany({
        where: {
          OR: [
            { stripePaymentIntentId: input.paymentIntentId },
            { gatewayTransactionId: input.paymentIntentId },
            { listingId: input.listingId },
          ],
        },
        data: {
          status: "PROCESSING",
          failureReason: reason,
          lastFailureCode: "amount_mismatch",
          lastFailureMessage: reason,
        },
      });

      await enqueueOutboxEvent(tx, TXN_EVENTS.PAYMENT_QUARANTINED, {
        paymentIntentId: input.paymentIntentId,
        listingId: input.listingId,
        capturedMinor: input.capturedMinor.toString(),
        expectedMinor: input.expectedMinor.toString(),
        currency: input.currency,
        reason,
      });
    });

    await recordAudit({
      actorType: "SYSTEM",
      action: "PAYMENT_QUARANTINED",
      entityType: "PAYMENT_INTENT",
      entityId: input.paymentIntentId,
      amountMinor: input.capturedMinor,
      currency: input.currency,
      reason,
    });

    return { status: "QUARANTINED", reason };
  }

  /** Record a declined charge and open the 24h recovery window. */
  static async recordFailure(intent: Stripe.PaymentIntent): Promise<void> {
    const now = new Date();
    const recoveryExpiresAt = new Date(now.getTime() + RECOVERY_WINDOW_MS);
    const failureCode = intent.last_payment_error?.code || "payment_failed";
    const failureMessage = intent.last_payment_error?.message || "Payment attempt failed";
    const listingId = intent.metadata?.listingId;
    const auctionId = intent.metadata?.auctionId;

    await prisma.$transaction(async (tx) => {
      await tx.payment.updateMany({
        where: {
          OR: [
            { stripePaymentIntentId: intent.id },
            { gatewayTransactionId: intent.id },
            ...(listingId ? [{ listingId }] : []),
            ...(auctionId ? [{ auctionId }] : []),
          ],
        },
        data: {
          status: "FAILED",
          paymentRecoveryStatus: "REQUIRED",
          stripePaymentIntentId: intent.id,
          gatewayTransactionId: intent.id,
          recoveryRequiredAt: now,
          recoveryStartedAt: now,
          recoveryExpiresAt,
          lastFailureCode: failureCode,
          lastFailureMessage: failureMessage,
        },
      });

      await enqueueOutboxEvent(tx, TXN_EVENTS.PAYMENT_FAILED, {
        paymentIntentId: intent.id,
        listingId: listingId ?? null,
        auctionId: auctionId ?? null,
        buyerUserId: intent.metadata?.buyerUserId ?? null,
        buyerId: intent.metadata?.buyerId ?? null,
        failureCode,
        failureMessage,
        recoveryExpiresAt: recoveryExpiresAt.toISOString(),
      });

      // The buyer is now blocked from bidding, so the main server's cached
      // eligibility answer has to go.
      await enqueueOutboxEvent(tx, TXN_EVENTS.PAYMENT_RECOVERY_OPENED, {
        buyerUserId: intent.metadata?.buyerUserId ?? null,
        buyerId: intent.metadata?.buyerId ?? null,
        listingId: listingId ?? null,
        recoveryExpiresAt: recoveryExpiresAt.toISOString(),
      });
    });
  }

  /** Record a refund against a charge. */
  static async recordRefund(charge: Stripe.Charge, paymentIntentId: string): Promise<void> {
    const currency = (charge.currency || "aed").toUpperCase();
    const refundedMinor = BigInt(charge.amount_refunded ?? 0);
    const fullyRefunded = charge.amount_refunded >= charge.amount;

    const payment = await prisma.payment.findFirst({
      where: { OR: [{ stripePaymentIntentId: paymentIntentId }, { gatewayTransactionId: paymentIntentId }] },
      select: { id: true, buyerId: true },
    });

    if (!payment) {
      logger.warn("Refund for an unknown payment intent", { paymentIntentId });
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: payment.id },
        // A partial refund leaves the payment PAID; only a full one flips it.
        data: { status: fullyRefunded ? "REFUNDED" : "PAID" },
      });

      await postTransaction(
        {
          kind: "REFUND",
          referenceType: "PAYMENT",
          referenceId: payment.id,
          currency,
          description: `Refund on ${paymentIntentId}`,
          lines: [
            { account: "REFUNDS", direction: "DEBIT", amountMinor: refundedMinor, paymentId: payment.id },
            { account: "STRIPE_CASH", direction: "CREDIT", amountMinor: refundedMinor, paymentId: payment.id },
          ],
        },
        tx,
      );

      await enqueueOutboxEvent(tx, TXN_EVENTS.REFUND_SUCCEEDED, {
        paymentId: payment.id,
        paymentIntentId,
        amountMinor: refundedMinor.toString(),
        currency,
        fullyRefunded,
      });
    });
  }
}

function minorToMajor(amountMinor: bigint, currency: string): number {
  return Number(amountMinor) / 10 ** currencyExponent(currency);
}

function parseAddress(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === "object") return value as Record<string, unknown>;

  try {
    const parsed = JSON.parse(String(value));
    return typeof parsed === "object" && parsed ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Order numbers are `TA-<year>-<5 digits>`, which is a 90,000-value space with
 * no unique index behind it. Until that changes, generate and check.
 */
async function generateOrderNumber(): Promise<string> {
  const year = new Date().getFullYear();

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = `TA-${year}-${Math.floor(10000 + Math.random() * 90000)}`;
    const taken = await prisma.fulfillmentOrder.findFirst({
      where: { orderNumber: candidate },
      select: { id: true },
    });
    if (!taken) return candidate;
  }

  // Fall back to something that cannot collide, even if it is uglier.
  return `TA-${year}-${Date.now().toString().slice(-8)}`;
}

async function nextAttemptNumber(tx: PrismaTransaction, paymentId: string): Promise<number> {
  const last = await tx.paymentAttempt.findFirst({
    where: { paymentId },
    orderBy: { attemptNo: "desc" },
    select: { attemptNo: true },
  });
  return (last?.attemptNo ?? 0) + 1;
}
