/**
 * Moving an eligible settlement to the seller.
 *
 * The order of operations is the whole point, so it is worth stating plainly:
 *
 *   1. re-check eligibility, immediately before doing anything;
 *   2. claim the settlement atomically (ELIGIBLE → TRANSFER_PENDING);
 *   3. write the PayoutTransfer row, with an idempotency key derived from the
 *      settlement id and nothing else;
 *   4. call the provider with that key;
 *   5. on success, move to TRANSFERRED and post the ledger entry in one
 *      database transaction.
 *
 * Steps 2 and 3 are what make two workers racing produce exactly one transfer.
 * Step 4's key is what makes a Stripe timeout safe to retry: the same key
 * returns the same transfer rather than creating a second one.
 */
import { recordAudit } from "../../core/audit.js";
import { loadEnv } from "../../core/env.js";
import { AppError } from "../../core/errors/AppError.js";
import { logger } from "../../core/logger.js";
import { fromMinorUnits, toMinorUnits } from "../../core/money.js";
import { TXN_EVENTS } from "../../core/outbox.js";
import { prisma } from "../../core/prisma.js";
import { isPayoutReady } from "../connect/connect.service.js";
import { postTransaction } from "../ledger/ledger.service.js";
import { getSettlementConfig } from "../settings/settlementConfig.service.js";
import { transitionSettlement } from "../settlements/settlement.service.js";
import type { SettlementActor } from "../settlements/settlement.types.js";
import { ManualPayoutProvider } from "./manual.payoutProvider.js";
import { PermanentPayoutError, type SellerPayoutProvider } from "./payout.provider.js";
import { StripeSellerPayoutProvider } from "./stripe.payoutProvider.js";

export const stripePayoutProvider = new StripeSellerPayoutProvider();

/** Derived from the settlement, never from the attempt. Retries reuse it. */
export function transferIdempotencyKey(settlementId: string): string {
  return `tradeauct_transfer_settlement_${settlementId}`;
}

export type TransferOutcome = {
  status: "TRANSFERRED" | "SKIPPED" | "FAILED" | "ALREADY_DONE";
  settlementId: string;
  reason?: string;
  transferId?: string;
  amountMinor?: string;
};

/**
 * Whether the automatic path may run at all.
 *
 * Two independent gates, both of which must be on: the env flag is
 * engineering's kill switch, the admin toggle is finance's pause button
 * (plan §8). Neither can be inferred from the other.
 */
export async function automaticTransfersAllowed(): Promise<{ allowed: boolean; reason?: string }> {
  const env = loadEnv();
  if (!env.SELLER_AUTO_TRANSFER_ENABLED) {
    return { allowed: false, reason: "SELLER_AUTO_TRANSFER_ENABLED is off" };
  }

  const config = await getSettlementConfig();
  if (!config.automaticPayoutEnabled) {
    return { allowed: false, reason: "Automatic payout is switched off in Super Admin" };
  }

  return { allowed: true };
}

/**
 * How much of a seller's debt to hold back from this transfer.
 *
 * A refund or chargeback after a payout leaves the seller owing the platform.
 * Rather than chase it, the balance is taken out of their next settlements
 * (spec §23).
 */
async function resolveRecoveryOffset(
  sellerId: string,
  availableMinor: bigint,
): Promise<{ offsetMinor: bigint; recoveryIds: string[] }> {
  const open = await prisma.settlementRecovery.findMany({
    where: { sellerId, status: { in: ["OPEN", "PARTIALLY_RECOVERED"] } },
    orderBy: { createdAt: "asc" },
  });

  let remaining = availableMinor;
  let offsetMinor = 0n;
  const recoveryIds: string[] = [];

  for (const recovery of open) {
    if (remaining <= 0n) break;
    const outstanding = recovery.amountMinor - recovery.recoveredMinor;
    if (outstanding <= 0n) continue;

    const take = outstanding < remaining ? outstanding : remaining;
    offsetMinor += take;
    remaining -= take;
    recoveryIds.push(recovery.id);
  }

  return { offsetMinor, recoveryIds };
}

