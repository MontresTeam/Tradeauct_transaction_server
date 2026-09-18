/**
 * Charging a card without the buyer present.
 *
 * Two cases: an auction winner whose saved card is charged when the auction
 * ends, and a retry inside the 24-hour recovery window after one of those
 * charges failed. Both are off-session, which is why the mandate is captured
 * when the card is saved.
 *
 * A failure here is not an error to swallow: it opens a recovery window that
 * blocks the buyer from bidding until they settle, and that window is what the
 * bids module checks.
 */
import type Stripe from "stripe";
import { type AuditEntry, recordAudit } from "../../core/audit.js";
import { AppError } from "../../core/errors/AppError.js";
import { logger } from "../../core/logger.js";
import { currencyExponent, toMinorUnits, toStripeAmount } from "../../core/money.js";
import { enqueueOutboxEvent, TXN_EVENTS } from "../../core/outbox.js";
import { prisma } from "../../core/prisma.js";
import { getStripeClient } from "../gateway/stripe.client.js";
import { PaymentFinalizationService } from "../payments/payments.finalize.service.js";
import { calculateLiveTotalBreakdown, getAuthoritativeFeeConfigs } from "../quote/buyerFee.utils.js";
import { buildQuoteMetadata, QUOTE_CURRENCY } from "../quote/quote.service.js";

const RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_RECOVERY_ATTEMPTS = 5;

type AuditActor = Pick<AuditEntry, "actorType" | "actorId" | "service" | "ip">;

/** Declared, not inferred: an inferred shape would leak Stripe module paths. */
export type RetryResult = {
  success: boolean;
  status: string;
  paymentId: string;
  paymentIntentId?: string;
  clientSecret?: string | null;
};

export type WinnerChargeResult = {
  success: boolean;
  reason?: string;
  paymentId?: string;
  paymentIntentId?: string;
  status?: string;
  recoveryExpiresAt?: string;
};

