/**
 * Stripe Connect onboarding for sellers.
 *
 * TradeAuct collects the buyer's money on its own account and sends the
 * seller's net across later, once the protection period has run — the
 * "separate charges and transfers" model. That needs each seller to have a
 * connected account with the `transfers` capability.
 *
 * Two things about the UAE that the seller-facing copy has to say plainly,
 * because Stripe's own documentation does:
 *
 *   - a UAE connected account needs a valid UAE trade licence;
 *   - individuals without one are not currently supported.
 *
 * A seller who cannot onboard is not stuck. Their settlements still accrue and
 * an admin can pay them by the manual override; see the payouts module.
 *
 * Nothing here runs unless `SELLER_CONNECT_ENABLED` is on. That flag stays off
 * in production until Stripe has verified TradeAuct's own account (plan §7).
 */
import type Stripe from "stripe";
import { recordAudit } from "../../core/audit.js";
import { loadEnv } from "../../core/env.js";
import { AppError } from "../../core/errors/AppError.js";
import { logger } from "../../core/logger.js";
import { enqueueOutboxEvent, TXN_EVENTS } from "../../core/outbox.js";
import { prisma } from "../../core/prisma.js";
import { getStripeClient } from "../gateway/stripe.client.js";

export type ConnectOnboardingStatus =
  | "NOT_STARTED"
  | "IN_PROGRESS"
  | "PENDING_VERIFICATION"
  | "COMPLETE"
  | "RESTRICTED";

export type ConnectStatus = {
  connected: boolean;
  stripeAccountId: string | null;
  onboardingStatus: ConnectOnboardingStatus;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  requirementsCurrentlyDue: string[];
  requirementsPastDue: string[];
  disabledReason: string | null;
  country: string | null;
  payoutSchedule: string | null;
  /** True when the feature flag is off, which the dashboard renders as "coming soon". */
  featureDisabled: boolean;
};

function assertConnectEnabled(): void {
  if (!loadEnv().SELLER_CONNECT_ENABLED) {
    throw new AppError(503, "Seller payout accounts are not enabled yet.", "SELLER_CONNECT_DISABLED");
  }
}

/** Stripe's account shape, reduced to what the dashboard and the worker need. */
function deriveOnboardingStatus(account: Stripe.Account): ConnectOnboardingStatus {
  const requirements = account.requirements;
  const pastDue = requirements?.past_due ?? [];
  const currentlyDue = requirements?.currently_due ?? [];

  if (requirements?.disabled_reason) return "RESTRICTED";
  if (!account.details_submitted) return currentlyDue.length > 0 ? "IN_PROGRESS" : "NOT_STARTED";
  if (pastDue.length > 0 || currentlyDue.length > 0) return "IN_PROGRESS";
  if (account.payouts_enabled) return "COMPLETE";
  return "PENDING_VERIFICATION";
}

/** Write Stripe's view of an account into `connect_accounts`. */
export async function syncConnectAccount(account: Stripe.Account): Promise<void> {
  const existing = await prisma.connectAccount.findUnique({ where: { stripeAccountId: account.id } });
  if (!existing) {
    logger.warn("Stripe reported an account TradeAuct does not know", { stripeAccountId: account.id });
    return;
  }

  const onboardingStatus = deriveOnboardingStatus(account);
  const payoutsEnabled = Boolean(account.payouts_enabled);

  await prisma.$transaction(async (tx) => {
    await tx.connectAccount.update({
      where: { id: existing.id },
      data: {
        country: account.country ?? existing.country,
        defaultCurrency: account.default_currency ?? existing.defaultCurrency,
        chargesEnabled: Boolean(account.charges_enabled),
        payoutsEnabled,
        detailsSubmitted: Boolean(account.details_submitted),
        requirementsDue: (account.requirements ?? null) as never,
        requirementsCurrentlyDue: (account.requirements?.currently_due ?? []) as never,
        requirementsPastDue: (account.requirements?.past_due ?? []) as never,
        requirementsDisabledUntil: account.requirements?.current_deadline
          ? new Date(account.requirements.current_deadline * 1000)
          : null,
        disabledReason: account.requirements?.disabled_reason ?? null,
        onboardingStatus,
        payoutSchedule: account.settings?.payouts?.schedule?.interval ?? existing.payoutSchedule,
        lastSyncedAt: new Date(),
        onboardedAt: payoutsEnabled ? (existing.onboardedAt ?? new Date()) : existing.onboardedAt,
      },
    });

    await enqueueOutboxEvent(tx, TXN_EVENTS.CONNECT_ACCOUNT_UPDATED, {
      sellerId: existing.sellerId,
      stripeAccountId: account.id,
      onboardingStatus,
      payoutsEnabled,
      chargesEnabled: Boolean(account.charges_enabled),
      disabledReason: account.requirements?.disabled_reason ?? null,
      requirementsCurrentlyDue: account.requirements?.currently_due ?? [],
    });
  });

  logger.info("Connected account synced", {
    sellerId: existing.sellerId,
    stripeAccountId: account.id,
    onboardingStatus,
    payoutsEnabled,
  });
}

