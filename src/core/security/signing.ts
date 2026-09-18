/**
 * Request signing shared by both ends of the main-server <-> transaction-server
 * link.
 *
 * The signature covers the method, path, timestamp, nonce and a hash of the
 * exact body bytes. Binding all five means a captured request cannot be
 * replayed, retargeted at a different route, or have its body edited in
 * transit by anything sitting between the two services.
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-ta-signature";
export const KEY_ID_HEADER = "x-ta-key-id";
export const TIMESTAMP_HEADER = "x-ta-timestamp";
export const NONCE_HEADER = "x-ta-nonce";
export const SERVICE_HEADER = "x-ta-service";
export const ACTOR_HEADER = "x-ta-actor";
export const TRACE_HEADER = "x-ta-trace-id";
export const IDEMPOTENCY_HEADER = "idempotency-key";

export type SignatureMaterial = {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  body: Buffer | string;
};

export function sha256Hex(body: Buffer | string): string {
  return createHash("sha256").update(body).digest("hex");
}

/**
 * The exact bytes that get signed. Newline-separated so no field can absorb
 * another: a path containing a newline still cannot forge a timestamp.
 */
export function canonicalString(material: SignatureMaterial): string {
  return [
    material.method.toUpperCase(),
    material.path,
    material.timestamp,
    material.nonce,
    sha256Hex(material.body),
  ].join("\n");
}

export function computeSignature(secret: string, material: SignatureMaterial): string {
  return createHmac("sha256", secret).update(canonicalString(material)).digest("base64");
}

export function signaturesMatch(expected: string, received: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function newNonce(): string {
  return randomUUID();
}
