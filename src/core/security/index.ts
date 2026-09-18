import type { RequestHandler } from "express";
import type { Env } from "../env.js";
import { getRedis } from "../queue.js";
import { createActorAuthMiddleware } from "./actorAuth.js";
import { createReplayGuard } from "./replay.js";
import { createServiceAuthMiddleware } from "./serviceAuth.js";
import { createSignedClient } from "./signedClient.js";

export type Security = {
  /** Proves the caller is the main server. Mount on every /internal route. */
  requireService: RequestHandler;
  /** Proves whose behalf the call is on. Mount on buyer-scoped routes. */
  requireActor: RequestHandler;
  /** Proves the actor is an active admin, optionally holding a permission. */
  requireAdminActor: (permission?: string) => RequestHandler;
  /** Outbound, signed calls back to the main server. */
  mainServer: ReturnType<typeof createSignedClient>;
};

export function createSecurity(env: Env): Security {
  const keys = [{ keyId: env.SERVICE_KEY_ID, secret: env.SERVICE_HMAC_SECRET }];
  if (env.SERVICE_KEY_ID_PREVIOUS && env.SERVICE_HMAC_SECRET_PREVIOUS) {
    keys.push({ keyId: env.SERVICE_KEY_ID_PREVIOUS, secret: env.SERVICE_HMAC_SECRET_PREVIOUS });
  }

  const requireService = createServiceAuthMiddleware({
    keys,
    publicKey: env.SERVICE_JWT_PUBLIC_KEY_MAIN,
    expectedIssuer: "main-server",
    expectedAudience: env.SERVICE_NAME,
    maxSkewSeconds: env.SERVICE_SIGNATURE_MAX_SKEW_SECONDS,
    replayWindowSeconds: env.SERVICE_REPLAY_WINDOW_SECONDS,
    replayGuard: createReplayGuard(getRedis),
    ipAllowlist: env.INTERNAL_IP_ALLOWLIST,
  });

  const { requireActor, requireAdminActor } = createActorAuthMiddleware({ jwtSecret: env.JWT_SECRET });

  const mainServer = createSignedClient({
    baseUrl: env.MAIN_SERVER_URL,
    serviceName: env.SERVICE_NAME,
    audience: "main-server",
    keyId: env.SERVICE_KEY_ID,
    hmacSecret: env.SERVICE_HMAC_SECRET,
    privateKey: env.SERVICE_JWT_PRIVATE_KEY_TXN,
    tokenTtlSeconds: env.SERVICE_JWT_TTL_SECONDS,
  });

  return { requireService, requireActor, requireAdminActor, mainServer };
}
