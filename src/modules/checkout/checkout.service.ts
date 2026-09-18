/**
 * Starting a payment.
 *
 * Two entry points — a hosted Checkout Session and a PaymentIntent for Stripe
 * Elements — both priced by the same quote, both attaching the same metadata,
 * and both writing the same pending `Payment` row. Confirmation is a third
 * path, used when the browser completes an Elements payment and wants the
 * order fulfilled without waiting for the webhook.
 */
import type Stripe from "stripe";
import { type AuditEntry, recordAudit } from "../../core/audit.js";
import { AppError } from "../../core/errors/AppError.js";
import { logger } from "../../core/logger.js";
import { currencyExponent, toStripeAmount } from "../../core/money.js";
import { prisma } from "../../core/prisma.js";
import { getStripeClient } from "../gateway/stripe.client.js";
import { PaymentFinalizationService, type PaymentMetadata } from "../payments/payments.finalize.service.js";
import { type AddressPayload, buildOrderQuote, type OrderQuote } from "../quote/quote.service.js";

type AuditActor = Pick<AuditEntry, "actorType" | "actorId" | "service" | "ip">;

export type CreateCheckoutInput = {
  listingId: string;
  shippingAddress: AddressPayload;
  purchaseType?: "AUCTION" | "BUY_NOW" | "OFFER";
  storageSelected?: boolean;
  successUrl: string;
  cancelUrl: string;
};

export type CreateIntentInput = Omit<CreateCheckoutInput, "successUrl" | "cancelUrl">;

export type ConfirmInput = {
  paymentIntentId: string;
  listingId: string;
};

function minorOf(amount: number, currency: string): number {
  return Math.round(amount * 10 ** currencyExponent(currency));
}

export class CheckoutService {
  /**
   * Record the pending payment for a quote.
   *
   * `Payment.listingId` is unique, so this is an upsert. A row already marked
   * PAID is never overwritten — that would turn a completed purchase back into
   * a pending one and lose the link to its charge.
   */
  private static async upsertPendingPayment(quote: OrderQuote, paymentIntentId: string): Promise<string> {
    const existing = await prisma.payment.findUnique({
      where: { listingId: quote.listing.id },
      select: { id: true, status: true },
    });

    if (existing?.status === "PAID") {
      throw new AppError(409, "This listing has already been paid for.", "PAYMENT_ALREADY_COMPLETED");
    }

    const payment = await prisma.payment.upsert({
      where: { listingId: quote.listing.id },
      update: {
        buyerId: quote.buyer.id,
        amount: quote.breakdown.totalAmount,
        amountMinor: quote.totalMinor,
        currency: quote.currency,
        currencyExponent: currencyExponent(quote.currency),
        gateway: "STRIPE",
        status: "PENDING",
        stripePaymentIntentId: paymentIntentId,
        gatewayTransactionId: paymentIntentId,
      },
      create: {
        listingId: quote.listing.id,
        buyerId: quote.buyer.id,
        amount: quote.breakdown.totalAmount,
        amountMinor: quote.totalMinor,
        currency: quote.currency,
        currencyExponent: currencyExponent(quote.currency),
        gateway: "STRIPE",
        status: "PENDING",
        stripePaymentIntentId: paymentIntentId,
        gatewayTransactionId: paymentIntentId,
      },
    });

    return payment.id;
  }

