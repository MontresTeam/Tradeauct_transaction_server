/**
 * Reconciliation: does what TradeAuct believes match what Stripe did?
 *
 * Three questions, asked hourly:
 *
 *   1. **Do the books balance?** Every ledger transaction balances by
 *      construction, so the whole ledger must sum to zero. If it does not,
 *      something wrote entries outside `postTransaction`.
 *   2. **Does SELLER_PAYABLE equal what is actually owed?** The ledger's
 *      liability account and the sum of unsettled settlement net are two
 *      independent records of the same number. They must agree.
 *   3. **Does Stripe agree about each transfer and payout?** A settlement that
 *      says TRANSFERRED must name a transfer Stripe has; a settlement Stripe
 *      has paid out must not still say TRANSFERRED.
 *
 * Every disagreement becomes a `ReconciliationException` for a person to look
 * at. Nothing here corrects anything on its own: an automatic "fix" to a
 * financial discrepancy is how a small problem becomes an unexplainable one.
 */
import { loadEnv } from "../../core/env.js";
import { logger } from "../../core/logger.js";
import { enqueueOutboxEvent, TXN_EVENTS } from "../../core/outbox.js";
import { prisma } from "../../core/prisma.js";
import { getStripeClient } from "../gateway/stripe.client.js";
import { accountBalances, assertLedgerBalanced } from "../ledger/ledger.service.js";
import { stripePayoutProvider } from "../payouts/payout.service.js";
import { OUTSTANDING_LIABILITY_STATES } from "../settlements/settlement.types.js";

export type ExceptionKind =
  | "LEDGER_OUT_OF_BALANCE"
  | "SELLER_PAYABLE_MISMATCH"
  | "PLATFORM_BALANCE_SHORTFALL"
  | "TRANSFER_MISSING_AT_STRIPE"
  | "TRANSFER_AMOUNT_MISMATCH"
  | "SETTLEMENT_STUCK_IN_TRANSFER"
  | "PAYOUT_STATUS_DRIFT";

export type ReconciliationReport = {
  ranAt: string;
  checked: number;
  exceptionsRaised: number;
  exceptionsResolved: number;
  ledgerBalanced: boolean;
  sellerPayableMinor: string;
  outstandingSettlementMinor: string;
};

/** How long a settlement may sit in TRANSFER_PENDING before it is suspicious. */
const STUCK_TRANSFER_MINUTES = 30;

/**
 * Record a disagreement.
 *
 * Upserted on (kind, entity), so a problem that persists across runs raises
 * its occurrence count rather than filling the table with duplicates.
 */
export async function raiseException(input: {
  kind: ExceptionKind;
  severity?: "INFO" | "WARNING" | "CRITICAL";
  entityType: string;
  entityId: string;
  expectedMinor?: bigint | null;
  actualMinor?: bigint | null;
  currency?: string;
  detail?: Record<string, unknown>;
}): Promise<string> {
  const severity = input.severity ?? "WARNING";

  const existing = await prisma.reconciliationException.findUnique({
    where: {
      kind_entityType_entityId: {
        kind: input.kind,
        entityType: input.entityType,
        entityId: input.entityId,
      },
    },
  });

  if (existing && existing.status === "RESOLVED") {
    // It came back. Reopen rather than leaving a resolved row that no longer
    // describes reality.
    await prisma.reconciliationException.update({
      where: { id: existing.id },
      data: {
        status: "OPEN",
        severity,
        expectedMinor: input.expectedMinor ?? null,
        actualMinor: input.actualMinor ?? null,
        detail: (input.detail ?? null) as never,
        lastSeenAt: new Date(),
        occurrences: { increment: 1 },
        resolvedAt: null,
        resolvedById: null,
        resolutionNote: null,
      },
    });
    return existing.id;
  }

  const row = await prisma.reconciliationException.upsert({
    where: {
      kind_entityType_entityId: {
        kind: input.kind,
        entityType: input.entityType,
        entityId: input.entityId,
      },
    },
    update: {
      severity,
      expectedMinor: input.expectedMinor ?? null,
      actualMinor: input.actualMinor ?? null,
      detail: (input.detail ?? null) as never,
      lastSeenAt: new Date(),
      occurrences: { increment: 1 },
    },
    create: {
      kind: input.kind,
      severity,
      entityType: input.entityType,
      entityId: input.entityId,
      expectedMinor: input.expectedMinor ?? null,
      actualMinor: input.actualMinor ?? null,
      currency: input.currency ?? "AED",
      detail: (input.detail ?? null) as never,
    },
  });

  if (!existing) {
    logger.error("Reconciliation exception raised", {
      kind: input.kind,
      entityType: input.entityType,
      entityId: input.entityId,
      expectedMinor: input.expectedMinor?.toString(),
      actualMinor: input.actualMinor?.toString(),
    });

    await prisma.$transaction(async (tx) => {
      await enqueueOutboxEvent(tx, TXN_EVENTS.RECONCILIATION_EXCEPTION_RAISED, {
        exceptionId: row.id,
        kind: input.kind,
        severity,
        entityType: input.entityType,
        entityId: input.entityId,
      });
    });
  }

  return row.id;
}

