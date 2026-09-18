/**
 * Service identity tokens.
 *
 * ES256 rather than a shared HMAC secret: each service signs with its own
 * private key and holds only the peer's public key, so compromising one side
 * does not yield the ability to impersonate the other.
 */
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { AppError } from "../errors/AppError.js";

export type ServiceTokenClaims = {
  iss: string;
  aud: string;
  jti: string;
  iat: number;
  exp: number;
};

export function signServiceToken(params: {
  privateKey: string;
  issuer: string;
  audience: string;
  ttlSeconds: number;
}): { token: string; jti: string } {
  const jti = randomUUID();
  const token = jwt.sign({ jti }, params.privateKey, {
    algorithm: "ES256",
    issuer: params.issuer,
    audience: params.audience,
    expiresIn: params.ttlSeconds,
  });
  return { token, jti };
}

export function verifyServiceToken(params: {
  token: string;
  publicKey: string;
  expectedIssuer: string;
  expectedAudience: string;
}): ServiceTokenClaims {
  try {
    const decoded = jwt.verify(params.token, params.publicKey, {
      algorithms: ["ES256"],
      issuer: params.expectedIssuer,
      audience: params.expectedAudience,
    }) as jwt.JwtPayload;

    if (!decoded.jti || !decoded.exp || !decoded.iat) {
      throw new AppError(401, "Service token is missing required claims", "SERVICE_TOKEN_INVALID");
    }

    return {
      iss: String(decoded.iss),
      aud: String(decoded.aud),
      jti: String(decoded.jti),
      iat: Number(decoded.iat),
      exp: Number(decoded.exp),
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(401, "Service token rejected", "SERVICE_TOKEN_INVALID");
  }
}