  /** PaymentIntent for client-side Stripe Elements. */
  static async createPaymentIntent(actorUserId: string, input: CreateIntentInput, actor: AuditActor) {
    const quote = await buildOrderQuote({
      buyerUserId: actorUserId,
      listingId: input.listingId,
      shippingAddress: input.shippingAddress,
      purchaseType: input.purchaseType,
      storageSelected: input.storageSelected,
    });

    const intent = await getStripeClient().paymentIntents.create(
      {
        amount: toStripeAmount(quote.totalMinor),
        currency: quote.currency.toLowerCase(),
        description: `TradeAuct Purchase: ${quote.listing.title} (${quote.orderNumber})`,
        metadata: quote.metadata,
        receipt_email: quote.buyer.email || undefined,
        automatic_payment_methods: { enabled: true },
      },
      // Keyed on the listing and the exact total, so a retried request reuses
      // the same intent while a re-quoted order gets a new one.
      { idempotencyKey: `intent:${quote.listing.id}:${quote.totalMinor}` },
    );

    const paymentId = await CheckoutService.upsertPendingPayment(quote, intent.id);

    await recordAudit({
      ...actor,
      action: "PAYMENT_INTENT_CREATED",
      entityType: "PAYMENT",
      entityId: paymentId,
      amountMinor: quote.totalMinor,
      currency: quote.currency,
      after: { paymentIntentId: intent.id, orderNumber: quote.orderNumber },
    });

    return {
      success: true,
      clientSecret: intent.client_secret,
      paymentIntentId: intent.id,
      orderNumber: quote.orderNumber,
      amount: quote.breakdown.totalAmount,
      currency: quote.currency,
      breakdown: quote.breakdown,
    };
  }

  /** Hosted Stripe Checkout, itemised so the buyer sees what they are paying for. */
  static async createCheckoutSession(actorUserId: string, input: CreateCheckoutInput, actor: AuditActor) {
    assertSafeRedirect(input.successUrl);
    assertSafeRedirect(input.cancelUrl);

    const quote = await buildOrderQuote({
      buyerUserId: actorUserId,
      listingId: input.listingId,
      shippingAddress: input.shippingAddress,
      purchaseType: input.purchaseType,
      storageSelected: input.storageSelected,
    });

    const currency = quote.currency.toLowerCase();
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
      {
        price_data: {
          currency,
          product_data: {
            name: quote.listing.title,
            description: `Order #${quote.orderNumber} — Item purchase`,
            images: quote.listing.imageUrl ? [quote.listing.imageUrl] : undefined,
          },
          unit_amount: minorOf(quote.breakdown.purchasePrice, quote.currency),
        },
        quantity: 1,
      },
    ];

    if (quote.breakdown.buyerFee > 0) {
      lineItems.push({
        price_data: {
          currency,
          product_data: { name: "TradeAuct Buyer Protection & Platform Fee" },
          unit_amount: minorOf(quote.breakdown.buyerFee, quote.currency),
        },
        quantity: 1,
      });
    }

    if (quote.breakdown.shippingCost > 0) {
      lineItems.push({
        price_data: {
          currency,
          product_data: { name: `Insured Express Shipping (${quote.destinationCountry})` },
          unit_amount: minorOf(quote.breakdown.shippingCost, quote.currency),
        },
        quantity: 1,
      });
    }

    if (quote.breakdown.vat > 0) {
      lineItems.push({
        price_data: {
          currency,
          // Labelled from the configured rate rather than a hardcoded "5%",
          // which was wrong whenever the setting said otherwise.
          product_data: { name: "VAT" },
          unit_amount: minorOf(quote.breakdown.vat, quote.currency),
        },
        quantity: 1,
      });
    }

    if (quote.breakdown.storageFee > 0) {
      lineItems.push({
        price_data: {
          currency,
          product_data: { name: "TradeAuct Vault Monthly Storage" },
          unit_amount: minorOf(quote.breakdown.storageFee, quote.currency),
        },
        quantity: 1,
      });
    }

    const session = await getStripeClient().checkout.sessions.create(
      {
        payment_method_types: ["card"],
        line_items: lineItems,
        mode: "payment",
        customer_email: quote.buyer.email || undefined,
        // Ownership of the session, checked before its status is ever shown.
        client_reference_id: quote.buyer.userId,
        payment_intent_data: { metadata: quote.metadata },
        metadata: quote.metadata,
        success_url: `${input.successUrl}${input.successUrl.includes("?") ? "&" : "?"}session_id={CHECKOUT_SESSION_ID}&order_number=${quote.orderNumber}`,
        cancel_url: input.cancelUrl,
      },
      { idempotencyKey: `session:${quote.listing.id}:${quote.totalMinor}` },
    );

