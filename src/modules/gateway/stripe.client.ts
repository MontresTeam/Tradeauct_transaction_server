import Stripe from "stripe";
import { loadEnv } from "../../core/env.js";

/**
 * The only Stripe client in the platform.
 *
 * `STRIPE_SECRET_KEY` is required by the env schema, so there is no
 * "configured?" branch here and no path that silently does nothing.
 */
let client: Stripe | null = null;

export function getStripeClient(): Stripe {
  if (client) return client;

  const env = loadEnv();
  client = new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: env.STRIPE_API_VERSION as Stripe.LatestApiVersion,
    maxNetworkRetries: 2,
    timeout: 20000,
    appInfo: { name: "Tradeauct-transaction-server" },
  });

  return client;
}

/** Test helper: drop the memoized client after changing the environment. */
export function resetStripeClient(): void {
  client = null;
}
