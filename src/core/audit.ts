/**
 * Audit trail for money mutations.
 *
 * Every write that moves money, or changes what can move money, leaves a row:
 * who did it, from where, what the values were before and after. Reads are not
 * audited here — they would drown the signal.
 *
 * Auditing never fails the operation it describes. A failed audit write is
 * logged loudly and the caller continues: refusing a refund because the audit
 * table was unreachable would be a worse outcome than a gap in the trail.
 */
import type { Request } from "express";
import { getTraceId, logger } from "./logger.js";
import { type PrismaTransaction, prisma } from "./prisma.js";

export type AuditActorType = "USER" | "ADMIN" | "SERVICE" | "SYSTEM";

export type AuditEntry = {
  action: string;
  entityType: string;
  entityId?: string | null;
  actorType?: AuditActorType;
  actorId?: string | null;
  service?: string | null;
  amountMinor?: bigint | null;
  currency?: string | null;
  ip?: string | null;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
};

/** Pull actor, service and address out of a request that has passed auth. */
export function auditContext(req: Request): Pick<AuditEntry, "actorType" | "actorId" | "service" | "ip"> {
  const role = req.actor?.role;
  return {
    actorType: role && role !== "BUYER" ? "ADMIN" : req.actor ? "USER" : "SERVICE",
    actorId: req.actor?.userId ?? null,
    service: req.serviceCaller?.service ?? null,
    ip: req.ip ?? null,
  };
}

/**
 * Write an audit row. Pass a transaction client when the audit must land with
 * the change it describes; omit it for after-the-fact records.
 */
export async function recordAudit(entry: AuditEntry, tx?: PrismaTransaction): Promise<void> {
  const client = tx ?? prisma;

  try {
    await client.serviceAuditLog.create({
      data: {
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        actorType: entry.actorType ?? "SYSTEM",
        actorId: entry.actorId ?? null,
        service: entry.service ?? null,
        amountMinor: entry.amountMinor ?? null,
        currency: entry.currency ?? null,
        ip: entry.ip ?? null,
        traceId: getTraceId() ?? null,
        reason: entry.reason ?? null,
        before: (entry.before ?? null) as never,
        after: (entry.after ?? null) as never,
      },
    });
  } catch (error) {
    if (tx) throw error;
    logger.error("Audit write failed", { action: entry.action, entityType: entry.entityType, error });
  }
}
