/**
 * Environment for the transaction server.
 *
 * Every secret this server needs is required, with no fallback and no
 * development bypass. A payment process that boots with a missing Stripe key
 * or an unset service secret is a process that will fail open somewhere later,
 * so the cheapest place to stop it is here.
 */
import fs from "node:fs";
import dotenv from "dotenv";

export function setupEnvironment(): void {
  dotenv.config();

  // Mirrors TradeAuct_backend_server: `.db_target` / DB_ENV selects which env
  // file wins, so both servers read the same database in local development.
  let target = "local";
  const dbEnv = process.env.DB_ENV?.toLowerCase();

  if (dbEnv === "prod" || dbEnv === "production" || process.env.USE_PROD_DB === "true") {
    target = "prod";
  } else if (dbEnv === "local" || dbEnv === "development" || process.env.USE_LOCAL_DB === "true") {
    target = "local";
  } else if (fs.existsSync(".db_target")) {
    const fileContent = fs.readFileSync(".db_target", "utf8").trim().toLowerCase();
    if (fileContent === "prod" || fileContent === "production") {
      target = "prod";
    }
  }

  if (target === "local" && fs.existsSync(".env.local")) {
    dotenv.config({ path: ".env.local", override: true });
  } else if (target === "prod" && fs.existsSync(".env")) {
    dotenv.config({ path: ".env", override: true });
  }
}

setupEnvironment();

import { z } from "zod";

function normalizeDatabaseUrl(value: string): string {
  const trimmed = value.trim();
  if (/^postgres(?:ql)?:\/\//i.test(trimmed)) return trimmed;
  if (/^\/\//.test(trimmed)) return `postgresql:${trimmed}`;
  return trimmed ? `postgresql://${trimmed}` : trimmed;
}

/** PEM keys survive .env round-trips as `\n`-escaped single lines. */
function normalizePem(value: string): string {
  return value.includes("\n") ? value.replace(/\n/g, "\n") : value;
}

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  );

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(9100),
  /** Bind address. Defaults to loopback: this server is never internet-facing. */
  HOST: z.string().default("127.0.0.1"),
  DATABASE_URL: z.string().min(1).transform(normalizeDatabaseUrl),
  REDIS_URL: z.string().min(1, "REDIS_URL is required: idempotency and replay defence depend on it"),

  /** Verifies end-user (buyer/admin) access tokens forwarded by the main server. */
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),

  /** Stripe. This process is the only one in the platform that holds the secret key. */
  STRIPE_SECRET_KEY: z.string().min(1, "STRIPE_SECRET_KEY is required"),
  STRIPE_PUBLISHABLE_KEY: z.string().min(1, "STRIPE_PUBLISHABLE_KEY is required"),
  STRIPE_WEBHOOK_SECRET: z.string().min(1, "STRIPE_WEBHOOK_SECRET is required"),
  /**
   * Connect events are delivered to their own endpoint with their own secret.
   * Optional so the server still boots before Connect is set up; the Connect
   * webhook route refuses deliveries while it is unset rather than accepting
   * unverifiable ones.
   */
  STRIPE_CONNECT_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_API_VERSION: z.string().default("2025-02-24.acacia"),

  /**
   * The two hard gates on seller money movement.
   *
   * These are engineering kill switches, separate from the Super Admin
   * toggles in SETTLEMENT_CONFIG. Both an env flag and its admin toggle must
   * be on before anything moves; see the plan §8. They default off, so a
   * production deploy that forgets to set them does nothing rather than
   * something irreversible.
   */
  SELLER_CONNECT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  SELLER_AUTO_TRANSFER_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  /** ISO country for connected accounts created by this platform. */
  CONNECT_ACCOUNT_COUNTRY: z.string().length(2).default("AE"),
  /**
   * Payout schedule set on new connected accounts. "manual" gives TradeAuct
   * one payout per settlement, which maps 1:1 but costs a payout fee each
   * time; "daily" is cheaper but bundles settlements (plan Q4).
   */
  CONNECT_PAYOUT_INTERVAL: z.enum(["manual", "daily", "weekly", "monthly"]).default("manual"),
  /** Where Stripe returns the seller after hosted onboarding. */
  SELLER_DASHBOARD_URL: z.string().default("http://localhost:5174"),

  /** Service-to-service authentication (see core/security). */
  SERVICE_NAME: z.string().default("txn-server"),
  SERVICE_KEY_ID: z.string().min(1, "SERVICE_KEY_ID is required"),
  SERVICE_HMAC_SECRET: z.string().min(32, "SERVICE_HMAC_SECRET must be at least 32 characters"),
  /** Second active key during rotation; requests may be signed with either. */
  SERVICE_HMAC_SECRET_PREVIOUS: z.string().optional(),
  SERVICE_KEY_ID_PREVIOUS: z.string().optional(),
  /** Public key of the main server, used to verify its service JWTs. */
  SERVICE_JWT_PUBLIC_KEY_MAIN: z.string().min(1, "SERVICE_JWT_PUBLIC_KEY_MAIN is required").transform(normalizePem),
  /** This server's own private key, used to sign callbacks to the main server. */
  SERVICE_JWT_PRIVATE_KEY_TXN: z.string().min(1, "SERVICE_JWT_PRIVATE_KEY_TXN is required").transform(normalizePem),
  SERVICE_JWT_TTL_SECONDS: z.coerce.number().min(15).max(300).default(60),
  /** Rejected outside this window, in seconds, in either direction. */
  SERVICE_SIGNATURE_MAX_SKEW_SECONDS: z.coerce.number().min(30).max(600).default(120),
  SERVICE_REPLAY_WINDOW_SECONDS: z.coerce.number().min(60).max(3600).default(300),

  /** Where callbacks to the main server go. */
  MAIN_SERVER_URL: z.string().min(1, "MAIN_SERVER_URL is required"),
  /** Comma-separated CIDRs / addresses permitted to reach /internal. Empty disables the check. */
  INTERNAL_IP_ALLOWLIST: csv,

  /** Queue names shared with the main server. */
  TXN_EVENTS_QUEUE: z.string().default("txn-events"),
  TXN_COMMANDS_QUEUE: z.string().default("txn-commands"),
  STRIPE_WEBHOOK_QUEUE: z.string().default("stripe-webhooks"),
  /** Repeatable settlement release, transfer and reconciliation jobs. */
  SETTLEMENT_QUEUE: z.string().default("settlements"),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const fields = parsed.error.flatten().fieldErrors;
    throw new Error(
      `Invalid environment for the transaction server: ${JSON.stringify(fields)}. ` +
        "Run `npm run keys:generate` to create the service keys, and copy .env.example for the rest.",
    );
  }

  cached = parsed.data;
  return cached;
}

/** Test helper: forget the memoized env after mutating process.env. */
export function resetEnvCache(): void {
  cached = null;
}
