/**
 * Read-side of the payment domain.
 *
 * Every method takes the actor the transaction server verified for itself, and
 * every query is scoped by it. That is the difference from the code this
 * replaces: `GET /api/v1/payments/:paymentId` on the main server accepted a
 * listing id — a value printed in the public catalogue — with no auth at all,
 * and answered with amounts, status and order numbers.
 */
import { AppError } from "../../core/errors/AppError.js";
import { prisma } from "../../core/prisma.js";
import { getStripeClient } from "../gateway/stripe.client.js";
import { type BuyerRecord, findBuyer, requireBuyer } from "./buyer.repository.js";

/** Recovery states that block a buyer from bidding. */
const BLOCKING_RECOVERY_STATES = ["REQUIRED", "IN_PROGRESS", "RETRYING", "EXPIRED"] as const;

/**
 * Declared explicitly rather than inferred: the inferred shape would reference
 * Stripe's internal module paths, which do not survive a declaration build.
 */
export type CheckoutSessionStatus = {
  success: true;
  sessionId: string;
  paymentStatus: string;
  sessionStatus: string | null;
  paymentIntentId: string | null;
  amountTotal: number | null;
  currency: string;
  orderNumber: string | null;
  listingId: string | null;
  recordStatus: string | null;
  fulfillmentReady: boolean;
};

export class PaymentReadService {
  /** Payment status by payment id, PaymentIntent id or listing id. */
  static async getPaymentStatus(actorUserId: string, paymentId: string) {
    const buyer = await requireBuyer(actorUserId);

    const payment = await prisma.payment.findFirst({
      where: {
        buyerId: buyer.id,
        OR: [{ id: paymentId }, { stripePaymentIntentId: paymentId }, { listingId: paymentId }],
      },
      include: { listing: { select: { id: true, title: true, status: true } }, fulfillmentOrder: true },
    });

    if (!payment) {
      // Same answer whether the row does not exist or belongs to someone else.
      throw new AppError(404, "Payment record not found", "PAYMENT_NOT_FOUND");
    }

    return {
      success: true,
      paymentId: payment.id,
      listingId: payment.listingId,
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      recoveryStatus: payment.paymentRecoveryStatus,
      stripePaymentIntentId: payment.stripePaymentIntentId,
      fulfillmentOrderNumber: payment.fulfillmentOrder?.orderNumber || null,
      paidAt: payment.paidAt,
    };
  }

  /**
   * Authoritative status of a Checkout Session.
   *
   * The buyer's success page calls this after the Stripe redirect. The redirect
   * query string is attacker-controlled and proves nothing, so Stripe is asked
   * directly and the local record only reports whether the webhook has landed.
   */
  static async getCheckoutSessionStatus(actorUserId: string, sessionId: string): Promise<CheckoutSessionStatus> {
    if (!sessionId.startsWith("cs_")) {
      throw new AppError(400, "A valid Stripe Checkout Session id is required", "INVALID_SESSION_ID");
    }

    const buyer = await requireBuyer(actorUserId);
    const session = await getStripeClient().checkout.sessions.retrieve(sessionId);

    // A session id leaked from a redirect URL must not expose another buyer's
    // order. The session is only ours if Stripe says so.
    const sessionOwner = session.client_reference_id || session.metadata?.buyerUserId || null;
    const ownerMatches = sessionOwner === actorUserId || sessionOwner === buyer.id || sessionOwner === buyer.userId;
    if (!sessionOwner || !ownerMatches) {
      throw new AppError(403, "This checkout session does not belong to the current user", "SESSION_NOT_OWNED");
    }

    const paymentIntentId =
      typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent?.id ?? null);

    const payment = paymentIntentId
      ? await prisma.payment.findFirst({
          where: {
            buyerId: buyer.id,
            OR: [{ stripePaymentIntentId: paymentIntentId }, { gatewayTransactionId: paymentIntentId }],
          },
          include: { fulfillmentOrder: true },
        })
      : null;

