/**
 * Outbound calls to the main server, signed with the same scheme this server
 * enforces on the way in.
 */
import { AppError } from "../errors/AppError.js";
import { getTraceId, logger } from "../logger.js";
import { signServiceToken } from "./serviceJwt.js";
import {
  computeSignature,
  KEY_ID_HEADER,
  NONCE_HEADER,
  newNonce,
  SERVICE_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  TRACE_HEADER,
} from "./signing.js";

export type SignedClientConfig = {
  baseUrl: string;
  serviceName: string;
  audience: string;
  keyId: string;
  hmacSecret: string;
  privateKey: string;
  tokenTtlSeconds: number;
  defaultTimeoutMs?: number;
};

export type SignedRequest = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  timeoutMs?: number;
  headers?: Record<string, string>;
};

export type SignedResponse<T = unknown> = {
  status: number;
  body: T;
};

export function createSignedClient(config: SignedClientConfig) {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");

  async function request<T = unknown>(options: SignedRequest): Promise<SignedResponse<T>> {
    const path = options.path.startsWith("/") ? options.path : `/${options.path}`;
    const payload = options.body === undefined ? "" : JSON.stringify(options.body);
    const timestamp = String(Date.now());
    const nonce = newNonce();

    const signature = computeSignature(config.hmacSecret, {
      method: options.method,
      path,
      timestamp,
      nonce,
      body: payload,
    });

    const { token } = signServiceToken({
      privateKey: config.privateKey,
      issuer: config.serviceName,
      audience: config.audience,
      ttlSeconds: config.tokenTtlSeconds,
    });

    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      [SERVICE_HEADER]: config.serviceName,
      [KEY_ID_HEADER]: config.keyId,
      [TIMESTAMP_HEADER]: timestamp,
      [NONCE_HEADER]: nonce,
      [SIGNATURE_HEADER]: signature,
      ...(getTraceId() ? { [TRACE_HEADER]: getTraceId() as string } : {}),
      ...options.headers,
    };

    if (payload) {
      headers["content-type"] = "application/json";
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? config.defaultTimeoutMs ?? 5000);

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: options.method,
        headers,
        body: payload || undefined,
        signal: controller.signal,
      });

      const text = await response.text();
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { raw: text };
        }
      }

      return { status: response.status, body: parsed as T };
    } catch (error) {
      logger.error("Signed call to the main server failed", { path, method: options.method, error });
      throw new AppError(502, "Main server is unreachable", "MAIN_SERVER_UNREACHABLE");
    } finally {
      clearTimeout(timeout);
    }
  }

  return { request };
}