    const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : session.id;
    const paymentId = await CheckoutService.upsertPendingPayment(quote, paymentIntentId);

    await recordAudit({
      ...actor,
      action: "CHECKOUT_SESSION_CREATED",
      entityType: "PAYMENT",
      entityId: paymentId,
      amountMinor: quote.totalMinor,
      currency: quote.currency,
      after: { sessionId: session.id, orderNumber: quote.orderNumber },
    });

    return {
      success: true,
      sessionId: session.id,
      sessionUrl: session.url,
      orderNumber: quote.orderNumber,
      amount: quote.breakdown.totalAmount,
      currency: quote.currency,
      breakdown: quote.breakdown,
    };
  }

  /**
   * Confirm an Elements payment the browser has already completed.
   *
   * Three things are verified against Stripe before anything is settled: the
   * intent succeeded, it is for the listing the caller named, and it belongs
   * to the caller. Without the second check a buyer could pay for a cheap
   * listing and confirm fulfilment of an expensive one.
   */
  static async confirmPayment(actorUserId: string, input: ConfirmInput, actor: AuditActor) {
    const intent = await getStripeClient().paymentIntents.retrieve(input.paymentIntentId);

    if (intent.status !== "succeeded") {
      throw new AppError(
        400,
        `Payment has not succeeded yet. Stripe reports: ${intent.status}`,
        "PAYMENT_NOT_SUCCEEDED",
      );
    }

    const metadata = (intent.metadata ?? {}) as PaymentMetadata;

    if (!metadata.listingId || String(metadata.listingId) !== input.listingId) {
      logger.error("Confirmation names a different listing than the payment", {
        paymentIntentId: intent.id,
        claimedListingId: input.listingId,
      });
      throw new AppError(403, "This payment is not for the listing provided.", "PAYMENT_LISTING_MISMATCH");
    }

    const buyer = await prisma.buyer.findFirst({
      where: { OR: [{ userId: actorUserId }, { id: actorUserId }] },
      select: { id: true, userId: true },
    });

    const owner = metadata.buyerUserId ? String(metadata.buyerUserId) : null;
    const ownerId = metadata.buyerId ? String(metadata.buyerId) : null;

    if (!buyer || (owner !== buyer.userId && owner !== actorUserId && ownerId !== buyer.id)) {
      throw new AppError(403, "This payment does not belong to the current buyer.", "PAYMENT_NOT_OWNED");
    }

    // The metadata is only a claim about the amount; settlePaidIntent
    // reconciles it against amount_received before anything is fulfilled.
    const result = await PaymentFinalizationService.settlePaidIntent(intent.id, metadata, "direct-confirmation");

    await recordAudit({
      ...actor,
      action: "PAYMENT_CONFIRMED_DIRECTLY",
      entityType: "PAYMENT",
      entityId: result.paymentId ?? intent.id,
      reason: result.status,
    });

    if (result.status === "QUARANTINED") {
      throw new AppError(409, "This payment is under review and has not been completed.", "PAYMENT_UNDER_REVIEW");
    }

    return {
      success: true,
      status: result.status,
      paymentId: result.paymentId,
      orderNumber: result.orderNumber,
    };
  }
}

/**
 * Redirect targets end up in a Stripe-hosted page, so they are checked here
 * rather than trusted: an open redirect on `success_url` would let a phishing
 * page sit at the end of a real payment flow.
 */
function assertSafeRedirect(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppError(400, "Redirect URL is not a valid absolute URL", "INVALID_REDIRECT_URL");
  }

  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new AppError(400, "Redirect URL must use HTTPS", "INVALID_REDIRECT_URL");
  }

  const allowed =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "tradeauct.com" ||
    parsed.hostname.endsWith(".tradeauct.com");

  if (!allowed) {
    throw new AppError(400, "Redirect URL host is not permitted", "INVALID_REDIRECT_URL");
  }
}
