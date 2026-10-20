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
  /** The money moved and the delivery did not happen. */
  UNFULFILLED: "order.unfulfilled",
  /** The merchant said they would deliver and the agent never paid. */
  UNPAID_AFTER_CONFIRMATION: "order.unpaid_after_confirmation",
  /** The merchant delivered synchronously and the payment did not execute. */
  PAYMENT_FAILED_AFTER_DELIVERY: "order.payment_failed_after_delivery",
} as const);

/**
 * Why a paid order remains unfulfilled: the merchant refused, a deadline
 * passed, or they left. `deadline_passed` is the delivery deadline after the money
 * moved, or Agentify's wait for word of a charge that was later reported to
 * have gone through, on an order the merchant was never sent.
 */
export const UnfulfilledReasonSchema = z.enum(["refused", "deadline_passed", "merchant_left"]);

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
    type: z.literal(ORDER_EVENT_TYPES.UNPAID_AFTER_CONFIRMATION),
    order_id: IdentifierSchema,
    at: TimestampSchema,
  }),

  z.strictObject({
    type: z.literal(ORDER_EVENT_TYPES.PAYMENT_FAILED_AFTER_DELIVERY),
    order_id: IdentifierSchema,
    at: TimestampSchema,
  }),
]);

export type UnfulfilledReason = z.infer<typeof UnfulfilledReasonSchema>;
export type OrderEvent = z.infer<typeof OrderEventSchema>;
