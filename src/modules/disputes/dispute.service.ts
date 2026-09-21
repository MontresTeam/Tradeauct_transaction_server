/**
 * Disputes, returns and what they do to a settlement.
 *
 * Two different things arrive here and they are not the same:
 *
 *   - a **card dispute** (chargeback) from Stripe. The bank has taken the
 *     money, or is about to. TradeAuct is liable for it under Custom connected
 *     accounts, so this is real money leaving.
 *   - a **buyer case or return** raised inside TradeAuct, which the main
 *     server owns. It reaches this server as a command and freezes the
 *     settlement while it is open.
 *
 * Before the seller has been paid, both simply stop the money: the settlement
 * is frozen or disputed and the release worker will not touch it. After the
 * seller has been paid there is nothing left to stop, so a lost dispute opens
 * a recovery instead and the PAID_OUT record stands (spec §24, §25).
 */
import { logger } from "../../core/logger.js";
import { toMinorUnits } from "../../core/money.js";
import { prisma } from "../../core/prisma.js";
import { recoverFromSeller } from "../refunds/refund.service.js";
import {
  findSettlement,
  freezeSettlement,
  transitionSettlement,
  unfreezeSettlement,
} from "../settlements/settlement.service.js";
import type { SettlementActor } from "../settlements/settlement.types.js";

const SYSTEM: SettlementActor = { type: "SYSTEM" };

/** A chargeback has been raised against a payment. */
export async function onCardDisputeOpened(input: {
  paymentId: string | null;
  stripeDisputeId: string;
  amountMinor: bigint;
  currency: string;
  reason: string;
}): Promise<{ handled: boolean; outcome: string }> {
  if (!input.paymentId) return { handled: false, outcome: "NO_PAYMENT" };

  const settlement = await findSettlement({ paymentId: input.paymentId });
  if (!settlement) return { handled: false, outcome: "NO_SETTLEMENT" };

  if (["TRANSFERRED", "PAID_OUT"].includes(settlement.settlementStatus)) {
    // The seller already has the money. Whether to claw it back now or wait
    // for the outcome is plan Q5; the default is to wait, because a dispute
    // TradeAuct wins costs the seller nothing and reversing it early would.
    logger.warn("Dispute opened on a settlement that is already paid out", {
      settlementId: settlement.id,
      stripeDisputeId: input.stripeDisputeId,
    });

    await prisma.sellerSettlement.update({
      where: { id: settlement.id },
      data: { holdReason: `Card dispute ${input.stripeDisputeId} opened after payout` },
    });

    return { handled: true, outcome: "AWAITING_DISPUTE_OUTCOME" };
  }

  const result = await transitionSettlement({
    settlementId: settlement.id,
    from: ["PENDING", "ON_HOLD", "ELIGIBLE", "TRANSFER_FAILED", "FROZEN"],
    to: "DISPUTED",
    reason: `Card dispute ${input.stripeDisputeId}: ${input.reason}`,
    actor: SYSTEM,
    data: {
      frozenFromStatus: settlement.settlementStatus,
      holdReason: `Card dispute ${input.stripeDisputeId}`,
      holdPlacedAt: new Date(),
    },
  });

  return { handled: result.changed, outcome: result.changed ? "DISPUTED" : (result.refusedReason ?? "UNCHANGED") };
}

/** Stripe has closed the dispute. `won` releases; `lost` costs the money. */
export async function onCardDisputeClosed(input: {
  paymentId: string | null;
  stripeDisputeId: string;
  outcome: string;
  amountMinor: bigint;
  currency: string;
}): Promise<{ handled: boolean; outcome: string }> {
  if (!input.paymentId) return { handled: false, outcome: "NO_PAYMENT" };

  const settlement = await findSettlement({ paymentId: input.paymentId });
  if (!settlement) return { handled: false, outcome: "NO_SETTLEMENT" };

  if (input.outcome === "won" || input.outcome === "warning_closed") {
    if (settlement.settlementStatus !== "DISPUTED") {
      return { handled: false, outcome: `Settlement is ${settlement.settlementStatus}` };
    }

    // Back to where it was, and re-evaluated on the next worker pass. It does
    // not jump straight to ELIGIBLE: the checks run again from scratch.
    const restoreTo = settlement.deliveredAt ? "ON_HOLD" : "PENDING";
    const result = await transitionSettlement({
      settlementId: settlement.id,
      from: ["DISPUTED"],
      to: restoreTo,
      reason: `Card dispute ${input.stripeDisputeId} won`,
      actor: SYSTEM,
      data: { holdReason: null, holdPlacedAt: null, frozenFromStatus: null },
    });

    return { handled: result.changed, outcome: result.changed ? `RESTORED_${restoreTo}` : "UNCHANGED" };
  }

  if (input.outcome !== "lost") {
    return { handled: false, outcome: `Dispute closed as ${input.outcome}; nothing to do` };
  }

  if (["TRANSFERRED", "PAID_OUT"].includes(settlement.settlementStatus)) {
    const recovery = await recoverFromSeller({
      settlementId: settlement.id,
      amountMinor: input.amountMinor,
      currency: input.currency,
      cause: "DISPUTE_LOST_AFTER_PAYOUT",
      reason: `Card dispute ${input.stripeDisputeId} lost`,
      actor: SYSTEM,
      sourceType: "STRIPE_DISPUTE",
      sourceId: input.stripeDisputeId,
    });

    return { handled: true, outcome: recovery };
  }

  const result = await transitionSettlement({
    settlementId: settlement.id,
    from: ["DISPUTED", "FROZEN", "PENDING", "ON_HOLD", "ELIGIBLE"],
    to: "REFUNDED",
    reason: `Card dispute ${input.stripeDisputeId} lost; funds returned to the buyer`,
    actor: SYSTEM,
    // The seller's payable is written off against the refund expense: the
    // bank took the money back and the seller is not getting it.
    data: { netProceeds: 0, payoutStatus: "UNPAID" },
    ledger: () => {
      const netMinor = toMinorUnits(settlement.netProceeds, settlement.currency);
      if (netMinor <= 0n) return null;
      return {
        kind: "DISPUTE",
        referenceType: "SETTLEMENT",
        referenceId: settlement.id,
        currency: settlement.currency,
        description: `Card dispute ${input.stripeDisputeId} lost`,
        lines: [
          {
            account: "SELLER_PAYABLE",
            direction: "DEBIT",
            amountMinor: netMinor,
            sellerId: settlement.sellerId,
            paymentId: settlement.paymentId,
          },
          {
            account: "DISPUTES_RESERVE",
            direction: "CREDIT",
            amountMinor: netMinor,
            sellerId: settlement.sellerId,
            paymentId: settlement.paymentId,
          },
        ],
      };
    },
  });

  return { handled: result.changed, outcome: "SETTLEMENT_REFUNDED" };
}