export class ChargeService {
  /**
   * Charge the winner of a closed auction.
   *
   * Driven by a queue command rather than a request, so a restart mid-charge
   * does not lose the work — and so the auction-closing path does not wait on
   * Stripe.
   */
  static async chargeAuctionWinner(auctionId: string, winnerId: string): Promise<WinnerChargeResult> {
    const auction = await prisma.auction.findFirst({
      where: { OR: [{ id: auctionId }, { listingId: auctionId }] },
      include: {
        listing: true,
        bids: { orderBy: { amount: "desc" }, take: 1 },
      },
    });

    if (!auction) {
      throw new AppError(404, `Auction not found: ${auctionId}`, "AUCTION_NOT_FOUND");
    }

    const highestBid = auction.bids[0];
    if (!highestBid) {
      logger.info("Auction closed with no bids", { auctionId: auction.id });
      return { success: false, reason: "NO_BIDS" };
    }

    const buyer = await prisma.buyer.findFirst({
      where: {
        OR: [{ id: winnerId }, { userId: winnerId }, { id: highestBid.bidderId }, { userId: highestBid.bidderId }],
      },
      select: { id: true, userId: true, stripeCustomerId: true },
    });

    if (!buyer) {
      throw new AppError(404, "Winner buyer profile not found", "BUYER_NOT_FOUND");
    }

    const existing = await prisma.payment.findUnique({
      where: { listingId: auction.listingId },
      select: { id: true, status: true, stripePaymentIntentId: true, recoveryAttemptCount: true },
    });

    if (existing?.status === "PAID") {
      // The webhook may already have settled it, or this command is a retry of
      // one that succeeded.
      return { success: true, paymentId: existing.id, status: "ALREADY_PAID" };
    }

    const winningAmount = highestBid.amount;
    const feeConfigs = await getAuthoritativeFeeConfigs();
    const destinationCountry = "United Arab Emirates";

    const breakdown = calculateLiveTotalBreakdown({
      bidAmount: winningAmount,
      shippingPayer: auction.listing.shippingPayer || "BUYER",
      shippingCoverage: auction.listing.shippingCoverage || "WORLDWIDE",
      destinationCountry,
      buyerFeeConfig: feeConfigs.buyerFeeConfig,
      shippingConfig: feeConfigs.shippingConfig,
      vatConfig: feeConfigs.vatConfig,
    });

    const totals = {
      purchasePrice: winningAmount,
      buyerFee: breakdown.buyerFee,
      shippingCost: breakdown.estimatedShipping,
      storageFee: 0,
      vat: breakdown.vat,
      totalAmount: breakdown.estimatedTotal,
    };
    const totalMinor = toMinorUnits(totals.totalAmount, QUOTE_CURRENCY);

    const card = await prisma.savedPaymentMethod.findFirst({
      where: { buyerId: buyer.id, status: "active" },
      orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }, { createdAt: "desc" }],
    });

    if (!card) {
      const payment = await ChargeService.openRecovery({
        listingId: auction.listingId,
        auctionId: auction.id,
        buyerId: buyer.id,
        buyerUserId: buyer.userId,
        totalMinor,
        totalAmount: totals.totalAmount,
        failureCode: "no_saved_payment_method",
        failureMessage: "Winner has no active saved payment method on file",
        attemptNo: (existing?.recoveryAttemptCount ?? 0) + 1,
      });

      return {
        success: false,
        reason: "NO_SAVED_PAYMENT_METHOD",
        paymentId: payment.paymentId,
        recoveryExpiresAt: payment.recoveryExpiresAt,
      };
    }

    const attemptNo = (existing?.recoveryAttemptCount ?? 0) + 1;
    const metadata = buildQuoteMetadata({
      orderNumber: `TA-${new Date().getFullYear()}-${Date.now().toString().slice(-5)}`,
      buyerUserId: buyer.userId,
      buyerId: buyer.id,
      listingId: auction.listingId,
      sellerId: auction.listing.sellerId,
      auctionId: auction.id,
      purchaseType: "AUCTION",
      destinationCountry,
      storageSelected: false,
      breakdown: totals,
      shippingAddress: null,
    });

    try {
      const intent = await getStripeClient().paymentIntents.create(
        {
          amount: toStripeAmount(totalMinor),
          currency: QUOTE_CURRENCY.toLowerCase(),
          customer: card.stripeCustomerId,
          payment_method: card.stripePaymentMethodId,
          off_session: true,
          confirm: true,
          description: `TradeAuct Winner Payment: ${auction.listing.title}`,
          metadata,
        },
        {
          // The attempt number is part of the key. The old key was fixed per
          // auction and buyer, so a second attempt after a failure got
          // Stripe's cached first answer back instead of a real charge.
          idempotencyKey: `winner:${auction.id}:${buyer.id}:${attemptNo}`,
        },
      );

      await ChargeService.recordAttempt({
        listingId: auction.listingId,
        auctionId: auction.id,
        buyerId: buyer.id,
        intent,
        totalMinor,
        totalAmount: totals.totalAmount,
        attemptNo,
      });

      if (intent.status === "succeeded") {
        const settled = await PaymentFinalizationService.settlePaidIntent(intent.id, metadata, "winner-charge");
        return { success: true, paymentId: settled.paymentId, paymentIntentId: intent.id, status: settled.status };
      }

      if (intent.status === "requires_action") {
        // 3D Secure cannot be completed without the buyer, so this becomes a
        // recovery the buyer is asked to finish.
        const recovery = await ChargeService.openRecovery({
          listingId: auction.listingId,
          auctionId: auction.id,
          buyerId: buyer.id,
          buyerUserId: buyer.userId,
          totalMinor,
          totalAmount: totals.totalAmount,
          failureCode: "authentication_required",
          failureMessage: "The card issuer requires the buyer to authenticate this payment",
          attemptNo,
          paymentIntentId: intent.id,
          isTechnicalFailure: true,
        });

        return {
          success: false,
          reason: "REQUIRES_ACTION",
          paymentId: recovery.paymentId,
          paymentIntentId: intent.id,
          recoveryExpiresAt: recovery.recoveryExpiresAt,
        };
      }

      return { success: false, reason: intent.status, paymentIntentId: intent.id };
    } catch (error) {
      const stripeError = error as Stripe.errors.StripeError;
      const recovery = await ChargeService.openRecovery({
        listingId: auction.listingId,
        auctionId: auction.id,
        buyerId: buyer.id,
        buyerUserId: buyer.userId,
        totalMinor,
        totalAmount: totals.totalAmount,
        failureCode: stripeError?.code || stripeError?.decline_code || "charge_failed",
        failureMessage: stripeError?.message || "The card was declined",
        attemptNo,
        paymentIntentId: stripeError?.payment_intent?.id,
      });

      logger.warn("Winner charge declined", {
        auctionId: auction.id,
        failureCode: stripeError?.code,
        paymentId: recovery.paymentId,
      });

      return {
        success: false,
        reason: "DECLINED",
        paymentId: recovery.paymentId,
        recoveryExpiresAt: recovery.recoveryExpiresAt,
      };
    }
  }

  /**
   * Retry a failed payment inside its recovery window.
   *
   * The buyer is present for this one, so a 3D Secure challenge can be
   * returned to them as a client secret rather than becoming another failure.
   */
  static async retryPayment(
    actorUserId: string,
    paymentId: string,
    paymentMethodId: string | undefined,
    actor: AuditActor,
  ): Promise<RetryResult> {
    const buyer = await prisma.buyer.findFirst({
      where: { OR: [{ userId: actorUserId }, { id: actorUserId }] },
      select: { id: true, userId: true },
    });

    if (!buyer) {
      throw new AppError(404, "Buyer profile not found", "BUYER_NOT_FOUND");
    }

    const payment = await prisma.payment.findFirst({
      where: {
        buyerId: buyer.id,
        OR: [{ id: paymentId }, { listingId: paymentId }, { auctionId: paymentId }],
      },
      include: { listing: { select: { title: true } } },
    });

    if (!payment) {
      throw new AppError(404, "Payment record not found", "PAYMENT_NOT_FOUND");
    }

    if (payment.status === "PAID") {
      return { success: true, status: "ALREADY_PAID", paymentId: payment.id };
    }

    if (payment.recoveryExpiresAt && payment.recoveryExpiresAt.getTime() <= Date.now()) {
      // Mark it expired on the way out, so the state matches what the buyer
      // is being told even if the sweeper has not run yet.
      await prisma.payment.update({
        where: { id: payment.id },
        data: { paymentRecoveryStatus: "EXPIRED" },
      });
      throw new AppError(400, "The payment recovery window has expired.", "PAYMENT_RECOVERY_EXPIRED");
    }

    if ((payment.recoveryAttemptCount ?? 0) >= MAX_RECOVERY_ATTEMPTS) {
      throw new AppError(
        429,
        "Too many payment attempts. Please contact support.",
        "PAYMENT_RECOVERY_ATTEMPTS_EXHAUSTED",
      );
    }

    const card = paymentMethodId
      ? await prisma.savedPaymentMethod.findFirst({
          // Scoped to the caller: a payment-method id from somebody else must
          // not be chargeable here.
          where: {
            buyerId: buyer.id,
            status: "active",
            OR: [{ id: paymentMethodId }, { stripePaymentMethodId: paymentMethodId }],
          },
        })
      : await prisma.savedPaymentMethod.findFirst({
          where: { buyerId: buyer.id, status: "active" },
          orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
        });

    if (!card) {
      throw new AppError(400, "No usable payment method found for this retry.", "PAYMENT_METHOD_NOT_FOUND");
    }

    const attemptNo = (payment.recoveryAttemptCount ?? 0) + 1;
    const now = new Date();
    const currency = payment.currency || QUOTE_CURRENCY;
    const amountMinor = payment.amountMinor ?? toMinorUnits(payment.amount, currency);

    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        paymentRecoveryStatus: "IN_PROGRESS",
        recoveryAttemptCount: attemptNo,
        lastRecoveryAttemptAt: now,
      },
    });

    try {
      const intent = await getStripeClient().paymentIntents.create(
        {
          amount: toStripeAmount(amountMinor),
          currency: currency.toLowerCase(),
          customer: card.stripeCustomerId,
          payment_method: card.stripePaymentMethodId,
          off_session: true,
          confirm: true,
          description: `TradeAuct Recovery Retry (attempt ${attemptNo}): ${payment.listing?.title ?? payment.listingId}`,
          metadata: {
            paymentId: payment.id,
            listingId: payment.listingId,
            ...(payment.auctionId ? { auctionId: payment.auctionId } : {}),
            buyerId: buyer.id,
            buyerUserId: buyer.userId,
            attemptNumber: String(attemptNo),
            isRecoveryRetry: "true",
          },
        },
        { idempotencyKey: `retry:${payment.id}:${attemptNo}` },
      );

      if (intent.status === "succeeded") {
        // Metadata on a retry carries no breakdown, so the finalizer reads it
        // from the intent and reconciles against amount_received as usual.
        const settled = await PaymentFinalizationService.settlePaidIntent(
          intent.id,
          { ...intent.metadata, listingId: payment.listingId } as never,
          "recovery-retry",
        );

        await prisma.payment.update({
          where: { id: payment.id },
          data: { paymentRecoveryStatus: "RECOVERED", paidAt: new Date() },
        });

        await ChargeService.announceRecoveryResolved(buyer, payment.listingId);

        await recordAudit({
          ...actor,
          action: "PAYMENT_RECOVERY_SUCCEEDED",
          entityType: "PAYMENT",
          entityId: payment.id,
          amountMinor,
          currency,
          after: { attemptNo },
        });

        return { success: true, status: settled.status, paymentId: payment.id, paymentIntentId: intent.id };
      }

      if (intent.status === "requires_action") {
        await prisma.payment.update({
          where: { id: payment.id },
          data: { status: "REQUIRES_ACTION", paymentRecoveryStatus: "RETRYING" },
        });

        return {
          success: false,
          status: "REQUIRES_ACTION",
          paymentId: payment.id,
          paymentIntentId: intent.id,
          // The buyer is here, so they can complete the challenge.
          clientSecret: intent.client_secret,
        };
      }

      await prisma.payment.update({
        where: { id: payment.id },
        data: { paymentRecoveryStatus: "RETRYING", stripePaymentIntentId: intent.id },
      });

      return { success: false, status: intent.status, paymentId: payment.id, paymentIntentId: intent.id };
    } catch (error) {
      const stripeError = error as Stripe.errors.StripeError;

      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: "FAILED",
          paymentRecoveryStatus: "REQUIRED",
          lastFailureCode: stripeError?.code || stripeError?.decline_code || "charge_failed",
          lastFailureMessage: stripeError?.message || "The card was declined",
        },
      });

      await recordAudit({
        ...actor,
        action: "PAYMENT_RECOVERY_FAILED",
        entityType: "PAYMENT",
        entityId: payment.id,
        reason: stripeError?.code,
      });

      throw new AppError(
        402,
        stripeError?.message || "The card was declined.",
        stripeError?.code || "PAYMENT_DECLINED",
      );
    }
  }

  /** Write the failed payment and open its 24-hour window. */
  private static async openRecovery(input: {
    listingId: string;
    auctionId: string | null;
    buyerId: string;
    buyerUserId: string;
    totalMinor: bigint;
    totalAmount: number;
    failureCode: string;
    failureMessage: string;
    attemptNo: number;
    paymentIntentId?: string;
    isTechnicalFailure?: boolean;
  }): Promise<{ paymentId: string; recoveryExpiresAt: string }> {
    const now = new Date();
    const recoveryExpiresAt = new Date(now.getTime() + RECOVERY_WINDOW_MS);

    const paymentId = await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.upsert({
        where: { listingId: input.listingId },
        update: {
          buyerId: input.buyerId,
          auctionId: input.auctionId,
          amount: input.totalAmount,
          amountMinor: input.totalMinor,
          currency: QUOTE_CURRENCY,
          currencyExponent: currencyExponent(QUOTE_CURRENCY),
          status: "FAILED",
          failureReason: input.failureMessage,
          paymentRecoveryStatus: "REQUIRED",
          recoveryRequiredAt: now,
          recoveryStartedAt: now,
          recoveryExpiresAt,
          recoveryAttemptCount: input.attemptNo,
          lastRecoveryAttemptAt: now,
          lastFailureCode: input.failureCode,
          lastFailureMessage: input.failureMessage,
          isTechnicalFailure: Boolean(input.isTechnicalFailure),
          ...(input.paymentIntentId
            ? { stripePaymentIntentId: input.paymentIntentId, gatewayTransactionId: input.paymentIntentId }
            : {}),
        },
        create: {
          listingId: input.listingId,
          auctionId: input.auctionId,
          buyerId: input.buyerId,
          amount: input.totalAmount,
          amountMinor: input.totalMinor,
          currency: QUOTE_CURRENCY,
          currencyExponent: currencyExponent(QUOTE_CURRENCY),
          gateway: "STRIPE",
          status: "FAILED",
          failureReason: input.failureMessage,
          paymentRecoveryStatus: "REQUIRED",
          recoveryRequiredAt: now,
          recoveryStartedAt: now,
          recoveryExpiresAt,
          recoveryAttemptCount: input.attemptNo,
          lastRecoveryAttemptAt: now,
          lastFailureCode: input.failureCode,
          lastFailureMessage: input.failureMessage,
          isTechnicalFailure: Boolean(input.isTechnicalFailure),
          ...(input.paymentIntentId
            ? { stripePaymentIntentId: input.paymentIntentId, gatewayTransactionId: input.paymentIntentId }
            : {}),
        },
      });

      await tx.paymentAttempt.create({
        data: {
          paymentId: payment.id,
          attemptNo: input.attemptNo,
          stripePaymentIntentId: input.paymentIntentId ?? null,
          status: "FAILED",
          amountMinor: input.totalMinor,
          currency: QUOTE_CURRENCY,
          offSession: true,
          failureCode: input.failureCode,
          failureMessage: input.failureMessage,
          idempotencyKey: `attempt:${payment.id}:${input.attemptNo}`,
        },
      });

      await enqueueOutboxEvent(tx, TXN_EVENTS.PAYMENT_FAILED, {
        paymentId: payment.id,
        listingId: input.listingId,
        auctionId: input.auctionId,
        buyerId: input.buyerId,
        buyerUserId: input.buyerUserId,
        failureCode: input.failureCode,
        failureMessage: input.failureMessage,
        recoveryExpiresAt: recoveryExpiresAt.toISOString(),
      });

      await enqueueOutboxEvent(tx, TXN_EVENTS.PAYMENT_RECOVERY_OPENED, {
        paymentId: payment.id,
        buyerId: input.buyerId,
        buyerUserId: input.buyerUserId,
        listingId: input.listingId,
        recoveryExpiresAt: recoveryExpiresAt.toISOString(),
      });

      return payment.id;
    });

    await recordAudit({
      actorType: "SYSTEM",
      action: "PAYMENT_RECOVERY_OPENED",
      entityType: "PAYMENT",
      entityId: paymentId,
      amountMinor: input.totalMinor,
      currency: QUOTE_CURRENCY,
      reason: input.failureCode,
    });

    return { paymentId, recoveryExpiresAt: recoveryExpiresAt.toISOString() };
  }

  /** Record a non-terminal attempt (pending, requires_action, succeeded). */
  private static async recordAttempt(input: {
    listingId: string;
    auctionId: string;
    buyerId: string;
    intent: Stripe.PaymentIntent;
    totalMinor: bigint;
    totalAmount: number;
    attemptNo: number;
  }): Promise<void> {
    const status =
      input.intent.status === "succeeded"
        ? "PAID"
        : input.intent.status === "requires_action"
          ? "REQUIRES_ACTION"
          : "PENDING";

    await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.upsert({
        where: { listingId: input.listingId },
        update: {
          buyerId: input.buyerId,
          auctionId: input.auctionId,
          amount: input.totalAmount,
          amountMinor: input.totalMinor,
          currency: QUOTE_CURRENCY,
          currencyExponent: currencyExponent(QUOTE_CURRENCY),
          gateway: "STRIPE",
          status,
          stripePaymentIntentId: input.intent.id,
          gatewayTransactionId: input.intent.id,
        },
        create: {
          listingId: input.listingId,
          auctionId: input.auctionId,
          buyerId: input.buyerId,
          amount: input.totalAmount,
          amountMinor: input.totalMinor,
          currency: QUOTE_CURRENCY,
          currencyExponent: currencyExponent(QUOTE_CURRENCY),
          gateway: "STRIPE",
          status,
          stripePaymentIntentId: input.intent.id,
          gatewayTransactionId: input.intent.id,
        },
      });

      await tx.paymentAttempt.upsert({
        where: { idempotencyKey: `attempt:${payment.id}:${input.attemptNo}` },
        update: {
          status: input.intent.status === "succeeded" ? "SUCCEEDED" : "REQUIRES_ACTION",
          stripePaymentIntentId: input.intent.id,
        },
        create: {
          paymentId: payment.id,
          attemptNo: input.attemptNo,
          stripePaymentIntentId: input.intent.id,
          status: input.intent.status === "succeeded" ? "SUCCEEDED" : "PENDING",
          amountMinor: input.totalMinor,
          currency: QUOTE_CURRENCY,
          offSession: true,
          idempotencyKey: `attempt:${payment.id}:${input.attemptNo}`,
        },
      });
    });
  }

  private static async announceRecoveryResolved(
    buyer: { id: string; userId: string },
    listingId: string,
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await enqueueOutboxEvent(tx, TXN_EVENTS.PAYMENT_RECOVERY_RECOVERED, {
        buyerId: buyer.id,
        buyerUserId: buyer.userId,
        listingId,
      });
    });
  }

  /**
   * Expire recovery windows that have run out.
   *
   * Each row is re-read inside its own transaction before being changed: a
   * payment that was settled between the sweep query and the write must not be
   * marked expired.
   */
  static async expireStaleRecoveries(): Promise<number> {
    const now = new Date();
    const candidates = await prisma.payment.findMany({
      where: {
        paymentRecoveryStatus: { in: ["REQUIRED", "IN_PROGRESS", "RETRYING"] },
        recoveryExpiresAt: { lte: now },
        status: { not: "PAID" },
      },
      select: { id: true, buyerId: true, listingId: true, amountMinor: true, currency: true },
    });

    let expired = 0;

    for (const candidate of candidates) {
      const changed = await prisma.$transaction(async (tx) => {
        const fresh = await tx.payment.findUnique({
          where: { id: candidate.id },
          select: { status: true, paymentRecoveryStatus: true, recoveryExpiresAt: true },
        });

        if (
          !fresh ||
          fresh.status === "PAID" ||
          fresh.paymentRecoveryStatus === "EXPIRED" ||
          fresh.paymentRecoveryStatus === "RECOVERED" ||
          !fresh.recoveryExpiresAt ||
          fresh.recoveryExpiresAt.getTime() > Date.now()
        ) {
          return false;
        }

        await tx.payment.update({
          where: { id: candidate.id },
          data: { paymentRecoveryStatus: "EXPIRED" },
        });

        await tx.financialAuditLog.create({
          data: {
            action: "PAYMENT_RECOVERY_EXPIRED",
            entityType: "PAYMENT",
            entityId: candidate.id,
            reason: "The 24-hour payment recovery window elapsed without a successful payment",
            performedByRole: "SYSTEM",
          },
        });

        await enqueueOutboxEvent(tx, TXN_EVENTS.PAYMENT_RECOVERY_EXPIRED, {
          paymentId: candidate.id,
          buyerId: candidate.buyerId,
          listingId: candidate.listingId,
        });

        return true;
      });

      if (changed) expired += 1;
    }

    if (expired > 0) {
      logger.info("Expired payment recovery windows", { count: expired });
    }

    return expired;
  }
}

let recoveryTimer: NodeJS.Timeout | null = null;

export function startRecoveryScheduler(intervalMs = 60000): void {
  if (recoveryTimer) return;

  const tick = async (): Promise<void> => {
    try {
      await ChargeService.expireStaleRecoveries();
    } catch (error) {
      logger.error("Recovery sweep failed", { error });
    }
  };

  void tick();
  recoveryTimer = setInterval(() => void tick(), intervalMs);
  logger.info("Recovery scheduler started", { intervalMs });
}

export function stopRecoveryScheduler(): void {
  if (!recoveryTimer) return;
  clearInterval(recoveryTimer);
  recoveryTimer = null;
}