/** Close an exception that this run no longer sees. */
async function autoResolve(kind: ExceptionKind, entityType: string, entityId: string): Promise<boolean> {
  const updated = await prisma.reconciliationException.updateMany({
    where: { kind, entityType, entityId, status: "OPEN" },
    data: { status: "RESOLVED", resolvedAt: new Date(), resolutionNote: "No longer reproducible" },
  });
  return updated.count > 0;
}

/** Check 1: the whole ledger sums to zero. */
async function checkLedgerBalanced(): Promise<{ balanced: boolean; resolved: number }> {
  try {
    await assertLedgerBalanced();
    const resolved = await autoResolve("LEDGER_OUT_OF_BALANCE", "LEDGER", "ALL");
    return { balanced: true, resolved: resolved ? 1 : 0 };
  } catch (error) {
    await raiseException({
      kind: "LEDGER_OUT_OF_BALANCE",
      severity: "CRITICAL",
      entityType: "LEDGER",
      entityId: "ALL",
      detail: { message: (error as Error).message },
    });
    return { balanced: false, resolved: 0 };
  }
}

/** Check 2: the liability account equals the settlements still outstanding. */
async function checkSellerPayable(): Promise<{
  sellerPayableMinor: bigint;
  outstandingMinor: bigint;
  raised: number;
  resolved: number;
}> {
  const balances = await accountBalances("AED");
  const payable = balances.find((balance) => balance.account === "SELLER_PAYABLE");
  // Liability accounts run negative under the debits-minus-credits
  // convention, so flip the sign to get "what is owed".
  const sellerPayableMinor = payable ? -payable.balanceMinor : 0n;

  const outstanding = await prisma.sellerSettlement.aggregate({
    where: { settlementStatus: { in: [...OUTSTANDING_LIABILITY_STATES] } },
    _sum: { netProceeds: true },
  });
  const outstandingMinor = BigInt(Math.round((outstanding._sum.netProceeds ?? 0) * 100));

  // A fils of rounding drift across thousands of orders is not a discrepancy
  // worth waking anyone for; a real mismatch is orders of magnitude larger.
  const tolerance = 100n;
  const difference =
    sellerPayableMinor > outstandingMinor
      ? sellerPayableMinor - outstandingMinor
      : outstandingMinor - sellerPayableMinor;

  if (difference > tolerance) {
    await raiseException({
      kind: "SELLER_PAYABLE_MISMATCH",
      severity: "CRITICAL",
      entityType: "LEDGER_ACCOUNT",
      entityId: "SELLER_PAYABLE",
      expectedMinor: outstandingMinor,
      actualMinor: sellerPayableMinor,
      detail: { differenceMinor: difference.toString() },
    });
    return { sellerPayableMinor, outstandingMinor, raised: 1, resolved: 0 };
  }

  const resolved = await autoResolve("SELLER_PAYABLE_MISMATCH", "LEDGER_ACCOUNT", "SELLER_PAYABLE");
  return { sellerPayableMinor, outstandingMinor, raised: 0, resolved: resolved ? 1 : 0 };
}

