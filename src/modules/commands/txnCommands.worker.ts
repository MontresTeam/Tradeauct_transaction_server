/**
 * Commands sent by the main server.
 *
 * Some work must not be tied to a request: charging an auction winner takes as
 * long as Stripe takes, has to survive a restart, and must be retried on a
 * network blip rather than dropped. Those arrive here as queue jobs instead of
 * HTTP calls.
 *
 * The division of labour is the point. The main server sends **facts** — "this
 * order was delivered at T", "the buyer opened a return" — and this server
 * makes the **decisions** about money. The main server never writes a
 * settlement, a wallet or a payout row.
 *
 * `jobId` makes each command idempotent at the queue level, and every handler
 * is idempotent in its own right, because BullMQ retries are at-least-once.
 */
import { Worker } from "bullmq";
import { loadEnv } from "../../core/env.js";
import { logger, withTrace } from "../../core/logger.js";
import { getRedis, isRedisConnected } from "../../core/queue.js";
import { ChargeService } from "../charges/charges.service.js";
import { onBuyerIssueOpened, onBuyerIssueResolved } from "../disputes/dispute.service.js";
import {
  findSettlement,
  linkFulfillmentOrder,
  recordDelivery,
  transitionSettlement,
} from "../settlements/settlement.service.js";

export const TXN_COMMANDS = {
  CHARGE_AUCTION_WINNER: "CHARGE_AUCTION_WINNER",

  /** The main server has built the fulfilment order for a paid payment. */
  FULFILLMENT_ORDER_CREATED: "FULFILLMENT_ORDER_CREATED",
  /** The item reached the buyer. This starts the protection period. */
  FULFILLMENT_DELIVERED: "FULFILLMENT_DELIVERED",
  /** The order was cancelled before delivery. */
  FULFILLMENT_CANCELLED: "FULFILLMENT_CANCELLED",

  RETURN_OPENED: "RETURN_OPENED",
  RETURN_RESOLVED: "RETURN_RESOLVED",
  DISPUTE_CASE_OPENED: "DISPUTE_CASE_OPENED",
  DISPUTE_CASE_RESOLVED: "DISPUTE_CASE_RESOLVED",
} as const;

export type TxnCommandName = (typeof TXN_COMMANDS)[keyof typeof TXN_COMMANDS];

type ChargeWinnerCommand = { auctionId: string; winnerId: string; traceId?: string };

type FulfillmentOrderCreatedCommand = {
  fulfillmentOrderId: string;
  paymentId: string;
  orderNumber?: string;
  traceId?: string;
};

type FulfillmentDeliveredCommand = {
  fulfillmentOrderId: string;
  paymentId?: string | null;
  /** ISO 8601. The main server's clock, not this one's. */
  deliveredAt: string;
  /** "ADMIN_STATUS_UPDATE" | "DHL_WEBHOOK" | … — recorded for the audit trail. */
  source: string;
  traceId?: string;
};

type FulfillmentCancelledCommand = {
  fulfillmentOrderId: string;
  reason?: string;
  traceId?: string;
};

type BuyerIssueCommand = {
  fulfillmentOrderId: string;
  caseNumber?: string | null;
  note?: string | null;
  outcome?: string | null;
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
      const data = job.data as { traceId?: string };

      return withTrace(data.traceId, async () => {
        switch (job.name) {
          case TXN_COMMANDS.CHARGE_AUCTION_WINNER: {
            const command = job.data as ChargeWinnerCommand;
            logger.info("Charging auction winner", { auctionId: command.auctionId });
            const result = await ChargeService.chargeAuctionWinner(command.auctionId, command.winnerId);
            logger.info("Winner charge finished", {
              auctionId: command.auctionId,
              success: result.success,
              reason: result.reason,
            });
            return result;
          }

          case TXN_COMMANDS.FULFILLMENT_ORDER_CREATED: {
            const command = job.data as FulfillmentOrderCreatedCommand;
            await linkFulfillmentOrder(command.paymentId, command.fulfillmentOrderId);
            return { linked: true, fulfillmentOrderId: command.fulfillmentOrderId };
          }

          case TXN_COMMANDS.FULFILLMENT_DELIVERED: {
            const command = job.data as FulfillmentDeliveredCommand;
            const deliveredAt = new Date(command.deliveredAt);

            if (Number.isNaN(deliveredAt.getTime())) {
              // Not retryable, and not something to guess at: a bad date would
              // put the protection window in the wrong place.
              logger.error("FULFILLMENT_DELIVERED carried an unparseable date", { data: command });
              return { handled: false, reason: "INVALID_DELIVERED_AT" };
            }

            const result = await recordDelivery({
              fulfillmentOrderId: command.fulfillmentOrderId,
              paymentId: command.paymentId ?? null,
              deliveredAt,
              source: command.source,
            });

            logger.info("Delivery recorded against the settlement", {
              fulfillmentOrderId: command.fulfillmentOrderId,
              source: command.source,
              changed: result.changed,
              reason: result.refusedReason,
            });

            return {
              handled: result.changed,
              settlementId: result.settlement?.id ?? null,
              eligibleAt: result.settlement?.eligibleAt ?? null,
              reason: result.refusedReason ?? null,
            };
          }

          case TXN_COMMANDS.FULFILLMENT_CANCELLED: {
            const command = job.data as FulfillmentCancelledCommand;
            const settlement = await findSettlement({ fulfillmentOrderId: command.fulfillmentOrderId });
            if (!settlement) return { handled: false, reason: "NO_SETTLEMENT" };

            const result = await transitionSettlement({
              settlementId: settlement.id,
              // Only before delivery. A cancellation after the item arrived is
              // a return, and a refund, not a cancellation.
              from: ["PENDING"],
              to: "CANCELLED",
              reason: command.reason ?? "Order cancelled before delivery",
              data: { netProceeds: 0, payoutStatus: "UNPAID" },
            });

            return { handled: result.changed, reason: result.refusedReason ?? null };
          }

          case TXN_COMMANDS.RETURN_OPENED: {
            const command = job.data as BuyerIssueCommand;
            return onBuyerIssueOpened({
              fulfillmentOrderId: command.fulfillmentOrderId,
              kind: "RETURN",
              caseNumber: command.caseNumber,
              note: command.note,
            });
          }

          case TXN_COMMANDS.RETURN_RESOLVED: {
            const command = job.data as BuyerIssueCommand;
            return onBuyerIssueResolved({
              fulfillmentOrderId: command.fulfillmentOrderId,
              kind: "RETURN",
              outcome: command.outcome,
            });
          }

          case TXN_COMMANDS.DISPUTE_CASE_OPENED: {
            const command = job.data as BuyerIssueCommand;
            return onBuyerIssueOpened({
              fulfillmentOrderId: command.fulfillmentOrderId,
              kind: "DISPUTE_CASE",
              caseNumber: command.caseNumber,
              note: command.note,
            });
          }

          case TXN_COMMANDS.DISPUTE_CASE_RESOLVED: {
            const command = job.data as BuyerIssueCommand;
            return onBuyerIssueResolved({
              fulfillmentOrderId: command.fulfillmentOrderId,
              kind: "DISPUTE_CASE",
              outcome: command.outcome,
            });
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
