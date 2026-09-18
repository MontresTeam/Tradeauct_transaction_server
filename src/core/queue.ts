/**
 * Redis and BullMQ.
 *
 * Unlike the main server's scheduler, there is no in-memory fallback here:
 * idempotency, replay defence and the outbox all depend on Redis, and a
 * payment process that quietly runs without them is worse than one that
 * refuses to start.
 */
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { loadEnv } from "./env.js";
import { logger } from "./logger.js";

let connection: Redis | null = null;
let connected = false;
const queues = new Map<string, Queue>();

export function getRedis(): Redis | null {
  return connection;
}

export function isRedisConnected(): boolean {
  return connected;
}

export async function initQueue(): Promise<void> {
  if (connection) return;

  const env = loadEnv();
  connection = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    connectTimeout: 5000,
  });

  connection.on("error", (error: Error) => {
    connected = false;
    logger.warn("Redis error", { error });
  });
  connection.on("ready", () => {
    connected = true;
  });
  connection.on("end", () => {
    connected = false;
  });

  await connection.connect();
  connected = true;
  logger.info("Redis connection established");
}

export function getQueue(name: string): Queue {
  const existing = queues.get(name);
  if (existing) return existing;

  if (!connection) {
    throw new Error(`Cannot create queue "${name}" before initQueue()`);
  }

  const queue = new Queue(name, { connection });
  queues.set(name, queue);
  return queue;
}

export async function closeQueues(): Promise<void> {
  for (const queue of queues.values()) {
    await queue.close();
  }
  queues.clear();

  if (connection) {
    connection.disconnect();
    connection = null;
    connected = false;
  }
}
