/**
 * The background jobs that move settlements along.
 *
 * Four repeatable jobs on one queue:
 *
 *   release        every 5 min — ON_HOLD whose window has passed → ELIGIBLE
 *   transfer       every 5 min — ELIGIBLE → Stripe transfer
 *   reconcile      hourly      — TradeAuct's records against Stripe's
 *   cleanup        hourly      — expired idempotency keys
 *
 * These are BullMQ repeatable jobs rather than `setInterval`, which the old
 * settlement cron used. The difference matters with more than one instance
 * running: a repeatable job fires once across the fleet, while a timer fires
 * once per process. The per-settlement work is claimed atomically anyway, so
 * a double fire would be safe — but it would also be wasted.
 *
 * Each settlement is scheduled as its own job with `jobId = <kind>:<id>`, so a
 * settlement already queued is not queued twice.
 */
import { type Job, Queue, Worker } from "bullmq";
import { loadEnv } from "../../core/env.js";
import { logger, withTrace } from "../../core/logger.js";
import { prisma } from "../../core/prisma.js";
import { getRedis, isRedisConnected } from "../../core/queue.js";
import { automaticTransfersAllowed, findTransferCandidates, transferSettlement } from "../payouts/payout.service.js";
import { runReconciliation } from "../reconciliation/reconciliation.service.js";
import { getSettlementConfig } from "../settings/settlementConfig.service.js";
import { findReleaseCandidates, releaseIfEligible } from "./settlement.service.js";

export const SETTLEMENT_JOBS = {
  SCAN_RELEASES: "scan-releases",
  RELEASE_ONE: "release-one",
  SCAN_TRANSFERS: "scan-transfers",
  TRANSFER_ONE: "transfer-one",
  RECONCILE: "reconcile",
  CLEANUP_IDEMPOTENCY: "cleanup-idempotency",
} as const;

const SCAN_INTERVAL_MS = 5 * 60 * 1000;
const HOURLY_MS = 60 * 60 * 1000;

let queue: Queue | null = null;
let worker: Worker | null = null;

export function getSettlementQueue(): Queue | null {
  return queue;
}

/** Queue one settlement for release evaluation, at most once. */
export async function enqueueRelease(settlementId: string): Promise<void> {
  if (!queue) return;
  await queue.add(
    SETTLEMENT_JOBS.RELEASE_ONE,
    { settlementId },
    { jobId: `release:${settlementId}`, attempts: 5, backoff: { type: "exponential", delay: 10000 } },
  );
}

/** Queue one settlement for transfer, at most once. */
export async function enqueueTransfer(settlementId: string): Promise<void> {
  if (!queue) return;
  await queue.add(
    SETTLEMENT_JOBS.TRANSFER_ONE,
    { settlementId },
    {
      jobId: `transfer:${settlementId}`,
      // Generous: a Stripe timeout must be retried with the same idempotency
      // key rather than abandoned, and the key never changes between tries.
      attempts: 8,
      backoff: { type: "exponential", delay: 15000 },
      removeOnFail: false,
    },
  );
}

async function handleScanReleases(): Promise<{ queued: number }> {
  const config = await getSettlementConfig();
  if (!config.automaticSettlementEnabled) {
    logger.debug("Release scan skipped: automatic settlement is off");
    return { queued: 0 };
  }

  const candidates = await findReleaseCandidates();
  for (const settlementId of candidates) {
    await enqueueRelease(settlementId);
  }

  if (candidates.length > 0) logger.info("Release candidates queued", { count: candidates.length });
  return { queued: candidates.length };
}

async function handleScanTransfers(): Promise<{ queued: number }> {
  const gate = await automaticTransfersAllowed();
  if (!gate.allowed) {
    logger.debug("Transfer scan skipped", { reason: gate.reason });
    return { queued: 0 };
  }

  const candidates = await findTransferCandidates();
  for (const settlementId of candidates) {
    await enqueueTransfer(settlementId);
  }

  if (candidates.length > 0) logger.info("Transfer candidates queued", { count: candidates.length });
  return { queued: candidates.length };
}

