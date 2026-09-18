/**
 * Inbound authentication for /internal routes.
 *
 * Four checks, all of which must pass:
 *   1. an ES256 service JWT proves which service is calling;
 *   2. an HMAC signature binds the request to its method, path, time and body;
 *   3. the nonce and the token id are each redeemable once;
 *   4. the caller's address is on the allowlist, when one is configured.
 *
 * The end user's own token is handled separately (see actorAuth), because
 * "which service called" and "on whose behalf" are different questions and a
 * compromised main server must not be able to answer the second one freely.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { AppError } from "../errors/AppError.js";
import { logger } from "../logger.js";
import type { ReplayGuard } from "./replay.js";
import { verifyServiceToken } from "./serviceJwt.js";
import {
  computeSignature,
  KEY_ID_HEADER,
  NONCE_HEADER,
  SERVICE_HEADER,
  SIGNATURE_HEADER,
  signaturesMatch,
  TIMESTAMP_HEADER,
} from "./signing.js";

export type ServiceAuthConfig = {
  /** Accepted signing keys, newest first. Two entries allow a rotation window. */
  keys: Array<{ keyId: string; secret: string }>;
  publicKey: string;
  expectedIssuer: string;
  expectedAudience: string;
  maxSkewSeconds: number;
  replayWindowSeconds: number;
  replayGuard: ReplayGuard;
  /** Empty means "do not check the caller address". */
  ipAllowlist: string[];
};

export type ServiceCaller = {
  service: string;
  keyId: string;
  jti: string;
};

declare module "express-serve-static-core" {
  interface Request {
    serviceCaller?: ServiceCaller;
    rawBody?: Buffer;
  }
}

function header(req: Request, name: string): string {
  const value = req.headers[name];
  return typeof value === "string" ? value : "";
}

function requireHeader(req: Request, name: string): string {
  const value = header(req, name);
  if (!value) {
    throw new AppError(401, `Missing ${name} header`, "SERVICE_AUTH_HEADER_MISSING");
  }
  return value;
}

function normalizeAddress(address: string): string {
  // Express reports IPv4-mapped IPv6 addresses as ::ffff:127.0.0.1.
  return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}

function addressAllowed(address: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  const normalized = normalizeAddress(address);
  return allowlist.some((entry) => {
    const allowed = normalizeAddress(entry);
    if (allowed.endsWith(".")) return normalized.startsWith(allowed);
    return allowed === normalized;
  });
}

/**
 * The signature covers the path as the caller signed it, which includes the
 * query string. `req.originalUrl` preserves both; `req.path` would not.
 */
function signedPath(req: Request): string {
  return req.originalUrl || req.url;
}

export function createServiceAuthMiddleware(config: ServiceAuthConfig): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    void (async () => {
      try {
        const address = req.ip || req.socket.remoteAddress || "";
        if (!addressAllowed(address, config.ipAllowlist)) {
          logger.warn("Internal call from an address outside the allowlist", { address, path: req.path });
          throw new AppError(403, "Caller address not permitted", "SERVICE_ADDRESS_FORBIDDEN");
        }

        const authorization = req.headers.authorization;
        if (!authorization?.startsWith("Bearer ")) {
          throw new AppError(401, "Missing service token", "SERVICE_TOKEN_MISSING");
        }

        const claims = verifyServiceToken({
          token: authorization.slice("Bearer ".length).trim(),
          publicKey: config.publicKey,
          expectedIssuer: config.expectedIssuer,
          expectedAudience: config.expectedAudience,
        });

        const keyId = requireHeader(req, KEY_ID_HEADER);
        const timestamp = requireHeader(req, TIMESTAMP_HEADER);
        const nonce = requireHeader(req, NONCE_HEADER);
        const signature = requireHeader(req, SIGNATURE_HEADER);

        const timestampMs = Number(timestamp);
        if (!Number.isFinite(timestampMs)) {
          throw new AppError(401, "Invalid request timestamp", "SERVICE_TIMESTAMP_INVALID");
        }

        const skewSeconds = Math.abs(Date.now() - timestampMs) / 1000;
        if (skewSeconds > config.maxSkewSeconds) {
          throw new AppError(401, "Request timestamp outside the accepted window", "SERVICE_TIMESTAMP_SKEWED");
        }

        const key = config.keys.find((candidate) => candidate.keyId === keyId);
        if (!key) {
          throw new AppError(401, "Unknown signing key", "SERVICE_KEY_UNKNOWN");
        }

        const body = req.rawBody ?? Buffer.alloc(0);
        const expected = computeSignature(key.secret, {
          method: req.method,
          path: signedPath(req),
          timestamp,
          nonce,
          body,
        });

        if (!signaturesMatch(expected, signature)) {
          throw new AppError(401, "Request signature rejected", "SERVICE_SIGNATURE_INVALID");
        }

        // Claimed only after the signature verifies, so an unsigned flood
        // cannot exhaust the nonce space for legitimate callers.
        await config.replayGuard.claim(`nonce:${keyId}:${nonce}`, config.replayWindowSeconds);
        await config.replayGuard.claim(`jti:${claims.jti}`, config.replayWindowSeconds);

        req.serviceCaller = {
          service: header(req, SERVICE_HEADER) || claims.iss,
          keyId,
          jti: claims.jti,
        };

        next();
      } catch (error) {
        next(error);
      }
    })();
  };
}
