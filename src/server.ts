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

  server.listen(env.PORT, env.HOST, () => {
    // Must run after initQueue: it reuses that Redis connection.
    initStripeWebhookWorker();
    initTxnCommandsWorker();
    startOutboxRelay();
    if (env.NODE_ENV !== "test") {
      startRecoveryScheduler();
    }
    logger.info("Transaction server listening", { host: env.HOST, port: env.PORT, env: env.NODE_ENV });
  });
}

startServer().catch((error) => {
  logger.error("Transaction server failed to start", { error });
  process.exit(1);
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
  server.close();
  await closeQueues();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
