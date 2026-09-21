/**
 * The Fee Engine — the only thing on the platform that decides what a sale costs.
 *
 * Fees are a function of the selling method and the hammer/sale price, and of
 * nothing else. Shipping, VAT and any other charge are separate lines that are
 * added elsewhere; Stripe's own processing fees never enter here at all.
 *
 * Two rules the client stated explicitly, and which this file exists to hold:
 *
 *   - the seller fee is never "6% of the customer total". There is no such
 *     formula. `platformFee.utils.ts`, which implemented it, is deleted.
 *   - a fee never moves under an order that has already been quoted. Every
 *     listing carries a snapshot of the rule it was created under, and the
 *     order carries a copy of that snapshot, so an admin changing the matrix
 *     tomorrow changes tomorrow's orders only.
 */
import { AppError } from "../../core/errors/AppError.js";
import { logger } from "../../core/logger.js";
import { prisma } from "../../core/prisma.js";
import {
  FeeRuleType,
  type ListingFeeCalculationInput,
  type ListingFeeCalculationResult,
  type ListingFeeSnapshot,
  type OrderFeeCalculation,
  type PlatformFeeEngineConfig,
  type SellerPayoutBreakdown,
  type SellerPayoutCalculationInput,
} from "./feeEngine.types.js";

export const FEE_ENGINE_SETTING_KEY = "PLATFORM_FEE_ENGINE_CONFIG";

/**
 * The matrix the client signed off on. These are starting values for a fresh
 * database, not constants: everything reads the stored configuration first.
 */
export const DEFAULT_FEE_ENGINE_CONFIG: PlatformFeeEngineConfig = {
  buyNowSellerFeePercent: 6,
  buyNowBuyerPremiumPercent: 0,
  platformMinimumStartingBid: 1,
  minStartNoReserveSellerFeePercent: 0,
  minStartNoReserveBuyerPremiumPercent: 6,
  customStartNoReserveSellerFeePercent: 2,
  customStartNoReserveBuyerPremiumPercent: 4,
  reserveAuctionSellerFeePercent: 3,
  reserveAuctionBuyerPremiumPercent: 3,
  trialCancellationCutoffHours: 24,
  version: "1.0.0",
};

/** Mirror keys in AuctionSetting, which several admin screens still read. */
export const FEE_SETTING_KEYS = {
  BUY_NOW_SELLER_FEE: "buy_now_seller_fee_percent",
  BUY_NOW_BUYER_PREMIUM: "buy_now_buyer_premium_percent",
  PLATFORM_MINIMUM_STARTING_BID: "platform_minimum_starting_bid",
  MIN_START_NO_RESERVE_SELLER_FEE: "min_start_no_reserve_seller_fee_percent",
  MIN_START_NO_RESERVE_BUYER_PREMIUM: "min_start_no_reserve_buyer_premium_percent",
  CUSTOM_START_NO_RESERVE_SELLER_FEE: "custom_start_no_reserve_seller_fee_percent",
  CUSTOM_START_NO_RESERVE_BUYER_PREMIUM: "custom_start_no_reserve_buyer_premium_percent",
  RESERVE_AUCTION_SELLER_FEE: "reserve_auction_seller_fee_percent",
  RESERVE_AUCTION_BUYER_PREMIUM: "reserve_auction_buyer_premium_percent",
  TRIAL_CANCELLATION_CUTOFF_HOURS: "trial_cancellation_cutoff_hours",
  FEE_ENGINE_VERSION: "fee_engine_version",
} as const;

