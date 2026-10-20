/**
 * What state an order is in, in the words an agent and a merchant both read.
 *
 * Every value says what the agent can be told truthfully, which is not always
 * everything Agentify knows. `in_progress` covers every step of a purchase that
 * has not finished, and `rejected` covers both a purchase that never reached
 * the merchant and one the merchant refused, because to the buyer each is one
 * situation. A merchant who needs those apart reads their own order, which
 * carries the answer they gave.
 */

import { z } from "zod";

export const ORDER_STATUSES = Object.freeze([
  /** Running: no terminal answer yet, and no reason to read one into it. */
  "in_progress",
  /** Success: the product is with the agent and the money with the merchant. */
  "delivered",
  /**
   * A parcel is with the carrier and the money with the merchant: the merchant
   * recorded its shipment, and the order carries it. This is the last word
   * Agentify has about the parcel; nothing reports an arrival, and whether it
   * arrives is between the buyer and the merchant, whose site is where to ask.
   */
  "shipped",
  /**
   * Closed, and the buyer's money is known not to have moved: the product was
   * gone, the merchant's price check gave no price the purchase could use, the
   * charge came back failed, or a synchronous handler refused. On a parcel,
   * "gone" can also mean the merchant does not ship to that place or the
   * address lacks what their carrier needs. Parameters that do not fit the
   * card, and a payment that fails its check, are refused on the call itself
   * and end no order this way: the first opens none, and after the second the
   * order stays open until its price runs out and then reads `expired`.
   *
   * Where the merchant refused, the agent's status document carries their
   * `refusal` beside this word: a short code to branch on and a sentence to
   * show. Where Agentify ended the order, it carries a `reason` from
   * `ORDER_ENDING_REASONS` instead, never beside the merchant's words, so that
   * no merchant is credited with words they did not write.
   */
  "rejected",
  /**
   * Nobody can say whether the buyer was charged: the payment network was
   * asked and never answered. The order may still be open, the goods may
   * already exist, and a later read can still move. This is not `rejected` on
   * purpose: an agent told its purchase did not happen would buy again without
   * looking at its wallet.
   */
  "payment_unresolved",
  /** The merchant answered a confirmation request with "I will not deliver". */
  "declined",
  /**
   * A deadline passed with nobody at fault: the confirmation, the payment that
   * was to follow it, or the synchronous delivery.
   */
  "expired",
  /** The merchant left, and orders still open closed with them. */
  "cancelled",
  /**
   * The original payment completed and fulfillment did not. The reason says
   * whether the merchant refused, left or missed the deadline. Later delivery
   * remains possible until the merchant explicitly closes Agentify fulfillment.
   * This says nothing about a refund or the parties' agreement.
   */
  "unfulfilled",
  /**
   * The merchant closed fulfillment through Agentify: nothing more is
   * delivered here. `payment_status` says what happened to the original
   * payment, and the merchant's own words are under `merchant_closure`; on a
   * paid order Agentify's `reason` stands beside them.
   */
  "fulfillment_closed",
  /**
   * The merchant delivered synchronously and the payment did not execute. The
   * goods exist, nothing was paid, and the order stays open until a repeat
   * purchase carries the payment through. The agent's status document says so
   * under `reason`, with `payment_not_settled`.
   */
  "delivered_unpaid",
] as const);

export const OrderStatusSchema = z.enum(ORDER_STATUSES);

export type OrderStatus = z.infer<typeof OrderStatusSchema>;

/** The original payment's verified outcome, independent of fulfillment. */
export const PaymentStatusSchema = z.enum(["not_paid", "paid", "unresolved"]).meta({
  description:
    "What became of the buyer's original payment. not_paid: no payment went through, and none is waiting for an answer. paid: the payment went through. unresolved: Agentify asked the facilitator to execute the payment and has no answer yet; it keeps checking, and the word changes once the outcome is known. A merchant closing fulfillment changes none of this, cancels no payment and establishes no refund, so an unresolved payment may still go through after the closure.",
});
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;

/**
 * Why an order ended, in Agentify's words: where Agentify and not its merchant
 * decided it and one status word would otherwise cover endings that call for
 * different next steps, and where a merchant closed fulfillment of a paid
 * order, whose own words could otherwise be read as more than they establish.
 * A merchant's refusal travels in their own words and gets one of these beside
 * it only where they later closed the paid order.
 */
export const ORDER_ENDING_REASONS = Object.freeze([
  /**
   * `rejected`: the merchant's price check said there is none, and gave no
   * reason. On a parcel that can also mean the merchant does not ship to the
   * address given; nothing here can say which.
   */
  "unavailable",
  /**
   * `rejected`: the merchant's price check gave no price this purchase could
   * use — it did not answer in time, or its answer could not be accepted.
   */
  "price_check_unanswered",
  /**
   * `rejected`: the payment layer said the charge did not go through. The
   * same on `delivered_unpaid`, which is not an ending: the merchant made the
   * goods, Agentify holds them, and a payment for this same purchase from the
   * wallet that paid releases them.
   */
  "payment_not_settled",
  /** `expired`: the price ran out before a payment for it was taken. */
  "price_expired",
  /** `expired`: the merchant did not answer a synchronous purchase in time. */
  "merchant_timed_out",
  /**
   * `fulfillment_closed` on a paid order: the merchant closed fulfillment with
   * no delivery recorded, and Agentify has verified no refund or agreement.
   */
  "merchant_closed",
] as const);

export const OrderEndingReasonSchema = z.enum(ORDER_ENDING_REASONS);
