/**
 * Reconciliation endpoints, mounted under /internal/v1.
 *
 * The hourly job raises exceptions; these let an admin see them, run a pass on
 * demand, and record what was done about each one. Nothing here corrects a
 * discrepancy automatically — the resolution is a note, not a write to the
 * ledger.
 */
import { type Request, type Response, Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { validate } from "../../core/middleware/validate.js";
import type { Security } from "../../core/security/index.js";
import { FINANCE_PERMISSIONS } from "../settlements/settlement.routes.js";
import {
  buildDailyFinanceReport,
  listExceptions,
  resolveException,
  runReconciliation,
} from "./reconciliation.service.js";

const resolveBody = z
  .object({
    status: z.enum(["ACKNOWLEDGED", "RESOLVED", "IGNORED"]),
    note: z.string().min(3).max(1000),
  })
  .strict();

export function createReconciliationRouter(security: Security): Router {
  const router = Router();

  router.get(
    "/admin/reconciliation/exceptions",
    security.requireAdminActor(FINANCE_PERMISSIONS.READ),
    validate({
      query: z
        .object({
          status: z.enum(["OPEN", "ACKNOWLEDGED", "RESOLVED", "IGNORED"]).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .strict(),
    }),
    asyncHandler(async (req: Request, res: Response) => {
      const query = req.query as unknown as { status?: string; limit?: number };
      const rows = await listExceptions(query);

      res.json({
        success: true,
        data: rows.map((row) => ({
          ...row,
          expectedMinor: row.expectedMinor?.toString() ?? null,
          actualMinor: row.actualMinor?.toString() ?? null,
        })),
      });
    }),
  );

  router.post(
    "/admin/reconciliation/exceptions/:exceptionId",
    security.requireAdminActor(FINANCE_PERMISSIONS.MANAGE),
    validate({
      params: z
        .object({
          exceptionId: z
            .string()
            .min(6)
            .max(128)
            .regex(/^[A-Za-z0-9_-]+$/),
        })
        .strict(),
      body: resolveBody,
    }),
    asyncHandler(async (req: Request, res: Response) => {
      const updated = await resolveException({
        exceptionId: String(req.params.exceptionId),
        status: req.body.status,
        note: req.body.note,
        adminId: req.actor?.userId ?? "ADMIN",
      });

      res.json({
        success: true,
        data: {
          ...updated,
          expectedMinor: updated.expectedMinor?.toString() ?? null,
          actualMinor: updated.actualMinor?.toString() ?? null,
        },
      });
    }),
  );

  /** Run a pass now rather than waiting for the hour. */
  router.post(
    "/admin/reconciliation/run",
    security.requireAdminActor(FINANCE_PERMISSIONS.MANAGE),
    validate({
      body: z
        .object({ lookbackHours: z.number().int().min(1).max(720).optional() })
        .strict()
        .optional(),
    }),
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ success: true, data: await runReconciliation({ lookbackHours: req.body?.lookbackHours }) });
    }),
  );

  router.get(
    "/admin/reconciliation/daily-report",
    security.requireAdminActor(FINANCE_PERMISSIONS.READ),
    validate({ query: z.object({ date: z.string().datetime().optional() }).strict() }),
    asyncHandler(async (req: Request, res: Response) => {
      const date = req.query.date ? new Date(String(req.query.date)) : new Date();
      res.json({ success: true, data: await buildDailyFinanceReport(date) });
    }),
  );

  return router;
}