/** `+971 50 123 4567`, `00971501234567` → `+971501234567`; anything else → undefined. */
function toE164(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const compact = raw.replace(/[\s\-().]/g, "").replace(/^00/, "+");
  return /^\+[1-9]\d{7,14}$/.test(compact) ? compact : undefined;
}

type SellerForPrefill = {
  businessProfile: {
    legalBusinessName: string | null;
    businessName: string | null;
    tradeLicenseNumber: string | null;
    vatNumber: string | null;
  } | null;
  businessContact: { businessPhone: string } | null;
  addresses: {
    isDefault: boolean;
    addressType: string;
    addressLine1: string;
    addressLine2: string | null;
    city: string;
    state: string;
    postalCode: string;
    country: { code: string } | null;
  }[];
};

/**
 * Company details the seller already gave during business registration, so
 * Stripe's hosted onboarding asks for less. Every field is optional and only
 * sent when it looks valid: one malformed value would make Stripe refuse the
 * whole account. Stripe still verifies all of it; this only saves typing.
 */
function companyPrefill(seller: SellerForPrefill, country: string): Stripe.AccountCreateParams.Company {
  const profile = seller.businessProfile;
  const address =
    seller.addresses.find((a) => a.addressType === "REGISTERED_OFFICE") ??
    seller.addresses.find((a) => a.isDefault) ??
    seller.addresses[0];
  // Only an address in the account's own country; a foreign one would be refused.
  const usableAddress = address && (!address.country || address.country.code === country) ? address : undefined;
  const trimmed = (value: string | null | undefined) => value?.trim() || undefined;

  return {
    name: trimmed(profile?.legalBusinessName) ?? trimmed(profile?.businessName),
    registration_number: trimmed(profile?.tradeLicenseNumber),
    tax_id: trimmed(profile?.vatNumber),
    phone: toE164(seller.businessContact?.businessPhone),
    ...(usableAddress
      ? {
          address: {
            line1: trimmed(usableAddress.addressLine1),
            line2: trimmed(usableAddress.addressLine2),
            city: trimmed(usableAddress.city),
            state: trimmed(usableAddress.state),
            postal_code: trimmed(usableAddress.postalCode),
            country,
          },
        }
      : {}),
  };
}

const STRIPE_DOCUMENT_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
};
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024; // Stripe's limit for identity documents

function sniffDocumentType(data: Buffer): string | undefined {
  if (data.subarray(0, 4).toString("latin1") === "%PDF") return "application/pdf";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  return undefined;
}

const COMPANY_LICENSE_REQUIREMENT = "documents.company_license.files";

/**
 * Hand the trade licence the seller uploaded at registration to Stripe, so
 * hosted onboarding does not ask for it again.
 *
 * Called both when the connected account is first created and every time the
 * seller asks for a fresh onboarding link ("Continue verification") — the
 * first attempt is not the only chance: the seller may not have had a licence
 * on file yet, or the earlier upload may have failed. `requirements` is
 * Stripe's live view of that account, so a licence Stripe already has is
 * never re-uploaded.
 *
 * Best effort throughout: any failure is logged and onboarding carries on.
 * Stripe then simply asks the seller to upload the licence on its own page.
 *
 * The URL arrives from the main backend, but it is still fetched from a
 * payment server, so only HTTPS links to S3 are accepted.
 */
