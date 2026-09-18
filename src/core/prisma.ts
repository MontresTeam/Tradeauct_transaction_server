import "./env.js";
import { PrismaClient } from "@prisma/client";
import { loadEnv } from "./env.js";
import { logger } from "./logger.js";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient(): PrismaClient {
  const env = loadEnv();
  return new PrismaClient({
    datasources: { db: { url: env.DATABASE_URL } },
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
