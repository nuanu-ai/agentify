/**
 * Things that happen to an order without the merchant doing anything. They
 * arrive on the same subscription as the orders and want no answer.
 *
 * The list of event types grows only by a shape being added here, so that a
 * consumer switching on the type can read an unknown one as a version mismatch
 * rather than a typo.
 */

import { z } from "zod";
import { IdentifierSchema, MoneySchema, TimestampSchema } from "./primitives.js";

export const ORDER_EVENT_TYPES = Object.freeze({
  /**
   * The money moved and the delivery did not happen, including a payment that
   * completed after the merchant closed fulfillment.
   */
  UNFULFILLED: "order.unfulfilled",
  /** The merchant delivered synchronously and the payment did not execute. */
  PAYMENT_FAILED_AFTER_DELIVERY: "order.payment_failed_after_delivery",
} as const);

/**
 * Why a paid order remains unfulfilled: the merchant refused, a deadline
 * passed, or the payment completed after they had closed fulfillment. `deadline_passed` is the delivery deadline after the money
 * moved, or Agentify's wait for word of a charge that was later reported to
 * have gone through, on an order the merchant was never sent.
 * `paid_after_closure` is a payment that was still unresolved when the merchant
 * closed fulfillment and completed afterwards: the order stays closed, nothing
 * is delivered, and it waits on the merchant's open list until they close it
 * again.
 */
export const UnfulfilledReasonSchema = z
  .enum(["refused", "deadline_passed", "paid_after_closure"])
  .meta({
    description:
      "Why a paid order has no delivery. refused: the merchant refused it after it was paid. deadline_passed: its delivery deadline passed, or the payment was confirmed only after Agentify had stopped waiting for it and the order was never sent to the merchant. paid_after_closure: the payment was still unresolved when the merchant closed fulfillment and completed afterwards; the order stays closed, nothing is delivered, and it is on the merchant's open order list until they close it again.",
  });

export const OrderEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal(ORDER_EVENT_TYPES.UNFULFILLED),
    order_id: IdentifierSchema,
    at: TimestampSchema,
    /**
     * The original purchase price. It is not an amount owed as a refund;
     * the merchant and buyer determine their remedy outside Agentify.
     */
    price: MoneySchema,
    reason: UnfulfilledReasonSchema,
  }),

  z.strictObject({
    type: z.literal(ORDER_EVENT_TYPES.PAYMENT_FAILED_AFTER_DELIVERY),
    order_id: IdentifierSchema,
    at: TimestampSchema,
  }),
]);

export type UnfulfilledReason = z.infer<typeof UnfulfilledReasonSchema>;
export type OrderEvent = z.infer<typeof OrderEventSchema>;
