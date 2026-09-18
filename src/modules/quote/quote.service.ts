/**
 * Pricing an order.
 *
 * One place, one answer. `createPaymentIntent` and `createCheckoutSession`
 * used to carry ~120 duplicated lines of buyer lookup, listing lookup,
 * shipping rate and fee arithmetic between them, which is how their totals
 * drifted apart. Both now ask for a quote.
 *
 * Nothing here reads an amount from a request. The price comes from the
 * listing or its auction, the fees from configuration, and the total is
 * recomputed on every call — so the same quote can be rebuilt later to check
 * what Stripe actually captured against it.
 */
import { AppError } from "../../core/errors/AppError.js";
import { currencyExponent, toMinorUnits } from "../../core/money.js";
import { prisma } from "../../core/prisma.js";
import { calculateLiveTotalBreakdown, getAuthoritativeFeeConfigs } from "./buyerFee.utils.js";
import { ShippingRateService } from "./shippingRate.service.js";

/** Currency is fixed for now; every stored amount says AED. */
export const QUOTE_CURRENCY = "AED";

export type AddressPayload = {
  fullName: string;
  phoneNumber?: string;
  email?: string;
  streetAddress?: string;
  addressLine1?: string;
  addressLine2?: string;
  apartment?: string;
  city: string;
  state?: string;
  postalCode?: string;
  country: string;
};

export type QuoteInput = {
  buyerUserId: string;
  listingId: string;
  shippingAddress: AddressPayload;
  purchaseType?: "AUCTION" | "BUY_NOW" | "OFFER";
  storageSelected?: boolean;
};

export type OrderQuote = {
  buyer: { id: string; userId: string; email: string | null; stripeCustomerId: string | null };
  listing: { id: string; title: string; sellerId: string | null; saleType: string; imageUrl: string | null };
  currency: string;
  orderNumber: string;
  destinationCountry: string;
  storageSelected: boolean;
  purchaseType: string;
  breakdown: {
    purchasePrice: number;
    buyerFee: number;
    shippingCost: number;
    storageFee: number;
    vat: number;
    totalAmount: number;
  };
  totalMinor: bigint;
  /** Exactly what is attached to the Stripe object, and later reconciled. */
  metadata: Record<string, string>;
};

/**
 * The authoritative price of a listing.
 *
 * An auction settles at its current bid, a direct sale at the listing price.
 * There is deliberately no default: a listing with neither is a data problem,
 * not something to guess a number for and charge a card against.
 */
export function resolveListingPrice(listing: {
  price?: number | null;
  auction?: { currentBid?: number | null } | null;
}): number {
  const auctionBid = Number(listing.auction?.currentBid);
  if (Number.isFinite(auctionBid) && auctionBid > 0) return auctionBid;

  const listingPrice = Number(listing.price);
  if (Number.isFinite(listingPrice) && listingPrice > 0) return listingPrice;

  throw new AppError(409, "This listing has no payable price.", "LISTING_PRICE_UNAVAILABLE");
}