/** Apply the offset to the seller's open recoveries, oldest first. */
async function applyRecoveryOffset(
  tx: Parameters<typeof postTransaction>[1],
  sellerId: string,
  offsetMinor: bigint,
): Promise<void> {
  let remaining = offsetMinor;

  const open = await tx.settlementRecovery.findMany({
    where: { sellerId, status: { in: ["OPEN", "PARTIALLY_RECOVERED"] } },
    orderBy: { createdAt: "asc" },
  });

  for (const recovery of open) {
    if (remaining <= 0n) break;
    const outstanding = recovery.amountMinor - recovery.recoveredMinor;
    if (outstanding <= 0n) continue;

    const take = outstanding < remaining ? outstanding : remaining;
    remaining -= take;
    const recovered = recovery.recoveredMinor + take;

    await tx.settlementRecovery.update({
      where: { id: recovery.id },
      data: {
        recoveredMinor: recovered,
        status: recovered >= recovery.amountMinor ? "RECOVERED" : "PARTIALLY_RECOVERED",
        resolvedAt: recovered >= recovery.amountMinor ? new Date() : null,
      },
    });

    if (recovered >= recovery.amountMinor) {
      const stillOpen = await tx.settlementRecovery.count({
        where: { settlementId: recovery.settlementId, status: { in: ["OPEN", "PARTIALLY_RECOVERED"] } },
      });
      if (stillOpen === 0) {
        await tx.sellerSettlement.update({
          where: { id: recovery.settlementId },
          data: { hasOpenRecovery: false },
        });
      }
    }
  }
}

/**
 * Transfer one eligible settlement.
 *
 * Returns rather than throws for the ordinary "not yet" outcomes — a seller
 * who has not finished onboarding is not an error, it is a settlement to try
 * again later. It throws only for failures a retry might fix, so BullMQ backs
 * off and comes back.
 */
