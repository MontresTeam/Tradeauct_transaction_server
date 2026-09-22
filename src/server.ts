import "./core/env.js";
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { loadEnv } from "./core/env.js";
import { logger, setLogLevel } from "./core/logger.js";
import { startOutboxRelay, stopOutboxRelay } from "./core/outbox.js";
import { assertDatabaseConnection, prisma } from "./core/prisma.js";
import { closeQueues, initQueue } from "./core/queue.js";
import { startRecoveryScheduler, stopRecoveryScheduler } from "./modules/charges/charges.service.js";
import { initTxnCommandsWorker, stopTxnCommandsWorker } from "./modules/commands/txnCommands.worker.js";
import { initStripeWebhookWorker, stopStripeWebhookWorker } from "./modules/gateway/stripeWebhook.worker.js";
import { initSettlementWorker, stopSettlementWorker } from "./modules/settlements/settlement.worker.js";

const env = loadEnv();
setLogLevel(env.LOG_LEVEL);

const app = createApp(env);
const server = createServer(app);

async function startServer(): Promise<void> {
  // Ordering matters: nothing may serve traffic before the database and Redis
  // are known good. Redis in particular backs replay defence, so a server that
  // accepted requests without it would be accepting unverifiable ones.
  await assertDatabaseConnection();
  await initQueue();

  /**
   * A bind failure (EADDRINUSE, EACCES, ...) is an `error` event on the
   * `Server` instance, not a rejected promise — `server.listen()` returns
   * before the port is actually claimed. With no listener here, Node throws
   * it as an uncaught exception and the process dies immediately, skipping
   * `shutdown()` entirely: the Prisma pool from `assertDatabaseConnection()`
   * and the Redis connection from `initQueue()` above are never released.
   *
   * That is not hypothetical - it is exactly how a second `npm run dev`
   * against an already-running instance leaks a handful of connections into
   * a database with a 25-connection ceiling shared with another service.
   * Closing them here before exiting is what makes a failed start harmless
   * rather than a small, silent leak every time it happens.
   */
  server.once("error", (error: NodeJS.ErrnoException) => {
    logger.error("Transaction server failed to bind", { code: error.code, port: env.PORT, host: env.HOST, error });
    void Promise.allSettled([closeQueues(), prisma.$disconnect()]).finally(() => process.exit(1));
  });

  server.listen(env.PORT, env.HOST, () => {
    // Must run after initQueue: it reuses that Redis connection.
    initStripeWebhookWorker();
    initTxnCommandsWorker();
    // Release, transfer, reconciliation and idempotency-key cleanup. Its
    // repeatable schedules are registered here, not per request.
    initSettlementWorker();
    startOutboxRelay();
    if (env.NODE_ENV !== "test") {
      startRecoveryScheduler();
    }
    logger.info("Transaction server listening", { host: env.HOST, port: env.PORT, env: env.NODE_ENV });
  });
}

startServer().catch((error) => {
  logger.error("Transaction server failed to start", { error });
  // Same leak, earlier in the sequence: a rejection here (a bad DATABASE_URL,
  // Redis unreachable) can still follow a successful partial connection.
  void Promise.allSettled([closeQueues(), prisma.$disconnect()]).finally(() => process.exit(1));
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("Shutting down", { signal });

  stopOutboxRelay();
  stopRecoveryScheduler();
  await stopTxnCommandsWorker();
  await stopStripeWebhookWorker();
  await stopSettlementWorker();
  server.close();
  await closeQueues();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
