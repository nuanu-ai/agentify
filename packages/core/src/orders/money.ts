/**
 * The rules about money that no order may break, in a form a machine can check.
 * The gateway runs this on an order before writing it down; a violation is a
 * defect in this package, not a case to be handled.
 */

import type { Order, OrderState } from "./model.js";

/** These endings cannot carry a confirmed original payment. */
const CLOSED_WITHOUT_PAYMENT: readonly OrderState[] = ["rejected", "expired", "failed"];

/** The states in which the buyer's money has legitimately been taken. */
const MAY_HOLD_THE_BUYERS_MONEY: readonly OrderState[] = [
  "paid",
  "dispatched",
  "delivered",
  "unfulfilled",
  "fulfillment_closed",
];

/**
 * The states in which a payment may legitimately be mid-execution. Everywhere
 * else, a settle in flight means the machine let something else happen to the
 * order while it did not know where the money was.
 */
const MAY_BE_CHARGING: readonly OrderState[] = [
  "quoted",
  "fulfilled",
  "delivered_unpaid",
  "fulfillment_closed",
];

/**
 * The states in which a charge may be recorded as unaccounted for: orders the
 * machine has stopped moving while it waits for the payment layer to speak.
 * `rejected` closed on the guess that the money did not move;
 * `delivered_unpaid` has the goods already made.
 */
const MAY_BE_UNACCOUNTED: readonly OrderState[] = [
  "rejected",
  "delivered_unpaid",
  "fulfillment_closed",
];

/** An unfulfilled paid order requires a confirmed original payment. */
const REQUIRES_CONFIRMED_PAYMENT: readonly OrderState[] = ["unfulfilled"];

export function moneyInvariantViolations(order: Order): readonly string[] {
  const violations: string[] = [];

  if (order.payment === "settled" && !MAY_HOLD_THE_BUYERS_MONEY.includes(order.state)) {
    violations.push(
      `the buyer paid and the order sits in ${order.state}, which records neither completed nor stopped paid fulfillment`,
    );
  }

  if (order.payment === "settled" && CLOSED_WITHOUT_PAYMENT.includes(order.state)) {
    violations.push(`the buyer paid and the order is closed as ${order.state}, owing nothing`);
  }

  if (order.payment !== "settled" && REQUIRES_CONFIRMED_PAYMENT.includes(order.state)) {
    violations.push(`the order is in ${order.state} without a confirmed original payment`);
  }

  if (order.state === "delivered" && order.payment !== "settled") {
    violations.push("the order is a success and the money never moved");
  }

  if (order.state === "delivered_unpaid" && order.payment === "settled") {
    violations.push("the order is marked unpaid and the money did move");
  }

  if (order.payment === "settling" && !MAY_BE_CHARGING.includes(order.state)) {
    violations.push(
      `the payment is being executed and the order has moved on to ${order.state}, ` +
        "so whatever happens to the money now happens to a decided order",
    );
  }

  if (order.payment === "outcome_unknown" && !MAY_BE_UNACCOUNTED.includes(order.state)) {
    violations.push(
      `a charge on this order never reported back and the order is in ${order.state}, ` +
        "which is not a place to wait in",
    );
  }

  if (order.payment === "settling" && order.timestamps.settleStartedAt === null) {
    // Only the settle's own outcome can move an order in this stage, so an
    // order that lost the instant its clock runs from waits for an answer
    // nobody will ever ask for.
    violations.push("the payment is being executed and the order has no record of when that began");
  }

  return violations;
}