export async function transferSettlement(
  settlementId: string,
  options: { provider?: SellerPayoutProvider; actor?: SettlementActor; force?: boolean } = {},
): Promise<TransferOutcome> {
  const provider = options.provider ?? stripePayoutProvider;
  const actor = options.actor ?? { type: "SYSTEM" as const };

  const settlement = await prisma.sellerSettlement.findUnique({ where: { id: settlementId } });
  if (!settlement) {
    throw new AppError(404, `Settlement ${settlementId} not found`, "SETTLEMENT_NOT_FOUND");
  }

  if (["TRANSFERRED", "PAID_OUT"].includes(settlement.settlementStatus)) {
    return { status: "ALREADY_DONE", settlementId, reason: `Already ${settlement.settlementStatus}` };
  }

  if (settlement.settlementStatus !== "ELIGIBLE") {
    return { status: "SKIPPED", settlementId, reason: `Settlement is ${settlement.settlementStatus}, not ELIGIBLE` };
  }

  if (provider.name === "STRIPE_CONNECT" && !options.force) {
    const gate = await automaticTransfersAllowed();
    if (!gate.allowed) return { status: "SKIPPED", settlementId, reason: gate.reason };
  }

  const config = await getSettlementConfig();
  if (settlement.netProceeds < config.minimumPayoutAmount) {
    return {
      status: "SKIPPED",
      settlementId,
      reason: `Net ${settlement.netProceeds} is below the ${config.minimumPayoutAmount} minimum payout`,
    };
  }

  let connectedAccountId: string | null = null;
  if (provider.name === "STRIPE_CONNECT") {
    const readiness = await isPayoutReady(settlement.sellerId);
    if (!readiness.ready) {
      // Deliberately leaves the settlement ELIGIBLE. It is retried once the
      // account is ready; the money is never lost (spec §31).
      return { status: "SKIPPED", settlementId, reason: readiness.reason };
    }
    connectedAccountId = readiness.accountId ?? null;
  }

  const netMinor = toMinorUnits(settlement.netProceeds, settlement.currency);
  const { offsetMinor } = await resolveRecoveryOffset(settlement.sellerId, netMinor);
  const payableMinor = netMinor - offsetMinor;

  if (payableMinor <= 0n) {
    // The whole settlement went to clearing an earlier debt. Nothing is sent,
    // but the settlement is closed out and the recovery credited.
    return settleAgainstRecoveryOnly(settlement.id, settlement.sellerId, netMinor, settlement.currency, actor);
  }

  // The claim. Exactly one caller can win this.
  const claim = await transitionSettlement({
    settlementId,
    from: ["ELIGIBLE"],
    to: "TRANSFER_PENDING",
    reason: `Transfer claimed by ${provider.name}`,
    actor,
    data: {
      transferAttempts: { increment: 1 },
      stripeConnectedAccountId: connectedAccountId,
      payoutMethod: provider.name,
    },
  });

  if (!claim.changed) {
    return { status: "SKIPPED", settlementId, reason: claim.refusedReason ?? "Another worker claimed it" };
  }

  const idempotencyKey = transferIdempotencyKey(settlementId);
  const payment = settlement.paymentId
    ? await prisma.payment.findUnique({
        where: { id: settlement.paymentId },
        select: { stripeChargeId: true, transferGroup: true },
      })
    : null;

  await prisma.payoutTransfer.upsert({
    where: { idempotencyKey },
    update: { amountMinor: payableMinor, status: "PENDING" },
    create: {
      settlementId,
      sellerId: settlement.sellerId,
      provider: provider.name,
      stripeAccountId: connectedAccountId,
      amountMinor: payableMinor,
      currency: settlement.currency,
      status: "PENDING",
      idempotencyKey,
      transferGroup: payment?.transferGroup ?? null,
      sourceTransaction: payment?.stripeChargeId ?? null,
    },
  });

  try {
    const result = await provider.createTransfer({
      settlementId,
      sellerId: settlement.sellerId,
      connectedAccountId: connectedAccountId ?? "",
      amountMinor: payableMinor,
      currency: settlement.currency,
      transferGroup: payment?.transferGroup ?? null,
      sourceTransaction: payment?.stripeChargeId ?? null,
      idempotencyKey,
    });

    await prisma.$transaction(async (tx) => {
      await tx.payoutTransfer.update({
        where: { idempotencyKey },
        data: {
          status: "TRANSFERRED",
          stripeTransferId: result.providerTransferId,
          destinationPaymentId: result.destinationPaymentId ?? null,
          stripePayoutStatus: null,
          transferredAt: new Date(),
        },
      });

      if (offsetMinor > 0n) {
        await applyRecoveryOffset(tx, settlement.sellerId, offsetMinor);
        await postTransaction(
          {
            kind: "ADJUSTMENT",
            referenceType: "SETTLEMENT",
            referenceId: settlementId,
            currency: settlement.currency,
            description: "Recovery offset withheld from this settlement",
            lines: [
              {
                account: "SELLER_PAYABLE",
                direction: "DEBIT",
                amountMinor: offsetMinor,
                sellerId: settlement.sellerId,
              },
              {
                account: "SELLER_RECOVERABLE",
                direction: "CREDIT",
                amountMinor: offsetMinor,
                sellerId: settlement.sellerId,
              },
            ],
          },
          tx,
        );
      }

      await transitionSettlement(
        {
          settlementId,
          from: ["TRANSFER_PENDING"],
          to: "TRANSFERRED",
          reason: `Transfer ${result.providerTransferId} created`,
          actor,
          data: {
            stripeTransferId: result.providerTransferId,
            stripeTransferStatus: "created",
            transferredAt: new Date(),
            transferFailureCode: null,
            transferFailureMessage: null,
          },
          // The seller's obligation is discharged: cash leaves the platform's
          // Stripe balance and the payable comes off the books.
          ledger: () => ({
            kind: "PAYOUT",
            referenceType: "SETTLEMENT",
            referenceId: settlementId,
            currency: settlement.currency,
            description: `Seller transfer ${result.providerTransferId}`,
            lines: [
              {
                account: "SELLER_PAYABLE",
                direction: "DEBIT",
                amountMinor: payableMinor,
                sellerId: settlement.sellerId,
                paymentId: settlement.paymentId,
              },
              {
                account: "STRIPE_CASH",
                direction: "CREDIT",
                amountMinor: payableMinor,
                sellerId: settlement.sellerId,
                paymentId: settlement.paymentId,
              },
            ],
          }),
          event: {
            type: TXN_EVENTS.SETTLEMENT_TRANSFERRED,
            payload: {
              transferId: result.providerTransferId,
              amountMinor: payableMinor.toString(),
              currency: settlement.currency,
              recoveryOffsetMinor: offsetMinor.toString(),
            },
          },
        },
        tx,
      );
    });

    await recordAudit({
      action: "SETTLEMENT_TRANSFER_CREATED",
      entityType: "SETTLEMENT",
      entityId: settlementId,
      actorType: actor.type,
      actorId: actor.id ?? null,
      amountMinor: payableMinor,
      currency: settlement.currency,
      after: { transferId: result.providerTransferId, provider: provider.name },
    });

    logger.info("Settlement transferred", {
      settlementId,
      transferId: result.providerTransferId,
      amountMinor: payableMinor.toString(),
      provider: provider.name,
    });

    return {
      status: "TRANSFERRED",
      settlementId,
      transferId: result.providerTransferId,
      amountMinor: payableMinor.toString(),
    };
  } catch (error) {
    if (error instanceof PermanentPayoutError) {
      await prisma.payoutTransfer.update({
        where: { idempotencyKey },
        data: { status: "FAILED", failureCode: error.code, failureMessage: error.message },
      });

      await transitionSettlement({
        settlementId,
        from: ["TRANSFER_PENDING"],
        to: "TRANSFER_FAILED",
        reason: `Stripe refused the transfer: ${error.message}`,
        actor,
        data: { transferFailureCode: error.code, transferFailureMessage: error.message },
        event: { type: TXN_EVENTS.PAYOUT_FAILED, payload: { code: error.code, message: error.message } },
      });

      logger.error("Settlement transfer permanently failed", { settlementId, code: error.code });
      return { status: "FAILED", settlementId, reason: error.message };
    }

    // Transient. The settlement stays TRANSFER_PENDING and the job is retried
    // with the same idempotency key, so a transfer Stripe did create but never
    // acknowledged is returned rather than duplicated.
    logger.warn("Settlement transfer failed transiently; will retry", { settlementId, error });
    throw error;
  }
}

