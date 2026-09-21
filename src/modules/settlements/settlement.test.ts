/**
 * The settlement state machine and the balance view.
 *
 * These are the rules that decide when a seller gets paid, so they are
 * asserted directly rather than only through an integration test that needs a
 * database and Stripe.
 */
import { describe, expect, it } from "vitest";
import {
  ALLOWED_TRANSITIONS,
  OUTSTANDING_LIABILITY_STATES,
  SELLER_BALANCE_BUCKETS,
  SETTLEMENT_STATES,
} from "./settlement.types.js";

describe("Settlement state machine", () => {
  it("runs the happy path exactly as the spec describes it", () => {
    const path = ["PENDING", "ON_HOLD", "ELIGIBLE", "TRANSFER_PENDING", "TRANSFERRED", "PAID_OUT"] as const;

    for (let i = 0; i < path.length - 1; i += 1) {
      expect(ALLOWED_TRANSITIONS[path[i]]).toContain(path[i + 1]);
    }
  });

  it("will not let a settlement skip the protection period", () => {
    // PENDING means paid but not delivered. It must pass through ON_HOLD.
    expect(ALLOWED_TRANSITIONS.PENDING).not.toContain("ELIGIBLE");
    expect(ALLOWED_TRANSITIONS.PENDING).not.toContain("TRANSFER_PENDING");
    expect(ALLOWED_TRANSITIONS.PENDING).not.toContain("TRANSFERRED");
  });

  it("will not let a settlement skip the transfer claim", () => {
    // ELIGIBLE → TRANSFERRED without the TRANSFER_PENDING claim would mean two
    // workers could both believe they had it.
    expect(ALLOWED_TRANSITIONS.ELIGIBLE).not.toContain("TRANSFERRED");
    expect(ALLOWED_TRANSITIONS.ELIGIBLE).toContain("TRANSFER_PENDING");
  });

  it("treats PAID_OUT, REFUNDED and CANCELLED as terminal", () => {
    expect(ALLOWED_TRANSITIONS.PAID_OUT).toHaveLength(0);
    expect(ALLOWED_TRANSITIONS.REFUNDED).toHaveLength(0);
    expect(ALLOWED_TRANSITIONS.CANCELLED).toHaveLength(0);
  });

  it("lets a dispute or a freeze stop a settlement at any point before transfer", () => {
    for (const state of ["PENDING", "ON_HOLD", "ELIGIBLE"] as const) {
      expect(ALLOWED_TRANSITIONS[state]).toContain("FROZEN");
      expect(ALLOWED_TRANSITIONS[state]).toContain("DISPUTED");
    }
  });

  it("cannot freeze or dispute a settlement once the money has gone", () => {
    for (const state of ["TRANSFERRED", "PAID_OUT"] as const) {
      expect(ALLOWED_TRANSITIONS[state]).not.toContain("FROZEN");
      expect(ALLOWED_TRANSITIONS[state]).not.toContain("DISPUTED");
      expect(ALLOWED_TRANSITIONS[state]).not.toContain("REFUNDED");
    }
  });

  it("lets a frozen settlement return to where the delivery state says it belongs", () => {
    expect(ALLOWED_TRANSITIONS.FROZEN).toContain("PENDING");
    expect(ALLOWED_TRANSITIONS.FROZEN).toContain("ON_HOLD");
  });

  it("never lets a freeze or a dispute end in a release", () => {
    // Unfreezing, and winning a dispute, put the settlement back where the
    // delivery state says it belongs and let the checks run again. Going
    // straight to ELIGIBLE would skip them.
    expect(ALLOWED_TRANSITIONS.FROZEN).not.toContain("ELIGIBLE");
    expect(ALLOWED_TRANSITIONS.DISPUTED).not.toContain("ELIGIBLE");
  });

  it("only reaches ELIGIBLE from a state that has already served the window", () => {
    // This is the client's rule, stated structurally: delivered, then the
    // protection period, then release. ON_HOLD is the only way in;
    // TRANSFER_PENDING and TRANSFER_FAILED are retries of settlements that
    // already got there once.
    const canReachEligible = Object.entries(ALLOWED_TRANSITIONS)
      .filter(([, destinations]) => destinations.includes("ELIGIBLE"))
      .map(([from]) => from)
      .sort();

    expect(canReachEligible).toEqual(["AVAILABLE_FOR_PAYOUT", "ON_HOLD", "TRANSFER_FAILED", "TRANSFER_PENDING"]);
  });

  it("gives an undelivered settlement no route to the seller's bank", () => {
    expect(ALLOWED_TRANSITIONS.PENDING).not.toContain("PAID_OUT");
    expect(ALLOWED_TRANSITIONS.PENDING).not.toContain("TRANSFERRED");
  });

  it("lets a failed transfer be retried or paid manually, but not silently dropped", () => {
    expect(ALLOWED_TRANSITIONS.TRANSFER_FAILED).toContain("ELIGIBLE");
    expect(ALLOWED_TRANSITIONS.TRANSFER_FAILED).toContain("PAID_OUT");
    expect(ALLOWED_TRANSITIONS.TRANSFER_FAILED).not.toContain("CANCELLED");
  });

  it("declares a transition list for every state", () => {
    for (const state of SETTLEMENT_STATES) {
      expect(ALLOWED_TRANSITIONS[state]).toBeDefined();
    }
  });

  it("only ever names real states as destinations", () => {
    const known = new Set<string>([
      ...SETTLEMENT_STATES,
      // The deprecated members are reachable only as migration targets.
      "DISPUTE_OPEN",
      "RETURN_IN_PROGRESS",
      "AVAILABLE_FOR_PAYOUT",
      "PAID",
    ]);

    for (const [from, destinations] of Object.entries(ALLOWED_TRANSITIONS)) {
      for (const to of destinations) {
        expect(known.has(to), `${from} → ${to}`).toBe(true);
      }
    }
  });
});

