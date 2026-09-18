import { generateKeyPairSync, randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import jwt from "jsonwebtoken";
import { beforeEach, describe, expect, it } from "vitest";
import { AppError } from "../errors/AppError.js";
import { createInMemoryReplayGuard } from "./replay.js";
import { createServiceAuthMiddleware, type ServiceAuthConfig } from "./serviceAuth.js";
import { signServiceToken } from "./serviceJwt.js";
import {
  computeSignature,
  KEY_ID_HEADER,
  NONCE_HEADER,
  newNonce,
  SERVICE_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from "./signing.js";

const { privateKey: mainPrivateKey, publicKey: mainPublicKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const KEY_ID = "k-test";
const HMAC_SECRET = randomBytes(48).toString("base64url");

function baseConfig(overrides: Partial<ServiceAuthConfig> = {}): ServiceAuthConfig {
  return {
    keys: [{ keyId: KEY_ID, secret: HMAC_SECRET }],
    publicKey: mainPublicKey,
    expectedIssuer: "main-server",
    expectedAudience: "txn-server",
    maxSkewSeconds: 120,
    replayWindowSeconds: 300,
    replayGuard: createInMemoryReplayGuard(),
    ipAllowlist: [],
    ...overrides,
  };
}

type SignedRequestOptions = {
  method?: string;
  path?: string;
  body?: unknown;
  timestamp?: string;
  nonce?: string;
  keyId?: string;
  secret?: string;
  tokenTtlSeconds?: number;
  ip?: string;
  /** Body sent on the wire after signing, to simulate tampering. */
  wireBody?: string;
};

function buildRequest(options: SignedRequestOptions = {}): Request {
  const method = options.method ?? "POST";
  const path = options.path ?? "/internal/v1/ping";
  const payload = options.body === undefined ? "" : JSON.stringify(options.body);
  const timestamp = options.timestamp ?? String(Date.now());
  const nonce = options.nonce ?? newNonce();

  const signature = computeSignature(options.secret ?? HMAC_SECRET, {
    method,
    path,
    timestamp,
    nonce,
    body: payload,
  });

  const { token } = signServiceToken({
    privateKey: mainPrivateKey,
    issuer: "main-server",
    audience: "txn-server",
    ttlSeconds: options.tokenTtlSeconds ?? 60,
  });

  const wire = options.wireBody ?? payload;

  return {
    method,
    originalUrl: path,
    url: path,
    path,
    ip: options.ip ?? "127.0.0.1",
    socket: { remoteAddress: options.ip ?? "127.0.0.1" },
    headers: {
      authorization: `Bearer ${token}`,
      [SERVICE_HEADER]: "main-server",
      [KEY_ID_HEADER]: options.keyId ?? KEY_ID,
      [TIMESTAMP_HEADER]: timestamp,
      [NONCE_HEADER]: nonce,
      [SIGNATURE_HEADER]: signature,
    },
    rawBody: Buffer.from(wire),
  } as unknown as Request;
}

/** Run the middleware and resolve with whatever it passed to next(). */
function run(config: ServiceAuthConfig, req: Request): Promise<unknown> {
  const middleware = createServiceAuthMiddleware(config);
  return new Promise((resolve) => {
    middleware(req, {} as Response, (err?: unknown) => resolve(err));
  });
}

function expectRejected(result: unknown, code: string, status = 401): void {
  expect(result).toBeInstanceOf(AppError);
  expect((result as AppError).errorCode).toBe(code);
  expect((result as AppError).statusCode).toBe(status);
}

describe("service authentication", () => {
  let config: ServiceAuthConfig;

  beforeEach(() => {
    config = baseConfig();
  });

  it("accepts a correctly signed request", async () => {
    const req = buildRequest({ body: { listingId: "lst_1" } });
    const result = await run(config, req);

    expect(result).toBeUndefined();
    expect(req.serviceCaller).toEqual({
      service: "main-server",
      keyId: KEY_ID,
      jti: expect.any(String),
    });
  });

  it("rejects an unsigned request", async () => {
    const req = buildRequest();
    delete (req.headers as Record<string, unknown>)[SIGNATURE_HEADER];

    expectRejected(await run(config, req), "SERVICE_AUTH_HEADER_MISSING");
  });

  it("rejects a request with no service token", async () => {
    const req = buildRequest();
    delete (req.headers as Record<string, unknown>).authorization;

    expectRejected(await run(config, req), "SERVICE_TOKEN_MISSING");
  });

  it("rejects an expired service token", async () => {
    const req = buildRequest();
    const expired = jwt.sign({ jti: "expired-token" }, mainPrivateKey, {
      algorithm: "ES256",
      issuer: "main-server",
      audience: "txn-server",
      expiresIn: "-10s",
    });
    (req.headers as Record<string, unknown>).authorization = `Bearer ${expired}`;

    expectRejected(await run(config, req), "SERVICE_TOKEN_INVALID");
  });

  it("rejects a token signed by an unknown key", async () => {
    const other = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const req = buildRequest();
    const { token } = signServiceToken({
      privateKey: other.privateKey,
      issuer: "main-server",
      audience: "txn-server",
      ttlSeconds: 60,
    });
    (req.headers as Record<string, unknown>).authorization = `Bearer ${token}`;

    expectRejected(await run(config, req), "SERVICE_TOKEN_INVALID");
  });

  it("rejects a token issued for a different audience", async () => {
    const req = buildRequest();
    const { token } = signServiceToken({
      privateKey: mainPrivateKey,
      issuer: "main-server",
      audience: "some-other-service",
      ttlSeconds: 60,
    });
    (req.headers as Record<string, unknown>).authorization = `Bearer ${token}`;

    expectRejected(await run(config, req), "SERVICE_TOKEN_INVALID");
  });

  it("rejects a body edited after signing", async () => {
    const req = buildRequest({
      body: { amount: 10 },
      wireBody: JSON.stringify({ amount: 1000000 }),
    });

    expectRejected(await run(config, req), "SERVICE_SIGNATURE_INVALID");
  });

  it("rejects a signature replayed against a different path", async () => {
    const req = buildRequest({ path: "/internal/v1/ping" });
    (req as { originalUrl: string }).originalUrl = "/internal/v1/refunds";

    expectRejected(await run(config, req), "SERVICE_SIGNATURE_INVALID");
  });

  it("rejects an unknown signing key id", async () => {
    const req = buildRequest({ keyId: "k-rotated-out" });

    expectRejected(await run(config, req), "SERVICE_KEY_UNKNOWN");
  });

  it("rejects a stale timestamp", async () => {
    const req = buildRequest({ timestamp: String(Date.now() - 10 * 60 * 1000) });

    expectRejected(await run(config, req), "SERVICE_TIMESTAMP_SKEWED");
  });

  it("rejects a future timestamp beyond the skew window", async () => {
    const req = buildRequest({ timestamp: String(Date.now() + 10 * 60 * 1000) });

    expectRejected(await run(config, req), "SERVICE_TIMESTAMP_SKEWED");
  });

  it("accepts a request once and rejects the replay", async () => {
    const nonce = newNonce();
    const timestamp = String(Date.now());
    const first = buildRequest({ nonce, timestamp, body: { a: 1 } });
    const second = buildRequest({ nonce, timestamp, body: { a: 1 } });

    expect(await run(config, first)).toBeUndefined();
    expectRejected(await run(config, second), "REQUEST_REPLAYED");
  });

  it("accepts a request signed with the previous key during rotation", async () => {
    const previousSecret = randomBytes(48).toString("base64url");
    const rotating = baseConfig({
      keys: [
        { keyId: "k-new", secret: HMAC_SECRET },
        { keyId: "k-old", secret: previousSecret },
      ],
    });
    const req = buildRequest({ keyId: "k-old", secret: previousSecret });

    expect(await run(rotating, req)).toBeUndefined();
  });

  it("rejects a caller outside the address allowlist", async () => {
    const restricted = baseConfig({ ipAllowlist: ["10.0.1.4"] });
    const req = buildRequest({ ip: "203.0.113.9" });

    expectRejected(await run(restricted, req), "SERVICE_ADDRESS_FORBIDDEN", 403);
  });

  it("accepts a caller on the address allowlist", async () => {
    const restricted = baseConfig({ ipAllowlist: ["10.0.1.4"] });
    const req = buildRequest({ ip: "10.0.1.4" });

    expect(await run(restricted, req)).toBeUndefined();
  });

  it("fails closed when the replay guard cannot answer", async () => {
    const broken = baseConfig({
      replayGuard: {
        async claim(): Promise<void> {
          throw new AppError(503, "Replay protection unavailable", "REPLAY_GUARD_UNAVAILABLE");
        },
      },
    });

    expectRejected(await run(broken, buildRequest()), "REPLAY_GUARD_UNAVAILABLE", 503);
  });
});