/** A settlement entirely consumed by an earlier debt. Nothing is sent. */
async function settleAgainstRecoveryOnly(
  settlementId: string,
  sellerId: string,
  netMinor: bigint,
  currency: string,
  actor: SettlementActor,
): Promise<TransferOutcome> {
  await prisma.$transaction(async (tx) => {
    await applyRecoveryOffset(tx, sellerId, netMinor);

    await transitionSettlement(
      {
        settlementId,
        from: ["ELIGIBLE"],
        to: "PAID_OUT",
        reason: "Net proceeds fully withheld against an open recovery",
        actor,
        data: { paidOutAt: new Date(), payoutMethod: "RECOVERY_OFFSET", payoutStatus: "PAID" },
        ledger: () =>
          netMinor > 0n
            ? {
                kind: "ADJUSTMENT" as const,
                referenceType: "SETTLEMENT",
                referenceId: settlementId,
                currency,
                description: "Settlement withheld in full against an open recovery",
                lines: [
                  { account: "SELLER_PAYABLE" as const, direction: "DEBIT" as const, amountMinor: netMinor, sellerId },
                  {
                    account: "SELLER_RECOVERABLE" as const,
                    direction: "CREDIT" as const,
                    amountMinor: netMinor,
                    sellerId,
                  },
                ],
              }
            : null,
      },
      tx,
    );
  });

  return {
    status: "TRANSFERRED",
    settlementId,
    reason: "Withheld in full against an open recovery",
    amountMinor: "0",
  };
}

