/**
 * Double-entry ledger.
 *
 * The `Payment` row says what state a payment is in. The ledger says where the
 * money went, and it is the only record that can be reconciled against Stripe
 * or handed to an accountant. Entries are append-only: a mistake is corrected
 * with a compensating transaction, never by editing history.
 *
 * Every transaction must balance. `postTransaction` refuses to write one that
 * does not, because an unbalanced ledger is worse than no ledger — it looks
 * authoritative while being wrong.
 */
import type { LedgerAccount, LedgerDirection, LedgerTransactionKind } from "@prisma/client";
import { AppError } from "../../core/errors/AppError.js";
import { getTraceId } from "../../core/logger.js";
import { type PrismaTransaction, prisma } from "../../core/prisma.js";

export type LedgerLine = {
  account: LedgerAccount;
  direction: LedgerDirection;
  amountMinor: bigint;
  buyerId?: string | null;
  sellerId?: string | null;
  paymentId?: string | null;
};

export type PostTransactionInput = {
  kind: LedgerTransactionKind;
  referenceType: string;
  referenceId: string;
  currency: string;
  description?: string;
  lines: LedgerLine[];
};

function sum(lines: LedgerLine[], direction: LedgerDirection): bigint {
  return lines.filter((line) => line.direction === direction).reduce((total, line) => total + line.amountMinor, 0n);
}

/**
 * Write one balanced transaction.
 *
 * Pass the transaction client so the ledger lands with the state change it
 * describes; a ledger entry that survives a rolled-back payment would be a
 * phantom.
 */
export async function postTransaction(input: PostTransactionInput, tx: PrismaTransaction): Promise<string> {
  if (input.lines.length < 2) {
    throw new AppError(500, "A ledger transaction needs at least two entries", "LEDGER_INCOMPLETE");
  }

  if (input.lines.some((line) => line.amountMinor <= 0n)) {
    // Direction carries the sign. A negative amount would let the same entry
    // read as either a debit or a credit depending on who is looking.
    throw new AppError(500, "Ledger amounts must be positive; direction carries the sign", "LEDGER_INVALID_AMOUNT");
  }

  const debits = sum(input.lines, "DEBIT");
  const credits = sum(input.lines, "CREDIT");

  if (debits !== credits) {
    throw new AppError(
      500,
      `Ledger transaction does not balance: debits ${debits} vs credits ${credits}`,
      "LEDGER_UNBALANCED",
      { debits: debits.toString(), credits: credits.toString() },
    );
  }

  const transaction = await tx.ledgerTransaction.create({
    data: {
      kind: input.kind,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      currency: input.currency.toUpperCase(),
      description: input.description ?? null,
      traceId: getTraceId() ?? null,
      entries: {
        create: input.lines.map((line) => ({
          account: line.account,
          direction: line.direction,
          amountMinor: line.amountMinor,
          currency: input.currency.toUpperCase(),
          buyerId: line.buyerId ?? null,
          sellerId: line.sellerId ?? null,
          paymentId: line.paymentId ?? null,
        })),
      },
    },
  });

  return transaction.id;
}

/** True when a transaction has already been posted for this reference. */
export async function hasTransactionFor(
  referenceType: string,
  referenceId: string,
  kind: LedgerTransactionKind,
): Promise<boolean> {
  const existing = await prisma.ledgerTransaction.findFirst({
    where: { referenceType, referenceId, kind },
    select: { id: true },
  });
  return Boolean(existing);
}

export type AccountBalance = { account: LedgerAccount; currency: string; balanceMinor: bigint };

/**
 * Balance per account, as debits minus credits.
 *
 * Asset accounts (cash) run positive; liability and revenue accounts run
 * negative under this convention, and the sum across all accounts must be
 * zero. `assertLedgerBalanced` is what a nightly job calls.
 */
export async function accountBalances(currency?: string): Promise<AccountBalance[]> {
  const rows = await prisma.ledgerEntry.groupBy({
    by: ["account", "direction", "currency"],
    where: currency ? { currency: currency.toUpperCase() } : undefined,
    _sum: { amountMinor: true },
  });

  const totals = new Map<string, AccountBalance>();

  for (const row of rows) {
    const key = `${row.account}:${row.currency}`;
    const current = totals.get(key) ?? { account: row.account, currency: row.currency, balanceMinor: 0n };
    const amount = BigInt(row._sum.amountMinor ?? 0);
    current.balanceMinor += row.direction === "DEBIT" ? amount : -amount;
    totals.set(key, current);
  }

  return [...totals.values()];
}

/** Throws when the books do not sum to zero. Used by the reconciliation job. */
export async function assertLedgerBalanced(currency?: string): Promise<void> {
  const balances = await accountBalances(currency);
  const total = balances.reduce((acc, balance) => acc + balance.balanceMinor, 0n);

  if (total !== 0n) {
    throw new AppError(500, `Ledger does not balance: net ${total}`, "LEDGER_OUT_OF_BALANCE", {
      net: total.toString(),
      balances: balances.map((b) => ({ ...b, balanceMinor: b.balanceMinor.toString() })),
    });
  }
}
