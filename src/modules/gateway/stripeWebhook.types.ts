import type Stripe from "stripe";

/**
 * Lifecycle of a received Stripe event.
 *
 * RECEIVED   - signature verified and the event persisted, not yet handled
 * PROCESSING - a worker has claimed the event
 * PROCESSED  - handled successfully
 * IGNORED    - no handler is registered for this event type
 * FAILED     - a handler threw; the stored payload allows a safe replay
 */
export type StripeWebhookStatus = "RECEIVED" | "PROCESSING" | "PROCESSED" | "IGNORED" | "FAILED";

/** Placed on the queue. The event body is read back from the log row. */
export type StripeWebhookJobData = {
  eventId: string;
  eventType: string;
};

/** What the controller answers Stripe with. */
export type StripeWebhookIntakeResult = {
  received: true;
  eventId: string;
  eventType: string;
  duplicate: boolean;
  queued: boolean;
};

/** Result of handling one event inside the worker. */
export type StripeWebhookHandlerResult = {
  status: Extract<StripeWebhookStatus, "PROCESSED" | "IGNORED">;
  detail?: Record<string, unknown>;
};

export type StripeWebhookHandler = (event: Stripe.Event) => Promise<StripeWebhookHandlerResult>;

/** The only route on this server reachable from the public internet. */
export const STRIPE_WEBHOOK_PATH = "/webhooks/stripe";
