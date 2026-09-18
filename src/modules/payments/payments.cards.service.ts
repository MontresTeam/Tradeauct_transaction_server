/**
 * Saved cards.
 *
 * The card itself never touches this server: the browser confirms a
 * SetupIntent directly with Stripe, and what is stored here is the Stripe
 * payment-method id plus the brand, last four digits and expiry that a buyer
 * needs to recognise their own card. No PAN, no CVC, nothing that would put
 * this database in PCI scope.
 */
import type Stripe from "stripe";
import { type AuditEntry, recordAudit } from "../../core/audit.js";
import { AppError } from "../../core/errors/AppError.js";
import { logger } from "../../core/logger.js";
import { prisma } from "../../core/prisma.js";
import { getStripeClient } from "../gateway/stripe.client.js";
import { type BuyerRecord, requireBuyer } from "./buyer.repository.js";

export type SavedCard = {
  id: string;
  brand: string;
  last4: string;
  expMonth: number | null;
  expYear: number | null;
  isDefault: boolean;
  stripePaymentMethodId: string;
  createdAt: Date;
};

export type SetupIntentResult = {
  success: true;
  clientSecret: string | null;
  setupIntentId: string;
  customerId: string;
};

type AuditActor = Pick<AuditEntry, "actorType" | "actorId" | "service" | "ip">;

export class CardService {
  /**
   * Ensure the buyer has a Stripe Customer, creating one the first time.
   *
   * The customer id is written back to the Buyer row, so a later SetupIntent
   * attaches to the same customer rather than stranding cards across several.
   */
  private static async ensureStripeCustomer(buyer: BuyerRecord, actorUserId: string): Promise<string> {
    if (buyer.stripeCustomerId) return buyer.stripeCustomerId;

    const user = await prisma.user.findUnique({
      where: { id: buyer.userId },
      select: { email: true, firstName: true, lastName: true },
    });

    const customer = await getStripeClient().customers.create({
      email: user?.email || undefined,
      name: `${user?.firstName || "Buyer"} ${user?.lastName || ""}`.trim(),
      metadata: { buyerId: buyer.id, userId: actorUserId },
    });

    await prisma.buyer.update({
      where: { id: buyer.id },
      data: { stripeCustomerId: customer.id },
    });

    return customer.id;
  }

  /** Start card capture. The client secret is confirmed in the browser. */
  static async createSetupIntent(actorUserId: string, actor: AuditActor): Promise<SetupIntentResult> {
    const buyer = await requireBuyer(actorUserId);
    const customerId = await CardService.ensureStripeCustomer(buyer, actorUserId);

    const setupIntent = await getStripeClient().setupIntents.create({
      customer: customerId,
      payment_method_types: ["card"],
      // Off-session is what a winning bid is charged against, so the mandate
      // has to be captured now, while the buyer is present.
      usage: "off_session",
      metadata: { buyerId: buyer.id, userId: actorUserId },
    });

    await recordAudit({
      ...actor,
      action: "SETUP_INTENT_CREATED",
      entityType: "SETUP_INTENT",
      entityId: setupIntent.id,
      after: { buyerId: buyer.id, customerId },
    });

    return {
      success: true,
      clientSecret: setupIntent.client_secret,
      setupIntentId: setupIntent.id,
      customerId,
    };
  }

  /**
   * Persist a card after the browser has confirmed the SetupIntent.
   *
   * Three things are checked before anything is written: the intent actually
   * succeeded, its customer belongs to the caller, and the payment-method id
   * is not already attached to a different buyer.
   */
  static async saveFromSetupIntent(
    actorUserId: string,
    setupIntentId: string,
    actor: AuditActor,
  ): Promise<{ success: true; paymentMethod: SavedCard }> {
    const buyer = await requireBuyer(actorUserId);
    const stripe = getStripeClient();
    const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);

    if (setupIntent.status !== "succeeded") {
      throw new AppError(
        400,
        `SetupIntent has not succeeded. Current status: ${setupIntent.status}`,
        "SETUP_INTENT_NOT_SUCCEEDED",
      );
    }

    const paymentMethodId = idOf(setupIntent.payment_method);
    const customerId = idOf(setupIntent.customer);

