import { type Express, type Request, type Response, Router } from "express";
import rateLimit from "express-rate-limit";
import type { Env } from "../../core/env.js";
import { logger } from "../../core/logger.js";
import { ingestStripeWebhook } from "./stripeWebhook.service.js";
import { STRIPE_CONNECT_WEBHOOK_PATH, STRIPE_WEBHOOK_PATH, type StripeWebhookSource } from "./stripeWebhook.types.js";

/**
 * The Stripe webhook endpoint — the only route on this server that anything
 * outside the private network may reach.
 *
 * It has no service signature and no user token, because Stripe has neither.
 * Its authentication is the Stripe signature, checked inside
 * `ingestStripeWebhook` against the raw bytes.
 */
export function registerGatewayModule(app: Express, _env: Env): void {
  const router = Router();

  // Generous, because Stripe legitimately bursts, but not unbounded: an
  // unauthenticated public endpoint should not be a free way to make this
  // server do database work.
  const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 600,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: "RATE_LIMITED", message: "Too many webhook deliveries" } },
  });

  /**
   * Both endpoints do the same work; they differ only in which secret
   * verifies the signature. Connect events are signed with the Connect
   * endpoint's own secret, so a delivery meant for one endpoint cannot be
   * replayed against the other.
   */
  const handleDelivery =
    (source: StripeWebhookSource) =>
    (req: Request, res: Response): void => {
      void (async () => {
        const signature = req.headers["stripe-signature"] as string | undefined;

        try {
          const result = await ingestStripeWebhook(req.rawBody, signature, source);
          res.status(200).json(result);
        } catch (error) {
          const statusCode = (error as { statusCode?: number })?.statusCode ?? 400;

          // 4xx tells Stripe not to retry something we will never accept — a bad
          // signature, a malformed body. 5xx tells it to retry, which is what we
          // want when the failure was ours.
          logger.warn("Stripe delivery rejected", { statusCode, source, error });

          res.status(statusCode).json({
            error: {
              code: (error as { errorCode?: string })?.errorCode ?? "WEBHOOK_ERROR",
              message: (error as Error)?.message ?? "Stripe webhook handling failed",
            },
          });
        }
      })();
    };

  router.post(STRIPE_CONNECT_WEBHOOK_PATH, webhookLimiter, handleDelivery("connect"));
  router.post(STRIPE_WEBHOOK_PATH, webhookLimiter, handleDelivery("platform"));

  app.use(router);
}
