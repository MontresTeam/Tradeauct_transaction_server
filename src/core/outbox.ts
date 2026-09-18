/**
 * Transactional outbox.
 *
 * The money write and the announcement of it have to be all-or-nothing, but
 * they land in two different systems (Postgres and Redis). Writing the event
 * into the same database transaction as the state change, then relaying it
 * afterwards, gets that property without a distributed transaction: the relay
 * may deliver an event more than once, never zero times, so consumers dedup.
 */
import { randomUUID } from "node:crypto";
import { loadEnv } from "./env.js";
import { getTraceId, logger, withTrace } from "./logger.js";
import { type PrismaTransaction, prisma } from "./prisma.js";
import { getQueue } from "./queue.js";

export const TXN_EVENTS = {
  PAYMENT_SUCCEEDED: "PAYMENT_SUCCEEDED",
  PAYMENT_FAILED: "PAYMENT_FAILED",
  PAYMENT_CANCELED: "PAYMENT_CANCELED",
  PAYMENT_QUARANTINED: "PAYMENT_QUARANTINED",
  PAYMENT_RECOVERY_OPENED: "PAYMENT_RECOVERY_OPENED",
  PAYMENT_RECOVERY_EXPIRED: "PAYMENT_RECOVERY_EXPIRED",
  PAYMENT_RECOVERY_RECOVERED: "PAYMENT_RECOVERY_RECOVERED",
  REFUND_SUCCEEDED: "REFUND_SUCCEEDED",
  DISPUTE_OPENED: "DISPUTE_OPENED",
  DISPUTE_CLOSED: "DISPUTE_CLOSED",
  PAYOUT_PAID: "PAYOUT_PAID",
} as const;

export type TxnEventType = (typeof TXN_EVENTS)[keyof typeof TXN_EVENTS];

/** Wire contract shared with the main server's consumer. */
export type TxnEventEnvelope = {
  eventId: string;
  type: TxnEventType;
  version: 1;
  occurredAt: string;
  traceId?: string;
  payload: Record<string, unknown>;
};

/**
 * Queue an event as part of an existing database transaction.
 * Pass the transaction client, never the global one.
 */
export async function enqueueOutboxEvent(
  tx: PrismaTransaction,
  eventType: TxnEventType,
  payload: Record<string, unknown>,
): Promise<void> {
  await tx.outboxEvent.create({
    data: {
      eventType,
      payload: payload as never,
      traceId: getTraceId() ?? null,
    },
  });
}

const RELAY_BATCH_SIZE = 50;
const MAX_ATTEMPTS = 20;

/** Publish pending outbox rows. Safe to call concurrently. */
export async function relayOutboxOnce(): Promise<number> {
  const env = loadEnv();
  const pending = await prisma.outboxEvent.findMany({
    where: { publishedAt: null, attempts: { lt: MAX_ATTEMPTS } },
    orderBy: { createdAt: "asc" },
    take: RELAY_BATCH_SIZE,
  });

  if (pending.length === 0) return 0;

  const queue = getQueue(env.TXN_EVENTS_QUEUE);
  let published = 0;

  for (const row of pending) {
    const envelope: TxnEventEnvelope = {
      eventId: row.id,
      type: row.eventType as TxnEventType,
      version: 1,
      occurredAt: row.createdAt.toISOString(),
      traceId: row.traceId ?? undefined,
      payload: (row.payload ?? {}) as Record<string, unknown>,
    };

    await withTrace(row.traceId ?? randomUUID(), async () => {
      try {
        await queue.add(envelope.type, envelope, {
          // The outbox row id is the event id, so a relay that crashes after
          // adding but before marking published cannot create a second job.
          jobId: envelope.eventId,
          attempts: 10,
          backoff: { type: "exponential", delay: 5000 },
          removeOnComplete: { age: 86400, count: 5000 },
          removeOnFail: false,
        });

        await prisma.outboxEvent.update({
          where: { id: row.id },
          data: { publishedAt: new Date(), attempts: { increment: 1 } },
        });
        published += 1;
      } catch (error) {
        logger.error("Outbox relay failed for event", { eventId: row.id, type: row.eventType, error });
        await prisma.outboxEvent.update({
          where: { id: row.id },
          data: { attempts: { increment: 1 }, lastError: String((error as Error).message ?? error).slice(0, 500) },
        });
      }
    });
  }

  return published;
}

let relayTimer: NodeJS.Timeout | null = null;

export function startOutboxRelay(intervalMs = 1000): void {
  if (relayTimer) return;

  const tick = async (): Promise<void> => {
    try {
      const count = await relayOutboxOnce();
      if (count > 0) logger.debug("Outbox relayed events", { count });
    } catch (error) {
      logger.error("Outbox relay tick failed", { error });
    }
  };

  void tick();
  relayTimer = setInterval(() => void tick(), intervalMs);
  logger.info("Outbox relay started", { intervalMs });
}

export function stopOutboxRelay(): void {
  if (!relayTimer) return;
  clearInterval(relayTimer);
  relayTimer = null;
}
