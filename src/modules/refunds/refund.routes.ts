/**
 * Refund endpoints, mounted under /internal/v1.
 *
 * Admin-only and idempotent. A refund is money leaving, so a
 * double-submitted form must produce one refund, not two — the
 * `Idempotency-Key` header is required and the stored response is replayed.
 */
import { type Request, type Response, Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { idempotent } from "../../core/idempotency.js";
import { validate } from "../../core/middleware/validate.js";
import { toMinorUnits } from "../../core/money.js";
import { prisma } from "../../core/prisma.js";
import type { Security } from "../../core/security/index.js";
import { FINANCE_PERMISSIONS } from "../settlements/settlement.routes.js";
import { createRefund } from "./refund.service.js";

const identifier = z
  .string()
  .min(6)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

const refundBody = z
  .object({
    paymentId: identifier,
    /** Major units, e.g. 250.50. Omit for a full refund of what remains. */
    amount: z.number().positive().optional(),
    currency: z.string().length(3).optional(),
    reasonCode: z.string().min(2).max(60),
    reasonNote: z.string().max(500).optional(),
  })
  .strict();

export function createRefundRouter(security: Security): Router {
  const router = Router();

  router.post(
    "/admin/refunds",
    security.requireAdminActor(FINANCE_PERMISSIONS.MANAGE),
    validate({ body: refundBody }),
    idempotent({ scope: "admin-refund" }),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as z.infer<typeof refundBody>;
      const currency = body.currency ?? "AED";

      const result = await createRefund({
        paymentId: body.paymentId,
        amountMinor: body.amount !== undefined ? toMinorUnits(body.amount, currency) : undefined,
        reasonCode: body.reasonCode,
        reasonNote: body.reasonNote,
        requestedById: req.actor?.userId ?? "ADMIN",
        actor: { type: "ADMIN", id: req.actor?.userId ?? null, ip: req.ip ?? null },
      });

      res.json({ success: true, data: result });
    }),
  );

  router.get(
    "/admin/refunds",
    security.requireAdminActor(FINANCE_PERMISSIONS.READ),
    validate({
      query: z
        .object({
          paymentId: identifier.optional(),
          status: z.string().max(30).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .strict(),
    }),
    asyncHandler(async (req: Request, res: Response) => {
      const query = req.query as unknown as { paymentId?: string; status?: string; limit: number };

      const rows = await prisma.refund.findMany({
        where: {
          ...(query.paymentId ? { paymentId: query.paymentId } : {}),
          ...(query.status ? { status: query.status as never } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: query.limit,
      });

      res.json({
        success: true,
        data: rows.map((row) => ({ ...row, amountMinor: row.amountMinor.toString() })),
      });
    }),
  );

  return router;
}
