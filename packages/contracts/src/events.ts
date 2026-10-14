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
  REFUND_DUE: "order.refund_due",
  /** The merchant said they would deliver and the agent never paid. */
  UNPAID_AFTER_CONFIRMATION: "order.unpaid_after_confirmation",
  /** The merchant delivered synchronously and the payment did not execute. */
  PAYMENT_FAILED_AFTER_DELIVERY: "order.payment_failed_after_delivery",
} as const);

/**
 * How an order came to owe a refund: the merchant refused after the money had
 * moved, their delivery deadline passed, or they left and their open orders
 * closed with them.
 */
export const RefundDueReasonSchema = z.enum(["refused", "deadline_passed", "merchant_left"]);

export const OrderEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal(ORDER_EVENT_TYPES.REFUND_DUE),
    order_id: IdentifierSchema,
    at: TimestampSchema,
    /**
     * The sum owed: the whole price the sale went through at, which the
     * merchant pays back to the buyer from their own wallet. The buyer paid it
     * into the merchant's payout contract, which sends 99.9% of it to the
     * merchant and 0.1% to Agentify when it is paid out, and the commission is
     * not given back, so the sum owed is more than the merchant's share of the
     * sale, whether or not that sale has been paid out yet.
     */
    price: MoneySchema,
    reason: RefundDueReasonSchema,
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

export type RefundDueReason = z.infer<typeof RefundDueReasonSchema>;
export type OrderEvent = z.infer<typeof OrderEventSchema>;