    if (!paymentMethodId || !customerId) {
      throw new AppError(400, "Missing payment method or customer on SetupIntent", "INVALID_SETUP_INTENT");
    }

    // A SetupIntent id is not proof of ownership. It is only ours if it points
    // at our Stripe customer, or if we have no customer yet and can adopt it.
    if (buyer.stripeCustomerId && buyer.stripeCustomerId !== customerId) {
      throw new AppError(403, "This setup intent does not belong to the current buyer.", "SETUP_INTENT_FORBIDDEN");
    }

    const customerOwner = await prisma.buyer.findFirst({
      where: { stripeCustomerId: customerId },
      select: { id: true },
    });

    if (customerOwner && customerOwner.id !== buyer.id) {
      throw new AppError(403, "This setup intent does not belong to the current buyer.", "SETUP_INTENT_FORBIDDEN");
    }

    if (!buyer.stripeCustomerId) {
      await prisma.buyer.update({ where: { id: buyer.id }, data: { stripeCustomerId: customerId } });
    }

    // The payment-method id is globally unique in our table. If a row already
    // exists under another buyer, upserting would quietly hand them a card.
    const existing = await prisma.savedPaymentMethod.findUnique({
      where: { stripePaymentMethodId: paymentMethodId },
      select: { id: true, buyerId: true },
    });

    if (existing && existing.buyerId !== buyer.id) {
      throw new AppError(403, "This payment method belongs to another buyer.", "PAYMENT_METHOD_FORBIDDEN");
    }

    const card = await stripe.paymentMethods.retrieve(paymentMethodId);
    const details = {
      brand: card.card?.brand || "card",
      last4: card.card?.last4 || "0000",
      expMonth: card.card?.exp_month ?? null,
      expYear: card.card?.exp_year ?? null,
    };

    // One default at a time, and the newly saved card becomes it.
    const saved = await prisma.$transaction(async (tx) => {
      await tx.savedPaymentMethod.updateMany({
        where: { buyerId: buyer.id },
        data: { isDefault: false },
      });

      return tx.savedPaymentMethod.upsert({
        where: { stripePaymentMethodId: paymentMethodId },
        update: { ...details, status: "active", isDefault: true },
        create: {
          ...details,
          buyerId: buyer.id,
          stripeCustomerId: customerId,
          stripePaymentMethodId: paymentMethodId,
          status: "active",
          isDefault: true,
        },
      });
    });

    await recordAudit({
      ...actor,
      action: existing ? "PAYMENT_METHOD_REACTIVATED" : "PAYMENT_METHOD_SAVED",
      entityType: "SAVED_PAYMENT_METHOD",
      entityId: saved.id,
      after: { buyerId: buyer.id, brand: saved.brand, last4: saved.last4 },
    });

