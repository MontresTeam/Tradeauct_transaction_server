import { type Express, type Request, type Response, Router } from "express";
import rateLimit from "express-rate-limit";
import type { Env } from "../../core/env.js";
import { logger } from "../../core/logger.js";
import { ingestStripeWebhook } from "./stripeWebhook.service.js";
import { STRIPE_WEBHOOK_PATH } from "./stripeWebhook.types.js";

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

  router.post(STRIPE_WEBHOOK_PATH, webhookLimiter, (req: Request, res: Response) => {
    void (async () => {
      const signature = req.headers["stripe-signature"] as string | undefined;

      try {
        const result = await ingestStripeWebhook(req.rawBody, signature);
        res.status(200).json(result);
      } catch (error) {
        const statusCode = (error as { statusCode?: number })?.statusCode ?? 400;

        // 4xx tells Stripe not to retry something we will never accept — a bad
        // signature, a malformed body. 5xx tells it to retry, which is what we
        // want when the failure was ours.
        logger.warn("Stripe delivery rejected", { statusCode, error });

        res.status(statusCode).json({
          error: {
            code: (error as { errorCode?: string })?.errorCode ?? "WEBHOOK_ERROR",
            message: (error as Error)?.message ?? "Stripe webhook handling failed",
          },
        });
      }
    })();
  });

  app.use(router);
}
