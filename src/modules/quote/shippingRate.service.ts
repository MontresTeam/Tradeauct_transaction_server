/**
 * Country shipping rates.
 *
 * Moved from TradeAuct_backend_server (modules/settlement/shippingRate.service.ts)
 * unchanged; it is part of pricing an order, so it belongs with the quote.
 */

import { AppError } from "../../core/errors/AppError.js";
import { prisma } from "../../core/prisma.js";
import { GCC_COUNTRY_IDENTIFIERS, UAE_COUNTRY_IDENTIFIERS } from "./buyerFee.utils.js";

export interface CountryRateInput {
  countryCode: string;
  countryName: string;
  zone?: string;
  shippingMethod?: string;
  rate: number;
  currency?: string;
  isActive?: boolean;
  estimatedDays?: string;
}

export interface ShippingCalculationResult {
  isAllowed: boolean;
  isAvailable: boolean;
  isFree: boolean;
  rate: number;
  currency: string;
  countryCode: string;
  countryName: string;
  shippingMethod: string;
  estimatedDays: string;
  message?: string;
  coverageCheck: {
    coverage: string;
    allowed: boolean;
    reason?: string;
  };
}

// Initial canonical GCC and domestic defaults for seeding
export const INITIAL_DEFAULT_RATES: CountryRateInput[] = [
  {
    countryCode: "AE",
    countryName: "United Arab Emirates",
    zone: "DOMESTIC",
    rate: 25,
    shippingMethod: "TradeAuct Same-Day / Next-Day Escort",
    estimatedDays: "1-2 business days",
  },
  {
    countryCode: "SA",
    countryName: "Saudi Arabia",
    zone: "GCC",
    rate: 80,
    shippingMethod: "TradeAuct GCC Insured Express",
    estimatedDays: "2-3 business days",
  },
  {
    countryCode: "KW",
    countryName: "Kuwait",
    zone: "GCC",
    rate: 75,
    shippingMethod: "TradeAuct GCC Insured Express",
    estimatedDays: "2-3 business days",
  },
  {
    countryCode: "QA",
    countryName: "Qatar",
    zone: "GCC",
    rate: 70,
    shippingMethod: "TradeAuct GCC Insured Express",
    estimatedDays: "2-3 business days",
  },
  {
    countryCode: "BH",
    countryName: "Bahrain",
    zone: "GCC",
    rate: 65,
    shippingMethod: "TradeAuct GCC Insured Express",
    estimatedDays: "2-3 business days",
  },
  {
    countryCode: "OM",
    countryName: "Oman",
    zone: "GCC",
    rate: 60,
    shippingMethod: "TradeAuct GCC Insured Express",
    estimatedDays: "2-3 business days",
  },
  {
    countryCode: "GB",
    countryName: "United Kingdom",
    zone: "WORLDWIDE",
    rate: 250,
    shippingMethod: "TradeAuct Global Insured Escort",
    estimatedDays: "3-5 business days",
  },
  {
    countryCode: "US",
    countryName: "United States",
    zone: "WORLDWIDE",
    rate: 280,
    shippingMethod: "TradeAuct Global Insured Escort",
    estimatedDays: "3-5 business days",
  },
];

export class ShippingRateService {
  /**
   * Ensures default shipping rates exist in DB.
   */
  static async ensureDefaultRatesSeeded(): Promise<void> {
    try {
      const count = await prisma.countryShippingRate.count();
      if (count === 0) {
        for (const rate of INITIAL_DEFAULT_RATES) {
          await prisma.countryShippingRate.create({
            data: {
              countryCode: rate.countryCode.toUpperCase(),
              countryName: rate.countryName,
              zone: rate.zone || "GCC",
              shippingMethod: rate.shippingMethod || "TradeAuct Insured Express",
              rate: rate.rate,
              currency: rate.currency || "AED",
              isActive: rate.isActive !== undefined ? rate.isActive : true,
              estimatedDays: rate.estimatedDays || "2-4 business days",
            },
          });
        }
      }
    } catch (_err) {
      // Ignore if concurrent seed
    }
  }

