import { describe, expect, it } from "vitest";
import type { CreateOrderInput } from "./create.js";
import { createOrder } from "./create.js";
import { deadlines } from "./deadlines.js";
import { transition } from "./machine.js";
import type { Effect, Order, OrderEvent, OrderPolicy, Price } from "./model.js";
import { modeOf } from "./model.js";
import { moneyInvariantViolations } from "./money.js";
import { outcomeFor } from "./outcome.js";

/**
 * One order from the intent to buy to the receipt, built without the shared
 * fixtures so that this walk cannot agree with the other tests about a mistake.
 * It asks at every step whether what came back is what a person would expect to
 * see.
 *
 * The product is an eSIM in the asynchronous mode, paid for at once and
 * provisioned afterwards, as a real merchant sells it. The provisioning outage
 * in the middle is invented for this walk.
 */

const NOON = 1_772_000_000_000;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const POLICY: OrderPolicy = {
  deadlines: {
    quoteResponseMs: 5 * SECOND,
    quoteTtlMs: 2 * MINUTE,
    settleResponseMs: 30 * SECOND,
    syncResponseMs: 10 * SECOND,
    asyncFulfillmentMs: 4 * HOUR,
  },
  redelivery: { baseDelayMs: 2 * SECOND, factor: 4, maxDelayMs: 5 * MINUTE, maxAttempts: 6 },
};

/** What the card says the eSIM costs. */
const CARD_PRICE: Price = { amount: "9.00", currency: "USD", asOf: NOON - HOUR };

/** What the merchant's own price check answers when asked at the purchase. */
const LIVE_PRICE: Price = { amount: "9.50", currency: "USD", asOf: NOON };

const PURCHASE: CreateOrderInput = {
  id: "ord_e51m01",
  at: NOON,
  mode: modeOf("async"),
  policy: POLICY,
  priceCheck: "merchant",
  cardPrice: CARD_PRICE,
  test: false,
  selling: "open",
};

function step(order: Order, event: OrderEvent): { order: Order; effects: readonly Effect[] } {
  const result = transition(order, event);
  if (!result.ok) {
    throw new Error(
      `${event.kind} was refused in ${order.state}: ${result.rejection.code} — ` +
        result.rejection.message,
    );
  }
  // Checking after every step catches the step that broke the money invariant
  // rather than the one that inherited it.
  expect(moneyInvariantViolations(result.order), `after ${event.kind}`).toStrictEqual([]);
  return { order: result.order, effects: result.effects };
}

