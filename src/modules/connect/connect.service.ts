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
    include: { businessProfile: true, individualProfile: true, user: { select: { email: true } } },
  });

  if (!seller) {
    throw new AppError(404, "Seller not found", "SELLER_NOT_FOUND");
  }

  const env = loadEnv();
  const businessName =
    seller.businessProfile?.legalBusinessName ||
    seller.businessProfile?.businessName ||
    seller.individualProfile?.storeName ||
    undefined;

  const account = await getStripeClient().accounts.create(
    {
      type: "custom",
      country: env.CONNECT_ACCOUNT_COUNTRY,
      email: input.email ?? seller.user?.email ?? undefined,
      capabilities: { transfers: { requested: true } },
      business_type: seller.sellerType === "INDIVIDUAL" ? "individual" : "company",
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
    // Keyed on the seller: a retried onboarding click cannot create a second
    // connected account for the same person.
    { idempotencyKey: `tradeauct_connect_account_${input.sellerId}` },
  );

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
}): Promise<{ url: string; expiresAt: Date }> {
  assertConnectEnabled();

  const account = await prisma.connectAccount.findUnique({ where: { sellerId: input.sellerId } });
  if (!account) {
    throw new AppError(404, "This seller has no payout account yet", "CONNECT_ACCOUNT_NOT_FOUND");
  }

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
