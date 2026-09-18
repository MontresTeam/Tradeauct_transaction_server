import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../core/prisma.js";
import { getStripeClient } from "../gateway/stripe.client.js";
import { CardService } from "./payments.cards.service.js";

vi.mock("../gateway/stripe.client.js", () => ({ getStripeClient: vi.fn() }));
vi.mock("../../core/audit.js", () => ({
  recordAudit: vi.fn().mockResolvedValue(undefined),
  auditContext: vi.fn().mockReturnValue({}),
}));

const BUYER = { id: "buy_1", userId: "usr_1", stripeCustomerId: "cus_1" };
const ACTOR = { actorType: "USER" as const, actorId: "usr_1", service: "main-server", ip: "127.0.0.1" };

function mockBuyer(record: typeof BUYER | null = BUYER): void {
  vi.spyOn(prisma.buyer, "findFirst").mockResolvedValue(record as never);
}

function mockStripe(overrides: Record<string, unknown>): void {
  vi.mocked(getStripeClient).mockReturnValue(overrides as never);
}

/** Run the callback passed to prisma.$transaction against a stub client. */
function mockTransaction(txClient: Record<string, unknown>): void {
  vi.spyOn(prisma, "$transaction").mockImplementation(((fn: (tx: unknown) => Promise<unknown>) =>
    fn(txClient)) as never);
}

describe("saving a card", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses a SetupIntent that belongs to a different Stripe customer", async () => {
    mockBuyer();
    mockStripe({
      setupIntents: {
        retrieve: vi.fn().mockResolvedValue({
          status: "succeeded",
          payment_method: "pm_x",
          customer: "cus_someone_else",
        }),
      },
    });

    await expect(CardService.saveFromSetupIntent("usr_1", "seti_1", ACTOR)).rejects.toMatchObject({
      errorCode: "SETUP_INTENT_FORBIDDEN",
      statusCode: 403,
    });
  });

  it("refuses a SetupIntent that has not succeeded", async () => {
    mockBuyer();
    mockStripe({
      setupIntents: {
        retrieve: vi.fn().mockResolvedValue({
          status: "requires_confirmation",
          payment_method: "pm_x",
          customer: "cus_1",
        }),
      },
    });

    await expect(CardService.saveFromSetupIntent("usr_1", "seti_1", ACTOR)).rejects.toMatchObject({
      errorCode: "SETUP_INTENT_NOT_SUCCEEDED",
      statusCode: 400,
    });
  });

  it("refuses a payment method already held by another buyer", async () => {
    mockBuyer();
    mockStripe({
      setupIntents: {
        retrieve: vi.fn().mockResolvedValue({ status: "succeeded", payment_method: "pm_x", customer: "cus_1" }),
      },
    });
    // The Stripe customer resolves to us, but the card row does not.
    vi.spyOn(prisma.savedPaymentMethod, "findUnique").mockResolvedValue({
      id: "spm_1",
      buyerId: "buy_other",
    } as never);

    await expect(CardService.saveFromSetupIntent("usr_1", "seti_1", ACTOR)).rejects.toMatchObject({
      errorCode: "PAYMENT_METHOD_FORBIDDEN",
      statusCode: 403,
    });
  });

  it("stores only the non-sensitive card details", async () => {
    mockBuyer();
    mockStripe({
      setupIntents: {
        retrieve: vi.fn().mockResolvedValue({ status: "succeeded", payment_method: "pm_x", customer: "cus_1" }),
      },
      paymentMethods: {
        retrieve: vi.fn().mockResolvedValue({
          card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 },
        }),
      },
    });
    vi.spyOn(prisma.savedPaymentMethod, "findUnique").mockResolvedValue(null as never);

    const upsert = vi.fn().mockResolvedValue({
      id: "spm_new",
      brand: "visa",
      last4: "4242",
      expMonth: 12,
      expYear: 2030,
      isDefault: true,
      stripePaymentMethodId: "pm_x",
      createdAt: new Date(),
    });
    mockTransaction({ savedPaymentMethod: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), upsert } });

    const result = await CardService.saveFromSetupIntent("usr_1", "seti_1", ACTOR);

    expect(result.paymentMethod).toMatchObject({ brand: "visa", last4: "4242", isDefault: true });

    // Whatever else changes, a PAN or CVC must never appear in what is written.
    const written = JSON.stringify(upsert.mock.calls[0][0]);
    expect(written).not.toMatch(/cvc|number|"pan"/i);
  });
});

describe("changing the default card", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("reports not-found when the card belongs to someone else", async () => {
    mockBuyer();
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    mockTransaction({ savedPaymentMethod: { updateMany } });

    await expect(CardService.setDefault("usr_1", "spm_other", ACTOR)).rejects.toMatchObject({
      errorCode: "PAYMENT_METHOD_NOT_FOUND",
      statusCode: 404,
    });

    // The update is scoped by buyer id, so nothing was changed before it failed.
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ buyerId: BUYER.id }) }),
    );
  });

  it("promotes a card the buyer owns", async () => {
    mockBuyer();
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    mockTransaction({ savedPaymentMethod: { updateMany } });

    await expect(CardService.setDefault("usr_1", "spm_mine", ACTOR)).resolves.toMatchObject({ success: true });
  });
});

describe("removing a card", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("clears the local record even when Stripe refuses the detach", async () => {
    mockBuyer();
    vi.spyOn(prisma.savedPaymentMethod, "findFirst").mockResolvedValue({
      id: "spm_1",
      stripePaymentMethodId: "pm_x",
      brand: "visa",
      last4: "4242",
      isDefault: true,
    } as never);
    mockStripe({
      paymentMethods: { detach: vi.fn().mockRejectedValue(new Error("No such PaymentMethod")) },
    });

    const update = vi.fn().mockResolvedValue({});
    mockTransaction({ savedPaymentMethod: { update, findFirst: vi.fn().mockResolvedValue(null) } });

    const result = await CardService.remove("usr_1", "spm_1", ACTOR);

    // Otherwise the buyer keeps seeing a card that can no longer be charged.
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "removed", isDefault: false } }));
    expect(result).toMatchObject({ removedPaymentMethodId: "spm_1", hasPaymentMethod: false });
  });

  it("refuses to remove a card that is not the caller's", async () => {
    mockBuyer();
    vi.spyOn(prisma.savedPaymentMethod, "findFirst").mockResolvedValue(null as never);

    await expect(CardService.remove("usr_1", "spm_other", ACTOR)).rejects.toMatchObject({
      errorCode: "PAYMENT_METHOD_NOT_FOUND",
    });
  });
});

describe("listing cards", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns an empty list rather than an error for a buyer with no profile", async () => {
    mockBuyer(null);

    await expect(CardService.list("usr_new")).resolves.toEqual({
      success: true,
      paymentMethods: [],
      hasPaymentMethod: false,
      canBid: false,
    });
  });

  it("lists only active cards for the caller", async () => {
    mockBuyer();
    const findMany = vi.spyOn(prisma.savedPaymentMethod, "findMany").mockResolvedValue([] as never);

    await CardService.list("usr_1");

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { buyerId: BUYER.id, status: "active" } }));
  });
});
