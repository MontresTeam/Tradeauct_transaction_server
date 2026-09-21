/**
 * What a refund does to the seller's side of an order.
 *
 * The split below is the plan's default answer to open question Q3, so these
 * tests are as much a statement of the rule as a check of the arithmetic: if
 * the client decides a partial refund should come out of someone else's
 * share, these are the numbers that change.
 */
import { describe, expect, it } from "vitest";
import { computeSettlementImpact } from "./refund.service.js";

/**
 * A worked example, used throughout:
 *
 *   hammer price     10,000   (a custom start, no reserve: seller 2%, buyer 4%)
 *   buyer fee           400
 *   shipping            250
 *   VAT                   0
 *   ---------------------------
 *   customer total   10,650
 *   seller fee          200
 *   seller net        9,800
 */
const ORDER = {
  salePrice: 10000,
  customerTotal: 10650,
  sellerFeePercent: 2,
  currentNet: 9800,
  otherDeductions: 0,
};

describe("Refund impact on a settlement", () => {
  it("a full refund of the customer total wipes out the seller's net", () => {
    const impact = computeSettlementImpact({ ...ORDER, refundAmount: 10650 });

    expect(impact.newSaleAmount).toBe(0);
    expect(impact.newSellerFee).toBe(0);
    expect(impact.newNet).toBe(0);
    expect(impact.adjustment).toBe(-9800);
  });

  it("a partial refund reduces the seller pro-rata, not by the whole amount", () => {
    // AED 1,065 is 10% of the customer total, so 10% of the hammer price -
    // AED 1,000 - comes off the sale, and the seller fee is recalculated on
    // the AED 9,000 that is left.
    const impact = computeSettlementImpact({ ...ORDER, refundAmount: 1065 });

    expect(impact.newSaleAmount).toBe(9000);
    expect(impact.newSellerFee).toBe(180);
    expect(impact.newNet).toBe(8820);
    expect(impact.adjustment).toBe(-980);
  });

  it("recalculates the seller fee rather than keeping the original one", () => {
    const impact = computeSettlementImpact({ ...ORDER, refundAmount: 5325 });

    // Half the order refunded: the seller fee halves too, from 200 to 100.
    expect(impact.newSaleAmount).toBe(5000);
    expect(impact.newSellerFee).toBe(100);
    expect(impact.newNet).toBe(4900);
  });

  it("does not let a refund larger than the order produce a negative net", () => {
    const impact = computeSettlementImpact({ ...ORDER, refundAmount: 99999 });

    expect(impact.newNet).toBe(0);
    expect(impact.newSaleAmount).toBe(0);
  });

  it("refunding only the buyer's own charges still shares the reduction", () => {
    // Refunding the shipping (AED 250) is 2.35% of the customer total, which
    // takes 2.35% off the hammer price too. Whether shipping should instead
    // come entirely off the platform's side is exactly what Q3 asks.
    const impact = computeSettlementImpact({ ...ORDER, refundAmount: 250 });

    expect(impact.newSaleAmount).toBeCloseTo(9765.26, 1);
    expect(impact.adjustment).toBeLessThan(0);
  });

  it("keeps other deductions out of the recalculated fee", () => {
    const impact = computeSettlementImpact({
      ...ORDER,
      otherDeductions: 300,
      currentNet: 9500,
      refundAmount: 1065,
    });

    expect(impact.newSellerFee).toBe(180);
    expect(impact.newNet).toBe(8520); // 9000 - 180 - 300
  });

  it("treats a zero customer total as a full refund rather than dividing by zero", () => {
    const impact = computeSettlementImpact({ ...ORDER, customerTotal: 0, refundAmount: 100 });

    expect(Number.isFinite(impact.newNet)).toBe(true);
    expect(impact.newNet).toBe(0);
  });
});
