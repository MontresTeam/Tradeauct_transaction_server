/**
 * Buyer fee, shipping and VAT configuration.
 *
 * Moved from TradeAuct_backend_server (modules/user/bids/buyerFee.utils.ts)
 * unchanged, so prices do not move as part of the migration. The
 * transaction server is now the only caller that prices an order.
 */
import { prisma } from "../../core/prisma.js";

export type BuyerFeeType = "PERCENTAGE" | "FIXED" | "TIERED";

export interface BuyerFeeTier {
  min: number;
  max: number | null;
  rate: number;
  isPercentage: boolean; // true = percentage (e.g., 2%), false = fixed amount (e.g., AED 500)
}

export interface BuyerFeeConfig {
  feeType: BuyerFeeType;
  percentage: number; // e.g. 2 for 2%
  fixedAmount: number; // e.g. 500 for AED 500
  minFee?: number;
  maxFee?: number;
  tiers?: BuyerFeeTier[];
}

export interface ShippingConfig {
  domesticRate: number; // e.g. AED 25 for UAE
  gccRate: number; // e.g. AED 150 for GCC countries
  worldwideRate: number; // e.g. AED 250 for rest of world
}

export interface VatConfig {
  enabled: boolean;
  rate: number; // e.g. 0 or 5 for 5%
}

export interface LiveCalculationInput {
  bidAmount: number;
  shippingPayer?: "BUYER" | "SELLER" | string;
  shippingCoverage?: "UAE_ONLY" | "GCC" | "WORLDWIDE" | string;
  destinationCountry?: string;
  buyerFeeConfig?: Partial<BuyerFeeConfig>;
  shippingConfig?: Partial<ShippingConfig>;
  vatConfig?: Partial<VatConfig>;
}

export interface LiveCalculationBreakdown {
  bidAmount: number;
  buyerFee: number;
  buyerFeeName: string;
  buyerFeeType: BuyerFeeType;
  estimatedShipping: number;
  isFreeShipping: boolean;
  shippingLabel: string;
  vat: number;
  vatRate: number;
  vatApplicable: boolean;
  estimatedTotal: number;
  destinationCountry: string;
  disclaimer: string;
}

// Canonical Default Configurations
export const DEFAULT_BUYER_FEE_CONFIG: BuyerFeeConfig = {
  feeType: "PERCENTAGE",
  percentage: 2, // 2% of bid amount: e.g. AED 45,000 * 2% = AED 900
  fixedAmount: 500,
  minFee: 0,
  maxFee: 50000,
  tiers: [
    { min: 1, max: 50000, rate: 2, isPercentage: true },
    { min: 50001, max: 200000, rate: 1.5, isPercentage: true },
    { min: 200001, max: null, rate: 1, isPercentage: true },
  ],
};

export const DEFAULT_SHIPPING_CONFIG: ShippingConfig = {
  domesticRate: 25, // AED 25 for UAE
  gccRate: 150, // AED 150 for Saudi Arabia, Qatar, etc.
  worldwideRate: 250, // AED 250 for other international destinations
};

export const DEFAULT_VAT_CONFIG: VatConfig = {
  enabled: false,
  rate: 0, // Default 0% VAT unless configured
};

export const GCC_COUNTRY_IDENTIFIERS = new Set([
  "saudi arabia",
  "sa",
  "sau",
  "ksa",
  "qatar",
  "qa",
  "qat",
  "kuwait",
  "kw",
  "kwt",
  "bahrain",
  "bh",
  "bhr",
  "oman",
  "om",
  "omn",
]);

export const UAE_COUNTRY_IDENTIFIERS = new Set([
  "united arab emirates",
  "uae",
  "ae",
  "are",
  "dubai",
  "abu dhabi",
  "sharjah",
]);

/**
 * Calculates the TradeAuct Buyer Fee based on configured fee structure.
 */