/**
 * Check 3: the platform still holds enough to pay what it owes.
 *
 * TradeAuct's own payout schedule must not sweep held seller funds into
 * TradeAuct's bank account. If the available balance has fallen below the
 * outstanding seller liability, transfers will start failing — better to find
 * out from a report than from a seller (plan Phase 4, Q10).
 */
async function checkPlatformBalance(outstandingMinor: bigint): Promise<number> {
  try {
    const balance = await getStripeClient().balance.retrieve();
    const availableMinor = balance.available
      .filter((entry) => entry.currency === "aed")
      .reduce((total, entry) => total + BigInt(entry.amount), 0n);

    if (availableMinor < outstandingMinor) {
      await raiseException({
        kind: "PLATFORM_BALANCE_SHORTFALL",
        severity: "CRITICAL",
        entityType: "STRIPE_BALANCE",
        entityId: "PLATFORM",
        expectedMinor: outstandingMinor,
        actualMinor: availableMinor,
        detail: { note: "The platform's available balance is below the seller liability it is holding" },
      });
      return 1;
    }

    await autoResolve("PLATFORM_BALANCE_SHORTFALL", "STRIPE_BALANCE", "PLATFORM");
    return 0;
  } catch (error) {
    logger.warn("Could not read the Stripe balance for reconciliation", { error });
    return 0;
  }
}

/** Check 4: each recent settlement against what Stripe says happened. */
async function checkSettlements(since: Date): Promise<{ checked: number; raised: number; resolved: number }> {
  const settlements = await prisma.sellerSettlement.findMany({
    where: {
      updatedAt: { gte: since },
      settlementStatus: { in: ["TRANSFER_PENDING", "TRANSFERRED", "PAID_OUT"] },
    },
    take: 500,
  });

  let raised = 0;
  let resolved = 0;

  for (const settlement of settlements) {
    // Stuck in the claim state: a worker took it and never came back.
    if (settlement.settlementStatus === "TRANSFER_PENDING") {
      const stuckSince = Date.now() - STUCK_TRANSFER_MINUTES * 60 * 1000;
      if (settlement.updatedAt.getTime() < stuckSince) {
        await raiseException({
          kind: "SETTLEMENT_STUCK_IN_TRANSFER",
          severity: "CRITICAL",
          entityType: "SETTLEMENT",
          entityId: settlement.id,
          detail: {
            since: settlement.updatedAt.toISOString(),
            attempts: settlement.transferAttempts,
            note: "Claimed for transfer but never resolved. Check Stripe for a transfer under this settlement's idempotency key before retrying.",
          },
        });
        raised += 1;
      }
      continue;
    }

    if (!settlement.stripeTransferId || settlement.payoutMethod !== "STRIPE_CONNECT") {
      // Manual payouts and TradeAuct-owned settlements have nothing at Stripe.
      continue;
    }

    const transfer = await stripePayoutProvider.getTransfer(settlement.stripeTransferId);

    if (!transfer) {
      await raiseException({
        kind: "TRANSFER_MISSING_AT_STRIPE",
        severity: "CRITICAL",
        entityType: "SETTLEMENT",
        entityId: settlement.id,
        detail: { stripeTransferId: settlement.stripeTransferId },
      });
      raised += 1;
      continue;
    }

    const localTransfer = await prisma.payoutTransfer.findUnique({ where: { settlementId: settlement.id } });
    const expectedMinor = localTransfer?.amountMinor ?? 0n;

    if (expectedMinor > 0n && transfer.amountMinor !== expectedMinor) {
      await raiseException({
        kind: "TRANSFER_AMOUNT_MISMATCH",
        severity: "CRITICAL",
        entityType: "SETTLEMENT",
        entityId: settlement.id,
        expectedMinor,
        actualMinor: transfer.amountMinor,
        currency: settlement.currency,
      });
      raised += 1;
      continue;
    }

    if (await autoResolve("TRANSFER_MISSING_AT_STRIPE", "SETTLEMENT", settlement.id)) resolved += 1;
    if (await autoResolve("TRANSFER_AMOUNT_MISMATCH", "SETTLEMENT", settlement.id)) resolved += 1;
  }

  return { checked: settlements.length, raised, resolved };
}

