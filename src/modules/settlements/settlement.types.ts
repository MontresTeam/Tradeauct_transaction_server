/**
 * The settlement state machine, written down.
 *
 * Every legal move is in `ALLOWED_TRANSITIONS`. `transitionSettlement` refuses
 * anything not listed, which is what keeps a settlement from going straight
 * from PENDING to PAID_OUT because some new code path forgot the window.
 *
 * Read this next to the diagram in payment_settlement_implementation_plan.md §6.
 */
import type { SettlementStatus } from "@prisma/client";

/** Live states. The four deprecated members are never written. */
export const SETTLEMENT_STATES = [
  "PENDING",
  "ON_HOLD",
  "ELIGIBLE",
  "TRANSFER_PENDING",
  "TRANSFERRED",
  "PAID_OUT",
  "FROZEN",
  "DISPUTED",
  "TRANSFER_FAILED",
  "REFUNDED",
  "CANCELLED",
] as const satisfies readonly SettlementStatus[];

/**
 * Where each state may go.
 *
 * PAID_OUT is terminal on purpose. A refund or dispute afterwards opens a
 * SettlementRecovery and leaves the payout record exactly as it was — the
 * spec is explicit that history is not rewritten (§10, §45).
 */
export const ALLOWED_TRANSITIONS: Record<SettlementStatus, readonly SettlementStatus[]> = {
  // Not PAID_OUT: an undelivered order has no window behind it, so there is no
  // route from here to the seller's bank. TradeAuct's own stock is created
  // PAID_OUT rather than transitioned into it.
  PENDING: ["ON_HOLD", "FROZEN", "DISPUTED", "REFUNDED", "CANCELLED"],
  ON_HOLD: ["ELIGIBLE", "FROZEN", "DISPUTED", "REFUNDED", "CANCELLED"],
  ELIGIBLE: ["TRANSFER_PENDING", "PAID_OUT", "FROZEN", "DISPUTED", "REFUNDED", "ON_HOLD"],
  // Back to ELIGIBLE only as a retry: both of these already passed the window.
  TRANSFER_PENDING: ["TRANSFERRED", "TRANSFER_FAILED", "ELIGIBLE"],
  TRANSFERRED: ["PAID_OUT", "TRANSFER_FAILED"],
  TRANSFER_FAILED: ["ELIGIBLE", "PAID_OUT", "FROZEN"],
  // Unfreezing and winning a dispute both return to PENDING or ON_HOLD, never
  // straight to ELIGIBLE: the checks run again from the top.
  FROZEN: ["PENDING", "ON_HOLD", "REFUNDED", "CANCELLED", "DISPUTED"],
  DISPUTED: ["PENDING", "ON_HOLD", "FROZEN", "REFUNDED", "CANCELLED"],
  PAID_OUT: [],
  REFUNDED: [],
  CANCELLED: [],

  // Deprecated members. Nothing writes them; a legacy row that somehow still
  // holds one can only be migrated onto the live lifecycle.
  DISPUTE_OPEN: ["DISPUTED"],
  RETURN_IN_PROGRESS: ["FROZEN"],
  AVAILABLE_FOR_PAYOUT: ["ELIGIBLE"],
  PAID: ["PAID_OUT"],
};

/** States whose net amount the platform still owes the seller. */
export const OUTSTANDING_LIABILITY_STATES: readonly SettlementStatus[] = [
  "PENDING",
  "ON_HOLD",
  "ELIGIBLE",
  "TRANSFER_PENDING",
  "TRANSFER_FAILED",
  "FROZEN",
  "DISPUTED",
];

/** What the seller dashboard shows, and which states feed each bucket. */
export const SELLER_BALANCE_BUCKETS = {
  pending: ["PENDING"],
  onHold: ["ON_HOLD"],
  available: ["ELIGIBLE", "TRANSFER_PENDING", "TRANSFERRED", "TRANSFER_FAILED"],
  paidOut: ["PAID_OUT"],
  frozen: ["FROZEN"],
  disputed: ["DISPUTED"],
} as const satisfies Record<string, readonly SettlementStatus[]>;

export type SellerBalanceBucket = keyof typeof SELLER_BALANCE_BUCKETS;

export type SellerBalances = Record<SellerBalanceBucket, { amount: number; count: number }> & {
  currency: string;
  /** Owed back to the platform after a payout; subtracted from future transfers. */
  openRecoveryAmount: number;
};

/** Who asked for a state change. Every transition records one. */
export type SettlementActor = {
  type: "ADMIN" | "SYSTEM" | "SERVICE" | "USER";
  id?: string | null;
  ip?: string | null;
};

export const SYSTEM_ACTOR: SettlementActor = { type: "SYSTEM", id: null, ip: null };

/** Why a settlement is not eligible yet. Surfaced to admins verbatim. */
export type EligibilityCheck = {
  eligible: boolean;
  reasons: string[];
  checks: {
    paymentSucceeded: boolean;
    deliveryConfirmed: boolean;
    protectionPeriodCompleted: boolean;
    noActiveReturn: boolean;
    noActiveDispute: boolean;
    noUnresolvedIssue: boolean;
    notAlreadyTransferred: boolean;
    automaticSettlementEnabled: boolean;
  };
};