export function calculateTradeAuctBuyerFee(
  bidAmount: number,
  config: BuyerFeeConfig = DEFAULT_BUYER_FEE_CONFIG,
): number {
  if (bidAmount <= 0) return 0;

  let fee = 0;

  switch (config.feeType) {
    case "FIXED":
      fee = config.fixedAmount || 0;
      break;

    case "TIERED":
      if (config.tiers && config.tiers.length > 0) {
        // Find matching tier
        const matchedTier = config.tiers.find((tier) => {
          if (tier.max === null || tier.max === undefined) {
            return bidAmount >= tier.min;
          }
          return bidAmount >= tier.min && bidAmount <= tier.max;
        });

        if (matchedTier) {
          fee = matchedTier.isPercentage ? (bidAmount * matchedTier.rate) / 100 : matchedTier.rate;
        } else {
          // Fallback to highest tier
          const highest = [...config.tiers].sort((a, b) => (b.max ?? Infinity) - (a.max ?? Infinity))[0];
          fee = highest?.isPercentage ? (bidAmount * highest.rate) / 100 : highest?.rate || (bidAmount * 2) / 100;
        }
      } else {
        fee = (bidAmount * (config.percentage || 2)) / 100;
      }
      break;

    case "PERCENTAGE":
    default:
      fee = (bidAmount * (config.percentage || 2)) / 100;
      break;
  }

  // Apply min / max boundaries if defined
  if (config.minFee !== undefined && config.minFee > 0 && fee < config.minFee) {
    fee = config.minFee;
  }
  if (config.maxFee !== undefined && config.maxFee > 0 && fee > config.maxFee) {
    fee = config.maxFee;
  }

  return Math.round(fee * 100) / 100;
}

/**
 * Calculates Estimated Shipping amount based on listing configuration and buyer destination.
 */
export function calculateEstimatedShipping(
  shippingPayer: string = "BUYER",
  destinationCountry: string = "United Arab Emirates",
  config: ShippingConfig = DEFAULT_SHIPPING_CONFIG,
): { amount: number; isFree: boolean; label: string } {
  const normalizedPayer = (shippingPayer || "BUYER").toUpperCase();

  // If seller pays shipping, shipping is completely FREE for the buyer
  if (normalizedPayer === "SELLER") {
    return {
      amount: 0,
      isFree: true,
      label: "FREE",
    };
  }

  const normalizedCountry = (destinationCountry || "United Arab Emirates").trim().toLowerCase();

  let amount = config.worldwideRate || 250;

  if (UAE_COUNTRY_IDENTIFIERS.has(normalizedCountry)) {
    amount = config.domesticRate !== undefined ? config.domesticRate : 25;
  } else if (GCC_COUNTRY_IDENTIFIERS.has(normalizedCountry)) {
    amount = config.gccRate !== undefined ? config.gccRate : 150;
  }

  return {
    amount: Math.round(amount * 100) / 100,
    isFree: false,
    label: `AED ${amount.toLocaleString()}`,
  };
}

/**
 * Calculates VAT when applicable.
 */
export function calculateVat(taxableBase: number, config: VatConfig = DEFAULT_VAT_CONFIG): number {
  if (!config.enabled || !config.rate || config.rate <= 0) {
    return 0;
  }

  const vat = (taxableBase * config.rate) / 100;
  return Math.round(vat * 100) / 100;
}

/**
 * Computes the complete Live Total Price Breakdown.
 */
