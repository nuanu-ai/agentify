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
   * gone, the parameters did not fit, the payment failed its check, the charge
   * came back failed, or a synchronous handler refused. On a parcel, "gone" can
   * also mean the merchant does not ship to that place or the address lacks
   * what their carrier needs.
   *
   * Where the merchant refused, the agent's status document carries their
   * `refusal` beside this word: a short code to branch on and a sentence to
   * show. Where Agentify ended the order, it carries a `reason` from
   * `ORDER_ENDING_REASONS` instead, never beside the merchant's words, so that
   * no merchant is credited with words they did not write. A payment that
   * failed its check carries neither.
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
   * The money moved and the goods have not come: the merchant owes the buyer
   * the goods or the money back. Not an ending, and it carries no deadline of
   * its own. Goods the merchant delivers after it still reach the buyer, settle
   * the debt and make the order `delivered`. The agent's status document always
   * says why it is owed, under `reason`.
   *
   * It does not say whether the money has already gone back. The merchant pays
   * back the whole price from their own wallet, although their payout contract
   * paid them only their share and the commission stays with Agentify. The
   * gateway has no way to record that they did, so nothing moves an order on to
   * `refunded`, and a buyer already paid back still reads this word.
   */
  "refund_due",
  /** A refund of that debt is recorded. Nothing can record one yet. */
  "refunded",
  /**
   * The merchant delivered synchronously and the payment did not execute. The
   * goods exist, nothing was paid, and the order stays open until a repeat
   * purchase carries the payment through.
   */
  "delivered_unpaid",
] as const);

export const OrderStatusSchema = z.enum(ORDER_STATUSES);

export type OrderStatus = z.infer<typeof OrderStatusSchema>;

/**
 * Why an order ended, where Agentify and not its merchant decided it and one
 * status word would otherwise cover endings that call for different next
 * steps. A merchant's refusal travels in their own words and never gets one of
 * these beside it.
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
  /** `rejected`: the payment layer said the charge did not go through. */
  "payment_not_settled",
  /** `expired`: the price ran out before a payment for it was taken. */
  "price_expired",
  /** `expired`: the merchant did not answer a synchronous purchase in time. */
  "merchant_timed_out",
] as const);

export const OrderEndingReasonSchema = z.enum(ORDER_ENDING_REASONS);
