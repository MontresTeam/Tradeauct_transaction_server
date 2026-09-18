/**
 * Worker that processes stored Stripe events.
 *
 * `jobId` is the Stripe event id, which gives a second layer of deduplication
 * on top of the `stripe_event_logs` unique constraint: a re-delivery that
 * arrives while the first is still queued does not create a second job.
 *
 * Failed jobs are kept. A payment event that could not be processed is
 * something a person needs to look at, not something to garbage-collect.
 */
import { Queue, Worker } from "bullmq";
import { loadEnv } from "../../core/env.js";
import { logger } from "../../core/logger.js";
import { getRedis, isRedisConnected } from "../../core/queue.js";
import { processStoredStripeEvent } from "./stripeWebhook.service.js";
import type { StripeWebhookJobData } from "./stripeWebhook.types.js";

let worker: Worker<StripeWebhookJobData> | null = null;
let queue: Queue<StripeWebhookJobData> | null = null;

export function initStripeWebhookWorker(): void {
  if (worker) return;

  const connection = getRedis();
  if (!connection || !isRedisConnected()) {
    logger.error("Stripe webhook worker not started: Redis is unavailable");
    return;
  }

  const env = loadEnv();

  queue = new Queue<StripeWebhookJobData>(env.STRIPE_WEBHOOK_QUEUE, { connection });
  worker = new Worker<StripeWebhookJobData>(
    env.STRIPE_WEBHOOK_QUEUE,
    async (job) => {
      const status = await processStoredStripeEvent(job.data.eventId);
      return { status };
    },
    { connection, concurrency: 5 },
  );

  worker.on("failed", (job, error) => {
    logger.error("Stripe webhook job failed", {
      eventId: job?.data.eventId,
      eventType: job?.data.eventType,
      attempts: job?.attemptsMade,
      error,
    });
  });

  logger.info("Stripe webhook worker started", { queue: env.STRIPE_WEBHOOK_QUEUE });
}

/**
 * Queue an event for processing.
 *
 * Returns false when there is no queue to put it on, in which case the caller
 * has already persisted the event and the HTTP path processes it inline —
 * slower, but never silently dropped.
 */
export async function enqueueStripeWebhookEvent(data: StripeWebhookJobData): Promise<boolean> {
  if (!queue) {
    const connection = getRedis();
    if (connection && isRedisConnected()) {
      queue = new Queue<StripeWebhookJobData>(loadEnv().STRIPE_WEBHOOK_QUEUE, { connection });
    }
  }

  if (!queue) {
    logger.warn("No queue available; processing the Stripe event inline", { eventId: data.eventId });
    await processStoredStripeEvent(data.eventId);
    return false;
  }

  await queue.add(data.eventType, data, {
    jobId: data.eventId,
    attempts: 5,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { age: 86400, count: 1000 },
    removeOnFail: false,
  });

  return true;
}

export async function stopStripeWebhookWorker(): Promise<void> {
  await worker?.close();
  await queue?.close();
  worker = null;
  queue = null;
}