describe("Seller balance buckets", () => {
  it("shows the seller the six buckets the client asked for", () => {
    expect(Object.keys(SELLER_BALANCE_BUCKETS)).toEqual([
      "pending",
      "onHold",
      "available",
      "paidOut",
      "frozen",
      "disputed",
    ]);
  });

  it("puts a settlement in exactly one bucket", () => {
    const seen = new Map<string, string>();

    for (const [bucket, states] of Object.entries(SELLER_BALANCE_BUCKETS)) {
      for (const state of states) {
        expect(seen.has(state), `${state} is in both ${seen.get(state)} and ${bucket}`).toBe(false);
        seen.set(state, bucket);
      }
    }
  });

  it("shows money in flight as available, not as already paid out", () => {
    expect(SELLER_BALANCE_BUCKETS.available).toContain("TRANSFER_PENDING");
    expect(SELLER_BALANCE_BUCKETS.available).toContain("TRANSFERRED");
    expect(SELLER_BALANCE_BUCKETS.paidOut).toEqual(["PAID_OUT"]);
  });

  it("does not show refunded or cancelled settlements as money", () => {
    const bucketed = Object.values(SELLER_BALANCE_BUCKETS).flat();
    expect(bucketed).not.toContain("REFUNDED");
    expect(bucketed).not.toContain("CANCELLED");
  });
});

describe("Outstanding liability", () => {
  it("counts every state where the platform still owes the seller", () => {
    for (const state of ["PENDING", "ON_HOLD", "ELIGIBLE", "TRANSFER_PENDING", "FROZEN", "DISPUTED"] as const) {
      expect(OUTSTANDING_LIABILITY_STATES).toContain(state);
    }
  });

  it("stops counting once the money has left the platform", () => {
    // The ledger's SELLER_PAYABLE is discharged by the transfer, so counting
    // TRANSFERRED here would make reconciliation report a permanent mismatch.
    expect(OUTSTANDING_LIABILITY_STATES).not.toContain("TRANSFERRED");
    expect(OUTSTANDING_LIABILITY_STATES).not.toContain("PAID_OUT");
    expect(OUTSTANDING_LIABILITY_STATES).not.toContain("REFUNDED");
    expect(OUTSTANDING_LIABILITY_STATES).not.toContain("CANCELLED");
  });
});
