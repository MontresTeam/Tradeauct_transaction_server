/**
 * Idempotency-Key handling for mutating endpoints.
 *
 * Networks lose responses, and a lost response to "charge this card" is
 * indistinguishable from a failure. Callers therefore send a key; the first
 * request with that key does the work and has its response stored, and every
 * later request with the same key gets that stored response back rather than
 * a second charge.
 *
 * A key replayed with a *different* body is a caller bug, not a retry, and is
 * rejected — silently doing the new work under an old key would hide it.
 */
import { createHash } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { AppError } from "./errors/AppError.js";
import { logger } from "./logger.js";
import { prisma } from "./prisma.js";
import { IDEMPOTENCY_HEADER } from "./security/signing.js";

const DEFAULT_TTL_HOURS = 24;

/**
 * How long a claim may sit without a stored response before it is considered
 * abandoned.
 *
 * It has to exceed the longest a request can legitimately run. The Stripe
 * client is configured with a 20-second timeout and two network retries, so
 * roughly a minute is the realistic ceiling; two minutes leaves room and still
 * unblocks a buyer quickly. Stripe's own idempotency keys are the backstop if
 * a takeover ever does overlap a live request.
 */
const IN_PROGRESS_LEASE_MS = 2 * 60 * 1000;

export function requestHash(method: string, path: string, body: Buffer | string): string {
  return createHash("sha256").update(`${method.toUpperCase()}\n${path}\n`).update(body).digest("hex");
}

export type IdempotencyOptions = {
  scope: string;
  ttlHours?: number;
};

export function idempotent(options: IdempotencyOptions): RequestHandler {
  const ttlHours = options.ttlHours ?? DEFAULT_TTL_HOURS;

  return (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      try {
        const key = req.headers[IDEMPOTENCY_HEADER];
        if (typeof key !== "string" || key.trim().length < 8) {
          throw new AppError(
            400,
            "An Idempotency-Key header of at least 8 characters is required for this operation",
            "IDEMPOTENCY_KEY_REQUIRED",
          );
        }

        const scope = options.scope;
        const hash = requestHash(req.method, req.originalUrl || req.url, req.rawBody ?? Buffer.alloc(0));
        const actorId = req.actor?.userId ?? null;

        const existing = await prisma.idempotencyKey.findUnique({
          where: { scope_key: { scope, key } },
        });

        if (existing) {
          if (existing.requestHash !== hash) {
            throw new AppError(
              409,
              "This Idempotency-Key was already used with a different request body",
              "IDEMPOTENCY_KEY_REUSED",
            );
          }

          if (existing.completedAt && existing.responseStatus) {
            logger.info("Replaying stored idempotent response", { scope, status: existing.responseStatus });
            res.status(existing.responseStatus).json(existing.responseBody ?? {});
            return;
          }

          /**
           * A claim with no stored response. Either the first request is still
           * running, or it died before it could release the key.
           *
           * The difference matters. Without a lease, a process that crashed
           * mid-request left the key claimed for its whole 24-hour TTL, and
           * every retry got a 409 — the buyer could not check out that listing
           * again for a day. The release path is also best-effort: it runs
           * after the response is sent, so a database that is refusing
           * connections at that moment loses it entirely.
           *
           * So a claim older than the lease is treated as abandoned and taken
           * over. The lease is longer than any request can legitimately take,
           * and `updateMany` on the old `lockedAt` makes the takeover atomic:
           * two racing retries produce exactly one winner.
           */
          const leaseAge = Date.now() - existing.lockedAt.getTime();

          if (leaseAge < IN_PROGRESS_LEASE_MS) {
            throw new AppError(
              409,
              "A request with this Idempotency-Key is still in progress",
              "IDEMPOTENCY_IN_PROGRESS",
            );
          }

          const takeover = await prisma.idempotencyKey.updateMany({
            where: { scope, key, completedAt: null, lockedAt: existing.lockedAt },
            data: { lockedAt: new Date() },
          });

          if (takeover.count === 0) {
            throw new AppError(
              409,
              "A request with this Idempotency-Key is still in progress",
              "IDEMPOTENCY_IN_PROGRESS",
            );
          }

          logger.warn("Took over an abandoned idempotency claim", {
            scope,
            ageMs: leaseAge,
            path: req.path,
          });

          captureResponse(req, res, scope, key);
          next();
          return;
        }

        try {
          await prisma.idempotencyKey.create({
            data: {
              key,
              scope,
              actorId,
              requestHash: hash,
              expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000),
            },
          });
        } catch (error) {
          // Unique violation: another request claimed the key between our read
          // and our write. Treat it as in-progress.
          if ((error as { code?: string }).code === "P2002") {
            throw new AppError(
              409,
              "A request with this Idempotency-Key is still in progress",
              "IDEMPOTENCY_IN_PROGRESS",
            );
          }
          throw error;
        }

        captureResponse(req, res, scope, key);
        next();
      } catch (error) {
        next(error);
      }
    })();
  };
}

/**
 * Store the response so the next request with the same key can replay it.
 * A failed request releases the key instead: a decline should be retryable.
 */
function captureResponse(req: Request, res: Response, scope: string, key: string): void {
  const originalJson = res.json.bind(res);

  res.json = (body: unknown): Response => {
    const status = res.statusCode;

    void (async () => {
      try {
        if (status >= 200 && status < 300) {
          await prisma.idempotencyKey.update({
            where: { scope_key: { scope, key } },
            data: {
              responseStatus: status,
              responseBody: body as never,
              completedAt: new Date(),
            },
          });
        } else {
          await prisma.idempotencyKey.delete({ where: { scope_key: { scope, key } } });
        }
      } catch (error) {
        logger.error("Failed to record idempotent response", { scope, path: req.path, error });
      }
    })();

    return originalJson(body);
  };
}
