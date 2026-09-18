/**
 * Commands sent by the main server.
 *
 * Some work must not be tied to a request: charging an auction winner takes as
 * long as Stripe takes, has to survive a restart, and must be retried on a
 * network blip rather than dropped. Those arrive here as queue jobs instead of
 * HTTP calls.
 *
 * `jobId` makes each command idempotent at the queue level, and every handler
 * is idempotent in its own right, because BullMQ retries are at-least-once.
 */
import { Worker } from "bullmq";
import { loadEnv } from "../../core/env.js";
import { logger, withTrace } from "../../core/logger.js";
import { getRedis, isRedisConnected } from "../../core/queue.js";
import { ChargeService } from "../charges/charges.service.js";

export const TXN_COMMANDS = {
  CHARGE_AUCTION_WINNER: "CHARGE_AUCTION_WINNER",
} as const;

type ChargeWinnerCommand = {
  auctionId: string;
  winnerId: string;
  traceId?: string;
};

let worker: Worker | null = null;

export function initTxnCommandsWorker(): void {
  if (worker) return;

  const connection = getRedis();
  if (!connection || !isRedisConnected()) {
    logger.error("Command worker not started: Redis is unavailable");
    return;
  }

  const env = loadEnv();

  worker = new Worker(
    env.TXN_COMMANDS_QUEUE,
    async (job) => {
      const data = job.data as ChargeWinnerCommand;

      return withTrace(data.traceId, async () => {
        switch (job.name) {
          case TXN_COMMANDS.CHARGE_AUCTION_WINNER: {
            logger.info("Charging auction winner", { auctionId: data.auctionId });
            const result = await ChargeService.chargeAuctionWinner(data.auctionId, data.winnerId);
            logger.info("Winner charge finished", {
              auctionId: data.auctionId,
              success: result.success,
              reason: result.reason,
            });
            return result;
          }
          default:
            logger.warn("Unknown command ignored", { name: job.name });
            return { ignored: true };
        }
      });
    },
    { connection, concurrency: 3 },
  );

  worker.on("failed", (job, error) => {
    logger.error("Command failed", { name: job?.name, data: job?.data, attempts: job?.attemptsMade, error });
  });

  logger.info("Command worker started", { queue: env.TXN_COMMANDS_QUEUE });
}

export async function stopTxnCommandsWorker(): Promise<void> {
  await worker?.close();
  worker = null;
}