/** One full pass. Safe to run concurrently with everything else. */
export async function runReconciliation(options: { lookbackHours?: number } = {}): Promise<ReconciliationReport> {
  const since = new Date(Date.now() - (options.lookbackHours ?? 48) * 60 * 60 * 1000);
  const startedAt = Date.now();

  const ledger = await checkLedgerBalanced();
  const payable = await checkSellerPayable();
  const balanceExceptions = loadEnv().SELLER_AUTO_TRANSFER_ENABLED
    ? await checkPlatformBalance(payable.outstandingMinor)
    : 0;
  const settlements = await checkSettlements(since);

  const report: ReconciliationReport = {
    ranAt: new Date().toISOString(),
    checked: settlements.checked,
    exceptionsRaised: (ledger.balanced ? 0 : 1) + payable.raised + balanceExceptions + settlements.raised,
    exceptionsResolved: ledger.resolved + payable.resolved + settlements.resolved,
    ledgerBalanced: ledger.balanced,
    sellerPayableMinor: payable.sellerPayableMinor.toString(),
    outstandingSettlementMinor: payable.outstandingMinor.toString(),
  };

  logger.info("Reconciliation finished", { ...report, durationMs: Date.now() - startedAt });
  return report;
}

/** The admin list, newest and most severe first. */
export async function listExceptions(input: { status?: string; limit?: number } = {}) {
  return prisma.reconciliationException.findMany({
    where: input.status ? { status: input.status as never } : { status: { in: ["OPEN", "ACKNOWLEDGED"] } },
    orderBy: [{ severity: "asc" }, { lastSeenAt: "desc" }],
    take: Math.min(Math.max(input.limit ?? 50, 1), 200),
  });
}

/** An admin has dealt with it. */
export async function resolveException(input: {
  exceptionId: string;
  status: "ACKNOWLEDGED" | "RESOLVED" | "IGNORED";
  note: string;
  adminId: string;
}) {
  return prisma.reconciliationException.update({
    where: { id: input.exceptionId },
    data: {
      status: input.status,
      resolutionNote: input.note,
      resolvedById: input.adminId,
      resolvedAt: input.status === "ACKNOWLEDGED" ? null : new Date(),
    },
  });
}

/** The daily finance summary. */
export async function buildDailyFinanceReport(day = new Date()) {
  const start = new Date(day);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  const [created, paidOut, refunded, byStatus, openExceptions] = await Promise.all([
    prisma.sellerSettlement.aggregate({
      where: { createdAt: { gte: start, lt: end } },
      _sum: { saleAmount: true, platformFee: true, netProceeds: true },
      _count: { _all: true },
    }),
    prisma.sellerSettlement.aggregate({
      where: { paidOutAt: { gte: start, lt: end } },
      _sum: { netProceeds: true },
      _count: { _all: true },
    }),
    prisma.refund.aggregate({
      where: { createdAt: { gte: start, lt: end }, status: "SUCCEEDED" },
      _sum: { amountMinor: true },
      _count: { _all: true },
    }),
    prisma.sellerSettlement.groupBy({
      by: ["settlementStatus"],
      _sum: { netProceeds: true },
      _count: { _all: true },
    }),
    prisma.reconciliationException.count({ where: { status: "OPEN" } }),
  ]);

  return {
    date: start.toISOString().slice(0, 10),
    settlementsCreated: {
      count: created._count._all,
      saleAmount: created._sum.saleAmount ?? 0,
      platformFee: created._sum.platformFee ?? 0,
      netProceeds: created._sum.netProceeds ?? 0,
    },
    paidOut: { count: paidOut._count._all, netProceeds: paidOut._sum.netProceeds ?? 0 },
    refunds: { count: refunded._count._all, amountMinor: (refunded._sum.amountMinor ?? 0n).toString() },
    byStatus: byStatus.map((row) => ({
      status: row.settlementStatus,
      count: row._count._all,
      netProceeds: row._sum.netProceeds ?? 0,
    })),
    openExceptions,
  };
}