/** Eligible settlements the transfer worker should attempt, oldest first. */
export async function findTransferCandidates(limit = 50): Promise<string[]> {
  const rows = await prisma.sellerSettlement.findMany({
    where: { settlementStatus: "ELIGIBLE", netProceeds: { gt: 0 } },
    orderBy: { eligibleAt: "asc" },
    take: limit,
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/**
 * The admin override: record that a seller was paid outside Stripe.
 *
 * Moves ELIGIBLE (or TRANSFER_FAILED) straight to PAID_OUT. The ledger entry
 * is the same as an automatic payout's — the money left the platform either
 * way — but `payoutMethod` records which route it took.
 */
export async function recordManualPayout(input: {
  settlementId: string;
  reference: string;
  note?: string;
  actor: SettlementActor;
}): Promise<TransferOutcome> {
  const settlement = await prisma.sellerSettlement.findUnique({ where: { id: input.settlementId } });
  if (!settlement) {
    throw new AppError(404, `Settlement ${input.settlementId} not found`, "SETTLEMENT_NOT_FOUND");
  }

  if (!["ELIGIBLE", "TRANSFER_FAILED"].includes(settlement.settlementStatus)) {
    throw new AppError(
      409,
      `Settlement is ${settlement.settlementStatus}; a manual payout needs ELIGIBLE or TRANSFER_FAILED`,
      "SETTLEMENT_NOT_PAYABLE",
    );
  }

  const provider = new ManualPayoutProvider(input.reference);
  const netMinor = toMinorUnits(settlement.netProceeds, settlement.currency);
  const idempotencyKey = `tradeauct_manual_payout_${input.settlementId}`;

  await prisma.payoutTransfer.upsert({
    where: { idempotencyKey },
    update: { manualReference: input.reference, processedById: input.actor.id ?? null },
    create: {
      settlementId: input.settlementId,
      sellerId: settlement.sellerId,
      provider: provider.name,
      amountMinor: netMinor,
      currency: settlement.currency,
      status: "PAID_OUT",
      idempotencyKey,
      manualReference: input.reference,
      processedById: input.actor.id ?? null,
      transferredAt: new Date(),
      paidOutAt: new Date(),
    },
  });

  const result = await transitionSettlement({
    settlementId: input.settlementId,
    from: ["ELIGIBLE", "TRANSFER_FAILED"],
    to: "PAID_OUT",
    reason: input.note ?? `Manual payout, bank reference ${input.reference}`,
    actor: input.actor,
    data: {
      payoutMethod: "MANUAL",
      payoutStatus: "PAID",
      paidOutAt: new Date(),
      settledAt: new Date(),
      stripePayoutStatus: "manual",
    },
    ledger: () =>
      netMinor > 0n
        ? {
            kind: "PAYOUT" as const,
            referenceType: "SETTLEMENT",
            referenceId: input.settlementId,
            currency: settlement.currency,
            description: `Manual payout, reference ${input.reference}`,
            lines: [
              {
                account: "SELLER_PAYABLE" as const,
                direction: "DEBIT" as const,
                amountMinor: netMinor,
                sellerId: settlement.sellerId,
                paymentId: settlement.paymentId,
              },
              {
                account: "STRIPE_CASH" as const,
                direction: "CREDIT" as const,
                amountMinor: netMinor,
                sellerId: settlement.sellerId,
                paymentId: settlement.paymentId,
              },
            ],
          }
        : null,
    event: {
      type: TXN_EVENTS.PAYOUT_PAID,
      payload: { method: "MANUAL", reference: input.reference, amountMinor: netMinor.toString() },
    },
  });

  await recordAudit({
    action: "SETTLEMENT_MANUAL_PAYOUT",
    entityType: "SETTLEMENT",
    entityId: input.settlementId,
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    amountMinor: netMinor,
    currency: settlement.currency,
    reason: input.note ?? null,
    after: { reference: input.reference },
  });

  return {
    status: result.changed ? "TRANSFERRED" : "SKIPPED",
    settlementId: input.settlementId,
    reason: result.refusedReason,
    amountMinor: netMinor.toString(),
  };
}

/**
 * Attribute a completed Stripe payout back to the settlements it paid.
 *
 * One automatic payout bundles every transfer that landed in the window, so
 * the payout's own id says nothing about which settlements it covers. The
 * balance transactions on the connected account do: each names the destination
 * payment created by one transfer.
 */
export async function attributePayout(input: {
  payoutId: string;
  connectedAccountId: string;
  status: string;
  arrivalDate?: Date | null;
}): Promise<{ matched: number }> {
  const account = await prisma.connectAccount.findUnique({
    where: { stripeAccountId: input.connectedAccountId },
  });

  if (!account) {
    logger.warn("Payout for an account TradeAuct does not know", { stripeAccountId: input.connectedAccountId });
    return { matched: 0 };
  }

  const sourceIds = await stripePayoutProvider.listPayoutSourcePaymentIds(input.payoutId, input.connectedAccountId);

  /**
   * One automatic payout bundles several transfers, so the payout id alone
   * says nothing about which settlements it covers. Each of its balance
   * transactions names the destination payment that one transfer created on
   * the connected account, which is the link back.
   *
   * When Stripe returns none - an older transfer with no destination payment
   * recorded, or a listing that came back empty - fall back to this seller's
   * outstanding transfers rather than leaving them stuck at TRANSFERRED
   * forever. The reconciliation job catches anything this mis-attributes.
   */
  const transfers = await prisma.payoutTransfer.findMany({
    where:
      sourceIds.length > 0
        ? { sellerId: account.sellerId, destinationPaymentId: { in: sourceIds } }
        : {
            sellerId: account.sellerId,
            status: { in: ["TRANSFERRED", "PAYOUT_PENDING"] },
            stripePayoutId: null,
          },
  });

  const paid = input.status === "paid";
  let matched = 0;

  for (const transfer of transfers) {
    if (!transfer.settlementId) continue;

    await prisma.payoutTransfer.update({
      where: { id: transfer.id },
      data: {
        stripePayoutId: input.payoutId,
        stripePayoutStatus: input.status,
        status: paid ? "PAID_OUT" : "PAYOUT_PENDING",
        paidOutAt: paid ? (input.arrivalDate ?? new Date()) : null,
      },
    });

    if (paid) {
      const result = await transitionSettlement({
        settlementId: transfer.settlementId,
        from: ["TRANSFERRED"],
        to: "PAID_OUT",
        reason: `Stripe payout ${input.payoutId} paid`,
        data: {
          stripePayoutId: input.payoutId,
          stripePayoutStatus: input.status,
          paidOutAt: input.arrivalDate ?? new Date(),
          payoutStatus: "PAID",
          settledAt: new Date(),
        },
        event: {
          type: TXN_EVENTS.PAYOUT_PAID,
          payload: {
            payoutId: input.payoutId,
            method: "STRIPE_CONNECT",
            amountMinor: transfer.amountMinor.toString(),
            currency: transfer.currency,
          },
        },
      });
      if (result.changed) matched += 1;
    } else {
      await prisma.sellerSettlement.updateMany({
        where: { id: transfer.settlementId },
        data: { stripePayoutId: input.payoutId, stripePayoutStatus: input.status },
      });
      matched += 1;
    }
  }

  logger.info("Stripe payout attributed", {
    payoutId: input.payoutId,
    sellerId: account.sellerId,
    status: input.status,
    matched,
    sourcePayments: sourceIds.length,
  });

  return { matched };
}

/** A bank payout that bounced. The money is back in the connected account. */
export async function recordPayoutFailure(input: {
  payoutId: string;
  connectedAccountId: string;
  failureCode?: string | null;
  failureMessage?: string | null;
}): Promise<void> {
  const transfers = await prisma.payoutTransfer.findMany({ where: { stripePayoutId: input.payoutId } });

  for (const transfer of transfers) {
    await prisma.payoutTransfer.update({
      where: { id: transfer.id },
      data: {
        status: "TRANSFERRED",
        stripePayoutStatus: "failed",
        failureCode: input.failureCode ?? null,
        failureMessage: input.failureMessage ?? null,
        paidOutAt: null,
      },
    });

    if (transfer.settlementId) {
      // The settlement stays TRANSFERRED: the money is in the seller's Stripe
      // balance, it simply has not reached their bank. That is a bank-details
      // problem for the seller to fix, not a reason to unwind anything.
      await prisma.sellerSettlement.updateMany({
        where: { id: transfer.settlementId },
        data: { stripePayoutStatus: "failed", transferFailureMessage: input.failureMessage ?? null },
      });
    }
  }

  logger.error("Stripe payout failed", {
    payoutId: input.payoutId,
    account: input.connectedAccountId,
    code: input.failureCode,
  });
}

/** Human-readable amount for logs and admin responses. */
export function formatMinor(amountMinor: bigint, currency: string): string {
  return `${currency} ${fromMinorUnits(amountMinor, currency).toFixed(2)}`;
}
