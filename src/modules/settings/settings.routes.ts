/**
 * Settlement configuration endpoints, mounted under /internal/v1.
 *
 * This is where the 7-day protection period lives. The client asked that it
 * not be hard-coded, so it is a Super Admin setting with a version and a
 * change history — and the value in force is snapshotted onto each settlement
 * at delivery, so changing it never moves an order already counting down.
 */
import { type Request, type Response, Router } from "express";
import { z } from "zod";
import { loadEnv } from "../../core/env.js";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { validate } from "../../core/middleware/validate.js";
import type { Security } from "../../core/security/index.js";
import { FINANCE_PERMISSIONS } from "../settlements/settlement.routes.js";
import { getSettlementConfig, getSettlementConfigHistory, updateSettlementConfig } from "./settlementConfig.service.js";

const updateBody = z
  .object({
    protectionPeriodDays: z.number().int().min(0).max(90).optional(),
    automaticSettlementEnabled: z.boolean().optional(),
    automaticPayoutEnabled: z.boolean().optional(),
    minimumPayoutAmount: z.number().min(0).optional(),
    allowEarlyReleaseOnBuyerConfirmation: z.boolean().optional(),
    reason: z.string().max(500).optional(),
  })
  .strict();

export function createSettingsRouter(security: Security): Router {
  const router = Router();

  router.get(
    "/admin/settlement-config",
    security.requireAdminActor(FINANCE_PERMISSIONS.READ),
    asyncHandler(async (_req: Request, res: Response) => {
      const env = loadEnv();
      const config = await getSettlementConfig();

      res.json({
        success: true,
        data: {
          ...config,
          /**
           * The admin toggles alone do not move money. The UI shows these so
           * an operator can see why "automatic payout: on" is not paying
           * anyone — the engineering kill switch is still off.
           */
          environmentGates: {
            sellerConnectEnabled: env.SELLER_CONNECT_ENABLED,
            sellerAutoTransferEnabled: env.SELLER_AUTO_TRANSFER_ENABLED,
            connectAccountCountry: env.CONNECT_ACCOUNT_COUNTRY,
            connectPayoutInterval: env.CONNECT_PAYOUT_INTERVAL,
          },
          effectivelyPayingOut: env.SELLER_AUTO_TRANSFER_ENABLED && config.automaticPayoutEnabled,
        },
      });
    }),
  );

  router.put(
    "/admin/settlement-config",
    security.requireAdminActor(FINANCE_PERMISSIONS.SETTINGS),
    validate({ body: updateBody }),
    asyncHandler(async (req: Request, res: Response) => {
      const { reason, ...updates } = req.body as z.infer<typeof updateBody>;

      const config = await updateSettlementConfig(updates, {
        id: req.actor?.userId ?? null,
        ip: req.ip ?? null,
        reason: reason ?? null,
      });

      res.json({ success: true, data: config });
    }),
  );

  router.get(
    "/admin/settlement-config/history",
    security.requireAdminActor(FINANCE_PERMISSIONS.READ),
    asyncHandler(async (_req: Request, res: Response) => {
      res.json({ success: true, data: await getSettlementConfigHistory() });
    }),
  );

  return router;
}
