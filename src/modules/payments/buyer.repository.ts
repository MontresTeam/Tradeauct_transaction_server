import { AppError } from "../../core/errors/AppError.js";
import { prisma } from "../../core/prisma.js";

export type BuyerRecord = { id: string; userId: string; stripeCustomerId: string | null };

/**
 * Resolve the Buyer row for a verified actor.
 *
 * `Payment.buyerId` references `Buyer.id` while access tokens carry
 * `User.id`, so both are accepted — but only ever as the caller's own
 * identity. No request parameter is ever passed in here: that is what keeps a
 * buyer id in a body from selecting whose money is being read or charged.
 */
export async function findBuyer(actorUserId: string): Promise<BuyerRecord | null> {
  return prisma.buyer.findFirst({
    where: { OR: [{ userId: actorUserId }, { id: actorUserId }] },
    select: { id: true, userId: true, stripeCustomerId: true },
  });
}

export async function requireBuyer(actorUserId: string): Promise<BuyerRecord> {
  const buyer = await findBuyer(actorUserId);
  if (!buyer) {
    throw new AppError(404, "Buyer profile not found", "BUYER_NOT_FOUND");
  }
  return buyer;
}