/** Currency arithmetic is done to the fils. Rates are percentages, not fractions. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function percentOf(amount: number, rate: number): number {
  if (amount <= 0 || rate <= 0) return 0;
  return round2((amount * rate) / 100);
}

function numberOr(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export class FeeEngineService {
  /** Read the configuration. SystemSetting wins; AuctionSetting is the mirror. */
  static async getAuthoritativeFeeConfig(): Promise<PlatformFeeEngineConfig> {
    try {
      const [systemSetting, auctionSettings] = await Promise.all([
        prisma.systemSetting.findUnique({ where: { key: FEE_ENGINE_SETTING_KEY } }),
        prisma.auctionSetting.findMany(),
      ]);

      if (systemSetting?.value && typeof systemSetting.value === "object") {
        const stored = systemSetting.value as Record<string, unknown>;
        return {
          buyNowSellerFeePercent: numberOr(
            stored.buyNowSellerFeePercent,
            DEFAULT_FEE_ENGINE_CONFIG.buyNowSellerFeePercent,
          ),
          buyNowBuyerPremiumPercent: numberOr(
            stored.buyNowBuyerPremiumPercent,
            DEFAULT_FEE_ENGINE_CONFIG.buyNowBuyerPremiumPercent,
          ),
          platformMinimumStartingBid: numberOr(
            stored.platformMinimumStartingBid,
            DEFAULT_FEE_ENGINE_CONFIG.platformMinimumStartingBid,
          ),
          minStartNoReserveSellerFeePercent: numberOr(
            stored.minStartNoReserveSellerFeePercent,
            DEFAULT_FEE_ENGINE_CONFIG.minStartNoReserveSellerFeePercent,
          ),
          minStartNoReserveBuyerPremiumPercent: numberOr(
            stored.minStartNoReserveBuyerPremiumPercent,
            DEFAULT_FEE_ENGINE_CONFIG.minStartNoReserveBuyerPremiumPercent,
          ),
          customStartNoReserveSellerFeePercent: numberOr(
            stored.customStartNoReserveSellerFeePercent,
            DEFAULT_FEE_ENGINE_CONFIG.customStartNoReserveSellerFeePercent,
          ),
          customStartNoReserveBuyerPremiumPercent: numberOr(
            stored.customStartNoReserveBuyerPremiumPercent,
            DEFAULT_FEE_ENGINE_CONFIG.customStartNoReserveBuyerPremiumPercent,
          ),
          reserveAuctionSellerFeePercent: numberOr(
            stored.reserveAuctionSellerFeePercent,
            DEFAULT_FEE_ENGINE_CONFIG.reserveAuctionSellerFeePercent,
          ),
          reserveAuctionBuyerPremiumPercent: numberOr(
            stored.reserveAuctionBuyerPremiumPercent,
            DEFAULT_FEE_ENGINE_CONFIG.reserveAuctionBuyerPremiumPercent,
          ),
          trialCancellationCutoffHours: numberOr(
            stored.trialCancellationCutoffHours,
            DEFAULT_FEE_ENGINE_CONFIG.trialCancellationCutoffHours,
          ),
          version: typeof stored.version === "string" ? stored.version : DEFAULT_FEE_ENGINE_CONFIG.version,
          updatedAt: stored.updatedAt as string | undefined,
        };
      }

      const map: Record<string, string> = {};
      for (const setting of auctionSettings) {
        map[setting.settingName] = setting.settingValue;
      }

      return {
        buyNowSellerFeePercent: numberOr(
          map[FEE_SETTING_KEYS.BUY_NOW_SELLER_FEE],
          DEFAULT_FEE_ENGINE_CONFIG.buyNowSellerFeePercent,
        ),
        buyNowBuyerPremiumPercent: numberOr(
          map[FEE_SETTING_KEYS.BUY_NOW_BUYER_PREMIUM],
          DEFAULT_FEE_ENGINE_CONFIG.buyNowBuyerPremiumPercent,
        ),
        platformMinimumStartingBid: numberOr(
          map[FEE_SETTING_KEYS.PLATFORM_MINIMUM_STARTING_BID],
          DEFAULT_FEE_ENGINE_CONFIG.platformMinimumStartingBid,
        ),
        minStartNoReserveSellerFeePercent: numberOr(
          map[FEE_SETTING_KEYS.MIN_START_NO_RESERVE_SELLER_FEE],
          DEFAULT_FEE_ENGINE_CONFIG.minStartNoReserveSellerFeePercent,
        ),
        minStartNoReserveBuyerPremiumPercent: numberOr(
          map[FEE_SETTING_KEYS.MIN_START_NO_RESERVE_BUYER_PREMIUM],
          DEFAULT_FEE_ENGINE_CONFIG.minStartNoReserveBuyerPremiumPercent,
        ),
        customStartNoReserveSellerFeePercent: numberOr(
          map[FEE_SETTING_KEYS.CUSTOM_START_NO_RESERVE_SELLER_FEE],
          DEFAULT_FEE_ENGINE_CONFIG.customStartNoReserveSellerFeePercent,
        ),
        customStartNoReserveBuyerPremiumPercent: numberOr(
          map[FEE_SETTING_KEYS.CUSTOM_START_NO_RESERVE_BUYER_PREMIUM],
          DEFAULT_FEE_ENGINE_CONFIG.customStartNoReserveBuyerPremiumPercent,
        ),
        reserveAuctionSellerFeePercent: numberOr(
          map[FEE_SETTING_KEYS.RESERVE_AUCTION_SELLER_FEE],
          DEFAULT_FEE_ENGINE_CONFIG.reserveAuctionSellerFeePercent,
        ),
        reserveAuctionBuyerPremiumPercent: numberOr(
          map[FEE_SETTING_KEYS.RESERVE_AUCTION_BUYER_PREMIUM],
          DEFAULT_FEE_ENGINE_CONFIG.reserveAuctionBuyerPremiumPercent,
        ),
        trialCancellationCutoffHours: numberOr(
          map[FEE_SETTING_KEYS.TRIAL_CANCELLATION_CUTOFF_HOURS],
          DEFAULT_FEE_ENGINE_CONFIG.trialCancellationCutoffHours,
        ),
        version: map[FEE_SETTING_KEYS.FEE_ENGINE_VERSION] || DEFAULT_FEE_ENGINE_CONFIG.version,
      };
    } catch (error) {
      logger.error("Fee configuration read failed; using the canonical defaults", { error });
      return DEFAULT_FEE_ENGINE_CONFIG;
    }
  }

  /**
   * Write a new configuration, bumping the patch version.
   *
   * The version is what makes historical orders safe: every snapshot records
   * the version it was taken under, so a change here is visibly a new rule
   * rather than a silent rewrite of an old one.
   */
  static async updateAuthoritativeFeeConfig(
    updates: Partial<PlatformFeeEngineConfig>,
    adminUserId?: string,
  ): Promise<PlatformFeeEngineConfig> {
    const current = await FeeEngineService.getAuthoritativeFeeConfig();

    const parts = (current.version || "1.0.0").split(".").map((part) => Number.parseInt(part, 10) || 0);
    if (parts.length === 3) parts[2] += 1;
    const nextVersion = updates.version || parts.join(".");

    const merged: PlatformFeeEngineConfig = {
      ...current,
      ...updates,
      version: nextVersion,
      updatedAt: new Date().toISOString(),
    };

    await prisma.$transaction(async (tx) => {
      await tx.systemSetting.upsert({
        where: { key: FEE_ENGINE_SETTING_KEY },
        update: { value: merged as never },
        create: { key: FEE_ENGINE_SETTING_KEY, value: merged as never },
      });

      const mirror: Record<string, number | string> = {
        [FEE_SETTING_KEYS.BUY_NOW_SELLER_FEE]: merged.buyNowSellerFeePercent,
        [FEE_SETTING_KEYS.BUY_NOW_BUYER_PREMIUM]: merged.buyNowBuyerPremiumPercent,
        [FEE_SETTING_KEYS.PLATFORM_MINIMUM_STARTING_BID]: merged.platformMinimumStartingBid,
        [FEE_SETTING_KEYS.MIN_START_NO_RESERVE_SELLER_FEE]: merged.minStartNoReserveSellerFeePercent,
        [FEE_SETTING_KEYS.MIN_START_NO_RESERVE_BUYER_PREMIUM]: merged.minStartNoReserveBuyerPremiumPercent,
        [FEE_SETTING_KEYS.CUSTOM_START_NO_RESERVE_SELLER_FEE]: merged.customStartNoReserveSellerFeePercent,
        [FEE_SETTING_KEYS.CUSTOM_START_NO_RESERVE_BUYER_PREMIUM]: merged.customStartNoReserveBuyerPremiumPercent,
        [FEE_SETTING_KEYS.RESERVE_AUCTION_SELLER_FEE]: merged.reserveAuctionSellerFeePercent,
        [FEE_SETTING_KEYS.RESERVE_AUCTION_BUYER_PREMIUM]: merged.reserveAuctionBuyerPremiumPercent,
        [FEE_SETTING_KEYS.TRIAL_CANCELLATION_CUTOFF_HOURS]: merged.trialCancellationCutoffHours,
        [FEE_SETTING_KEYS.FEE_ENGINE_VERSION]: merged.version,
      };

      for (const [key, value] of Object.entries(mirror)) {
        await tx.auctionSetting.upsert({
          where: { settingName: key },
          update: { settingValue: String(value) },
          create: { settingName: key, settingValue: String(value) },
        });
      }

      await tx.financialAuditLog.create({
        data: {
          action: "FEE_ENGINE_CONFIG_UPDATED",
          entityType: "SYSTEM_SETTING",
          entityId: FEE_ENGINE_SETTING_KEY,
          previousState: current as never,
          newState: merged as never,
          reason: "Fee engine configuration updated",
          performedById: adminUserId ?? "ADMIN",
          performedByRole: "ADMIN",
        },
      });
    });

    logger.info("Fee configuration updated", { version: merged.version, adminUserId });
    return merged;
  }

  /**
   * Which rule applies.
   *
   * The order of these branches is the business rule, not an implementation
   * detail: a reserve price wins over the starting bid, and a Buy Now wins
   * over both.
   */
  static calculateListingFees(input: ListingFeeCalculationInput): ListingFeeCalculationResult {
    const config = input.feeConfig ?? DEFAULT_FEE_ENGINE_CONFIG;
    const saleType = (input.saleType || "BUY_NOW").toUpperCase().trim();
    const isTradeAuctOwned = (input.ownerType || "").toUpperCase() === "TRADEAUCT";

    const minimumStartingBid = config.platformMinimumStartingBid || 1;
    const startingBid = input.startingBid != null ? Number(input.startingBid) : 0;
    const reservePrice =
      input.reservePrice != null && Number(input.reservePrice) > 0 ? Number(input.reservePrice) : null;

    let feeRuleType: FeeRuleType;
    let sellerFeePercent: number;
    let buyerPremiumPercent: number;

    if (saleType === "BUY_NOW" || saleType === "BUY_NOW_WITH_OFFER") {
      feeRuleType = FeeRuleType.BUY_NOW;
      sellerFeePercent = config.buyNowSellerFeePercent;
      buyerPremiumPercent = config.buyNowBuyerPremiumPercent;
    } else if (reservePrice !== null) {
      feeRuleType = FeeRuleType.RESERVE_AUCTION;
      sellerFeePercent = config.reserveAuctionSellerFeePercent;
      buyerPremiumPercent = config.reserveAuctionBuyerPremiumPercent;
    } else if (startingBid <= minimumStartingBid) {
      feeRuleType = FeeRuleType.MINIMUM_START_NO_RESERVE;
      sellerFeePercent = config.minStartNoReserveSellerFeePercent;
      buyerPremiumPercent = config.minStartNoReserveBuyerPremiumPercent;
    } else {
      feeRuleType = FeeRuleType.CUSTOM_START_NO_RESERVE;
      sellerFeePercent = config.customStartNoReserveSellerFeePercent;
      buyerPremiumPercent = config.customStartNoReserveBuyerPremiumPercent;
    }

    // TradeAuct's own stock pays itself no commission.
    if (isTradeAuctOwned) sellerFeePercent = 0;

    const hasOverride =
      input.sellerFeeOverrideRate != null ||
      input.buyerPremiumOverrideRate != null ||
      input.sellerCustomFeePercent != null ||
      input.sellerCustomBuyerPremiumPercent != null;

    if (input.sellerFeeOverrideRate != null) {
      sellerFeePercent = Number(input.sellerFeeOverrideRate);
    } else if (input.sellerCustomFeePercent != null && !isTradeAuctOwned) {
      sellerFeePercent = Number(input.sellerCustomFeePercent);
    }

    if (input.buyerPremiumOverrideRate != null) {
      buyerPremiumPercent = Number(input.buyerPremiumOverrideRate);
    } else if (input.sellerCustomBuyerPremiumPercent != null) {
      buyerPremiumPercent = Number(input.sellerCustomBuyerPremiumPercent);
    }

    return {
      feeRuleType,
      sellerFeePercent,
      buyerPremiumPercent,
      minimumStartingBid,
      configurationVersion: config.version,
      ownerType: input.ownerType,
      buyerPremiumOverrideRate: input.buyerPremiumOverrideRate,
      sellerFeeOverrideRate: input.sellerFeeOverrideRate,
      overrideApplied: hasOverride,
      isTradeAuctOwned,
      displayData: {
        sellerFeeLabel: `${sellerFeePercent}%`,
        buyerPremiumLabel: `${buyerPremiumPercent}%`,
      },
    };
  }

  /** Resolve the live configuration and apply it in one call. */
  static async resolveFeeRule(input: ListingFeeCalculationInput): Promise<ListingFeeCalculationResult> {
    const feeConfig = await FeeEngineService.getAuthoritativeFeeConfig();
    return FeeEngineService.calculateListingFees({ ...input, feeConfig });
  }

  /** The immutable snapshot written onto a Listing or Auction at creation. */
  static createListingFeeSnapshot(
    input: ListingFeeCalculationInput,
    config?: PlatformFeeEngineConfig,
  ): ListingFeeSnapshot {
    const feeConfig = config ?? input.feeConfig ?? DEFAULT_FEE_ENGINE_CONFIG;
    const calculated = FeeEngineService.calculateListingFees({ ...input, feeConfig });

    return {
      feeRuleType: calculated.feeRuleType,
      sellerFeePercentSnapshot: calculated.sellerFeePercent,
      buyerPremiumPercentSnapshot: calculated.buyerPremiumPercent,
      minimumStartingBidSnapshot: calculated.minimumStartingBid,
      feeConfigurationVersion: calculated.configurationVersion,
      feeSnapshotCreatedAt: new Date(),
      ownerType: calculated.ownerType,
      buyerPremiumOverrideRate: calculated.buyerPremiumOverrideRate,
    };
  }

  /**
   * Read the snapshot a listing or auction was created under.
   *
   * A listing written before the Fee Engine existed has no snapshot. Rather
   * than invent one, the rule is recomputed from the listing's own shape —
   * sale type, starting bid, reserve — which is the same input the snapshot
   * would have been taken from.
   */
  static resolveListingFeeSnapshot(
    record:
      | {
          feeRuleType?: string | null;
          sellerFeePercentSnapshot?: number | null;
          buyerPremiumPercentSnapshot?: number | null;
          minimumStartingBidSnapshot?: number | null;
          feeConfigurationVersion?: string | null;
          feeSnapshotCreatedAt?: Date | null;
          saleType?: string | null;
          price?: number | null;
          startingPrice?: number | null;
          reservePrice?: number | null;
          ownerType?: string | null;
          buyerPremiumOverrideRate?: unknown;
          auction?: unknown;
          listing?: unknown;
        }
      | null
      | undefined,
    fallbackConfig: PlatformFeeEngineConfig = DEFAULT_FEE_ENGINE_CONFIG,
  ): ListingFeeSnapshot {
    if (!record) {
      throw new AppError(500, "Cannot resolve a fee snapshot without a listing", "FEE_SNAPSHOT_UNRESOLVABLE");
    }

    const direct = FeeEngineService.snapshotFrom(record, fallbackConfig);
    if (direct) return direct;

    // An auction carries its own copy; so does the listing above it.
    const nested = (record.auction ?? record.listing) as Parameters<typeof FeeEngineService.snapshotFrom>[0];
    const inherited = nested ? FeeEngineService.snapshotFrom(nested, fallbackConfig) : null;
    if (inherited) return inherited;

    const nestedRecord = (nested ?? {}) as Record<string, unknown>;
    const saleType = record.saleType ?? (nestedRecord.saleType as string | undefined) ?? "AUCTION";
    const startingBid =
      record.startingPrice ?? (nestedRecord.startingPrice as number | undefined) ?? record.price ?? null;
    const reservePrice = record.reservePrice ?? (nestedRecord.reservePrice as number | undefined) ?? null;
    const ownerType = record.ownerType ?? (nestedRecord.ownerType as string | undefined);
    const overrideRate = record.buyerPremiumOverrideRate ?? nestedRecord.buyerPremiumOverrideRate;

    return FeeEngineService.createListingFeeSnapshot(
      {
        saleType,
        startingBid,
        reservePrice,
        ownerType,
        buyerPremiumOverrideRate: overrideRate != null ? Number(overrideRate) : undefined,
        feeConfig: fallbackConfig,
      },
      fallbackConfig,
    );
  }

  private static snapshotFrom(
    record: Record<string, unknown> | null | undefined,
    fallbackConfig: PlatformFeeEngineConfig,
  ): ListingFeeSnapshot | null {
    if (!record) return null;

    const ruleType = record.feeRuleType as string | null | undefined;
    const sellerPercent = record.sellerFeePercentSnapshot as number | null | undefined;
    const buyerPercent = record.buyerPremiumPercentSnapshot as number | null | undefined;

    if (!ruleType || sellerPercent == null || buyerPercent == null) return null;

    return {
      feeRuleType: ruleType as FeeRuleType,
      sellerFeePercentSnapshot: sellerPercent,
      buyerPremiumPercentSnapshot: buyerPercent,
      minimumStartingBidSnapshot:
        (record.minimumStartingBidSnapshot as number | null) ?? fallbackConfig.platformMinimumStartingBid,
      feeConfigurationVersion: (record.feeConfigurationVersion as string | null) ?? fallbackConfig.version,
      feeSnapshotCreatedAt: (record.feeSnapshotCreatedAt as Date | null) ?? new Date(),
      ownerType: (record.ownerType as string | null) ?? undefined,
      buyerPremiumOverrideRate:
        record.buyerPremiumOverrideRate != null ? Number(record.buyerPremiumOverrideRate) : undefined,
    };
  }

  /**
   * The spec's §6.3 result: both fees for one sale, from one snapshot.
   *
   * This is what the checkout quote and the seller settlement both call, which
   * is the point — a buyer charged under one rule and a seller settled under
   * another is the defect this replaces.
   */
  static calculateOrderFees(input: {
    snapshot: ListingFeeSnapshot;
    salePrice: number;
    currency?: string;
  }): OrderFeeCalculation {
    const salePrice = Math.max(0, Number(input.salePrice) || 0);
    const sellerFeeRate = input.snapshot.sellerFeePercentSnapshot;
    const buyerFeeRate = input.snapshot.buyerPremiumPercentSnapshot;

    return {
      sellingMethod: input.snapshot.feeRuleType,
      salePrice,
      currency: input.currency ?? "AED",
      sellerFeeRate,
      sellerFeeAmount: percentOf(salePrice, sellerFeeRate),
      buyerFeeRate,
      buyerFeeAmount: percentOf(salePrice, buyerFeeRate),
      feeRuleId: input.snapshot.feeRuleType,
      feeRuleVersion: input.snapshot.feeConfigurationVersion,
      calculatedAt: new Date(),
      isTradeAuctOwned: (input.snapshot.ownerType || "").toUpperCase() === "TRADEAUCT",
    };
  }

  /**
   * What the seller actually receives.
   *
   * Sale price, minus the seller fee, minus the deductions that are genuinely
   * theirs. The buyer premium is never subtracted here: the buyer paid it on
   * top, and taking it off the seller as well would charge it twice.
   */
  static calculateSellerPayoutBreakdown(input: SellerPayoutCalculationInput): SellerPayoutBreakdown {
    const saleAmount = Math.max(0, Number(input.saleAmount) || 0);
    const currency = input.currency ?? "AED";
    const shippingPayer = String(input.shippingPayer ?? "BUYER").toUpperCase() === "SELLER" ? "SELLER" : "BUYER";
    const reserveFee = Math.max(0, Number(input.reserveFee) || 0);
    const otherDeductions = Math.max(0, Number(input.otherDeductions) || 0);
    const adjustmentAmount = Number(input.adjustmentAmount) || 0;
    const refundAmount = Math.max(0, Number(input.refundAmount) || 0);

    const sellerFeeRate = input.snapshot.sellerFeePercentSnapshot;
    const buyerPremiumRate = input.snapshot.buyerPremiumPercentSnapshot;

    const sellerFeeAmount = percentOf(saleAmount, sellerFeeRate);
    const buyerPremiumAmount = percentOf(saleAmount, buyerPremiumRate);

    // The actual shipping cost replaces the estimate as soon as it is known.
    const shippingCost = input.actualShipping != null ? input.actualShipping : (input.estimatedShipping ?? 0);
    const appliedShippingCost = shippingPayer === "SELLER" ? Math.max(0, Number(shippingCost) || 0) : 0;

    const net =
      saleAmount -
      sellerFeeAmount -
      appliedShippingCost -
      reserveFee -
      otherDeductions +
      adjustmentAmount -
      refundAmount;
    const sellerNetPayout = Math.max(0, round2(net));

    return {
      saleAmount,
      feeRuleType: input.snapshot.feeRuleType,
      sellerFeeRate,
      sellerFeeAmount,
      buyerPremiumRate,
      buyerPremiumAmount,
      reserveFee,
      shippingPayer,
      appliedShippingCost,
      otherDeductions,
      adjustmentAmount,
      refundAmount,
      sellerNetPayout,
      currency,
      isEstimate: Boolean(input.isEstimate),
      explanation: {
        ruleLabel: FEE_RULE_LABELS[input.snapshot.feeRuleType] ?? String(input.snapshot.feeRuleType),
        sellerFeeFormula: `${currency} ${saleAmount} × ${sellerFeeRate}% = ${currency} ${sellerFeeAmount}`,
        payoutFormula:
          appliedShippingCost > 0
            ? `${currency} ${saleAmount} − ${sellerFeeAmount} (seller fee) − ${appliedShippingCost} (shipping) = ${currency} ${sellerNetPayout}`
            : `${currency} ${saleAmount} − ${sellerFeeAmount} (seller fee) = ${currency} ${sellerNetPayout}`,
      },
    };
  }
}

const FEE_RULE_LABELS: Record<string, string> = {
  BUY_NOW: "Buy Now",
  MINIMUM_START_NO_RESERVE: "Minimum start, no reserve",
  CUSTOM_START_NO_RESERVE: "Custom start, no reserve",
  RESERVE_AUCTION: "Reserve auction",
};