    return { success: true, paymentMethod: toSavedCard(saved) };
  }

  /** The buyer's active cards, default first. */
  static async list(actorUserId: string): Promise<{
    success: true;
    paymentMethods: SavedCard[];
    hasPaymentMethod: boolean;
    canBid: boolean;
  }> {
    const buyer = await prisma.buyer.findFirst({
      where: { OR: [{ userId: actorUserId }, { id: actorUserId }] },
      select: { id: true },
    });

    if (!buyer) {
      // No profile yet is a normal state for a new account, not an error.
      return { success: true, paymentMethods: [], hasPaymentMethod: false, canBid: false };
    }

    const cards = await prisma.savedPaymentMethod.findMany({
      where: { buyerId: buyer.id, status: "active" },
      orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
    });

    return {
      success: true,
      paymentMethods: cards.map(toSavedCard),
      hasPaymentMethod: cards.length > 0,
      canBid: cards.length > 0,
    };
  }

  /** Make one card the default used for off-session charges. */
  static async setDefault(
    actorUserId: string,
    paymentMethodId: string,
    actor: AuditActor,
  ): Promise<{ success: true; message: string }> {
    const buyer = await requireBuyer(actorUserId);

    await prisma.$transaction(async (tx) => {
      const promoted = await tx.savedPaymentMethod.updateMany({
        where: {
          buyerId: buyer.id,
          status: "active",
          OR: [{ id: paymentMethodId }, { stripePaymentMethodId: paymentMethodId }],
        },
        data: { isDefault: true },
      });

      // Scoped by buyer id and asserted, so a card id belonging to somebody
      // else changes nothing and reports not-found.
      if (promoted.count !== 1) {
        throw new AppError(404, "Payment method not found", "PAYMENT_METHOD_NOT_FOUND");
      }

      await tx.savedPaymentMethod.updateMany({
        where: {
          buyerId: buyer.id,
          isDefault: true,
          NOT: { OR: [{ id: paymentMethodId }, { stripePaymentMethodId: paymentMethodId }] },
        },
        data: { isDefault: false },
      });
    });

    await recordAudit({
      ...actor,
      action: "PAYMENT_METHOD_DEFAULT_CHANGED",
      entityType: "SAVED_PAYMENT_METHOD",
      entityId: paymentMethodId,
      after: { buyerId: buyer.id },
    });

    return { success: true, message: "Default payment method updated successfully." };
  }

  /**
   * Remove a card: detached at Stripe so it can no longer be charged, and
   * marked removed locally rather than deleted, so past payments keep pointing
   * at something.
   */
  static async remove(
    actorUserId: string,
    paymentMethodId: string | undefined,
    actor: AuditActor,
  ): Promise<{ success: true; removedPaymentMethodId: string; hasPaymentMethod: boolean }> {
    const buyer = await requireBuyer(actorUserId);

    const target = paymentMethodId
      ? await prisma.savedPaymentMethod.findFirst({
          where: {
            buyerId: buyer.id,
            status: "active",
            OR: [{ id: paymentMethodId }, { stripePaymentMethodId: paymentMethodId }],
          },
        })
      : // No id given: remove the default card, else the most recent one.
        await prisma.savedPaymentMethod.findFirst({
          where: { buyerId: buyer.id, status: "active" },
          orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
        });

    if (!target) {
      throw new AppError(404, "No saved payment method found to remove.", "PAYMENT_METHOD_NOT_FOUND");
    }

    try {
      await getStripeClient().paymentMethods.detach(target.stripePaymentMethodId);
    } catch (error) {
      // Already detached at Stripe is fine; the local row still must be
      // cleared, or the buyer keeps seeing a card that cannot be charged.
      logger.warn("Stripe detach failed; clearing the local record anyway", {
        paymentMethodId: target.id,
        error,
      });
    }

    const remaining = await prisma.$transaction(async (tx) => {
      await tx.savedPaymentMethod.update({
        where: { id: target.id },
        data: { status: "removed", isDefault: false },
      });

      const next = await tx.savedPaymentMethod.findFirst({
        where: { buyerId: buyer.id, status: "active" },
        orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
      });

      // Keep exactly one default, so an off-session charge is never ambiguous.
      if (next && target.isDefault) {
        await tx.savedPaymentMethod.update({ where: { id: next.id }, data: { isDefault: true } });
      }

      return next;
    });

    await recordAudit({
      ...actor,
      action: "PAYMENT_METHOD_REMOVED",
      entityType: "SAVED_PAYMENT_METHOD",
      entityId: target.id,
      before: { brand: target.brand, last4: target.last4, isDefault: target.isDefault },
      after: { status: "removed" },
    });

    return {
      success: true,
      removedPaymentMethodId: target.id,
      hasPaymentMethod: Boolean(remaining),
    };
  }
}

function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

function toSavedCard(row: {
  id: string;
  brand: string;
  last4: string;
  expMonth: number | null;
  expYear: number | null;
  isDefault: boolean;
  stripePaymentMethodId: string;
  createdAt: Date;
}): SavedCard {
  return {
    id: row.id,
    brand: row.brand,
    last4: row.last4,
    expMonth: row.expMonth,
    expYear: row.expYear,
    isDefault: row.isDefault,
    stripePaymentMethodId: row.stripePaymentMethodId,
    createdAt: row.createdAt,
  };
}

/** Narrow a Stripe error to its decline code, for callers that map messages. */
export function stripeErrorCode(error: unknown): string | null {
  const stripeError = error as Stripe.errors.StripeError;
  return stripeError?.code ?? stripeError?.decline_code ?? null;
}