    return {
      success: true,
      sessionId: session.id,
      /** "paid" | "unpaid" | "no_payment_required" */
      paymentStatus: session.payment_status,
      /** "open" | "complete" | "expired" */
      sessionStatus: session.status,
      paymentIntentId,
      amountTotal: session.amount_total != null ? session.amount_total / 100 : null,
      currency: (session.currency || "aed").toUpperCase(),
      orderNumber: payment?.fulfillmentOrder?.orderNumber || session.metadata?.orderNumber || null,
      listingId: session.metadata?.listingId || payment?.listingId || null,
      /** Local record state: lags Stripe until the webhook has been processed. */
      recordStatus: payment?.status || null,
      fulfillmentReady: Boolean(payment?.fulfillmentOrder),
    };
  }

  /** Detailed recovery state for the buyer's recovery page. */
  static async getRecoveryStatus(actorUserId: string, paymentId: string) {
    const buyer = await requireBuyer(actorUserId);

    const payment = await prisma.payment.findFirst({
      where: {
        buyerId: buyer.id,
        OR: [
          { id: paymentId },
          { listingId: paymentId },
          { auctionId: paymentId },
          { listing: { auction: { id: paymentId } } },
        ],
      },
      include: {
        listing: {
          include: {
            media: { orderBy: { order: "asc" } },
            auction: true,
            seller: { include: { user: { select: { firstName: true, lastName: true } } } },
            masterReference: { include: { brand: true, collection: true } },
          },
        },
      },
    });

    if (!payment) {
      throw new AppError(404, "Payment record not found", "PAYMENT_NOT_FOUND");
    }

    const primaryMedia = payment.listing?.media?.[0]?.url || null;

    return {
      success: true,
      paymentId: payment.id,
      listingId: payment.listingId,
      auctionId: payment.auctionId || payment.listing?.auction?.id || null,
      title: payment.listing.title,
      listingTitle: payment.listing.title,
      image: primaryMedia,
      productImage: primaryMedia,
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      recoveryStatus: payment.paymentRecoveryStatus,
      recoveryStartedAt: payment.recoveryStartedAt,
      recoveryExpiresAt: payment.recoveryExpiresAt,
      attemptCount: payment.recoveryAttemptCount,
      lastFailureCode: payment.lastFailureCode,
      lastFailureMessage: payment.lastFailureMessage,
      listing: payment.listing,
    };
  }

  /** The unresolved payment, if any, that currently blocks a buyer. */
  private static async findBlockingRecovery(buyer: BuyerRecord) {
    return prisma.payment.findFirst({
      where: {
        OR: [
          { buyerId: buyer.id },
          { listing: { auction: { winnerId: buyer.id } } },
          { listing: { auction: { winnerId: buyer.userId } } },
        ],
        status: { not: "PAID" },
        paymentRecoveryStatus: { in: [...BLOCKING_RECOVERY_STATES] },
      },
      include: { listing: true },
    });
  }

  /**
   * Bidding eligibility. Asked on the bid hot path, so it stays a single
   * indexed query plus a count, and it answers both questions the bids module
   * needs: is there an unpaid win, and is there a card on file.
   */
  static async getEligibility(actorUserId: string) {
    const buyer = await findBuyer(actorUserId);

    if (!buyer) {
      // No buyer profile means no saved card, so bidding is not possible yet.
      return {
        success: true,
        canPlaceBid: false,
        hasActiveRecovery: false,
        hasPaymentMethod: false,
        reason: "BUYER_PROFILE_MISSING" as const,
        recoveryState: null,
      };
    }

    const [recoveryState, activeCards] = await Promise.all([
      PaymentReadService.findBlockingRecovery(buyer),
      prisma.savedPaymentMethod.count({ where: { buyerId: buyer.id, status: "active" } }),
    ]);

    const hasPaymentMethod = activeCards > 0;
    const hasActiveRecovery = Boolean(recoveryState);

    return {
      success: true,
      // Mirrors the main server's two gates: an unpaid auction win blocks
      // bidding, and so does having no card on file.
      canPlaceBid: hasPaymentMethod && !hasActiveRecovery,
      hasActiveRecovery,
      hasPaymentMethod,
      reason: hasActiveRecovery
        ? ("PAYMENT_RECOVERY_REQUIRED" as const)
        : hasPaymentMethod
          ? null
          : ("PAYMENT_METHOD_REQUIRED" as const),
      recoveryState,
    };
  }

  /** Admin diagnostic: a buyer's outstanding payment obligations. */
  static async getBuyerDiagnostic(userIdOrBuyerId: string) {
    const buyer = await prisma.buyer.findFirst({
      where: { OR: [{ id: userIdOrBuyerId }, { userId: userIdOrBuyerId }] },
      include: { user: { select: { id: true, email: true, firstName: true, lastName: true } } },
    });

    if (!buyer) {
      throw new AppError(404, "Buyer profile not found", "BUYER_NOT_FOUND");
    }

    const unresolvedPayments = await prisma.payment.findMany({
      where: {
        OR: [
          { buyerId: buyer.id },
          { listing: { auction: { winnerId: buyer.id } } },
          { listing: { auction: { winnerId: buyer.userId } } },
        ],
        status: { not: "PAID" },
        paymentRecoveryStatus: { in: [...BLOCKING_RECOVERY_STATES] },
      },
      include: { listing: { select: { title: true } } },
    });

    const canBid = unresolvedPayments.length === 0;

    return {
      success: true,
      buyerId: buyer.id,
      userId: buyer.userId,
      email: buyer.user?.email,
      canBid,
      unresolvedPaymentsCount: unresolvedPayments.length,
      unresolvedPayments: unresolvedPayments.map((payment) => ({
        paymentId: payment.id,
        listingId: payment.listingId,
        auctionId: payment.auctionId,
        title: payment.listing?.title,
        amount: payment.amount,
        currency: payment.currency,
        paymentStatus: payment.status,
        recoveryStatus: payment.paymentRecoveryStatus,
        recoveryExpiresAt: payment.recoveryExpiresAt,
        lastFailureCode: payment.lastFailureCode,
        lastFailureMessage: payment.lastFailureMessage,
      })),
      bidEligibilityResult: canBid ? "ELIGIBLE" : "BLOCKED_PAYMENT_RECOVERY_REQUIRED",
    };
  }
}
