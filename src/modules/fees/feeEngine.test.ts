/**
 * The fee matrix, asserted exactly.
 *
 * These are the four numbers the client gave us, and the one formula they
 * explicitly ruled out. If a change makes any of these fail, the change is
 * wrong — not the test.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_FEE_ENGINE_CONFIG, FeeEngineService } from "./feeEngine.service.js";
import type { ListingFeeSnapshot, PlatformFeeEngineConfig } from "./feeEngine.types.js";

const config: PlatformFeeEngineConfig = DEFAULT_FEE_ENGINE_CONFIG;

function snapshotFor(input: {
  saleType: string;
  startingBid?: number | null;
  reservePrice?: number | null;
  ownerType?: string;
}): ListingFeeSnapshot {
  return FeeEngineService.createListingFeeSnapshot({ ...input, feeConfig: config }, config);
}

describe("Fee Engine — the selling-method matrix", () => {
  it("Buy Now charges the seller 6% and the buyer nothing", () => {
    const rule = FeeEngineService.calculateListingFees({ saleType: "BUY_NOW", startingBid: 5000, feeConfig: config });

    expect(rule.feeRuleType).toBe("BUY_NOW");
    expect(rule.sellerFeePercent).toBe(6);
    expect(rule.buyerPremiumPercent).toBe(0);
  });

  it("a minimum start with no reserve charges the seller nothing and the buyer 6%", () => {
    const rule = FeeEngineService.calculateListingFees({
      saleType: "AUCTION",
      startingBid: 1,
      reservePrice: null,
      feeConfig: config,
    });

    expect(rule.feeRuleType).toBe("MINIMUM_START_NO_RESERVE");
    expect(rule.sellerFeePercent).toBe(0);
    expect(rule.buyerPremiumPercent).toBe(6);
  });

  it("a custom start with no reserve splits 2% seller / 4% buyer", () => {
    const rule = FeeEngineService.calculateListingFees({
      saleType: "AUCTION",
      startingBid: 25000,
      reservePrice: null,
      feeConfig: config,
    });

    expect(rule.feeRuleType).toBe("CUSTOM_START_NO_RESERVE");
    expect(rule.sellerFeePercent).toBe(2);
    expect(rule.buyerPremiumPercent).toBe(4);
  });

  it("a reserve auction splits 3% / 3%", () => {
    const rule = FeeEngineService.calculateListingFees({
      saleType: "AUCTION",
      startingBid: 25000,
      reservePrice: 40000,
      feeConfig: config,
    });

    expect(rule.feeRuleType).toBe("RESERVE_AUCTION");
    expect(rule.sellerFeePercent).toBe(3);
    expect(rule.buyerPremiumPercent).toBe(3);
  });

  it("a reserve price wins over the starting bid, whatever the starting bid is", () => {
    const rule = FeeEngineService.calculateListingFees({
      saleType: "AUCTION",
      startingBid: 1,
      reservePrice: 40000,
      feeConfig: config,
    });

    expect(rule.feeRuleType).toBe("RESERVE_AUCTION");
  });

  it("TradeAuct's own stock pays itself no seller commission", () => {
    const rule = FeeEngineService.calculateListingFees({
      saleType: "BUY_NOW",
      startingBid: 5000,
      ownerType: "TRADEAUCT",
      feeConfig: config,
    });

    expect(rule.sellerFeePercent).toBe(0);
    expect(rule.isTradeAuctOwned).toBe(true);
  });
});

describe("Fee Engine — order fees", () => {
  it("never charges a percentage of the customer total", () => {
    // AED 10,000 hammer under Custom Start: seller 2%, buyer 4%. The customer
    // total is higher than the hammer price because it carries the buyer fee,
    // shipping and VAT — and none of that may reach the seller's fee.
    const snapshot = snapshotFor({ saleType: "AUCTION", startingBid: 25000, reservePrice: null });
    const fees = FeeEngineService.calculateOrderFees({ snapshot, salePrice: 10000, currency: "AED" });

    expect(fees.sellingMethod).toBe("CUSTOM_START_NO_RESERVE");
    expect(fees.sellerFeeAmount).toBe(200);
    expect(fees.buyerFeeAmount).toBe(400);

    // The banned formula would have produced 6% of ~11,090 = 665.40.
    expect(fees.sellerFeeAmount).not.toBeCloseTo(665.4, 1);
  });

  it("gives the seller sale price minus the seller fee, and never deducts the buyer premium", () => {
    const snapshot = snapshotFor({ saleType: "AUCTION", startingBid: 25000, reservePrice: null });
    const payout = FeeEngineService.calculateSellerPayoutBreakdown({
      saleAmount: 10000,
      snapshot,
      shippingPayer: "BUYER",
      currency: "AED",
    });

    expect(payout.sellerFeeAmount).toBe(200);
    expect(payout.buyerPremiumAmount).toBe(400);
    expect(payout.sellerNetPayout).toBe(9800);
  });

  it("deducts shipping from the seller only when the seller is the payer", () => {
    const snapshot = snapshotFor({ saleType: "BUY_NOW", startingBid: 10000 });

    const buyerPays = FeeEngineService.calculateSellerPayoutBreakdown({
      saleAmount: 10000,
      snapshot,
      shippingPayer: "BUYER",
      estimatedShipping: 250,
    });
    const sellerPays = FeeEngineService.calculateSellerPayoutBreakdown({
      saleAmount: 10000,
      snapshot,
      shippingPayer: "SELLER",
      estimatedShipping: 250,
    });

    expect(buyerPays.sellerNetPayout).toBe(9400);
    expect(sellerPays.sellerNetPayout).toBe(9150);
  });

  it("prefers the actual shipping cost over the estimate once it is known", () => {
    const snapshot = snapshotFor({ saleType: "BUY_NOW", startingBid: 10000 });
    const payout = FeeEngineService.calculateSellerPayoutBreakdown({
      saleAmount: 10000,
      snapshot,
      shippingPayer: "SELLER",
      estimatedShipping: 250,
      actualShipping: 310,
    });

    expect(payout.appliedShippingCost).toBe(310);
    expect(payout.sellerNetPayout).toBe(9090);
  });

  it("never returns a negative payout", () => {
    const snapshot = snapshotFor({ saleType: "BUY_NOW", startingBid: 1000 });
    const payout = FeeEngineService.calculateSellerPayoutBreakdown({
      saleAmount: 1000,
      snapshot,
      shippingPayer: "SELLER",
      actualShipping: 5000,
    });

    expect(payout.sellerNetPayout).toBe(0);
  });
});

describe("Fee Engine — snapshot immutability", () => {
  it("keeps an order on the rule it sold under when the matrix changes", () => {
    const soldUnder = snapshotFor({ saleType: "AUCTION", startingBid: 25000, reservePrice: null });
    expect(soldUnder.sellerFeePercentSnapshot).toBe(2);

    // Super Admin raises the custom-start seller fee from 2% to 3%.
    const newConfig: PlatformFeeEngineConfig = {
      ...config,
      customStartNoReserveSellerFeePercent: 3,
      version: "1.0.1",
    };

    const newListing = FeeEngineService.createListingFeeSnapshot(
      { saleType: "AUCTION", startingBid: 25000, reservePrice: null, feeConfig: newConfig },
      newConfig,
    );

    // The new listing gets the new rate...
    expect(newListing.sellerFeePercentSnapshot).toBe(3);
    expect(newListing.feeConfigurationVersion).toBe("1.0.1");

    // ...while the order already sold is still calculated at 2%.
    const existingOrder = FeeEngineService.calculateOrderFees({ snapshot: soldUnder, salePrice: 10000 });
    expect(existingOrder.sellerFeeAmount).toBe(200);
    expect(existingOrder.feeRuleVersion).toBe("1.0.0");
  });

  it("reads the snapshot stored on a listing rather than recomputing it", () => {
    const resolved = FeeEngineService.resolveListingFeeSnapshot({
      feeRuleType: "RESERVE_AUCTION",
      sellerFeePercentSnapshot: 3,
      buyerPremiumPercentSnapshot: 3,
      minimumStartingBidSnapshot: 1,
      feeConfigurationVersion: "0.9.0",
      feeSnapshotCreatedAt: new Date("2026-01-01"),
      // Deliberately inconsistent with the snapshot: a Buy Now shape that
      // would resolve to 6/0 if it were recomputed.
      saleType: "BUY_NOW",
      price: 5000,
    });

    expect(resolved.sellerFeePercentSnapshot).toBe(3);
    expect(resolved.feeConfigurationVersion).toBe("0.9.0");
  });

  it("falls back to the listing's own shape when it predates the Fee Engine", () => {
    const resolved = FeeEngineService.resolveListingFeeSnapshot(
      { saleType: "AUCTION", startingPrice: 1, reservePrice: null },
      config,
    );

    expect(resolved.feeRuleType).toBe("MINIMUM_START_NO_RESERVE");
    expect(resolved.sellerFeePercentSnapshot).toBe(0);
    expect(resolved.buyerPremiumPercentSnapshot).toBe(6);
  });

  it("inherits the auction's snapshot through its listing", () => {
    const resolved = FeeEngineService.resolveListingFeeSnapshot({
      saleType: "AUCTION",
      listing: {
        feeRuleType: "CUSTOM_START_NO_RESERVE",
        sellerFeePercentSnapshot: 2,
        buyerPremiumPercentSnapshot: 4,
        feeConfigurationVersion: "1.0.0",
      },
    });

    expect(resolved.feeRuleType).toBe("CUSTOM_START_NO_RESERVE");
    expect(resolved.sellerFeePercentSnapshot).toBe(2);
  });
});