  /**
   * Helper to normalize country input to standard name and code.
   */
  static normalizeCountry(destination: string): { normalizedName: string; isUae: boolean; isGcc: boolean } {
    const raw = (destination || "United Arab Emirates").trim().toLowerCase();
    const isUae = UAE_COUNTRY_IDENTIFIERS.has(raw);
    const isGcc = isUae || GCC_COUNTRY_IDENTIFIERS.has(raw);

    let normalizedName = destination || "United Arab Emirates";
    if (isUae) normalizedName = "United Arab Emirates";
    else if (raw.includes("saudi") || raw === "sa" || raw === "ksa") normalizedName = "Saudi Arabia";
    else if (raw.includes("kuwait") || raw === "kw") normalizedName = "Kuwait";
    else if (raw.includes("qatar") || raw === "qa") normalizedName = "Qatar";
    else if (raw.includes("bahrain") || raw === "bh") normalizedName = "Bahrain";
    else if (raw.includes("oman") || raw === "om") normalizedName = "Oman";
    else if (raw.includes("kingdom") || raw === "uk" || raw === "gb") normalizedName = "United Kingdom";
    else if (raw.includes("united states") || raw === "usa" || raw === "us") normalizedName = "United States";

    return { normalizedName, isUae, isGcc };
  }

  /**
   * Validates if listing shipping coverage allows shipping to destination country.
   */
  static validateShippingCoverage(
    shippingCoverage: string = "WORLDWIDE",
    destinationCountry: string = "United Arab Emirates",
  ): { isAllowed: boolean; reason?: string } {
    const coverage = (shippingCoverage || "WORLDWIDE").toUpperCase();
    const { isUae, isGcc, normalizedName } = this.normalizeCountry(destinationCountry);

    if (coverage === "UAE_ONLY") {
      if (!isUae) {
        return {
          isAllowed: false,
          reason: `This listing is restricted to UAE deliveries only. Delivery to ${normalizedName} is not permitted.`,
        };
      }
      return { isAllowed: true };
    }

    if (coverage === "GCC") {
      if (!isGcc) {
        return {
          isAllowed: false,
          reason: `This listing is restricted to GCC countries only. Delivery to ${normalizedName} is not permitted.`,
        };
      }
      return { isAllowed: true };
    }

    // WORLDWIDE: allowed for all supported countries
    return { isAllowed: true };
  }

