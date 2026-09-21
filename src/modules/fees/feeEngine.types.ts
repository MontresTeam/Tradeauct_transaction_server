/**
 * The fee vocabulary.
 *
 * Moved here from TradeAuct_backend_server/src/modules/core/feeEngine. This
 * server is now the single authority on what anything costs: the buyer total,
 * the seller fee and the seller's net all come out of one calculation, so the
 * two sides of an order can be reconciled against each other.
 *
 * There is deliberately no "default 6%" anywhere in this file. A fee comes
 * from the selling method and the configured rule, or it is an error.
 */

/** The four selling methods the fee matrix is keyed by. */
export const FeeRuleType = {
  BUY_NOW: "BUY_NOW",
  MINIMUM_START_NO_RESERVE: "MINIMUM_START_NO_RESERVE",
  CUSTOM_START_NO_RESERVE: "CUSTOM_START_NO_RESERVE",
  RESERVE_AUCTION: "RESERVE_AUCTION",
} as const;

export type FeeRuleType = (typeof FeeRuleType)[keyof typeof FeeRuleType];

/** Admin-configured, versioned. Stored as SystemSetting PLATFORM_FEE_ENGINE_CONFIG. */
export interface PlatformFeeEngineConfig {
  buyNowSellerFeePercent: number;
  buyNowBuyerPremiumPercent: number;

  platformMinimumStartingBid: number;

  minStartNoReserveSellerFeePercent: number;
  minStartNoReserveBuyerPremiumPercent: number;

  customStartNoReserveSellerFeePercent: number;
  customStartNoReserveBuyerPremiumPercent: number;

  reserveAuctionSellerFeePercent: number;
  reserveAuctionBuyerPremiumPercent: number;

  trialCancellationCutoffHours: number;

  version: string;
  updatedAt?: string | Date;
}

export interface ListingFeeCalculationInput {
  /** "BUY_NOW" | "BUY_NOW_WITH_OFFER" | "AUCTION", any case. */
  saleType: string;
  startingBid?: number | null;
  reservePrice?: number | null;
  sellerId?: string | null;
  feeConfig?: PlatformFeeEngineConfig;
  ownerType?: "TRADEAUCT" | "EXTERNAL_SELLER" | string;
  buyerPremiumOverrideRate?: number | null;
  sellerFeeOverrideRate?: number | null;
  sellerCustomFeePercent?: number | null;
  sellerCustomBuyerPremiumPercent?: number | null;
}

export interface ListingFeeCalculationResult {
  feeRuleType: FeeRuleType;
  sellerFeePercent: number;
  buyerPremiumPercent: number;
  minimumStartingBid: number;
  configurationVersion: string;
  ownerType?: string;
  buyerPremiumOverrideRate?: number | null;
  sellerFeeOverrideRate?: number | null;
  overrideApplied?: boolean;
  isTradeAuctOwned?: boolean;
  displayData: {
    sellerFeeLabel: string;
    buyerPremiumLabel: string;
  };
}

/** What is written onto a Listing or Auction when it is created. */
export interface ListingFeeSnapshot {
  feeRuleType: FeeRuleType;
  sellerFeePercentSnapshot: number;
  buyerPremiumPercentSnapshot: number;
  minimumStartingBidSnapshot: number;
  feeConfigurationVersion: string;
  feeSnapshotCreatedAt: Date;
  ownerType?: string;
  buyerPremiumOverrideRate?: number | null;
}

/**
 * The full result the spec asks the Fee Engine to return (§6.3): both sides of
 * the trade, the rule that produced them and the version it came from.
 */
export interface OrderFeeCalculation {
  sellingMethod: FeeRuleType;
  salePrice: number;
  currency: string;
  sellerFeeRate: number;
  sellerFeeAmount: number;
  buyerFeeRate: number;
  buyerFeeAmount: number;
  feeRuleId: FeeRuleType;
  feeRuleVersion: string;
  calculatedAt: Date;
  isTradeAuctOwned: boolean;
}

export interface SellerPayoutCalculationInput {
  saleAmount: number;
  /**
   * Required. A payout cannot be computed from a guessed rate, so there is no
   * fallback: callers pass the snapshot the order was sold under.
   */
  snapshot: ListingFeeSnapshot;
  shippingPayer?: "BUYER" | "SELLER" | string;
  estimatedShipping?: number;
  actualShipping?: number;
  reserveFee?: number;
  otherDeductions?: number;
  adjustmentAmount?: number;
  refundAmount?: number;
  currency?: string;
  isEstimate?: boolean;
}

export interface SellerPayoutBreakdown {
  saleAmount: number;
  feeRuleType: FeeRuleType;
  sellerFeeRate: number;
  sellerFeeAmount: number;
  buyerPremiumRate: number;
  buyerPremiumAmount: number;
  reserveFee: number;
  shippingPayer: "BUYER" | "SELLER";
  appliedShippingCost: number;
  otherDeductions: number;
  adjustmentAmount: number;
  refundAmount: number;
  sellerNetPayout: number;
  currency: string;
  isEstimate: boolean;
  explanation: {
    ruleLabel: string;
    sellerFeeFormula: string;
    payoutFormula: string;
  };
}
