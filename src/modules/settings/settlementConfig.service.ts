/**
 * Settlement configuration — the numbers Super Admin owns.
 *
 * The client asked for a 7-day protection period "for now", and asked
 * explicitly that it not be hard-coded. So it lives here, in a versioned
 * SystemSetting row with an audit trail, and the value is snapshotted onto
 * each settlement at delivery: changing it tomorrow changes tomorrow's
 * deliveries, never an order already counting down.
 *
 * `automaticPayoutEnabled` is the business pause button. It is not the safety
 * gate — the env flags in core/env.ts are, and both must be on before money
 * moves. See payment_settlement_implementation_plan.md §8.
 */
import { recordAudit } from "../../core/audit.js";
import { AppError } from "../../core/errors/AppError.js";
import { logger } from "../../core/logger.js";
import { prisma } from "../../core/prisma.js";

export const SETTLEMENT_SETTING_KEY = "SETTLEMENT_CONFIG";

export type SettlementConfig = {
  /** Days after confirmed delivery before a settlement may become eligible. */
  protectionPeriodDays: number;
  /** Whether the release worker may move ON_HOLD settlements to ELIGIBLE. */
  automaticSettlementEnabled: boolean;
  /** Whether the transfer worker may send eligible settlements to Stripe. */
  automaticPayoutEnabled: boolean;
  /** Settlements below this net amount wait to be batched or paid manually. */
  minimumPayoutAmount: number;
  /**
   * Whether a buyer pressing "confirm receipt" ends the window early.
   * Default false: the client's rule is 7 days after delivery (plan Q1).
   */
  allowEarlyReleaseOnBuyerConfirmation: boolean;
  version: string;
  updatedAt?: string;
};

export const DEFAULT_SETTLEMENT_CONFIG: SettlementConfig = {
  protectionPeriodDays: 7,
  automaticSettlementEnabled: true,
  // Off by default. Turning this on is a deliberate act once Stripe has
  // verified the account, not something a fresh database should do.
  automaticPayoutEnabled: false,
  minimumPayoutAmount: 0,
  allowEarlyReleaseOnBuyerConfirmation: false,
  version: "1.0.0",
};

/** Bounds, so a typo in an admin form cannot hold a seller's money for a year. */
const MAX_PROTECTION_PERIOD_DAYS = 90;

function coerce(stored: Record<string, unknown>): SettlementConfig {
  const days = Number(stored.protectionPeriodDays);
  return {
    protectionPeriodDays:
      Number.isFinite(days) && days >= 0 && days <= MAX_PROTECTION_PERIOD_DAYS
        ? Math.floor(days)
        : DEFAULT_SETTLEMENT_CONFIG.protectionPeriodDays,
    automaticSettlementEnabled:
      typeof stored.automaticSettlementEnabled === "boolean"
        ? stored.automaticSettlementEnabled
        : DEFAULT_SETTLEMENT_CONFIG.automaticSettlementEnabled,
    automaticPayoutEnabled:
      typeof stored.automaticPayoutEnabled === "boolean"
        ? stored.automaticPayoutEnabled
        : DEFAULT_SETTLEMENT_CONFIG.automaticPayoutEnabled,
    minimumPayoutAmount:
      Number.isFinite(Number(stored.minimumPayoutAmount)) && Number(stored.minimumPayoutAmount) >= 0
        ? Number(stored.minimumPayoutAmount)
        : DEFAULT_SETTLEMENT_CONFIG.minimumPayoutAmount,
    allowEarlyReleaseOnBuyerConfirmation:
      typeof stored.allowEarlyReleaseOnBuyerConfirmation === "boolean"
        ? stored.allowEarlyReleaseOnBuyerConfirmation
        : DEFAULT_SETTLEMENT_CONFIG.allowEarlyReleaseOnBuyerConfirmation,
    version: typeof stored.version === "string" ? stored.version : DEFAULT_SETTLEMENT_CONFIG.version,
    updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : undefined,
  };
}

export async function getSettlementConfig(): Promise<SettlementConfig> {
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key: SETTLEMENT_SETTING_KEY } });
    if (row?.value && typeof row.value === "object") {
      return coerce(row.value as Record<string, unknown>);
    }
  } catch (error) {
    logger.error("Settlement configuration read failed; using defaults", { error });
  }

  return DEFAULT_SETTLEMENT_CONFIG;
}

export type SettlementConfigUpdate = Partial<Omit<SettlementConfig, "version" | "updatedAt">>;

export async function updateSettlementConfig(
  updates: SettlementConfigUpdate,
  actor: { id?: string | null; ip?: string | null; reason?: string | null },
): Promise<SettlementConfig> {
  if (updates.protectionPeriodDays !== undefined) {
    const days = Number(updates.protectionPeriodDays);
    if (!Number.isInteger(days) || days < 0 || days > MAX_PROTECTION_PERIOD_DAYS) {
      throw new AppError(
        400,
        `The protection period must be a whole number of days between 0 and ${MAX_PROTECTION_PERIOD_DAYS}.`,
        "SETTLEMENT_CONFIG_INVALID",
      );
    }
  }

  if (updates.minimumPayoutAmount !== undefined && Number(updates.minimumPayoutAmount) < 0) {
    throw new AppError(400, "The minimum payout amount cannot be negative.", "SETTLEMENT_CONFIG_INVALID");
  }

  const current = await getSettlementConfig();
  const parts = (current.version || "1.0.0").split(".").map((part) => Number.parseInt(part, 10) || 0);
  if (parts.length === 3) parts[2] += 1;

  const merged: SettlementConfig = {
    ...current,
    ...updates,
    version: parts.join("."),
    updatedAt: new Date().toISOString(),
  };

  await prisma.systemSetting.upsert({
    where: { key: SETTLEMENT_SETTING_KEY },
    update: { value: merged as never },
    create: { key: SETTLEMENT_SETTING_KEY, value: merged as never },
  });

  await recordAudit({
    action: "SETTLEMENT_CONFIG_UPDATED",
    entityType: "SYSTEM_SETTING",
    entityId: SETTLEMENT_SETTING_KEY,
    actorType: "ADMIN",
    actorId: actor.id ?? null,
    ip: actor.ip ?? null,
    reason: actor.reason ?? null,
    before: current,
    after: merged,
  });

  logger.info("Settlement configuration updated", {
    version: merged.version,
    protectionPeriodDays: merged.protectionPeriodDays,
    automaticPayoutEnabled: merged.automaticPayoutEnabled,
  });

  return merged;
}

/** The change history the admin settings page renders under the form. */
export async function getSettlementConfigHistory(limit = 25): Promise<
  Array<{
    id: string;
    actorId: string | null;
    reason: string | null;
    before: unknown;
    after: unknown;
    createdAt: Date;
  }>
> {
  const rows = await prisma.serviceAuditLog.findMany({
    where: { action: "SETTLEMENT_CONFIG_UPDATED", entityId: SETTLEMENT_SETTING_KEY },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 100),
    select: { id: true, actorId: true, reason: true, before: true, after: true, createdAt: true },
  });

  return rows;
}
