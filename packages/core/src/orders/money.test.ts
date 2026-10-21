import { describe, expect, it } from "vitest";
import { must, newOrder, reach, sampleEvent, T0, walk } from "./fixtures.js";
import { transition } from "./machine.js";
import type { Effect, Order } from "./model.js";
import { ORDER_EVENT_KINDS, ORDER_STATES } from "./model.js";
import { moneyInvariantViolations } from "./money.js";

const MONEY_EFFECTS: readonly Effect["kind"][] = ["execute_payment", "release_goods_to_agent"];

function moved(effects: readonly Effect[]): readonly string[] {
  return effects.map((effect) => effect.kind).filter((kind) => MONEY_EFFECTS.includes(kind));
}

describe("the invariants of the order's money", () => {
  it("holds in every state the machine can reach", () => {
    for (const state of ORDER_STATES) {
      expect(moneyInvariantViolations(reach(state)), `an order in ${state}`).toStrictEqual([]);
    }
  });

  it("holds after every event the machine accepts, from every state", () => {
    // The gateway will feed the machine pairings nobody planned. Any one that
    // leaves the money and the state disagreeing leaves a buyer out of pocket
    // with no record saying so.
    let accepted = 0;

    for (const state of ORDER_STATES) {
      for (const kind of ORDER_EVENT_KINDS) {
        const result = transition(reach(state), sampleEvent(kind));
        if (!result.ok) continue;
        accepted += 1;
        expect(
          moneyInvariantViolations(result.order),
          `${state} on ${kind} produced ${result.order.state}/${result.order.payment}`,
        ).toStrictEqual([]);
      }
    }

    expect(accepted).toBeGreaterThan(60);
  });

  // Negative controls for the invariants. Each reads the whole list of broken
  // rules rather than its length, because a control that reads a length is
  // satisfied by any other rule that fires on the same order. The sentences are
  // not an implementation detail: the gateway joins them into the error a
  // person reads when an order will not persist.

  it("catches an order that claims paid fulfillment stopped without a charge behind it", () => {
    const impossible: Order = { ...reach("dispatched"), state: "unfulfilled", payment: "none" };

    expect(moneyInvariantViolations(impossible)).toStrictEqual([
      "the order is in unfulfilled without a confirmed original payment",
    ]);
  });

  it("catches a success that nobody paid for", () => {
    const impossible: Order = { ...reach("dispatched"), state: "delivered", payment: "verified" };

    expect(moneyInvariantViolations(impossible)).toStrictEqual([
      "the order is a success and the money never moved",
    ]);
  });

  it("catches money taken on an order closed as free", () => {
    const impossible: Order = { ...reach("dispatched"), state: "expired", payment: "settled" };

    expect(moneyInvariantViolations(impossible)).toStrictEqual([
      "the buyer paid and the order sits in expired, which records neither completed nor stopped paid fulfillment",
      "the buyer paid and the order is closed as expired, owing nothing",
    ]);
  });

  it("catches an order marked unpaid while the buyer's money did move", () => {
    const impossible: Order = { ...reach("delivered_unpaid"), payment: "settled" };

    expect(moneyInvariantViolations(impossible)).toStrictEqual([
      "the buyer paid and the order sits in delivered_unpaid, which records neither completed nor stopped paid fulfillment",
      "the order is marked unpaid and the money did move",
    ]);
  });

  it("catches an order carrying on with an unaccounted charge behind it", () => {
    // Only an order the machine has stopped moving may wait on a payment layer
    // that went quiet. Anywhere else the order is carrying on with an open
    // question about the buyer's money behind it.
    const impossible: Order = { ...reach("dispatched"), payment: "outcome_unknown" };

    expect(moneyInvariantViolations(impossible)).toStrictEqual([
      "a charge on this order never reported back and the order is in dispatched, " +
        "which is not a place to wait in",
    ]);
  });

  it("catches an order that moved on while its charge was still being executed", () => {
    // The machine never produces this; the rule exists so the gateway's stored
    // records can be checked against it.
    const dispatched = reach("dispatched");
    const impossible: Order = {
      ...dispatched,
      state: "expired",
      payment: "settling",
      // The charge has a start time, so the only thing wrong with this order is
      // the state it moved on to.
      timestamps: { ...dispatched.timestamps, settleStartedAt: T0 + 3 },
    };

    expect(moneyInvariantViolations(impossible)).toStrictEqual([
      "the payment is being executed and the order has moved on to expired, " +
        "so whatever happens to the money now happens to a decided order",
    ]);
  });

  it("catches a charge in flight with no record of when it started", () => {
    // Only the settle's own outcome moves an order in this stage, and that
    // outcome is asked for on a clock that runs from this instant. Without it
    // the order waits forever, invisibly, with the buyer's money in the air.
    const fulfilled = reach("fulfilled");
    const impossible: Order = {
      ...fulfilled,
      timestamps: { ...fulfilled.timestamps, settleStartedAt: null },
    };

    expect(fulfilled.payment).toBe("settling");
    expect(moneyInvariantViolations(impossible)).toStrictEqual([
      "the payment is being executed and the order has no record of when that began",
    ]);
  });
});

describe("a refusal before the charge never leaves a paid order unfulfilled", () => {
  const refusalsBeforeMoney: readonly [string, Order][] = [
    ["a handler refusing a synchronous order", reach("failed")],
    ["a price check saying the goods are gone", reach("rejected")],
  ];

  for (const [what, order] of refusalsBeforeMoney) {
    it(`leaves no paid order unfulfilled after ${what}`, () => {
      expect(order.payment).not.toBe("settled");
      expect(order.state).not.toBe("unfulfilled");
      expect(moneyInvariantViolations(order)).toStrictEqual([]);
    });
  }
});

describe("an asynchronous purchase is never made at an unknown stock level", () => {
  it("never reaches a charge after a silent price check", () => {
    // Failing open here would take the buyer's money for goods that do not
    // exist.
    const { order } = must(newOrder("async", { priceCheck: "merchant" }), {
      kind: "quote_silent",
      at: T0 + 1,
    });

    expect(order.state).toBe("rejected");

    for (const kind of ORDER_EVENT_KINDS) {
      const result = transition(order, sampleEvent(kind));
      if (!result.ok) continue;
      expect(result.order.payment, `${kind} after a silent check`).not.toBe("settled");
    }
  });
});

describe("a repeat never charges twice and never fulfills twice", () => {
  it("moves no money when the purchase is repeated on an order already delivered", () => {
    const delivered = reach("delivered");
    const { order, effects } = must(delivered, { kind: "purchase_repeated", at: T0 + 99 });

    expect(order).toStrictEqual(delivered);
    expect(moved(effects)).toStrictEqual([]);
  });

  it("asks for no second fulfillment when a repeat closes an unpaid delivery", () => {
    const closing = walk(reach("delivered_unpaid"), [
      { kind: "purchase_repeated", at: T0 + 6 },
      { kind: "payment_verified", at: T0 + 7 },
    ]);
    const { order, effects } = must(closing, { kind: "payment_settled", at: T0 + 8 });

    expect(order.state).toBe("delivered");
    expect(moved(effects)).toStrictEqual(["release_goods_to_agent"]);
    expect(effects.map((effect) => effect.kind)).not.toContain("dispatch_order");
  });
});
