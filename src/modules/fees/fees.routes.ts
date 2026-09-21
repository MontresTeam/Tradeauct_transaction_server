/**
 * Fee Engine endpoints, mounted under /internal/v1.
 *
 * The main server calls `/fees/listing-snapshot` when it creates a listing or
 * an auction, and writes the returned snapshot onto that row. It calls
 * `/fees/estimate` for anything the seller or buyer is shown. Neither server
 * calculates a fee itself any more, and the buyer frontend's calculator is
 * display-only — fed by an estimate from here.
 */
import { type Request, type Response, Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { validate } from "../../core/middleware/validate.js";
import type { Security } from "../../core/security/index.js";
import { FINANCE_PERMISSIONS } from "../settlements/settlement.routes.js";
import { FeeEngineService } from "./feeEngine.service.js";

const snapshotBody = z
  .object({
    saleType: z.string().min(2).max(40),
    startingBid: z.number().nonnegative().nullable().optional(),
    reservePrice: z.number().nonnegative().nullable().optional(),
    ownerType: z.string().max(40).optional(),
    buyerPremiumOverrideRate: z.number().min(0).max(100).nullable().optional(),
    sellerFeeOverrideRate: z.number().min(0).max(100).nullable().optional(),
    sellerCustomFeePercent: z.number().min(0).max(100).nullable().optional(),
    sellerCustomBuyerPremiumPercent: z.number().min(0).max(100).nullable().optional(),
  })
  .strict();

const estimateBody = snapshotBody.extend({
  salePrice: z.number().positive(),
  currency: z.string().length(3).optional(),
  shippingPayer: z.enum(["BUYER", "SELLER"]).optional(),
  estimatedShipping: z.number().nonnegative().optional(),
});

const configBody = z
  .object({
    buyNowSellerFeePercent: z.number().min(0).max(100).optional(),
    buyNowBuyerPremiumPercent: z.number().min(0).max(100).optional(),
    platformMinimumStartingBid: z.number().min(0).optional(),
    minStartNoReserveSellerFeePercent: z.number().min(0).max(100).optional(),
    minStartNoReserveBuyerPremiumPercent: z.number().min(0).max(100).optional(),
    customStartNoReserveSellerFeePercent: z.number().min(0).max(100).optional(),
    customStartNoReserveBuyerPremiumPercent: z.number().min(0).max(100).optional(),
    reserveAuctionSellerFeePercent: z.number().min(0).max(100).optional(),
    reserveAuctionBuyerPremiumPercent: z.number().min(0).max(100).optional(),
    trialCancellationCutoffHours: z.number().min(0).max(720).optional(),
  })
  .strict();

export function createFeesRouter(security: Security): Router {
  const router = Router();

  /** The snapshot to persist on a new listing or auction. */
  router.post(
    "/fees/listing-snapshot",
    validate({ body: snapshotBody }),
    asyncHandler(async (req: Request, res: Response) => {
      const feeConfig = await FeeEngineService.getAuthoritativeFeeConfig();
      const snapshot = FeeEngineService.createListingFeeSnapshot({ ...req.body, feeConfig }, feeConfig);

      res.json({
        success: true,
        data: {
          feeRuleType: snapshot.feeRuleType,
          sellerFeePercentSnapshot: snapshot.sellerFeePercentSnapshot,
          buyerPremiumPercentSnapshot: snapshot.buyerPremiumPercentSnapshot,
          minimumStartingBidSnapshot: snapshot.minimumStartingBidSnapshot,
          feeConfigurationVersion: snapshot.feeConfigurationVersion,
          feeSnapshotCreatedAt: snapshot.feeSnapshotCreatedAt,
        },
      });
    }),
  );

  /** Both sides of a hypothetical sale, for previews and display. */
  router.post(
    "/fees/estimate",
    validate({ body: estimateBody }),
    asyncHandler(async (req: Request, res: Response) => {
      const feeConfig = await FeeEngineService.getAuthoritativeFeeConfig();
      const snapshot = FeeEngineService.createListingFeeSnapshot({ ...req.body, feeConfig }, feeConfig);

      const fees = FeeEngineService.calculateOrderFees({
        snapshot,
        salePrice: req.body.salePrice,
        currency: req.body.currency ?? "AED",
      });

      const payout = FeeEngineService.calculateSellerPayoutBreakdown({
        saleAmount: req.body.salePrice,
        snapshot,
        shippingPayer: req.body.shippingPayer,
        estimatedShipping: req.body.estimatedShipping,
        currency: req.body.currency ?? "AED",
        isEstimate: true,
      });

      res.json({ success: true, data: { fees, sellerPayout: payout } });
    }),
  );

  router.get(
    "/admin/fee-config",
    security.requireAdminActor(FINANCE_PERMISSIONS.READ),
    asyncHandler(async (_req: Request, res: Response) => {
      res.json({ success: true, data: await FeeEngineService.getAuthoritativeFeeConfig() });
    }),
  );

  /**
   * Change the fee matrix.
   *
   * The version is bumped, and every listing already created keeps the version
   * it was created under. Historical orders never re-price.
   */
  router.put(
    "/admin/fee-config",
    security.requireAdminActor(FINANCE_PERMISSIONS.SETTINGS),
    validate({ body: configBody }),
    asyncHandler(async (req: Request, res: Response) => {
      const updated = await FeeEngineService.updateAuthoritativeFeeConfig(req.body, req.actor?.userId);
      res.json({ success: true, data: updated });
    }),
  );

  return router;
}
