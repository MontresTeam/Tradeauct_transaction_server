/**
 * The seller-payout provider interface (spec §39).
 *
 * The settlement engine decides *whether* and *when* a seller is paid. How the
 * money actually moves is behind this interface, so the business rules do not
 * know what a Stripe transfer is.
 *
 * Three implementations exist:
 *   - `StripeSellerPayoutProvider` — the automatic path, Connect transfers.
 *   - `ManualPayoutProvider` — the admin override, for sellers who cannot
 *     onboard and for recovery cases. It records a bank reference; no money
 *     moves through this server.
 *   - `FakePayoutProvider` — tests.
 *
 * If Stripe's answers change the model, this is the seam that absorbs it.
 */

export type TransferInput = {
  settlementId: string;
  sellerId: string;
  connectedAccountId: string;
  amountMinor: bigint;
  currency: string;
  /** Ties the transfer to the buyer's original charge in Stripe. */
  transferGroup?: string | null;
  /**
   * The charge the money came from. Naming it means Stripe takes the funds
   * from that charge rather than from the platform's general balance, which
   * matters when the platform's own payout schedule has already swept.
   */
  sourceTransaction?: string | null;
  /** Always derived from the settlement, never random. */
  idempotencyKey: string;
};

export type TransferResult = {
  providerTransferId: string;
  status: "PENDING" | "SUCCEEDED" | "FAILED";
  amountMinor: bigint;
  currency: string;
  destinationPaymentId?: string | null;
  failureCode?: string | null;
  failureMessage?: string | null;
  raw?: unknown;
};

export type ReversalInput = {
  providerTransferId: string;
  amountMinor: bigint;
  idempotencyKey: string;
  reason?: string;
};

export type ReversalResult = {
  reversalId: string;
  amountMinor: bigint;
  status: "SUCCEEDED" | "FAILED";
  failureMessage?: string | null;
};

export type PayoutInput = {
  connectedAccountId: string;
  amountMinor: bigint;
  currency: string;
  idempotencyKey: string;
  statementDescriptor?: string;
};

export type PayoutResult = {
  providerPayoutId: string;
  status: string;
  amountMinor: bigint;
  arrivalDate?: Date | null;
};

export interface SellerPayoutProvider {
  readonly name: "STRIPE_CONNECT" | "MANUAL" | "FAKE";

  createTransfer(input: TransferInput): Promise<TransferResult>;
  getTransfer(providerTransferId: string): Promise<TransferResult | null>;
  reverseTransfer(input: ReversalInput): Promise<ReversalResult>;

  /**
   * Push money from the connected account to the seller's bank.
   *
   * Only meaningful when the account's payout schedule is manual. On a daily
   * schedule Stripe creates the payout itself and this is never called.
   */
  createPayout(input: PayoutInput): Promise<PayoutResult>;
  getPayout(providerPayoutId: string, connectedAccountId: string): Promise<PayoutResult | null>;
}

/**
 * A permanent Stripe failure, as distinct from a timeout.
 *
 * A timeout must be retried with the *same* idempotency key. A permanent
 * failure must not be retried at all — it needs a person.
 */
export class PermanentPayoutError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "PermanentPayoutError";
  }
}
