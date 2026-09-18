/**
 * Structured JSON logging.
 *
 * Money code logs are read during incidents and are retained, so this logger
 * emits machine-parsable lines, carries a trace id, and passes values through
 * a redactor rather than trusting call sites to remember what is sensitive.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const traceStore = new AsyncLocalStorage<{ traceId: string }>();

/** Keys whose values are never written to a log line. */
const SECRET_KEY_PATTERN = /(secret|password|token|authorization|signature|cvc|card_number|pan|bank)/i;
/** Keys whose values are written as a short fingerprint instead of in full. */
const IDENTITY_KEY_PATTERN = /(email|phone|fullName|street|addressLine)/i;

function maskIdentity(value: string): string {
  if (value.length <= 4) return "***";
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

export function redact(value: unknown, key = ""): unknown {
  if (value == null) return value;

  if (SECRET_KEY_PATTERN.test(key)) return "[redacted]";

  if (typeof value === "string") {
    return IDENTITY_KEY_PATTERN.test(key) ? maskIdentity(value) : value;
  }

  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return value;

  if (Array.isArray(value)) return value.map((item) => redact(item, key));

  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redact(v, k);
  }
  return out;
}

let minLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

function write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

  const line = {
    ts: new Date().toISOString(),
    level,
    service: "txn-server",
    traceId: getTraceId(),
    message,
    ...(context ? (redact(context) as Record<string, unknown>) : {}),
  };

  const serialized = JSON.stringify(line);
  if (level === "error") process.stderr.write(`${serialized}\n`);
  else process.stdout.write(`${serialized}\n`);
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) => write("debug", message, context),
  info: (message: string, context?: Record<string, unknown>) => write("info", message, context),
  warn: (message: string, context?: Record<string, unknown>) => write("warn", message, context),
  error: (message: string, context?: Record<string, unknown>) => write("error", message, context),
};

export function getTraceId(): string | undefined {
  return traceStore.getStore()?.traceId;
}

/** Run `fn` with a trace id attached to every log line it produces. */
export function withTrace<T>(traceId: string | undefined, fn: () => T): T {
  return traceStore.run({ traceId: traceId || randomUUID() }, fn);
}

export function newTraceId(): string {
  return randomUUID();
}
