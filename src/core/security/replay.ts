/**
 * Single-use guard for nonces and service-token ids.
 *
 * Backed by Redis so it holds across instances. If Redis cannot answer, the
 * guard reports failure and the caller rejects the request: an unverifiable
 * replay check is not a passed replay check.
 */
import type { Redis } from "ioredis";
import { AppError } from "../errors/AppError.js";

export type ReplayGuard = {
  claim(key: string, ttlSeconds: number): Promise<void>;
};

export function createReplayGuard(getRedis: () => Redis | null): ReplayGuard {
  return {
    async claim(key: string, ttlSeconds: number): Promise<void> {
      const redis = getRedis();
      if (!redis) {
        throw new AppError(503, "Replay protection unavailable", "REPLAY_GUARD_UNAVAILABLE");
      }

      let result: "OK" | null;
      try {
        result = await redis.set(`replay:${key}`, "1", "EX", ttlSeconds, "NX");
      } catch (_error) {
        throw new AppError(503, "Replay protection unavailable", "REPLAY_GUARD_UNAVAILABLE");
      }

      if (result !== "OK") {
        throw new AppError(401, "Request replay detected", "REQUEST_REPLAYED");
      }
    },
  };
}

/** In-memory guard for tests. Not safe across processes. */
export function createInMemoryReplayGuard(): ReplayGuard {
  const seen = new Map<string, number>();
  return {
    async claim(key: string, ttlSeconds: number): Promise<void> {
      const now = Date.now();
      for (const [k, expiry] of seen) {
        if (expiry <= now) seen.delete(k);
      }
      if (seen.has(key)) {
        throw new AppError(401, "Request replay detected", "REQUEST_REPLAYED");
      }
      seen.set(key, now + ttlSeconds * 1000);
    },
  };
}
