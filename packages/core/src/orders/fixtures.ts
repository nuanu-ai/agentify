/**
 * Order fixtures for this package's tests, deliberately not exported from the
 * package index: a builder that guesses defaults has no place next to real
 * purchases. Every number here is a test value; the real deadlines and attempt
 * counts are the gateway's configuration.
 */

import type { CreateOrderInput, MerchantSelling, PriceCheck } from "./create.js";
import { createOrder } from "./create.js";
import { transition } from "./machine.js";
import type {
  Effect,
  FulfillmentMode,
  Order,
  OrderEvent,
  OrderEventKind,
  OrderPolicy,
  OrderState,
  Price,
} from "./model.js";
import { modeOf } from "./model.js";

/** An arbitrary but fixed instant. Time is a value here, never a clock. */
export const T0 = 1_000_000;

export const TEST_POLICY: OrderPolicy = {
  deadlines: {
    quoteResponseMs: 5_000,
    quoteTtlMs: 60_000,
    settleResponseMs: 30_000,
    syncResponseMs: 10_000,
    paymentAfterConfirmationMs: 300_000,
    confirmationResponseMs: 600_000,
    asyncFulfillmentMs: 900_000,
  },
  redelivery: {
    baseDelayMs: 1_000,
    factor: 2,
    maxDelayMs: 60_000,
    maxAttempts: 5,
  },
};

export const TEST_PRICE: Price = { amount: "5.00", currency: "USD", asOf: T0 };

export function createInput(
  fulfillment: FulfillmentMode,
  overrides: Partial<CreateOrderInput> = {},
): CreateOrderInput {
  return {
    id: "ord_7c1e05",
    at: T0,
    mode: modeOf(fulfillment),
    policy: TEST_POLICY,
    priceCheck: "none" satisfies PriceCheck,
    cardPrice: TEST_PRICE,
    test: false,
    selling: "open" satisfies MerchantSelling,
    ...overrides,
  };
}

/** An order that already passed creation, for tests that start further in. */
export function newOrder(
  fulfillment: FulfillmentMode,
  overrides: Partial<CreateOrderInput> = {},
): Order {
  const created = createOrder(createInput(fulfillment, overrides));
  if (!created.ok) {
    throw new Error(`fixture could not create the order: ${created.rejection.code}`);
  }
  return created.order;
}

/**
 * One event of every kind, for the sweeps over every pairing of a state and an
 * event. Two values are load-bearing and easy to break without noticing.
 *
 * The quoted price is in the card's own currency. A quote in another currency
 * is refused, so a sample in euros would make the one pairing that prices an
 * order illegal while every sweep went on passing.
 *
 * The expiry is far enough out that any deadline it names is due. An earlier
 * instant would be turned back as premature everywhere, and the sweeps would
 * exercise that guard instead of the machine.
 */
export function sampleEvent(kind: OrderEventKind): OrderEvent {
  switch (kind) {
    case "quote_answered":
      return {
        kind,
        at: T0 + 1,
        available: true,
        price: { amount: "6.50", currency: TEST_PRICE.currency, asOf: T0 + 1 },
      };
    case "handler_refused":
      return { kind, at: T0 + 1, code: "out_of_stock", message: "none left" };
    case "refuse_called":
      return { kind, at: T0 + 1, code: "cannot_fulfill", message: "the supplier is silent" };
    case "payment_verification_failed":
      return { kind, at: T0 + 1, reason: "insufficient_funds" };
    case "deadline_expired":
      return { kind, at: T0 + 1_000_000, deadline: "sync_response" };
    default:
      return { kind, at: T0 + 1 };
  }
}

/** Unwraps a transition, turning a rejection into a loud test failure. */
export function must(
  order: Order,
  event: OrderEvent,
): { order: Order; effects: readonly Effect[] } {
  const result = transition(order, event);
  if (!result.ok) {
    throw new Error(
      `expected a legal transition out of ${order.state} on ${event.kind}, ` +
        `got ${result.rejection.code}: ${result.rejection.message}`,
    );
  }
  return { order: result.order, effects: result.effects };
}

/** Walks a sequence of legal events and returns the order at the end of it. */
export function walk(order: Order, events: readonly OrderEvent[]): Order {
  return events.reduce((current, event) => must(current, event).order, order);
}

const PAID_SYNC: readonly OrderEvent[] = [{ kind: "payment_verified", at: T0 + 1 }];

const PAID_ASYNC: readonly OrderEvent[] = [
  { kind: "payment_verified", at: T0 + 1 },
  { kind: "payment_settled", at: T0 + 2 },
];

/**
 * One order in each state, each walked there through legal events only, so a
 * state nothing can reach fails here first.
 */
export function reach(state: OrderState): Order {
  switch (state) {
    case "created":
      return newOrder("sync", { priceCheck: "merchant" });
    case "quoted":
      return newOrder("sync");
    case "awaiting_confirmation":
      return walk(newOrder("confirm"), [{ kind: "confirmation_dispatched", at: T0 + 1 }]);
    case "confirmed":
      return walk(newOrder("confirm"), [
        { kind: "confirmation_dispatched", at: T0 + 1 },
        { kind: "handler_accepted", at: T0 + 2 },
      ]);
    case "paid":
      return walk(newOrder("sync"), PAID_SYNC);
    case "dispatched":
      return walk(newOrder("sync"), [...PAID_SYNC, { kind: "order_dispatched", at: T0 + 3 }]);
    case "fulfilled":
      return walk(newOrder("sync"), [
        ...PAID_SYNC,
        { kind: "order_dispatched", at: T0 + 3 },
        { kind: "handler_delivered", at: T0 + 4 },
      ]);
    case "delivered":
      return walk(reach("fulfilled"), [{ kind: "payment_settled", at: T0 + 5 }]);
    case "delivered_unpaid":
      return walk(reach("fulfilled"), [{ kind: "payment_settle_failed", at: T0 + 5 }]);
    case "unfulfilled":
      return walk(newOrder("async"), [
        ...PAID_ASYNC,
        { kind: "order_dispatched", at: T0 + 3 },
        { kind: "handler_refused", at: T0 + 4, code: "out_of_stock", message: "none left" },
      ]);
    case "fulfillment_closed":
      return walk(reach("unfulfilled"), [{ kind: "close_called", at: T0 + 9 }]);
    case "failed":
      return walk(newOrder("sync"), [
        ...PAID_SYNC,
        { kind: "order_dispatched", at: T0 + 3 },
        { kind: "handler_refused", at: T0 + 4, code: "out_of_stock", message: "none left" },
      ]);
    case "rejected":
      return walk(newOrder("sync", { priceCheck: "merchant" }), [
        { kind: "quote_answered", at: T0 + 1, available: false },
      ]);
    case "declined":
      return walk(newOrder("confirm"), [
        { kind: "confirmation_dispatched", at: T0 + 1 },
        { kind: "handler_refused", at: T0 + 2, code: "cannot_fulfill", message: "not this week" },
      ]);
    case "expired":
      return walk(newOrder("sync"), [
        { kind: "deadline_expired", at: T0 + 999_999, deadline: "quote_expiry" },
      ]);
    default:
      throw new Error(`no walk is written for the state ${state satisfies never}`);
  }
}
