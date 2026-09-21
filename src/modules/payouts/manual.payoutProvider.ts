/**
 * The admin manual-payout override (decision D3).
 *
 * Automatic payout is the primary path; sellers never request a withdrawal.
 * But some settlements cannot go through Connect — a seller without a UAE
 * trade licence, an account Stripe has restricted, a recovery case — and those
 * still have to be paid.
 *
 * No money moves through this provider. An admin pays the seller by bank
 * transfer and records the reference here, which is what moves the settlement
 * to PAID_OUT and posts the ledger entry.
 */
import { AppError } from "../../core/errors/AppError.js";
import { logger } from "../../core/logger.js";
import type {
  PayoutInput,
  PayoutResult,
  ReversalInput,
  ReversalResult,
  SellerPayoutProvider,
  TransferInput,
  TransferResult,
} from "./payout.provider.js";

export class ManualPayoutProvider implements SellerPayoutProvider {
  readonly name = "MANUAL" as const;

  constructor(private readonly reference: string) {
    if (!reference || reference.trim().length < 3) {
      throw new AppError(
        400,
        "A manual payout needs a bank reference so it can be reconciled later.",
        "MANUAL_PAYOUT_REFERENCE_REQUIRED",
      );
    }
  }

  async createTransfer(input: TransferInput): Promise<TransferResult> {
    logger.info("Manual payout recorded", {
      settlementId: input.settlementId,
      sellerId: input.sellerId,
      reference: this.reference,
      amountMinor: input.amountMinor.toString(),
    });

    return {
      providerTransferId: `manual_${this.reference}`,
      status: "SUCCEEDED",
      amountMinor: input.amountMinor,
      currency: input.currency,
    };
  }

  async getTransfer(): Promise<TransferResult | null> {
    return null;
  }

  async reverseTransfer(_input: ReversalInput): Promise<ReversalResult> {
    // Nothing to reverse: the money left by bank transfer, outside Stripe.
    // Recovering it is a SettlementRecovery, handled by the refunds module.
    throw new AppError(
      409,
      "A manual payout cannot be reversed automatically. Open a recovery instead.",
      "MANUAL_PAYOUT_NOT_REVERSIBLE",
    );
  }

  async createPayout(input: PayoutInput): Promise<PayoutResult> {
    return {
      providerPayoutId: `manual_${this.reference}`,
      status: "paid",
      amountMinor: input.amountMinor,
      arrivalDate: new Date(),
    };
  }

  async getPayout(): Promise<PayoutResult | null> {
    return null;
  }
}
