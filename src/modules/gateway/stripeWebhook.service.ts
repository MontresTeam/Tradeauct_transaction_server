/**
 * Stripe webhook intake: verify, persist, queue, answer.
 *
 * No business work happens on the HTTP path. Stripe times out at 20 seconds
 * and re-delivers, so the request does the minimum that cannot be deferred —
 * proving the event is genuine and writing it down — and the worker does the
 * rest.
 */
import type Stripe from "stripe";
import { loadEnv } from "../../core/env.js";
import { AppError } from "../../core/errors/AppError.js";
import { logger } from "../../core/logger.js";
import { prisma } from "../../core/prisma.js";
import { getStripeClient } from "./stripe.client.js";
import { handleStripeEvent, isHandledStripeEvent } from "./stripeWebhook.handlers.js";
import type { StripeWebhookIntakeResult, StripeWebhookStatus } from "./stripeWebhook.types.js";

/**
 * Verify the signature over the exact bytes Stripe sent.
 *
 * There is no fallback path that parses the body. A forged
 * `payment_intent.succeeded` fulfils an order nobody paid for, so an
 * unverifiable delivery is refused — the webhook secret is required by the
 * environment schema, so "not configured" cannot happen at runtime.
 */
export function verifyStripeEvent(payloadBuffer: Buffer | undefined, signature: string | undefined): Stripe.Event {
  if (!signature) {
    throw new AppError(400, "Missing stripe-signature header", "WEBHOOK_SIGNATURE_MISSING");
  }

  if (!Buffer.isBuffer(payloadBuffer)) {
    throw new AppError(
      400,
      "Webhook body was not received as a raw buffer; the signature cannot be verified.",
      "WEBHOOK_RAW_BODY_MISSING",
    );
  }

  try {
    return getStripeClient().webhooks.constructEvent(payloadBuffer, signature, loadEnv().STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    logger.warn("Stripe signature verification failed", { error });
    throw new AppError(400, "Webhook signature verification failed", "WEBHOOK_SIGNATURE_INVALID");
  }
}

/**
 * Persist the event, using the unique `eventId` as the deduplication lock.
 *
 * The row is written *before* any handler runs, so two instances racing on the
 * same re-delivery cannot both process it: the loser hits the unique
 * constraint and reports a duplicate.
 */
export async function recordIncomingEvent(event: Stripe.Event): Promise<{ duplicate: boolean }> {
  const existing = await prisma.stripeEventLog.findUnique({ where: { eventId: event.id } });
  if (existing) return { duplicate: true };

  try {
    await prisma.stripeEventLog.create({
      data: {
        eventId: event.id,
        eventType: event.type,
        status: "RECEIVED" satisfies StripeWebhookStatus,
        metadata: {
          receivedAt: new Date().toISOString(),
          attempts: 0,
          // Kept so a FAILED event can be replayed without asking Stripe to
          // resend it.
          payload: JSON.parse(JSON.stringify(event)),
        },
      },
    });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") {
      return { duplicate: true };
    }
    throw error;
  }

  return { duplicate: false };
}

async function updateEventStatus(
  eventId: string,
  status: StripeWebhookStatus,
  extra?: Record<string, unknown>,
): Promise<void> {
  const existing = await prisma.stripeEventLog.findUnique({ where: { eventId } });
  const currentMetadata = (existing?.metadata as Record<string, unknown> | null) ?? {};

  await prisma.stripeEventLog.update({
    where: { eventId },
    data: {
      status,
      metadata: { ...currentMetadata, ...extra, statusUpdatedAt: new Date().toISOString() },
    },
  });
}

export async function markEventProcessing(eventId: string): Promise<void> {
  const existing = await prisma.stripeEventLog.findUnique({ where: { eventId } });
  const currentMetadata = (existing?.metadata as Record<string, unknown> | null) ?? {};
  const attempts = Number(currentMetadata.attempts ?? 0) + 1;

  await updateEventStatus(eventId, "PROCESSING", { attempts });
}

/**
 * Run the handler for a stored event and record the outcome.
 *
 * Throws on handler failure so BullMQ retries with backoff — and, when there
 * is no queue, so the HTTP caller sees a 5xx and Stripe retries instead.
 */
export async function processStoredStripeEvent(eventId: string): Promise<StripeWebhookStatus> {
  const log = await prisma.stripeEventLog.findUnique({ where: { eventId } });

  if (!log) {
    logger.warn("No stored event to process", { eventId });
    return "FAILED";
  }

  if (log.status === "PROCESSED" || log.status === "IGNORED") {
    return log.status as StripeWebhookStatus;
  }

  const metadata = (log.metadata as Record<string, unknown> | null) ?? {};
  const event = metadata.payload as Stripe.Event | undefined;

  if (!event?.type) {
    await updateEventStatus(eventId, "FAILED", { error: "Stored event payload is missing or malformed" });
    return "FAILED";
  }

  await markEventProcessing(eventId);

  try {
    const result = await handleStripeEvent(event);
    await updateEventStatus(eventId, result.status, {
      detail: result.detail,
      processedAt: new Date().toISOString(),
      error: null,
    });
    logger.info("Stripe event handled", { eventId, eventType: event.type, status: result.status });
    return result.status;
  } catch (error) {
    await updateEventStatus(eventId, "FAILED", {
      error: (error as Error)?.message ?? String(error),
      failedAt: new Date().toISOString(),
    });
    logger.error("Stripe event handler failed", { eventId, eventType: event.type, error });
    throw error;
  }
}

/** verify → record → queue. Fast by design. */
export async function ingestStripeWebhook(
  payloadBuffer: Buffer | undefined,
  signature: string | undefined,
): Promise<StripeWebhookIntakeResult> {
  const event = verifyStripeEvent(payloadBuffer, signature);
  const { duplicate } = await recordIncomingEvent(event);

  if (duplicate) {
    logger.info("Duplicate Stripe delivery ignored", { eventId: event.id, eventType: event.type });
    return { received: true, eventId: event.id, eventType: event.type, duplicate: true, queued: false };
  }

  if (!isHandledStripeEvent(event.type)) {
    await updateEventStatus(event.id, "IGNORED", { reason: `No handler registered for ${event.type}` });
    return { received: true, eventId: event.id, eventType: event.type, duplicate: false, queued: false };
  }

  // Imported lazily so code that only verifies — the tests, for instance —
  // does not pull Redis into its import graph.
  const { enqueueStripeWebhookEvent } = await import("./stripeWebhook.worker.js");
  const queued = await enqueueStripeWebhookEvent({ eventId: event.id, eventType: event.type });

  return { received: true, eventId: event.id, eventType: event.type, duplicate: false, queued };
}