  /**
   * Calculates applicable shipping rate for a listing and destination.
   */
  static async calculateShippingRate(params: {
    destinationCountry: string;
    shippingPayer?: string; // "BUYER" | "SELLER"
    shippingCoverage?: string; // "UAE_ONLY" | "GCC" | "WORLDWIDE"
  }): Promise<ShippingCalculationResult> {
    await this.ensureDefaultRatesSeeded();

    const shippingPayer = (params.shippingPayer || "BUYER").toUpperCase();
    const shippingCoverage = (params.shippingCoverage || "WORLDWIDE").toUpperCase();
    const { normalizedName, isUae, isGcc } = this.normalizeCountry(params.destinationCountry);

    // 1. Verify Listing Coverage
    const coverageValidation = this.validateShippingCoverage(shippingCoverage, params.destinationCountry);
    if (!coverageValidation.isAllowed) {
      return {
        isAllowed: false,
        isAvailable: false,
        isFree: false,
        rate: 0,
        currency: "AED",
        countryCode: isUae ? "AE" : isGcc ? "GCC" : "INTL",
        countryName: normalizedName,
        shippingMethod: "N/A",
        estimatedDays: "N/A",
        message: coverageValidation.reason,
        coverageCheck: {
          coverage: shippingCoverage,
          allowed: false,
          reason: coverageValidation.reason,
        },
      };
    }

    // 2. If Seller Pays Shipping -> FREE for buyer
    if (shippingPayer === "SELLER") {
      return {
        isAllowed: true,
        isAvailable: true,
        isFree: true,
        rate: 0,
        currency: "AED",
        countryCode: isUae ? "AE" : "AE",
        countryName: normalizedName,
        shippingMethod: "TradeAuct Insured Escort (Free Shipping)",
        estimatedDays: isUae ? "1-2 business days" : "2-4 business days",
        message: "🚚 Free Shipping (Seller Pays)",
        coverageCheck: {
          coverage: shippingCoverage,
          allowed: true,
        },
      };
    }

    // 3. Find matching CountryShippingRate from database
    const matchedRate = await prisma.countryShippingRate.findFirst({
      where: {
        OR: [
          { countryName: { equals: normalizedName, mode: "insensitive" } },
          { countryCode: { equals: normalizedName.toUpperCase() } },
        ],
        isActive: true,
      },
    });

    if (matchedRate) {
      return {
        isAllowed: true,
        isAvailable: true,
        isFree: false,
        rate: matchedRate.rate,
        currency: matchedRate.currency,
        countryCode: matchedRate.countryCode,
        countryName: matchedRate.countryName,
        shippingMethod: matchedRate.shippingMethod,
        estimatedDays: matchedRate.estimatedDays || "2-4 business days",
        coverageCheck: {
          coverage: shippingCoverage,
          allowed: true,
        },
      };
    }

    // Fallback based on zone if specific country is not configured
    let fallbackRate: number | null = null;
    const fallbackMethod = "TradeAuct Insured Express";

    if (isUae) {
      const uaeRate = await prisma.countryShippingRate.findFirst({ where: { countryCode: "AE", isActive: true } });
      fallbackRate = uaeRate ? uaeRate.rate : 25;
    } else if (isGcc) {
      const gccDefault = await prisma.countryShippingRate.findFirst({ where: { zone: "GCC", isActive: true } });
      fallbackRate = gccDefault ? gccDefault.rate : 80;
    } else {
      const worldwideDefault = await prisma.countryShippingRate.findFirst({
        where: { zone: "WORLDWIDE", isActive: true },
      });
      fallbackRate = worldwideDefault ? worldwideDefault.rate : null;
    }

    if (fallbackRate !== null) {
      return {
        isAllowed: true,
        isAvailable: true,
        isFree: false,
        rate: fallbackRate,
        currency: "AED",
        countryCode: isUae ? "AE" : isGcc ? "GCC" : "INTL",
        countryName: normalizedName,
        shippingMethod: fallbackMethod,
        estimatedDays: "2-4 business days",
        coverageCheck: {
          coverage: shippingCoverage,
          allowed: true,
        },
      };
    }

    // No shipping rate configured for destination
    return {
      isAllowed: true,
      isAvailable: false,
      isFree: false,
      rate: 0,
      currency: "AED",
      countryCode: "UNKNOWN",
      countryName: normalizedName,
      shippingMethod: "N/A",
      estimatedDays: "N/A",
      message: "Shipping is currently unavailable for this destination. Cost will be confirmed by TradeAuct.",
      coverageCheck: {
        coverage: shippingCoverage,
        allowed: true,
      },
    };
  }

  // =========================================================================
  // ADMIN SHIPPING RATE CRUD
  // =========================================================================

  static async getAllShippingRates(includeInactive = false) {
    await this.ensureDefaultRatesSeeded();
    return prisma.countryShippingRate.findMany({
      where: includeInactive ? undefined : { isActive: true },
      orderBy: [{ zone: "asc" }, { countryName: "asc" }],
    });
  }

  static async getShippingRateById(id: string) {
    const rate = await prisma.countryShippingRate.findUnique({ where: { id } });
    if (!rate) throw new AppError(404, "Shipping rate not found", "SHIPPING_RATE_NOT_FOUND");
    return rate;
  }

