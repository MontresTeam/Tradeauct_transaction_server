import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../core/errors/AppError.js";
import { prisma } from "../../core/prisma.js";
import { getStripeClient } from "../gateway/stripe.client.js";
import { PaymentReadService } from "./payments.read.service.js";

vi.mock("../gateway/stripe.client.js", () => ({
  getStripeClient: vi.fn(),
}));

const BUYER = { id: "buy_1", userId: "usr_1" };

function mockBuyer(record: { id: string; userId: string } | null = BUYER): void {
  vi.spyOn(prisma.buyer, "findFirst").mockResolvedValue(record as never);
}

function mockCheckoutSession(session: Record<string, unknown>): void {
  vi.mocked(getStripeClient).mockReturnValue({
    checkout: { sessions: { retrieve: vi.fn().mockResolvedValue(session) } },
  } as never);
}

describe("payment reads are scoped to the caller", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("scopes a payment lookup to the caller's buyer id", async () => {
    mockBuyer();
    const findFirst = vi.spyOn(prisma.payment, "findFirst").mockResolvedValue(null as never);

    await expect(PaymentReadService.getPaymentStatus("usr_1", "lst_public_id")).rejects.toMatchObject({
      errorCode: "PAYMENT_NOT_FOUND",
      statusCode: 404,
    });

    // The listing id in the request is only ever an OR term; the buyer id is
    // a mandatory filter, so another buyer's payment cannot be reached.
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ buyerId: BUYER.id }) }),
    );
  });

  it("answers 404, not 403, for a payment belonging to someone else", async () => {
    mockBuyer();
    vi.spyOn(prisma.payment, "findFirst").mockResolvedValue(null as never);

    // Distinguishing "not yours" from "does not exist" would confirm that a
    // given listing has a payment against it.
    await expect(PaymentReadService.getPaymentStatus("usr_1", "pay_other")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("fails closed when the caller has no buyer profile", async () => {
    mockBuyer(null);

    await expect(PaymentReadService.getPaymentStatus("usr_unknown", "pay_1")).rejects.toBeInstanceOf(AppError);
  });

  it("rejects a checkout session that is not the caller's", async () => {
    mockBuyer();
    mockCheckoutSession({
      id: "cs_test_1",
      client_reference_id: "usr_someone_else",
      payment_status: "paid",
      status: "complete",
      metadata: {},
    });

    await expect(PaymentReadService.getCheckoutSessionStatus("usr_1", "cs_test_1")).rejects.toMatchObject({
      errorCode: "SESSION_NOT_OWNED",
      statusCode: 403,
    });
  });

  it("rejects a checkout session with no owner recorded at all", async () => {
    mockBuyer();
    mockCheckoutSession({
      id: "cs_test_2",
      client_reference_id: null,
      payment_status: "paid",
      status: "complete",
      metadata: {},
    });

    await expect(PaymentReadService.getCheckoutSessionStatus("usr_1", "cs_test_2")).rejects.toMatchObject({
      errorCode: "SESSION_NOT_OWNED",
    });
  });

  it("returns Stripe's status for the caller's own session", async () => {
    mockBuyer();
    mockCheckoutSession({
      id: "cs_test_3",
      client_reference_id: "usr_1",
      payment_status: "paid",
      status: "complete",
      payment_intent: "pi_123",
      amount_total: 5200000,
      currency: "aed",
      metadata: { listingId: "lst_1", orderNumber: "TA-2026-1" },
    });
    vi.spyOn(prisma.payment, "findFirst").mockResolvedValue({
      id: "pay_1",
      status: "PAID",
      listingId: "lst_1",
      fulfillmentOrder: { orderNumber: "TA-2026-1" },
    } as never);

    const result = await PaymentReadService.getCheckoutSessionStatus("usr_1", "cs_test_3");

    expect(result).toMatchObject({
      sessionId: "cs_test_3",
      paymentStatus: "paid",
      paymentIntentId: "pi_123",
      amountTotal: 52000,
      currency: "AED",
      recordStatus: "PAID",
      fulfillmentReady: true,
    });
  });

  it("rejects an id that is not a checkout session", async () => {
    await expect(PaymentReadService.getCheckoutSessionStatus("usr_1", "pi_123")).rejects.toMatchObject({
      errorCode: "INVALID_SESSION_ID",
      statusCode: 400,
    });
  });
});

describe("bid eligibility", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("blocks a buyer with an unresolved payment recovery", async () => {
    mockBuyer();
    vi.spyOn(prisma.payment, "findFirst").mockResolvedValue({ id: "pay_failed" } as never);
    vi.spyOn(prisma.savedPaymentMethod, "count").mockResolvedValue(1 as never);

    const result = await PaymentReadService.getEligibility("usr_1");

    expect(result).toMatchObject({
      canPlaceBid: false,
      hasActiveRecovery: true,
      reason: "PAYMENT_RECOVERY_REQUIRED",
    });
  });

  it("blocks a buyer with no saved card", async () => {
    mockBuyer();
    vi.spyOn(prisma.payment, "findFirst").mockResolvedValue(null as never);
    vi.spyOn(prisma.savedPaymentMethod, "count").mockResolvedValue(0 as never);

    const result = await PaymentReadService.getEligibility("usr_1");

    expect(result).toMatchObject({
      canPlaceBid: false,
      hasActiveRecovery: false,
      reason: "PAYMENT_METHOD_REQUIRED",
    });
  });

  it("allows a buyer with a card and nothing outstanding", async () => {
    mockBuyer();
    vi.spyOn(prisma.payment, "findFirst").mockResolvedValue(null as never);
    vi.spyOn(prisma.savedPaymentMethod, "count").mockResolvedValue(2 as never);

    const result = await PaymentReadService.getEligibility("usr_1");

    expect(result).toMatchObject({ canPlaceBid: true, hasActiveRecovery: false, reason: null });
  });

  it("blocks, rather than throws, when there is no buyer profile yet", async () => {
    mockBuyer(null);

    const result = await PaymentReadService.getEligibility("usr_new");

    expect(result).toMatchObject({ canPlaceBid: false, reason: "BUYER_PROFILE_MISSING" });
  });

  it("only counts active cards", async () => {
    mockBuyer();
    vi.spyOn(prisma.payment, "findFirst").mockResolvedValue(null as never);
    const count = vi.spyOn(prisma.savedPaymentMethod, "count").mockResolvedValue(1 as never);

    await PaymentReadService.getEligibility("usr_1");

    // A card that was removed is marked "removed" rather than deleted, so the
    // status filter is what stops it from unlocking bidding.
    expect(count).toHaveBeenCalledWith({ where: { buyerId: BUYER.id, status: "active" } });
  });
});
