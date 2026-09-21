/**
 * The Stripe Connect implementation of `SellerPayoutProvider`.
 *
 * This is the only file that knows a seller payout is a Stripe transfer
 * followed by a Stripe payout. Everything above it deals in settlements.
 *
 * The distinction between the two matters and is not cosmetic:
 *
 *   transfers.create → money reaches the seller's Stripe balance
 *   payouts.create   → money reaches the seller's bank account
 *
 * A settlement is TRANSFERRED after the first and PAID_OUT after the second
 * (spec §18).
 */
import Stripe from "stripe";
import { logger } from "../../core/logger.js";
import { toStripeAmount } from "../../core/money.js";
import { getStripeClient } from "../gateway/stripe.client.js";
import {
  type PayoutInput,
  type PayoutResult,
  PermanentPayoutError,
  type ReversalInput,
  type ReversalResult,
  type SellerPayoutProvider,
  type TransferInput,
  type TransferResult,
} from "./payout.provider.js";

/**
 * Stripe error types that will never succeed on a retry.
 *
 * `StripeConnectionError` and `StripeAPIError` are deliberately absent: those
 * are the ones to retry, with the same idempotency key.
 */
function isPermanent(error: unknown): boolean {
  if (!(error instanceof Stripe.errors.StripeError)) return false;
  return (
    error.type === "StripeInvalidRequestError" ||
    error.type === "StripeCardError" ||
    error.type === "StripePermissionError" ||
    error.type === "StripeAuthenticationError"
  );
}

function rethrow(error: unknown, context: string): never {
  if (isPermanent(error)) {
    const stripeError = error as Stripe.errors.StripeError;
    logger.error(`${context}: Stripe refused permanently`, {
      code: stripeError.code,
      type: stripeError.type,
      message: stripeError.message,
    });
    throw new PermanentPayoutError(stripeError.message, stripeError.code ?? stripeError.type);
  }
  throw error;
}

export class StripeSellerPayoutProvider implements SellerPayoutProvider {
  readonly name = "STRIPE_CONNECT" as const;

  async createTransfer(input: TransferInput): Promise<TransferResult> {
    try {
      const transfer = await getStripeClient().transfers.create(
        {
          amount: toStripeAmount(input.amountMinor),
          currency: input.currency.toLowerCase(),
          destination: input.connectedAccountId,
          ...(input.transferGroup ? { transfer_group: input.transferGroup } : {}),
          // Take the money from the buyer's charge specifically. Without this
          // Stripe draws on the platform's available balance, which may
          // already have been paid out to TradeAuct's own bank.
          ...(input.sourceTransaction ? { source_transaction: input.sourceTransaction } : {}),
          metadata: {
            settlementId: input.settlementId,
            sellerId: input.sellerId,
          },
        },
        { idempotencyKey: input.idempotencyKey },
      );

      return {
        providerTransferId: transfer.id,
        // A created transfer is money that has moved. What has not happened
        // yet is the bank payout.
        status: "SUCCEEDED",
        amountMinor: BigInt(transfer.amount),
        currency: transfer.currency.toUpperCase(),
        destinationPaymentId:
          typeof transfer.destination_payment === "string"
            ? transfer.destination_payment
            : (transfer.destination_payment?.id ?? null),
        raw: transfer,
      };
    } catch (error) {
      rethrow(error, "createTransfer");
    }
  }

  async getTransfer(providerTransferId: string): Promise<TransferResult | null> {
    try {
      const transfer = await getStripeClient().transfers.retrieve(providerTransferId);
      return {
        providerTransferId: transfer.id,
        status: "SUCCEEDED",
        amountMinor: BigInt(transfer.amount),
        currency: transfer.currency.toUpperCase(),
        destinationPaymentId:
          typeof transfer.destination_payment === "string"
            ? transfer.destination_payment
            : (transfer.destination_payment?.id ?? null),
        raw: transfer,
      };
    } catch (error) {
      if (error instanceof Stripe.errors.StripeInvalidRequestError && error.statusCode === 404) return null;
      throw error;
    }
  }

  /**
   * Pull money back out of the connected account.
   *
   * This only works while the balance is still there. Once Stripe has paid the
   * seller's bank, a reversal fails and the debt becomes a SettlementRecovery
   * offset against their next transfers (spec §23).
   */
  async reverseTransfer(input: ReversalInput): Promise<ReversalResult> {
    try {
      const reversal = await getStripeClient().transfers.createReversal(
        input.providerTransferId,
        {
          amount: toStripeAmount(input.amountMinor),
          ...(input.reason ? { metadata: { reason: input.reason } } : {}),
        },
        { idempotencyKey: input.idempotencyKey },
      );

      return { reversalId: reversal.id, amountMinor: BigInt(reversal.amount), status: "SUCCEEDED" };
    } catch (error) {
      if (isPermanent(error)) {
        const stripeError = error as Stripe.errors.StripeError;
        // Not thrown: an insufficient balance is an expected outcome here, and
        // the caller's next step is to open a recovery rather than to fail.
        return {
          reversalId: "",
          amountMinor: 0n,
          status: "FAILED",
          failureMessage: stripeError.message,
        };
      }
      throw error;
    }
  }

  async createPayout(input: PayoutInput): Promise<PayoutResult> {
    try {
      const payout = await getStripeClient().payouts.create(
        {
          amount: toStripeAmount(input.amountMinor),
          currency: input.currency.toLowerCase(),
          ...(input.statementDescriptor ? { statement_descriptor: input.statementDescriptor } : {}),
        },
        { idempotencyKey: input.idempotencyKey, stripeAccount: input.connectedAccountId },
      );

      return {
        providerPayoutId: payout.id,
        status: payout.status,
        amountMinor: BigInt(payout.amount),
        arrivalDate: payout.arrival_date ? new Date(payout.arrival_date * 1000) : null,
      };
    } catch (error) {
      rethrow(error, "createPayout");
    }
  }

  async getPayout(providerPayoutId: string, connectedAccountId: string): Promise<PayoutResult | null> {
    try {
      const payout = await getStripeClient().payouts.retrieve(
        providerPayoutId,
        {},
        { stripeAccount: connectedAccountId },
      );
      return {
        providerPayoutId: payout.id,
        status: payout.status,
        amountMinor: BigInt(payout.amount),
        arrivalDate: payout.arrival_date ? new Date(payout.arrival_date * 1000) : null,
      };
    } catch (error) {
      if (error instanceof Stripe.errors.StripeInvalidRequestError && error.statusCode === 404) return null;
      throw error;
    }
  }

  /**
   * Which settlements a completed Stripe payout covers.
   *
   * One automatic payout bundles every transfer that landed in the window, so
   * attributing it means listing the payout's balance transactions on the
   * connected account and matching each back to a transfer's destination
   * payment (spec §20, plan Phase 4).
   */
  async listPayoutSourcePaymentIds(payoutId: string, connectedAccountId: string): Promise<string[]> {
    const ids: string[] = [];
    const stripe = getStripeClient();

    for await (const balanceTransaction of stripe.balanceTransactions.list(
      { payout: payoutId, type: "payment", limit: 100 },
      { stripeAccount: connectedAccountId },
    )) {
      const source = balanceTransaction.source;
      const sourceId = typeof source === "string" ? source : (source?.id ?? null);
      if (sourceId) ids.push(sourceId);
    }

    return ids;
  }
}
