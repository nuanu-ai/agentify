/**
 * Which clocks are running on an order right now.
 *
 * The gateway schedules its timers off this list and the machine checks against
 * it: a deadline not in the list cannot expire an order, and one in it cannot
 * expire it early. That keeps a quote from timing out while its settle is
 * already on its way, and a timer that fired twice from closing an order whose
 * merchant is still inside his deadline.
 *
 * Every open state in which the machine waits for somebody has exactly one
 * clock, so an overdue order goes to an ending the agent is told rather than
 * hanging. Three open states deliberately carry none: `unfulfilled` and
 * `delivered_unpaid` require a merchant or buyer action, and an order whose
 * charge never reported back waits for the payment layer, which alone has that
 * fact.
 *
 * Both clocks on the goods run from the moment the order became paid: in the
 * synchronous mode that is the payment checking out, in the asynchronous mode
 * the settle, since the buyer's money is at risk from then on. Neither runs
 * from the opening of the order, or an agent that pays late but inside its
 * quote's life would find the merchant's whole answer window already spent. The
 * settle's own deadline runs from the moment the payment was handed over for
 * execution.
 */

import { assertNever } from "../index.js";
import type { Deadline, Order } from "./model.js";

export function deadlines(order: Order): readonly Deadline[] {
  // While the payment is being executed, that is the only thing the order is
  // waiting on, whichever state it is sitting in.
  if (order.payment === "settling") {
    // A settling order without a start time cannot come out of this package but
    // can come out of a store. Nothing but the settle's own outcome can move
    // it, so it is treated as already overdue rather than left without a clock;
    // `moneyInvariantViolations` reports the same order.
    const startedAt = order.timestamps.settleStartedAt;
    return [
      {
        kind: "settle_response",
        at:
          startedAt === null
            ? order.timestamps.createdAt
            : startedAt + order.policy.deadlines.settleResponseMs,
      },
    ];
  }

  switch (order.state) {
    case "created":
      // The price has not come back yet. Running out of this clock is the
      // merchant's silence, which is answered by mode rather than by closing
      // the order, so it is not the life of a price that was never quoted.
      return [
        {
          kind: "quote_response",
          at: order.timestamps.createdAt + order.policy.deadlines.quoteResponseMs,
        },
      ];

    case "quoted":
      return order.payment === "none" && order.timestamps.quotedAt !== null
        ? [
            {
              kind: "quote_expiry",
              at: order.timestamps.quotedAt + order.policy.deadlines.quoteTtlMs,
            },
          ]
        : [];

    case "awaiting_confirmation":
      return order.timestamps.confirmationRequestedAt === null
        ? []
        : [
            {
              kind: "confirmation_response",
              at:
                order.timestamps.confirmationRequestedAt +
                order.policy.deadlines.confirmationResponseMs,
            },
          ];

    case "confirmed":
      return order.payment === "none" && order.timestamps.confirmedAt !== null
        ? [
            {
              kind: "payment_after_confirmation",
              at: order.timestamps.confirmedAt + order.policy.deadlines.paymentAfterConfirmationMs,
            },
          ]
        : [];

    case "paid":
    case "dispatched":
      return fulfillmentDeadline(order);

    case "fulfilled":
    case "delivered_unpaid":
      // The merchant has produced the goods and the money is ours to move. He
      // is held to none of his deadlines here; the clock that runs, when one
      // runs, is the settle's, handled above.
      return [];

    case "delivered":
    case "unfulfilled":
    case "fulfillment_closed":
    case "failed":
    case "rejected":
    case "declined":
    case "expired":
      return [];

    default:
      return assertNever(order.state, "order state");
  }
}

/**
 * The deadline on the goods themselves, whichever of the two modes the order
 * is in. It is exported because the machine asks for it when it decides
 * whether another delivery attempt could still arrive in time.
 */
export function fulfillmentDeadline(order: Order): readonly Deadline[] {
  const paidAt = order.timestamps.paidAt;
  if (paidAt === null) {
    // A paid order without a paid time cannot come out of this package but can
    // come out of a store, and there is nothing honest to start the merchant's
    // clock from. Unlike the stranded settle above, the merchant's own answer
    // can still move this order, so it is left to him rather than made overdue.
    return [];
  }

  const { syncResponseMs, asyncFulfillmentMs } = order.policy.deadlines;

  return order.mode.settle === "after_fulfillment"
    ? [{ kind: "sync_response", at: paidAt + syncResponseMs }]
    : [{ kind: "async_fulfillment", at: paidAt + asyncFulfillmentMs }];
}
