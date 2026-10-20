/**
 * What the agent is told an order came to: the portal's table of endings read
 * from the buyer's side, plus a word for an order that has not ended and one
 * for fulfillment that Agentify will no longer perform. It is kept apart from the state because the machine
 * keeps distinctions the merchant's accounting needs, and the agent is told
 * only what is true of his purchase. An order whose answer has not arrived says
 * so as `in_progress`, so the agent never reads silence as a refusal.
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
   * A parcel is with the carrier and the money with the merchant. The machine's
   * state is `delivered`, but the agent is told something narrower because
   * nothing reached the agent: this is the last word anybody here has about the
   * parcel, and whether it arrives is between the buyer and the merchant.
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
   * Nobody can say whether the buyer was charged: the payment network was asked
   * and never answered. It is deliberately neither `rejected` nor a claim that
   * the order is closed: an agent told his purchase did not happen buys the
   * same thing elsewhere without looking at his wallet, and the machine has no
   * evidence for that. A later read can move when a fact about the charge
   * arrives.
   */
  "payment_unresolved",
  /** The merchant answered a confirmation request with "I will not". */
  "declined",
  /** A deadline ran out. Nothing was charged. */
  "expired",
  /** The merchant left and the order closed with him. */
  "cancelled",
  /** The original payment settled and no delivery is recorded. */
  "unfulfilled",
  /** Agentify fulfillment is closed; this says nothing about any refund. */
  "fulfillment_closed",
  /**
   * The merchant produced the goods for a synchronous purchase and the charge
   * did not go through. The purchase did not happen; repeating it drives the
   * payment home against the fulfillment that already exists.
   */
  "delivered_unpaid",
] as const;

export type OrderOutcome = (typeof ORDER_OUTCOMES)[number];

export function outcomeFor(order: Order): OrderOutcome {
  // A charge the payment network never answered about outranks the state: it is
  // what the agent most needs to hear and what the machine most easily
  // overstates. Open or closed, the word is the same, nobody knows. It is not
  // `in_progress`, because the interpreter asks only once and a merchant's
  // restart treats `in_progress` as an order waiting on him.
  //
  // The test reads the payment stage, not the closure. An order closed on the
  // silence keeps that closure after the charge reports in and the order
  // becomes unfulfilled, and reading the closure would keep claiming nobody
  // knows after the payment was confirmed.
  if (
    order.payment === "outcome_unknown" ||
    (order.state === "fulfillment_closed" && order.payment === "settling")
  ) {
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
    case "unfulfilled":
      return "unfulfilled";
    case "fulfillment_closed":
      return "fulfillment_closed";
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
 * Why an order ended, where its merchant did not say and one status word covers
 * endings that call for different next steps. `rejected` covers a product that
 * is gone, a price check nobody answered and a charge that did not go through;
 * `expired` covers a price that ran out before the payment and a merchant who
 * did not answer a synchronous purchase in time.
 *
 * The merchant's own refusal has no reason here: it travels in their words, and
 * a reason of ours beside it would speak for them. Endings whose word already
 * says it all have none either. A paid order the merchant closed is the one
 * place a reason of ours stands beside the merchant's words, because those
 * words can contradict the payment.
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
  /**
   * The merchant closed fulfillment of a paid order. Their own words stand
   * beside it, and this says what Agentify knows: paid, nothing delivered, no
   * refund verified.
   */
  "merchant_closed",
] as const;

export type EndingReason = (typeof ENDING_REASONS)[number];

export function endingReasonFor(order: Order): EndingReason | null {
  const outcome = outcomeFor(order);
  if (outcome === "fulfillment_closed") {
    return order.payment === "settled" ? "merchant_closed" : null;
  }
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
 * Whether a restarted merchant's open list carries this order. It is narrower
 * than machine-open: an unpaid price never reached the handler and is not the
 * merchant's to finish, and listing it is how goods get made for a purchase
 * that never happened (the buyer still reads `in_progress`). A charge nobody
 * heard back from is listed even so, with a status saying the outcome is
 * unknown. An order waiting on the buyer's payment after a confirmation is not
 * listed: nothing there is the merchant's to deliver. A closed order whose
 * payment completed after the closure is listed until the merchant closes it
 * again, since the buyer paid and nothing was delivered.
 */
export function onTheMerchantsOpenList(order: Order): boolean {
  if (order.payment === "outcome_unknown" && isOpen(order.state)) {
    return true;
  }
  if (paidAfterClosure(order)) {
    return true;
  }

  switch (order.state) {
    case "paid":
    case "dispatched":
    case "fulfilled":
    case "unfulfilled":
    case "delivered_unpaid":
      return true;
    case "created":
    case "quoted":
    case "awaiting_confirmation":
    case "confirmed":
    case "delivered":
    case "fulfillment_closed":
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

/**
 * Whether the buyer's payment completed after the merchant had closed
 * fulfillment, and the merchant has not closed the order again since. The
 * merchant was told by `order.unfulfilled`, and the order waits on their list.
 */
export function paidAfterClosure(order: Order): boolean {
  return (
    order.state === "fulfillment_closed" &&
    order.payment === "settled" &&
    order.merchantClosure?.paymentCompletedAt !== undefined
  );
}

/**
 * Whether the store keeps an order on its open list: an open state, or a
 * closed order whose payment completed after the closure.
 */
export function listedAsOpen(order: Order): boolean {
  return isOpen(order.state) || paidAfterClosure(order);
}