export function calculateLiveTotalBreakdown(input: LiveCalculationInput): LiveCalculationBreakdown {
  const bidAmount = Number(input.bidAmount) || 0;
  const buyerFeeConfig: BuyerFeeConfig = {
    ...DEFAULT_BUYER_FEE_CONFIG,
    ...input.buyerFeeConfig,
  };
  const shippingConfig: ShippingConfig = {
    ...DEFAULT_SHIPPING_CONFIG,
    ...input.shippingConfig,
  };
  const vatConfig: VatConfig = {
    ...DEFAULT_VAT_CONFIG,
    ...input.vatConfig,
  };

  // 1. TradeAuct Buyer Fee
  const buyerFee = calculateTradeAuctBuyerFee(bidAmount, buyerFeeConfig);

  // 2. Estimated Shipping
  const shipping = calculateEstimatedShipping(input.shippingPayer, input.destinationCountry, shippingConfig);

  // 3. VAT (calculated if enabled, e.g., on applicable taxable components)
  const vat = calculateVat(bidAmount + buyerFee, vatConfig);

  // 4. Estimated Total = Bid Amount + TradeAuct Buyer Fee + Estimated Shipping + VAT
  const estimatedTotal = Math.round((bidAmount + buyerFee + shipping.amount + vat) * 100) / 100;

  return {
    bidAmount,
    buyerFee,
    buyerFeeName: "TradeAuct Buyer Fee",
    buyerFeeType: buyerFeeConfig.feeType,
    estimatedShipping: shipping.amount,
    isFreeShipping: shipping.isFree,
    shippingLabel: shipping.label,
    vat,
    vatRate: vatConfig.rate || 0,
    vatApplicable: vatConfig.enabled && vatConfig.rate > 0,
    estimatedTotal,
    destinationCountry: input.destinationCountry || "United Arab Emirates",
    disclaimer: "Import duties or local taxes may apply depending on your country's regulations.",
  };
}

/**
 * Loads fee configuration dynamically from database with fallback defaults.
 */
export async function getAuthoritativeFeeConfigs(): Promise<{
  buyerFeeConfig: BuyerFeeConfig;
  shippingConfig: ShippingConfig;
  vatConfig: VatConfig;
}> {
  try {
    const [allSettings, systemTiers] = await Promise.all([
      prisma.auctionSetting.findMany(),
      prisma.systemSetting.findUnique({ where: { key: "AUCTION_BUYER_FEE_TIERS" } }),
    ]);

    const settingMap: Record<string, string> = {};
    for (const s of allSettings) {
      settingMap[s.settingName] = s.settingValue;
    }

    const feeType = (settingMap["buyer_fee_type"] as BuyerFeeType) || "PERCENTAGE";
    const percentage = parseFloat(settingMap["buyer_fee_percentage"] ?? "2") || 2;
    const fixedAmount = parseFloat(settingMap["buyer_fee_fixed"] ?? "500") || 500;
    const minFee = parseFloat(settingMap["buyer_fee_min"] ?? "0") || 0;
    const maxFee = parseFloat(settingMap["buyer_fee_max"] ?? "50000") || 50000;
    const tiers = Array.isArray(systemTiers?.value)
      ? (systemTiers.value as unknown as BuyerFeeTier[])
      : DEFAULT_BUYER_FEE_CONFIG.tiers;

    const buyerFeeConfig: BuyerFeeConfig = {
      feeType,
      percentage,
      fixedAmount,
      minFee,
      maxFee,
      tiers,
    };

    const domesticRate = parseFloat(settingMap["shipping_rate_domestic"] ?? "25") || 25;
    const gccRate = parseFloat(settingMap["shipping_rate_gcc"] ?? "150") || 150;
    const worldwideRate = parseFloat(settingMap["shipping_rate_worldwide"] ?? "250") || 250;

    const shippingConfig: ShippingConfig = {
      domesticRate,
      gccRate,
      worldwideRate,
    };

    const vatEnabled = settingMap["vat_enabled"] === "true";
    const vatRate = parseFloat(settingMap["vat_rate"] ?? "0") || 0;

    const vatConfig: VatConfig = {
      enabled: vatEnabled,
      rate: vatRate,
    };

    return { buyerFeeConfig, shippingConfig, vatConfig };
  } catch (_err) {
    return {
      buyerFeeConfig: DEFAULT_BUYER_FEE_CONFIG,
      shippingConfig: DEFAULT_SHIPPING_CONFIG,
      vatConfig: DEFAULT_VAT_CONFIG,
    };
  }
}
