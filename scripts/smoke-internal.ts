/**
 * End-to-end check of the signed boundary.
 *
 * Signs requests exactly the way TradeAuct_backend_server does — using the
 * main server's private key and the shared HMAC secret — and asserts that a
 * good call is accepted and that each way of breaking it is refused. Run it
 * against a running transaction server:
 *
 *     npx tsx scripts/smoke-internal.ts
 *
 * It needs the main server's SERVICE_JWT_PRIVATE_KEY_MAIN, so run it where
 * that value is available (the main server's env file, or exported).
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";

dotenv.config({ path: ".env.local" });
dotenv.config();

const MAIN_ENV_PATH = process.env.MAIN_ENV_PATH ?? path.resolve("../TradeAuct_backend_server/.env.local");
if (fs.existsSync(MAIN_ENV_PATH)) {
  // The main server's private key lives there, not here.
  dotenv.config({ path: MAIN_ENV_PATH });
}

const BASE_URL = process.env.TXN_SERVER_URL ?? "http://localhost:9100";
const KEY_ID = required("SERVICE_KEY_ID");
const HMAC_SECRET = required("SERVICE_HMAC_SECRET");
const PRIVATE_KEY = required("SERVICE_JWT_PRIVATE_KEY_MAIN").replace(/\\n/g, "\n");

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. Run \`npm run keys:generate\` and configure both servers.`);
    process.exit(1);
  }
  return value;
}

type CallOptions = {
  method?: string;
  path: string;
  body?: unknown;
  tamperBody?: unknown;
  omitSignature?: boolean;
  nonce?: string;
  timestamp?: string;
  actorToken?: string;
};

async function call(options: CallOptions): Promise<{ status: number; body: unknown }> {
  const method = options.method ?? "GET";
  const payload = options.body === undefined ? "" : JSON.stringify(options.body);
  const timestamp = options.timestamp ?? String(Date.now());
  const nonce = options.nonce ?? randomUUID();

  const canonical = [
    method,
    options.path,
    timestamp,
    nonce,
    createHash("sha256").update(payload).digest("hex"),
  ].join("\n");

  const signature = createHmac("sha256", HMAC_SECRET).update(canonical).digest("base64");
  const token = jwt.sign({ jti: randomUUID() }, PRIVATE_KEY, {
    algorithm: "ES256",
    issuer: "main-server",
    audience: "txn-server",
    expiresIn: 60,
  });

  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "x-ta-service": "main-server",
    "x-ta-key-id": KEY_ID,
    "x-ta-timestamp": timestamp,
    "x-ta-nonce": nonce,
  };
  if (!options.omitSignature) headers["x-ta-signature"] = signature;
  if (payload || options.tamperBody !== undefined) headers["content-type"] = "application/json";
  if (options.actorToken) headers["x-ta-actor"] = options.actorToken;

  const wireBody = options.tamperBody !== undefined ? JSON.stringify(options.tamperBody) : payload || undefined;

  const response = await fetch(`${BASE_URL}${options.path}`, { method, headers, body: wireBody });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

let failures = 0;

function check(name: string, actual: number, expected: number, body?: unknown): void {
  const ok = actual === expected;
  if (!ok) failures += 1;
  const code =
    body && typeof body === "object" && "error" in (body as Record<string, unknown>)
      ? ((body as { error?: { code?: string } }).error?.code ?? "")
      : "";
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${actual}${code ? ` ${code}` : ""} (expected ${expected})`);
}

async function main(): Promise<void> {
  console.log(`Transaction server: ${BASE_URL}\n`);

  const health = await fetch(`${BASE_URL}/health`);
  check("health is reachable", health.status, 200);

  const ok = await call({ path: "/internal/v1/ping" });
  check("signed ping is accepted", ok.status, 200, ok.body);

  const unsigned = await call({ path: "/internal/v1/ping", omitSignature: true });
  check("unsigned ping is rejected", unsigned.status, 401, unsigned.body);

  const tampered = await call({
    method: "POST",
    path: "/internal/v1/ping",
    body: { amount: 10 },
    tamperBody: { amount: 1000000 },
  });
  check("edited body is rejected", tampered.status, 401, tampered.body);

  const stale = await call({ path: "/internal/v1/ping", timestamp: String(Date.now() - 10 * 60 * 1000) });
  check("stale timestamp is rejected", stale.status, 401, stale.body);

  const nonce = randomUUID();
  const first = await call({ path: "/internal/v1/ping", nonce });
  check("first use of a nonce is accepted", first.status, 200, first.body);
  const replay = await call({ path: "/internal/v1/ping", nonce });
  check("replayed nonce is rejected", replay.status, 401, replay.body);

  const noActor = await call({ path: "/internal/v1/whoami" });
  check("actor-scoped route without a user token is rejected", noActor.status, 401, noActor.body);

  const forgedWebhook = await fetch(`${BASE_URL}/webhooks/stripe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "evt_fake", type: "payment_intent.succeeded" }),
  });
  // 404 until phase 4 mounts the endpoint; 400 once it exists. Never 200.
  const webhookOk = forgedWebhook.status === 400 || forgedWebhook.status === 404;
  if (!webhookOk) failures += 1;
  console.log(`${webhookOk ? "PASS" : "FAIL"}  forged webhook is not accepted — ${forgedWebhook.status}`);

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("Smoke run failed:", error);
  process.exit(1);
});
