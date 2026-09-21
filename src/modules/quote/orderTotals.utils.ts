/**
 * The non-fee parts of an order total: shipping and VAT.
 *
 * This file used to own a second, competing fee system — a 2%/1.5%/1% tiered
 * "TradeAuct Buyer Fee" that had nothing to do with the selling method. A Buy
 * Now buyer, who owes 0%, was charged about 2% by it; an AED 10 start buyer,
 * who owes 6%, was charged about 2% as well. Meanwhile the seller's settlement
 * used the Fee Engine, so the two halves of an order could never reconcile.
 *
 * That tiering is gone. The buyer fee now arrives here already calculated, by
 * the Fee Engine, from the listing's own snapshot. What is left is shipping
 * and tax, which genuinely are separate charges (spec §8, §37).
 */
import { prisma } from "../../core/prisma.js";

export interface ShippingConfig {
  domesticRate: number;
  gccRate: number;
  worldwideRate: number;
}

export interface VatConfig {
  enabled: boolean;
  /** Percentage, e.g. 5 for 5%. */
  rate: number;
}

export const DEFAULT_SHIPPING_CONFIG: ShippingConfig = {
  domesticRate: 25,
  gccRate: 150,
  worldwideRate: 250,
};

export const DEFAULT_VAT_CONFIG: VatConfig = {
  enabled: false,
  rate: 0,
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

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Shipping the buyer pays, or nothing when the seller carries it. */
export function calculateEstimatedShipping(
  shippingPayer: string = "BUYER",
  destinationCountry: string = "United Arab Emirates",
  config: ShippingConfig = DEFAULT_SHIPPING_CONFIG,
): { amount: number; isFree: boolean; label: string } {
  if ((shippingPayer || "BUYER").toUpperCase() === "SELLER") {
    return { amount: 0, isFree: true, label: "FREE" };
  }

  const country = (destinationCountry || "United Arab Emirates").trim().toLowerCase();

  let amount = config.worldwideRate ?? DEFAULT_SHIPPING_CONFIG.worldwideRate;
  if (UAE_COUNTRY_IDENTIFIERS.has(country)) {
    amount = config.domesticRate ?? DEFAULT_SHIPPING_CONFIG.domesticRate;
  } else if (GCC_COUNTRY_IDENTIFIERS.has(country)) {
    amount = config.gccRate ?? DEFAULT_SHIPPING_CONFIG.gccRate;
  }

  return { amount: round2(amount), isFree: false, label: `AED ${amount.toLocaleString()}` };
}

export function calculateVat(taxableBase: number, config: VatConfig = DEFAULT_VAT_CONFIG): number {
  if (!config.enabled || !config.rate || config.rate <= 0) return 0;
  return round2((taxableBase * config.rate) / 100);
}

export interface OrderTotalsInput {
  /** Hammer or Buy Now price. */
  salePrice: number;
  /** Already calculated by the Fee Engine from the listing's snapshot. */
  buyerFee: number;
  shippingPayer?: string;
  destinationCountry?: string;
  shippingConfig?: Partial<ShippingConfig>;
  vatConfig?: Partial<VatConfig>;
}

export interface OrderTotals {
  salePrice: number;
  buyerFee: number;
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

/**
 * Sale price + buyer fee + shipping + VAT.
 *
 * VAT is charged on the sale price and the buyer fee together, which is the
 * taxable base the previous implementation used; shipping is not taxed here.
 */
export function calculateOrderTotals(input: OrderTotalsInput): OrderTotals {
  const salePrice = Number(input.salePrice) || 0;
  const buyerFee = round2(Number(input.buyerFee) || 0);

  const shippingConfig: ShippingConfig = { ...DEFAULT_SHIPPING_CONFIG, ...input.shippingConfig };
  const vatConfig: VatConfig = { ...DEFAULT_VAT_CONFIG, ...input.vatConfig };

  const shipping = calculateEstimatedShipping(input.shippingPayer, input.destinationCountry, shippingConfig);
  const vat = calculateVat(salePrice + buyerFee, vatConfig);

  return {
    salePrice,
    buyerFee,
    estimatedShipping: shipping.amount,
    isFreeShipping: shipping.isFree,
    shippingLabel: shipping.label,
    vat,
    vatRate: vatConfig.rate || 0,
    vatApplicable: vatConfig.enabled && vatConfig.rate > 0,
    estimatedTotal: round2(salePrice + buyerFee + shipping.amount + vat),
    destinationCountry: input.destinationCountry || "United Arab Emirates",
    disclaimer: "Import duties or local taxes may apply depending on your country's regulations.",
  };
}

/**
 * Shipping and VAT configuration from the database.
 *
 * Buyer fee configuration is deliberately absent: it lives in the Fee Engine's
 * `PLATFORM_FEE_ENGINE_CONFIG` and nowhere else.
 */
export async function getAuthoritativeChargeConfigs(): Promise<{
  shippingConfig: ShippingConfig;
  vatConfig: VatConfig;
}> {
  try {
    const settings = await prisma.auctionSetting.findMany();
    const map: Record<string, string> = {};
    for (const setting of settings) {
      map[setting.settingName] = setting.settingValue;
    }

    const parse = (key: string, fallback: number): number => {
      const value = Number.parseFloat(map[key] ?? "");
      return Number.isFinite(value) ? value : fallback;
    };

    return {
      shippingConfig: {
        domesticRate: parse("shipping_rate_domestic", DEFAULT_SHIPPING_CONFIG.domesticRate),
        gccRate: parse("shipping_rate_gcc", DEFAULT_SHIPPING_CONFIG.gccRate),
        worldwideRate: parse("shipping_rate_worldwide", DEFAULT_SHIPPING_CONFIG.worldwideRate),
      },
      vatConfig: {
        enabled: map.vat_enabled === "true",
        rate: parse("vat_rate", DEFAULT_VAT_CONFIG.rate),
      },
    };
  } catch {
    return { shippingConfig: DEFAULT_SHIPPING_CONFIG, vatConfig: DEFAULT_VAT_CONFIG };
  }
}