describe("one eSIM, bought and provisioned, with the provisioner down at first", () => {
  it("walks from the intent to buy to the receipt", () => {
    // The card carries a price check, so nothing is quoted yet.
    const created = createOrder(PURCHASE);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(created.order.state).toBe("created");
    expect(created.order.price).toBeNull();
    expect(created.effects).toStrictEqual([{ kind: "request_quote" }]);
    expect(outcomeFor(created.order)).toBe("in_progress");
    // Even here the order is on a clock: the one bounding how long we wait for
    // the merchant to name a price.
    expect(deadlines(created.order)).toStrictEqual([
      { kind: "quote_response", at: NOON + 5 * SECOND },
    ]);

    // The merchant's price is fifty cents above the card's snapshot, so the
    // sale goes at his number.
    const quoted = step(created.order, {
      kind: "quote_answered",
      at: NOON + SECOND,
      available: true,
      price: LIVE_PRICE,
    });

    expect(quoted.order.state).toBe("quoted");
    expect(quoted.order.price).toStrictEqual(LIVE_PRICE);
    expect(quoted.order.quoteSource).toBe("merchant_answer");
    expect(quoted.effects).toStrictEqual([{ kind: "verify_payment" }]);
    expect(deadlines(quoted.order)).toStrictEqual([
      { kind: "quote_expiry", at: NOON + SECOND + 2 * MINUTE },
    ]);

    // This is an eSIM, so the money moves at the purchase and not after the
    // goods.
    const verified = step(quoted.order, { kind: "payment_verified", at: NOON + 2 * SECOND });

    expect(verified.order.state).toBe("quoted");
    expect(verified.order.payment).toBe("settling");
    expect(verified.effects).toStrictEqual([{ kind: "execute_payment" }]);
    // Once the settle is in flight the price no longer bounds the order, so
    // nothing can expire it out from under the money. The order now waits on
    // the answer about the charge, which has a clock of its own.
    expect(deadlines(verified.order)).toStrictEqual([
      { kind: "settle_response", at: NOON + 2 * SECOND + 30 * SECOND },
    ]);

    const paid = step(verified.order, { kind: "payment_settled", at: NOON + 3 * SECOND });

    expect(paid.order.state).toBe("paid");
    expect(paid.order.payment).toBe("settled");
    expect(paid.effects).toStrictEqual([{ kind: "dispatch_order" }]);
    // The merchant's four hours start here, where the buyer's money went.
    expect(deadlines(paid.order)).toStrictEqual([
      { kind: "async_fulfillment", at: NOON + 3 * SECOND + 4 * HOUR },
    ]);

    const dispatched = step(paid.order, { kind: "order_dispatched", at: NOON + 4 * SECOND });

    expect(dispatched.order.state).toBe("dispatched");
    expect(dispatched.order.dispatch).toStrictEqual({ attempts: 1, accepted: false });

    // The provisioning API is down and the handler throws. That is not an
    // answer, so the order comes back rather than closing.
    const threw = step(dispatched.order, { kind: "handler_undelivered", at: NOON + 5 * SECOND });

    expect(threw.order.state).toBe("dispatched");
    expect(threw.effects).toStrictEqual([
      { kind: "redeliver_order", attempt: 2, delayMs: 2 * SECOND },
    ]);

    const again = step(threw.order, { kind: "order_dispatched", at: NOON + 7 * SECOND });

    expect(again.order.dispatch.attempts).toBe(2);

    // This time the handler takes the order on; the profile will be issued
    // later, not in this answer.
    const accepted = step(again.order, { kind: "handler_accepted", at: NOON + 8 * SECOND });

    expect(accepted.order.dispatch.accepted).toBe(true);
    expect(accepted.effects).toStrictEqual([
      { kind: "answer_merchant", answer: { ok: true, result: "accepted" } },
    ]);
    expect(outcomeFor(accepted.order)).toBe("in_progress");

    // The queue delivers at least once. A third delivery was already on its way
    // when the second was taken on, so a second worker receives the order while
    // the first is still provisioning. The order is open, so this hand-over is
    // counted and the worker is told the work is his.
    const duplicate = step(accepted.order, { kind: "order_dispatched", at: NOON + 10 * MINUTE });

    expect(duplicate.order.dispatch.attempts).toBe(3);

    const acceptedAgain = step(duplicate.order, {
      kind: "handler_accepted",
      at: NOON + 10 * MINUTE + SECOND,
    });

    expect(acceptedAgain.effects).toStrictEqual([
      { kind: "answer_merchant", answer: { ok: true, result: "accepted" } },
    ]);

    // Twenty minutes later the profile exists and the merchant says so, well
    // inside his four hours.
    const delivered = step(acceptedAgain.order, { kind: "deliver_called", at: NOON + 20 * MINUTE });

    expect(delivered.order.state).toBe("delivered");
    expect(delivered.effects).toStrictEqual([
      { kind: "release_goods_to_agent" },
      { kind: "issue_receipt" },
      { kind: "answer_merchant", answer: { ok: true, result: "delivered" } },
    ]);
    expect(outcomeFor(delivered.order)).toBe("delivered");
    expect(deadlines(delivered.order)).toStrictEqual([]);

    // The second worker calls in a minute later with the profile it made. The
    // order is closed by then, so it is told the order's state rather than that
    // its delivery landed: the buyer keeps the first profile, and no second one
    // is recorded against the order.
    const answeredAgain = step(delivered.order, {
      kind: "handler_delivered",
      at: NOON + 21 * MINUTE,
    });

    expect(answeredAgain.order.state).toBe("delivered");
    expect(answeredAgain.effects).toStrictEqual([
      { kind: "answer_merchant", answer: { ok: true, result: "already_delivered" } },
    ]);

    // The merchant's own retry of the deliver call after a broken connection
    // gets the same success back, with no second profile issued.
    const deliveredTwice = step(answeredAgain.order, {
      kind: "deliver_called",
      at: NOON + 22 * MINUTE,
    });

    expect(deliveredTwice.effects).toStrictEqual([
      { kind: "answer_merchant", answer: { ok: true, result: "already_delivered" } },
    ]);
    expect(deliveredTwice.order.price).toStrictEqual(LIVE_PRICE);
    expect(deliveredTwice.order.payment).toBe("settled");
    expect(outcomeFor(deliveredTwice.order)).toBe("delivered");
  });

  it("would have been left unfulfilled had the four hours run out instead", () => {
    // The same order, taken to the same point and then left. The merchant's
    // side never comes back, and the order must end in a debt rather than a
    // quiet closure.
    const created = createOrder(PURCHASE);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    let order = created.order;
    for (const event of [
      { kind: "quote_answered", at: NOON + SECOND, available: true, price: LIVE_PRICE },
      { kind: "payment_verified", at: NOON + 2 * SECOND },
      { kind: "payment_settled", at: NOON + 3 * SECOND },
      { kind: "order_dispatched", at: NOON + 4 * SECOND },
      { kind: "handler_accepted", at: NOON + 5 * SECOND },
    ] satisfies OrderEvent[]) {
      order = step(order, event).order;
    }

    const late = step(order, {
      kind: "deadline_expired",
      at: NOON + 3 * SECOND + 4 * HOUR,
      deadline: "async_fulfillment",
    });

    expect(late.order.state).toBe("unfulfilled");
    expect(late.order.payment).toBe("settled");
    expect(late.effects).toStrictEqual([
      {
        kind: "mark_unfulfilled",
        closure: { cause: "deadline_expired", deadline: "async_fulfillment" },
      },
      { kind: "emit_merchant_event", event: "order.unfulfilled" },
    ]);
    expect(outcomeFor(late.order)).toBe("unfulfilled");

    // A profile that shows up an hour late still closes the debt: the buyer
    // paid for goods, and late goods beat a refund.
    const rescued = step(late.order, { kind: "deliver_called", at: NOON + 5 * HOUR });

    expect(rescued.order.state).toBe("delivered");
    expect(outcomeFor(rescued.order)).toBe("delivered");
    expect(rescued.effects).toContainEqual({
      kind: "answer_merchant",
      answer: { ok: true, result: "delivered_late" },
    });
  });
});