/** Stripe has actually taken the money out of the platform balance. */
export async function onDisputeFundsWithdrawn(input: {
  stripeDisputeId: string;
  amountMinor: bigint;
  currency: string;
}): Promise<void> {
  const dispute = await prisma.stripeDispute.findUnique({ where: { stripeDisputeId: input.stripeDisputeId } });
  if (!dispute) return;

  await prisma.stripeDispute.update({
    where: { id: dispute.id },
    data: { fundsWithdrawnAt: new Date() },
  });

  logger.warn("Dispute funds withdrawn", {
    stripeDisputeId: input.stripeDisputeId,
    amountMinor: input.amountMinor.toString(),
  });
}

/** Stripe has given the money back after a dispute was won. */
export async function onDisputeFundsReinstated(input: { stripeDisputeId: string }): Promise<void> {
  const dispute = await prisma.stripeDispute.findUnique({ where: { stripeDisputeId: input.stripeDisputeId } });
  if (!dispute) return;

  await prisma.stripeDispute.update({
    where: { id: dispute.id },
    data: { fundsReinstatedAt: new Date() },
  });

  logger.info("Dispute funds reinstated", { stripeDisputeId: input.stripeDisputeId });
}

/**
 * A buyer case or a return opened in the main server.
 *
 * These are facts the main server sends; the decision about the money is made
 * here. Both freeze, with different reasons, so an admin can tell them apart.
 */
export async function onBuyerIssueOpened(input: {
  fulfillmentOrderId: string;
  kind: "RETURN" | "DISPUTE_CASE";
  caseNumber?: string | null;
  note?: string | null;
}): Promise<{ handled: boolean; outcome: string }> {
  const settlement = await findSettlement({ fulfillmentOrderId: input.fulfillmentOrderId });
  if (!settlement) return { handled: false, outcome: "NO_SETTLEMENT" };

  if (["TRANSFERRED", "PAID_OUT"].includes(settlement.settlementStatus)) {
    logger.warn("Buyer issue raised after the seller was paid", {
      settlementId: settlement.id,
      kind: input.kind,
    });
    return { handled: false, outcome: "ALREADY_PAID_OUT" };
  }

  const result = await freezeSettlement({
    settlementId: settlement.id,
    reason: input.kind === "RETURN" ? "RETURN" : "BUYER_DISPUTE_CASE",
    note: input.note ?? `${input.kind} opened${input.caseNumber ? ` (${input.caseNumber})` : ""}`,
    actor: SYSTEM,
  });

  return { handled: result.changed, outcome: result.changed ? "FROZEN" : (result.refusedReason ?? "UNCHANGED") };
}

/**
 * The case or return is closed.
 *
 * A resolution that returns money to the buyer arrives separately, as a
 * refund. All this does is lift the freeze so the normal checks resume.
 */
export async function onBuyerIssueResolved(input: {
  fulfillmentOrderId: string;
  kind: "RETURN" | "DISPUTE_CASE";
  outcome?: string | null;
}): Promise<{ handled: boolean; outcome: string }> {
  const settlement = await findSettlement({ fulfillmentOrderId: input.fulfillmentOrderId });
  if (!settlement) return { handled: false, outcome: "NO_SETTLEMENT" };

  if (settlement.settlementStatus !== "FROZEN") {
    return { handled: false, outcome: `Settlement is ${settlement.settlementStatus}` };
  }

  const result = await unfreezeSettlement({
    settlementId: settlement.id,
    note: `${input.kind} resolved${input.outcome ? `: ${input.outcome}` : ""}`,
    actor: SYSTEM,
  });

  return { handled: result.changed, outcome: result.changed ? "UNFROZEN" : (result.refusedReason ?? "UNCHANGED") };
}
