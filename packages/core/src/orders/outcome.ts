/**
 * What the agent is told an order came to.
 *
 * The vocabulary here is the portal's table of how an order can end, read from
 * the buyer's side: nine endings, plus the word for an order that has not
 * ended yet, plus the one for a debt that has been paid back. The projection is
 * separate from the state on purpose — the machine keeps distinctions the
 * merchant's own accounting needs, and the agent is told only what is true of
 * his purchase.
 *
 * The fifth gate is the whole point of `in_progress`. An order whose answer has
 * not arrived says so, and the agent does not read silence as a refusal.
 */

import { assertNever } from "../index.js";
import type { Order } from "./model.js";
import { isOpen } from "./model.js";

export const ORDER_OUTCOMES = [
  /** The answer is not in yet. Not a refusal, and not a promise either. */
  "in_progress",
  /** The goods are the agent's and the receipt is written. */
  "delivered",
  /**
   * A parcel is with the carrier and the money with the merchant (ADR-0033).
   * The machine's state is `delivered`, and the agent is told something
   * narrower, because nothing reached the agent: this is the last word anybody
   * here has about the parcel, and whether it arrives is between the buyer and
   * the merchant.
   */
  "shipped",
  /**
   * The purchase did not happen and nothing was charged: the goods were gone,
   * the parameters did not fit, the payment did not pass verification, the
   * charge was reported as failed, or the merchant refused a synchronous
   * order. In every one of these the machine knows the buyer's money did not
   * move; where it only believes so, the word is `payment_unresolved`.
   */
  "rejected",
  /**
   * Nobody can say whether the buyer was charged: the payment network was
   * asked and never answered. It is deliberately not `rejected`, and it does
   * not say the order is closed. An agent told his purchase did not happen
   * goes and buys the same thing elsewhere without looking at his wallet, and
   * that is a claim this machine has no evidence for. A later read can still
   * move, where a fact about the charge arrives after this one.
   */
  "payment_unresolved",
  /** The merchant answered a confirmation request with "I will not". */
  "declined",
  /** A deadline ran out. Nothing was charged. */
  "expired",
  /** The merchant left and the order closed with him. */
  "cancelled",
  /** The money was taken and the goods never came: a refund is owed. */
  "refund_due",
  /** That refund has been paid back. */
  "refunded",
  /**
   * The merchant produced the goods for a synchronous purchase and the charge
   * did not go through. The purchase did not happen; repeating it drives the
   * payment home against the fulfillment that already exists.
   */
  "delivered_unpaid",
] as const;

export type OrderOutcome = (typeof ORDER_OUTCOMES)[number];

export function outcomeFor(order: Order): OrderOutcome {
  // A charge the payment network never answered about outranks whatever the
  // state would otherwise say, because it is the one thing the agent most
  // needs to hear and the one thing the machine most easily overstates. Open
  // or closed, the word is the same: nobody knows. The interpreter asks once;
  // a silence is not a question still in flight, and `in_progress` is what a
  // merchant's restart treats as an order waiting on him. A later fact can
  // still move the order — the state stays open where the goods are already
  // made — and a later read says which way it moved.
  //
  // The test is the payment stage and not the closure. An order closed on the
  // silence keeps that closure after the charge finally reports in and the
  // order becomes a debt, because the closure records why the order stopped
  // where it stopped; reading it here would go on claiming nobody knows about
  // an order the machine has just written a refund against.
  if (order.payment === "outcome_unknown") {
    return "payment_unresolved";
  }

  switch (order.state) {
    case "created":
    case "quoted":
    case "awaiting_confirmation":
    case "confirmed":
    case "paid":
    case "dispatched":
    case "fulfilled":
      return "in_progress";
    case "delivered":
      return order.mode.parcel === true ? "shipped" : "delivered";
    case "delivered_unpaid":
      return "delivered_unpaid";
    case "refund_due":
      return "refund_due";
    case "refunded":
      return "refunded";
    case "failed":
      // The merchant's handler refused before any money moved. The merchant's
      // own metrics can tell this apart from a purchase that never reached
      // him; to the agent both are one sentence — a refusal with a reason.
      return "rejected";
    case "rejected":
      return "rejected";
    case "declined":
      return "declined";
    case "expired":
      return "expired";
    case "cancelled":
      return "cancelled";
    default:
      return assertNever(order.state, "order state");
  }
}

/**
 * Why an order ended, where its merchant did not say and one status word would
 * otherwise cover endings that call for different next steps.
 *
 * `rejected` is a product that is gone, a price check nobody answered and a
 * charge that did not go through; `expired` is a price that ran out before the
 * payment and a merchant who did not answer a synchronous purchase in time. An
 * agent told only the word either gives up on a seller worth trying again or
 * keeps trying one that will not sell. The merchant's own refusal is not here:
 * it travels in their words, and a reason of ours beside it would be speaking
 * for them. Nor are the endings whose word already says it all — a payment
 * nobody can account for, a debt, a departure.
 */
export const ENDING_REASONS = [
  /** The merchant's price check said there is none; it did not say why. */
  "unavailable",
  /** The merchant's price check gave no price the purchase could use. */
  "price_check_unanswered",
  /** The payment layer said the charge did not go through. */
  "payment_not_settled",
  /** The price ran out before a payment for it was taken. */
  "price_expired",
  /** The merchant did not answer a synchronous purchase in time. */
  "merchant_timed_out",
] as const;

export type EndingReason = (typeof ENDING_REASONS)[number];

export function endingReasonFor(order: Order): EndingReason | null {
  const outcome = outcomeFor(order);
  if ((outcome !== "rejected" && outcome !== "expired") || order.closure === null) {
    return null;
  }
  const closure = order.closure;
  switch (closure.cause) {
    case "unavailable":
      return "unavailable";
    case "quote_silent":
      return "price_check_unanswered";
    case "payment_not_settled":
      return "payment_not_settled";
    case "deadline_expired":
      if (closure.deadline === "quote_expiry") {
        return "price_expired";
      }
      return closure.deadline === "sync_response" ? "merchant_timed_out" : null;
    case "payment_not_verified":
    case "payment_outcome_unknown":
    case "merchant_refused":
    case "merchant_departed":
      return null;
    default:
      return assertNever(closure, "closure");
  }
}

/**
 * Whether a restarted merchant's open list should carry this order.
 *
 * Machine-open is wider. A price the buyer has not paid, which never reached
 * the handler, is open in the machine and is not this merchant's to finish.
 * Putting it on the list they walk after a restart is how goods get made for
 * a purchase that never happened. The buyer's own status of that order stays
 * `in_progress`; this predicate is only the list.
 *
 * A charge nobody heard back from is on the list even so. Hiding it is how it
 * gets read as an order still waiting on the merchant. Its status says the
 * outcome is unknown, which is the word the list is for.
 *
 * Confirmation is not a fulfillment the merchant was handed an order for, and
 * that mode is not on the wire. An order waiting on the buyer's payment after
 * a confirmation is not on this list either: nothing there is his to deliver.
 */
export function onTheMerchantsOpenList(order: Order): boolean {
  if (order.payment === "outcome_unknown" && isOpen(order.state)) {
    return true;
  }

  switch (order.state) {
    case "paid":
    case "dispatched":
    case "fulfilled":
    case "refund_due":
    case "delivered_unpaid":
      return true;
    case "created":
    case "quoted":
    case "awaiting_confirmation":
    case "confirmed":
    case "delivered":
    case "refunded":
    case "failed":
    case "rejected":
    case "declined":
    case "expired":
    case "cancelled":
      return false;
    default:
      return assertNever(order.state, "order state");
  }
}
