import "./env.js";
import { PrismaClient } from "@prisma/client";
import { loadEnv } from "./env.js";
import { logger } from "./logger.js";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Cap the connection pool.
 *
 * Prisma's default pool is `num_cpus * 2 + 1` per client. The main server and
 * this one share a managed Postgres whose ceiling is small — 25 on the current
 * cluster — so two unbounded pools exhaust it between them and every query
 * starts failing with "remaining connection slots are reserved for roles with
 * the SUPERUSER attribute", including the ones that would tell you why.
 *
 * `DATABASE_POOL_SIZE` overrides it where the ceiling is higher. An explicit
 * `connection_limit` already in the URL always wins.
 */
function withPoolLimit(url: string): string {
  if (url.includes("connection_limit=")) return url;

  const limit = Number.parseInt(process.env.DATABASE_POOL_SIZE ?? "", 10);
  const poolSize = Number.isFinite(limit) && limit > 0 ? limit : 5;
  const separator = url.includes("?") ? "&" : "?";

  return `${url}${separator}connection_limit=${poolSize}&pool_timeout=20`;
}

function createClient(): PrismaClient {
  const env = loadEnv();
  return new PrismaClient({
    datasources: { db: { url: withPoolLimit(env.DATABASE_URL) } },
    log: process.env.PRISMA_LOG_QUERIES === "true" ? ["query", "warn", "error"] : ["warn", "error"],
  });
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export type PrismaTransaction = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export async function assertDatabaseConnection(maxRetries = 5, delayMs = 1500): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      logger.info("Database connection established");
      return;
    } catch (error) {
      logger.warn("Database connection attempt failed", { attempt, maxRetries, error });
      if (attempt === maxRetries) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