/** Delete idempotency keys past their TTL, in batches so the table is not locked. */
async function handleCleanupIdempotency(): Promise<{ deleted: number }> {
  const deleted = await prisma.idempotencyKey.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });

  if (deleted.count > 0) logger.info("Expired idempotency keys removed", { count: deleted.count });
  return { deleted: deleted.count };
}

export function initSettlementWorker(): void {
  if (worker) return;

  const connection = getRedis();
  if (!connection || !isRedisConnected()) {
    logger.error("Settlement worker not started: Redis is unavailable");
    return;
  }

  const env = loadEnv();
  queue = new Queue(env.SETTLEMENT_QUEUE, { connection });

  worker = new Worker(
    env.SETTLEMENT_QUEUE,
    async (job: Job) => {
      return withTrace(job.data?.traceId, async () => {
        switch (job.name) {
          case SETTLEMENT_JOBS.SCAN_RELEASES:
            return handleScanReleases();

          case SETTLEMENT_JOBS.RELEASE_ONE: {
            const result = await releaseIfEligible(String(job.data.settlementId));
            return {
              settlementId: job.data.settlementId,
              released: result.changed,
              reason: result.refusedReason ?? null,
            };
          }

          case SETTLEMENT_JOBS.SCAN_TRANSFERS:
            return handleScanTransfers();

          case SETTLEMENT_JOBS.TRANSFER_ONE:
            return transferSettlement(String(job.data.settlementId));

          case SETTLEMENT_JOBS.RECONCILE:
            return runReconciliation();

          case SETTLEMENT_JOBS.CLEANUP_IDEMPOTENCY:
            return handleCleanupIdempotency();

          default:
            logger.warn("Unknown settlement job ignored", { name: job.name });
            return { ignored: true };
        }
      });
    },
    // Low concurrency on purpose. These jobs call Stripe and write money; the
    // bottleneck should be deliberate, not the database connection pool.
    { connection, concurrency: 4 },
  );

  worker.on("failed", (job, error) => {
    logger.error("Settlement job failed", {
      name: job?.name,
      data: job?.data,
      attempts: job?.attemptsMade,
      error,
    });
  });

  void scheduleRepeatables();
  logger.info("Settlement worker started", { queue: env.SETTLEMENT_QUEUE });
}

/**
 * Register the repeatable jobs.
 *
 * `jobId` is fixed per schedule, so restarting the server re-registers the
 * same schedule rather than accumulating a new one each time.
 */
async function scheduleRepeatables(): Promise<void> {
  if (!queue) return;

  try {
    await queue.add(
      SETTLEMENT_JOBS.SCAN_RELEASES,
      {},
      { repeat: { every: SCAN_INTERVAL_MS }, jobId: "repeat:scan-releases", removeOnComplete: { count: 50 } },
    );
    await queue.add(
      SETTLEMENT_JOBS.SCAN_TRANSFERS,
      {},
      { repeat: { every: SCAN_INTERVAL_MS }, jobId: "repeat:scan-transfers", removeOnComplete: { count: 50 } },
    );
    await queue.add(
      SETTLEMENT_JOBS.RECONCILE,
      {},
      { repeat: { every: HOURLY_MS }, jobId: "repeat:reconcile", removeOnComplete: { count: 50 } },
    );
    await queue.add(
      SETTLEMENT_JOBS.CLEANUP_IDEMPOTENCY,
      {},
      { repeat: { every: HOURLY_MS }, jobId: "repeat:cleanup-idempotency", removeOnComplete: { count: 50 } },
    );

    logger.info("Settlement schedules registered", {
      scanIntervalMs: SCAN_INTERVAL_MS,
      reconcileIntervalMs: HOURLY_MS,
    });
  } catch (error) {
    logger.error("Could not register the settlement schedules", { error });
  }
}

export async function stopSettlementWorker(): Promise<void> {
  await worker?.close();
  await queue?.close();
  worker = null;
  queue = null;
}