  static async createShippingRate(data: CountryRateInput, adminUserId?: string) {
    const existing = await prisma.countryShippingRate.findUnique({
      where: { countryCode: data.countryCode.toUpperCase() },
    });
    if (existing) {
      throw new AppError(
        409,
        `Shipping rate for country code ${data.countryCode} already exists`,
        "DUPLICATE_COUNTRY_RATE",
      );
    }

    const created = await prisma.countryShippingRate.create({
      data: {
        countryCode: data.countryCode.toUpperCase(),
        countryName: data.countryName,
        zone: data.zone || "GCC",
        shippingMethod: data.shippingMethod || "TradeAuct Insured Express",
        rate: Number(data.rate),
        currency: data.currency || "AED",
        isActive: data.isActive !== undefined ? data.isActive : true,
        estimatedDays: data.estimatedDays || "2-4 business days",
      },
    });

    await prisma.financialAuditLog.create({
      data: {
        action: "SHIPPING_RATE_CREATED",
        entityType: "COUNTRY_SHIPPING_RATE",
        entityId: created.id,
        amount: created.rate,
        newState: created as any,
        reason: `Admin created shipping rate for ${created.countryName} (${created.countryCode})`,
        performedById: adminUserId || "ADMIN",
        performedByRole: "ADMIN",
      },
    });

    return created;
  }

  static async updateShippingRate(id: string, data: Partial<CountryRateInput>, adminUserId?: string) {
    const existing = await this.getShippingRateById(id);

    const updated = await prisma.countryShippingRate.update({
      where: { id },
      data: {
        countryCode: data.countryCode ? data.countryCode.toUpperCase() : undefined,
        countryName: data.countryName,
        zone: data.zone,
        shippingMethod: data.shippingMethod,
        rate: data.rate !== undefined ? Number(data.rate) : undefined,
        currency: data.currency,
        isActive: data.isActive,
        estimatedDays: data.estimatedDays,
      },
    });

    await prisma.financialAuditLog.create({
      data: {
        action: "SHIPPING_RATE_UPDATED",
        entityType: "COUNTRY_SHIPPING_RATE",
        entityId: updated.id,
        amount: updated.rate,
        previousState: existing as any,
        newState: updated as any,
        reason: `Admin updated shipping rate for ${updated.countryName}`,
        performedById: adminUserId || "ADMIN",
        performedByRole: "ADMIN",
      },
    });

    return updated;
  }

  static async deleteShippingRate(id: string, adminUserId?: string) {
    const existing = await this.getShippingRateById(id);

    await prisma.countryShippingRate.delete({ where: { id } });

    await prisma.financialAuditLog.create({
      data: {
        action: "SHIPPING_RATE_DELETED",
        entityType: "COUNTRY_SHIPPING_RATE",
        entityId: id,
        previousState: existing as any,
        reason: `Admin deleted shipping rate for ${existing.countryName}`,
        performedById: adminUserId || "ADMIN",
        performedByRole: "ADMIN",
      },
    });

    return { success: true, message: `Shipping rate for ${existing.countryName} deleted successfully` };
  }

  static async toggleShippingRateStatus(id: string, isActive: boolean, adminUserId?: string) {
    const existing = await this.getShippingRateById(id);

    const updated = await prisma.countryShippingRate.update({
      where: { id },
      data: { isActive },
    });

    await prisma.financialAuditLog.create({
      data: {
        action: "SHIPPING_RATE_STATUS_TOGGLED",
        entityType: "COUNTRY_SHIPPING_RATE",
        entityId: id,
        previousState: { isActive: existing.isActive },
        newState: { isActive },
        reason: `Admin toggled active status to ${isActive}`,
        performedById: adminUserId || "ADMIN",
        performedByRole: "ADMIN",
      },
    });

    return updated;
  }

  /**
   * Helper: Gets shipping rate and method info for a given destination country.
   */
  static async getRateForCountry(destinationCountry: string) {
    const res = await this.calculateShippingRate({ destinationCountry });
    return {
      rate: res.rate,
      shippingMethod: res.shippingMethod,
      estimatedDays: res.estimatedDays,
      currency: res.currency,
    };
  }
}