async function ensureTradeLicense(
  stripeAccountId: string,
  sellerId: string,
  documentUrl: string | null | undefined,
  requirements: Stripe.Account.Requirements | null | undefined,
): Promise<void> {
  if (!documentUrl) return;

  const stillNeeded = [...(requirements?.currently_due ?? []), ...(requirements?.past_due ?? [])].includes(
    COMPANY_LICENSE_REQUIREMENT,
  );
  if (!stillNeeded) return;

  try {
    const url = new URL(documentUrl);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".amazonaws.com")) {
      logger.warn("Trade licence not sent to Stripe: not an S3 link", { sellerId, host: url.hostname });
      return;
    }

    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      logger.warn("Trade licence not sent to Stripe: download failed", { sellerId, status: response.status });
      return;
    }

    const data = Buffer.from(await response.arrayBuffer());
    // Uploads are sometimes stored as application/octet-stream, so fall back
    // to the file's own signature.
    const headerType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const contentType = STRIPE_DOCUMENT_TYPES[headerType] ? headerType : sniffDocumentType(data);
    const extension = contentType ? STRIPE_DOCUMENT_TYPES[contentType] : undefined;
    if (!contentType || !extension) {
      logger.warn("Trade licence not sent to Stripe: unsupported file type", { sellerId, headerType });
      return;
    }

    if (data.length > MAX_DOCUMENT_BYTES) {
      logger.warn("Trade licence not sent to Stripe: file too large", { sellerId, bytes: data.length });
      return;
    }

    const stripe = getStripeClient();
    const file = await stripe.files.create({
      purpose: "account_requirement",
      file: { data, name: `trade-licence.${extension}`, type: contentType },
    });
    await stripe.accounts.update(stripeAccountId, {
      documents: { company_license: { files: [file.id] } },
    });

    logger.info("Trade licence sent to Stripe", { sellerId, stripeAccountId, fileId: file.id });
  } catch (error) {
    logger.warn("Trade licence not sent to Stripe", {
      sellerId,
      stripeAccountId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Create the seller's connected account, or return the one they already have.
 *
 * Only `transfers` is requested. TradeAuct never charges a buyer on the
 * seller's account, so asking for `card_payments` would put the seller's
 * account through verification it does not need.
 */
export async function createConnectedAccount(input: {
  sellerId: string;
  email?: string | null;
  tradeLicenseDocumentUrl?: string | null;
  actorId?: string | null;
  ip?: string | null;
}): Promise<{ stripeAccountId: string; created: boolean }> {
  assertConnectEnabled();

  const existing = await prisma.connectAccount.findUnique({ where: { sellerId: input.sellerId } });
  if (existing) {
    return { stripeAccountId: existing.stripeAccountId, created: false };
  }

  const seller = await prisma.seller.findUnique({
    where: { id: input.sellerId },
    include: {
      businessProfile: true,
      businessContact: true,
      individualProfile: true,
      user: { select: { email: true } },
      addresses: { where: { isActive: true }, include: { country: true } },
    },
  });

  if (!seller) {
    throw new AppError(404, "Seller not found", "SELLER_NOT_FOUND");
  }

  const env = loadEnv();
  const businessType = seller.sellerType === "INDIVIDUAL" ? "individual" : "company";

  // Stripe refuses `individual` accounts in the UAE outright. Say so here
  // rather than surfacing Stripe's refusal as a 500.
  if (businessType === "individual" && env.CONNECT_ACCOUNT_COUNTRY === "AE") {
    throw new AppError(
      422,
      "Automatic payouts need a UAE trade licence, so individual sellers are paid by bank transfer instead.",
      "CONNECT_INDIVIDUAL_UNSUPPORTED",
    );
  }

  const businessName =
    seller.businessProfile?.legalBusinessName ||
    seller.businessProfile?.businessName ||
    seller.individualProfile?.storeName ||
    undefined;

  const company = businessType === "company" ? companyPrefill(seller, env.CONNECT_ACCOUNT_COUNTRY) : undefined;

  // Stripe stores the response to an idempotency key for 24 hours, errors
  // included. A key fixed on the seller alone therefore replays an old refusal
  // (e.g. before Connect was enabled) long after the cause is fixed. The
  // 10-minute window still collapses a double click into one account.
  const idempotencyWindow = Math.floor(Date.now() / (10 * 60 * 1000));
  const idempotencyKey = `tradeauct_connect_account_${input.sellerId}_${businessType}_${idempotencyWindow}`;

  let account: Stripe.Account;
  try {
    account = await getStripeClient().accounts.create(
      {
        type: "custom",
        country: env.CONNECT_ACCOUNT_COUNTRY,
        email: input.email ?? seller.user?.email ?? undefined,
        capabilities: { transfers: { requested: true } },
        business_type: businessType,
        ...(company ? { company } : {}),
        business_profile: {
          name: businessName,
          url: seller.businessProfile?.website ?? undefined,
          product_description: "Pre-owned luxury watches sold through the TradeAuct marketplace",
        },
        settings: {
          payouts: {
            // Manual by default: TradeAuct decides when money leaves the
            // connected account, which keeps a payout matched 1:1 to a
            // settlement. Switching this to daily is cheaper but bundles them
            // (plan Q4).
            schedule: { interval: env.CONNECT_PAYOUT_INTERVAL },
          },
        },
        metadata: { tradeauctSellerId: input.sellerId },
      },
      { idempotencyKey },
    );
  } catch (error) {
    const stripeError = error as { type?: string; code?: string; message?: string };
    if (stripeError?.type === "StripeInvalidRequestError" || stripeError?.type === "StripePermissionError") {
      // A configuration or eligibility refusal: retrying will not help. Log
      // Stripe's words for us; give the seller something they can act on.
      logger.error("Stripe refused to create a connected account", {
        sellerId: input.sellerId,
        businessType,
        code: stripeError.code,
        message: stripeError.message,
      });
      throw new AppError(
        502,
        "Payout accounts are temporarily unavailable. Please try again later or contact TradeAuct support.",
        "CONNECT_ACCOUNT_REJECTED",
      );
    }
    throw error;
  }

  await prisma.connectAccount.create({
    data: {
      sellerId: input.sellerId,
      stripeAccountId: account.id,
      country: account.country ?? env.CONNECT_ACCOUNT_COUNTRY,
      defaultCurrency: account.default_currency ?? null,
      chargesEnabled: Boolean(account.charges_enabled),
      payoutsEnabled: Boolean(account.payouts_enabled),
      detailsSubmitted: Boolean(account.details_submitted),
      onboardingStatus: deriveOnboardingStatus(account),
      payoutSchedule: account.settings?.payouts?.schedule?.interval ?? env.CONNECT_PAYOUT_INTERVAL,
      lastSyncedAt: new Date(),
    },
  });

  await recordAudit({
    action: "CONNECT_ACCOUNT_CREATED",
    entityType: "CONNECT_ACCOUNT",
    entityId: account.id,
    actorType: input.actorId ? "USER" : "SERVICE",
    actorId: input.actorId ?? null,
    ip: input.ip ?? null,
    after: { sellerId: input.sellerId, stripeAccountId: account.id },
  });

  if (businessType === "company") {
    await ensureTradeLicense(account.id, input.sellerId, input.tradeLicenseDocumentUrl, account.requirements);
  }

  logger.info("Connected account created", { sellerId: input.sellerId, stripeAccountId: account.id });
  return { stripeAccountId: account.id, created: true };
}

/**
 * A single-use Stripe-hosted onboarding link.
 *
 * Account Links expire in minutes and are single-use, so this is called each
 * time the seller presses "continue verification" rather than stored.
 */
export async function createAccountLink(input: {
  sellerId: string;
  returnPath?: string;
  refreshPath?: string;
  /** A licence uploaded since the account was created, or a retry of one that failed before. */
  tradeLicenseDocumentUrl?: string | null;
}): Promise<{ url: string; expiresAt: Date }> {
  assertConnectEnabled();

  const account = await prisma.connectAccount.findUnique({ where: { sellerId: input.sellerId } });
  if (!account) {
    throw new AppError(404, "This seller has no payout account yet", "CONNECT_ACCOUNT_NOT_FOUND");
  }

  // Stripe's live requirements, not the cached copy: a missed webhook must not
  // cause a licence Stripe still needs to go unsent, or a spent one to be
  // re-uploaded. This also keeps `connect_accounts` fresh on every "Continue
  // verification" click, not just when a webhook happens to arrive.
  const live = await getStripeClient().accounts.retrieve(account.stripeAccountId);
  await syncConnectAccount(live);
  await ensureTradeLicense(account.stripeAccountId, input.sellerId, input.tradeLicenseDocumentUrl, live.requirements);

  const base = loadEnv().SELLER_DASHBOARD_URL.replace(/\/+$/, "");
  const link = await getStripeClient().accountLinks.create({
    account: account.stripeAccountId,
    type: "account_onboarding",
    return_url: `${base}${input.returnPath ?? "/payouts?connect=return"}`,
    refresh_url: `${base}${input.refreshPath ?? "/payouts?connect=refresh"}`,
    collection_options: { fields: "currently_due" },
  });

  return { url: link.url, expiresAt: new Date(link.expires_at * 1000) };
}

/** What the seller dashboard's payout-account card renders. */
export async function getConnectStatus(sellerId: string): Promise<ConnectStatus> {
  const account = await prisma.connectAccount.findUnique({ where: { sellerId } });
  const featureDisabled = !loadEnv().SELLER_CONNECT_ENABLED;

  if (!account) {
    return {
      connected: false,
      stripeAccountId: null,
      onboardingStatus: "NOT_STARTED",
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
      requirementsCurrentlyDue: [],
      requirementsPastDue: [],
      disabledReason: null,
      country: null,
      payoutSchedule: null,
      featureDisabled,
    };
  }

  return {
    connected: true,
    stripeAccountId: account.stripeAccountId,
    onboardingStatus: account.onboardingStatus as ConnectOnboardingStatus,
    chargesEnabled: account.chargesEnabled,
    payoutsEnabled: account.payoutsEnabled,
    detailsSubmitted: account.detailsSubmitted,
    requirementsCurrentlyDue: toStringArray(account.requirementsCurrentlyDue),
    requirementsPastDue: toStringArray(account.requirementsPastDue),
    disabledReason: account.disabledReason,
    country: account.country,
    payoutSchedule: account.payoutSchedule,
    featureDisabled,
  };
}

/** Pull the live account from Stripe and re-sync. Used by admins and the reconciler. */
export async function refreshConnectAccount(sellerId: string): Promise<ConnectStatus> {
  const account = await prisma.connectAccount.findUnique({ where: { sellerId } });
  if (!account) {
    throw new AppError(404, "This seller has no payout account yet", "CONNECT_ACCOUNT_NOT_FOUND");
  }

  const live = await getStripeClient().accounts.retrieve(account.stripeAccountId);
  await syncConnectAccount(live);
  return getConnectStatus(sellerId);
}

export type BankAccountView = {
  id: string;
  bankName: string | null;
  last4: string;
  currency: string;
  country: string | null;
  accountHolderName: string | null;
  /** Stripe's own verification state: "new" | "validated" | "verified" | "errored". */
  status: string;
  isDefault: boolean;
};

/**
 * The seller's bank account, as Stripe holds it.
 *
 * Custom connected accounts are created and owned by the platform, so the
 * platform's API key can read this - unlike Standard or Express accounts,
 * where the seller's own dashboard would be the only place to see it. Nothing
 * here is ever written by TradeAuct: this is read-only, and "update" sends the
 * seller back through a Stripe-hosted Account Link (see `createAccountLink`),
 * never a local form. TradeAuct does not store bank details at all.
 */
export async function getConnectedBankAccounts(sellerId: string): Promise<BankAccountView[]> {
  const account = await prisma.connectAccount.findUnique({ where: { sellerId } });
  if (!account) return [];

  const externalAccounts = await getStripeClient().accounts.listExternalAccounts(account.stripeAccountId, {
    object: "bank_account",
    limit: 10,
  });

  return externalAccounts.data
    .filter((ext): ext is Stripe.BankAccount => ext.object === "bank_account")
    .map((bank) => ({
      id: bank.id,
      bankName: bank.bank_name ?? null,
      last4: bank.last4,
      currency: bank.currency.toUpperCase(),
      country: bank.country ?? null,
      accountHolderName: bank.account_holder_name ?? null,
      status: bank.status,
      isDefault: bank.default_for_currency ?? false,
    }));
}

/** True when a transfer to this seller would be accepted. */
export async function isPayoutReady(
  sellerId: string,
): Promise<{ ready: boolean; reason?: string; accountId?: string }> {
  const account = await prisma.connectAccount.findUnique({ where: { sellerId } });
  if (!account) return { ready: false, reason: "The seller has no connected account" };
  if (!account.payoutsEnabled) {
    return {
      ready: false,
      reason: account.disabledReason ?? "The connected account cannot receive payouts yet",
      accountId: account.stripeAccountId,
    };
  }
  return { ready: true, accountId: account.stripeAccountId };
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}
