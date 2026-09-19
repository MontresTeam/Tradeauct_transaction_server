BEGIN;

ALTER TABLE "idempotency_keys" DROP COLUMN "createdAt";
ALTER TABLE "idempotency_keys" ADD COLUMN "actorId" TEXT;
ALTER TABLE "idempotency_keys" ADD COLUMN "completedAt" TIMESTAMP(3);
ALTER TABLE "idempotency_keys" ADD COLUMN "lockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "idempotency_keys" ALTER COLUMN "responseStatus" DROP NOT NULL;
ALTER TABLE "idempotency_keys" ALTER COLUMN "responseBody" DROP NOT NULL;

COMMIT;