export async function buildOrderQuote(input: QuoteInput): Promise<OrderQuote> {
  const buyer = await prisma.buyer.findFirst({
    where: { OR: [{ userId: input.buyerUserId }, { id: input.buyerUserId }] },
    include: { user: { select: { email: true } } },
  });

  if (!buyer) {
    throw new AppError(404, "Buyer profile not found. Please sign in as a buyer.", "BUYER_NOT_FOUND");
  }

  const listing = await prisma.listing.findUnique({
    where: { id: input.listingId },
    include: {
      auction: true,
      media: { orderBy: { order: "asc" }, take: 1 },
    },
  });

  if (!listing) {
    throw new AppError(404, "Listing not found.", "LISTING_NOT_FOUND");
  }

  if (listing.status === "SOLD") {
    throw new AppError(400, "This listing has already been sold.", "LISTING_ALREADY_SOLD");
  }

  const purchasePrice = resolveListingPrice(listing);
  const destinationCountry = input.shippingAddress.country || "United Arab Emirates";

  const coverage = ShippingRateService.validateShippingCoverage(listing.shippingCoverage, destinationCountry);
  if (!coverage.isAllowed) {
    throw new AppError(
      400,
      coverage.reason || "Shipping is not permitted to this destination for this listing",
      "SHIPPING_COVERAGE_RESTRICTED",
    );
  }

  const shippingRate = await ShippingRateService.calculateShippingRate({
    destinationCountry,
    shippingPayer: listing.shippingPayer,
    shippingCoverage: listing.shippingCoverage,
  });

  if (!shippingRate.isAvailable && !shippingRate.isFree) {
    throw new AppError(
      400,
      shippingRate.message || "Shipping is currently unavailable for this destination",
      "SHIPPING_RATE_UNAVAILABLE",
    );
  }

  const shippingCost = shippingRate.isFree ? 0 : shippingRate.rate;
  const feeConfigs = await getAuthoritativeFeeConfigs();

  const breakdown = calculateLiveTotalBreakdown({
    bidAmount: purchasePrice,
    shippingPayer: listing.shippingPayer,
    shippingCoverage: listing.shippingCoverage,
    destinationCountry,
    buyerFeeConfig: feeConfigs.buyerFeeConfig,
    // The resolved rate replaces all three tiers: the tiering already happened
    // when the country rate was looked up.
    shippingConfig: {
      ...feeConfigs.shippingConfig,
      domesticRate: shippingRate.rate,
      gccRate: shippingRate.rate,
      worldwideRate: shippingRate.rate,
    },
    vatConfig: feeConfigs.vatConfig,
  });

  // 15 free storage days apply; any accrued fee is collected on release, not
  // at checkout.
  const storageFee = 0;

  // Totalled in minor units so the sum is exact, then converted back once for
  // display. Adding floats and rounding at the end is how a total ends up a
  // fils away from the sum of its parts.
  const exponent = currencyExponent(QUOTE_CURRENCY);
  const totalMinor =
    toMinorUnits(purchasePrice, QUOTE_CURRENCY) +
    toMinorUnits(breakdown.buyerFee, QUOTE_CURRENCY) +
    toMinorUnits(shippingCost, QUOTE_CURRENCY) +
    toMinorUnits(storageFee, QUOTE_CURRENCY) +
    toMinorUnits(breakdown.vat, QUOTE_CURRENCY);
  const totalAmount = Number(totalMinor) / 10 ** exponent;

  const orderNumber = await generateOrderNumber();
  const purchaseType = input.purchaseType || (listing.saleType as string) || "AUCTION";

  const quoteBreakdown = {
    purchasePrice,
    buyerFee: breakdown.buyerFee,
    shippingCost,
    storageFee,
    vat: breakdown.vat,
    totalAmount,
  };

  return {
    buyer: {
      id: buyer.id,
      userId: buyer.userId,
      email: buyer.user?.email ?? null,
      stripeCustomerId: buyer.stripeCustomerId,
    },
    listing: {
      id: listing.id,
      title: listing.title,
      sellerId: listing.sellerId,
      saleType: listing.saleType as string,
      imageUrl: listing.media?.[0]?.url ?? null,
    },
    currency: QUOTE_CURRENCY,
    orderNumber,
    destinationCountry,
    storageSelected: Boolean(input.storageSelected),
    purchaseType,
    breakdown: quoteBreakdown,
    totalMinor,
    metadata: buildQuoteMetadata({
      orderNumber,
      buyerUserId: buyer.userId,
      buyerId: buyer.id,
      listingId: listing.id,
      sellerId: listing.sellerId,
      auctionId: listing.auction?.id ?? null,
      purchaseType,
      destinationCountry,
      storageSelected: Boolean(input.storageSelected),
      breakdown: quoteBreakdown,
      shippingAddress: input.shippingAddress,
    }),
  };
}

/**
 * Metadata attached to every Stripe object we create.
 *
 * This is what the webhook reconciles against, so the keys and their meaning
 * are a contract: `payments.finalize.service.ts` reads exactly these names.
 */
export function buildQuoteMetadata(input: {
  orderNumber: string;
  buyerUserId: string;
  buyerId: string;
  listingId: string;
  sellerId: string | null;
  auctionId: string | null;
  purchaseType: string;
  destinationCountry: string;
  storageSelected: boolean;
  breakdown: OrderQuote["breakdown"];
  shippingAddress: AddressPayload | null;
}): Record<string, string> {
  return {
    orderNumber: input.orderNumber,
    buyerUserId: input.buyerUserId,
    buyerId: input.buyerId,
    listingId: input.listingId,
    ...(input.sellerId ? { sellerId: input.sellerId } : {}),
    ...(input.auctionId ? { auctionId: input.auctionId } : {}),
    purchaseType: input.purchaseType,
    purchasePrice: String(input.breakdown.purchasePrice),
    buyerFee: String(input.breakdown.buyerFee),
    shippingCost: String(input.breakdown.shippingCost),
    storageFee: String(input.breakdown.storageFee),
    vat: String(input.breakdown.vat),
    totalAmount: String(input.breakdown.totalAmount),
    storageSelected: String(input.storageSelected),
    destinationCountry: input.destinationCountry,
    ...(input.shippingAddress ? { shippingAddress: JSON.stringify(input.shippingAddress) } : {}),
  };
}

/**
 * `TA-<year>-<5 digits>` is a 90,000-value space with no unique index behind
 * it, so a candidate is checked before it is used.
 */
async function generateOrderNumber(): Promise<string> {
  const year = new Date().getFullYear();

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = `TA-${year}-${Math.floor(10000 + Math.random() * 90000)}`;
    const taken = await prisma.fulfillmentOrder.findFirst({
      where: { orderNumber: candidate },
      select: { id: true },
    });
    if (!taken) return candidate;
  }

  return `TA-${year}-${Date.now().toString().slice(-8)}`;
}
