import { describe, expect, it } from "vitest";
import { deadlines, fulfillmentDeadline } from "./deadlines.js";
import { must, newOrder, reach, T0, TEST_POLICY, TEST_PRICE, walk } from "./fixtures.js";
import { transition } from "./machine.js";
import type { Order } from "./model.js";
import { moneyInvariantViolations } from "./money.js";

/**
 * Deadlines are what keeps an order from hanging in the unknown. Every test
 * here answers the same question: if it failed, an order could wait forever,
 * or a timer could fire on an order that is no longer waiting for that thing.
 */

function at(order: Order, kind: string): number | undefined {
  return deadlines(order).find((deadline) => deadline.kind === kind)?.at;
}

describe("the deadlines of an order", () => {
  it("bounds the wait for the merchant to name a price, on its own budget", () => {
    // Two different waitings and two different numbers. This one is how long
    // we wait for him to answer at all, and running out of it is his silence;
    // the life of a price he did name is `quote_expiry` and is longer. Using
    // one number for both would let the price's life end a wait that ADR-0002
    // §3 says must go on to a sale.
    const order = newOrder("sync", { priceCheck: "merchant" });

    expect(deadlines(order)).toStrictEqual([
      { kind: "quote_response", at: T0 + TEST_POLICY.deadlines.quoteResponseMs },
    ]);
    expect(TEST_POLICY.deadlines.quoteResponseMs).not.toBe(TEST_POLICY.deadlines.quoteTtlMs);
  });

  it("keeps a settling order on a clock even when it has lost its start time", () => {
    // Such an order cannot come out of this package, but it can come out of a
    // store — and it is the one order that must never lose its clock, because
    // nothing but the settle's own outcome can move it and no clock means no
    // outcome. Frozen and invisible is the combination to avoid; this makes it
    // overdue and says so out loud.
    const base = newOrder("async");
    const stranded: Order = {
      ...base,
      payment: "settling",
      timestamps: { ...base.timestamps, settleStartedAt: null },
    };

    expect(deadlines(stranded)).toStrictEqual([{ kind: "settle_response", at: T0 }]);
    expect(moneyInvariantViolations(stranded).length).toBeGreaterThan(0);

    const closed = transition(stranded, {
      kind: "deadline_expired",
      at: T0 + 1,
      deadline: "settle_response",
    });

    expect(closed.ok).toBe(true);
  });

  it("gives a quoted price a life of its own", () => {
    // Portal, "Время вышло": the agent got a price and is thinking; when the
    // time runs out the price no longer holds.
    const order = newOrder("sync");

    expect(at(order, "quote_expiry")).toBe(T0 + TEST_POLICY.deadlines.quoteTtlMs);
  });

  it("hands the clock from the price to the charge once the settle is away", () => {
    // Two things at once. A quote expiring while the settle is on its way
    // would close an order that is about to be paid for; and a settle with no
    // clock on it at all would leave the order waiting for an answer that
    // never comes, with the agent told "not yet" forever.
    const base = newOrder("async");
    const order: Order = {
      ...base,
      payment: "settling",
      timestamps: { ...base.timestamps, settleStartedAt: T0 + 40 },
    };

    expect(deadlines(order)).toStrictEqual([
      { kind: "settle_response", at: T0 + 40 + TEST_POLICY.deadlines.settleResponseMs },
    ]);
  });

  it("holds the merchant to his own confirmation deadline", () => {
    const order: Order = {
      ...newOrder("confirm"),
      state: "awaiting_confirmation",
      timestamps: { ...newOrder("confirm").timestamps, confirmationRequestedAt: T0 + 5 },
    };

    expect(at(order, "confirmation_response")).toBe(
      T0 + 5 + TEST_POLICY.deadlines.confirmationResponseMs,
    );
  });

  it("holds the agent to his deadline to pay a confirmed order", () => {
    const order: Order = {
      ...newOrder("confirm"),
      state: "confirmed",
      timestamps: { ...newOrder("confirm").timestamps, confirmedAt: T0 + 7 },
    };

    expect(at(order, "payment_after_confirmation")).toBe(
      T0 + 7 + TEST_POLICY.deadlines.paymentAfterConfirmationMs,
    );
  });

  it("starts the synchronous answer from the payment, not from the opening of the order", () => {
    // This one was shipped and seen. An agent that reads the requirements,
    // decides, and pays twenty seconds later is inside the life of its price
    // and buys legitimately — and every synchronous clock used to be anchored
    // on the unpaid call that opened the order, so the merchant's whole answer
    // had already run out before there was an order to hand him. He delivered,
    // the money moved, and the agent was told its purchase was still in
    // progress and given nothing.
    //
    // Before the payment the order is held by the life of its price and by
    // nothing else; the merchant's clock cannot begin before there is a paid
    // order to give him. The dispatch is three seconds later again, so that
    // measuring from the wrong one of the two is visible here.
    const paid = must(newOrder("sync"), { kind: "payment_verified", at: T0 + 20_000 }).order;
    const dispatched: Order = {
      ...paid,
      state: "dispatched",
      timestamps: { ...paid.timestamps, dispatchedAt: T0 + 23_000 },
    };
    const due = T0 + 20_000 + TEST_POLICY.deadlines.syncResponseMs;

    expect(paid.timestamps.paidAt).toBe(T0 + 20_000);
    expect(at(paid, "sync_response")).toBe(due);
    expect(at(dispatched, "sync_response")).toBe(due);
    expect(at(dispatched, "async_fulfillment")).toBeUndefined();

    // And the instant the old anchor named is refused as premature, so a timer
    // left over from it closes nothing: the merchant is still honestly inside
    // his deadline there.
    const early = transition(paid, {
      kind: "deadline_expired",
      at: T0 + TEST_POLICY.deadlines.syncResponseMs,
      deadline: "sync_response",
    });

    expect(early.ok).toBe(false);
    if (early.ok) throw new Error("an expiry at the old anchor closed the order");
    expect(early.rejection.code).toBe("deadline_not_yet_due");
  });

  it("measures the merchant's fulfillment deadline from the moment money moved", () => {
    // The buyer's money is at risk from the settle onward, so that is when the
    // clock on the goods starts.
    const base = newOrder("async");
    const order: Order = {
      ...base,
      state: "dispatched",
      payment: "settled",
      timestamps: { ...base.timestamps, paidAt: T0 + 30 },
    };

    expect(at(order, "async_fulfillment")).toBe(T0 + 30 + TEST_POLICY.deadlines.asyncFulfillmentMs);
    expect(at(order, "sync_response")).toBeUndefined();
  });

  it("holds our own step to a deadline once the merchant has done his", () => {
    // In `fulfilled` the merchant has produced the goods and executing the
    // payment is ours. None of his deadlines may punish him for our step, and
    // ours may not run forever either: when it runs out he is told that the
    // goods went out and the money did not arrive.
    const base = newOrder("sync");
    const order: Order = {
      ...base,
      state: "fulfilled",
      payment: "settling",
      timestamps: { ...base.timestamps, settleStartedAt: T0 + 4_000 },
    };

    expect(deadlines(order)).toStrictEqual([
      { kind: "settle_response", at: T0 + 4_000 + TEST_POLICY.deadlines.settleResponseMs },
    ]);
  });

  it("runs no deadline on a closed order or on an unpaid debt", () => {
    const closed: Order = { ...newOrder("async"), state: "delivered", payment: "settled" };
    const debt: Order = { ...newOrder("async"), state: "refund_due", payment: "settled" };

    expect(deadlines(closed)).toStrictEqual([]);
    expect(deadlines(debt)).toStrictEqual([]);
  });

  it("runs no clock on goods that went out unpaid, whether the charge failed or said nothing", () => {
    // Portal, the two orders that stay open: the goods are made and the money
    // did not come. The merchant is owed nothing more and the buyer is not
    // late; what closes the order is the buyer's repeat, and a deadline cannot
    // settle a debt. This list is what the runner arms its timers off and what
    // the machine honours when one fires, so an entry here would be a timer
    // nobody asked for on an order nobody is waiting for. The charge that said
    // nothing is the same case: it waits for the payment layer to speak, and
    // no clock can speak for it.
    const failed = reach("delivered_unpaid");
    const silent = must(reach("fulfilled"), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "settle_response",
    }).order;

    expect(failed.payment).toBe("settle_failed");
    expect(silent).toMatchObject({ state: "delivered_unpaid", payment: "outcome_unknown" });
    expect(deadlines(failed)).toStrictEqual([]);
    expect(deadlines(silent)).toStrictEqual([]);

    // And a timer left over from the fulfillment closes nothing: it is not
    // armed, so the machine turns it back.
    for (const order of [failed, silent]) {
      const stale = transition(order, {
        kind: "deadline_expired",
        at: T0 + 999_999,
        deadline: "sync_response",
      });

      expect(stale.ok).toBe(false);
      if (stale.ok) throw new Error("a stale fulfillment timer closed an unpaid delivery");
      expect(stale.rejection.code).toBe("deadline_not_armed");
    }
  });

  it("invents no clock for a paid order that has no record of when it was paid", () => {
    // Such an order cannot come out of this package, but it can come out of a
    // store. Both clocks on the goods run from the paid instant and from
    // nothing else — the header of `deadlines.ts` is the lesson of what a
    // guessed anchor cost — and with that instant gone there is no honest
    // number to hand the runner. The alternative is `null` added to a
    // duration: a deadline in 1970, a timer that fires at once, and an order
    // expired under a merchant who may be honestly at work. Unlike the
    // stranded settle above, the merchant's own answer can still move this
    // order, so it is left to him rather than declared overdue.
    const paidSync = reach("dispatched");
    const paidAsync = walk(newOrder("async"), [
      { kind: "payment_verified", at: T0 + 1 },
      { kind: "payment_settled", at: T0 + 2 },
      { kind: "order_dispatched", at: T0 + 3 },
    ]);

    for (const [paid, clock] of [
      [paidSync, "sync_response"],
      [paidAsync, "async_fulfillment"],
    ] as const) {
      expect(at(paid, clock)).toBeDefined();

      const dateless: Order = { ...paid, timestamps: { ...paid.timestamps, paidAt: null } };

      expect(fulfillmentDeadline(dateless)).toStrictEqual([]);
      expect(deadlines(dateless)).toStrictEqual([]);

      const fired = transition(dateless, {
        kind: "deadline_expired",
        at: T0 + 999_999,
        deadline: clock,
      });

      expect(fired.ok).toBe(false);
      if (fired.ok) throw new Error(`an invented ${clock} deadline expired a dateless order`);
      expect(fired.rejection.code).toBe("deadline_not_armed");
    }
  });

  it("uses the order's own policy and invents no numbers of its own", () => {
    // The pilot's numbers are not chosen yet. If the core ever grew a default,
    // an order would quietly acquire a deadline nobody agreed to.
    const base = newOrder("sync");
    const order: Order = {
      ...base,
      policy: {
        ...TEST_POLICY,
        deadlines: { ...TEST_POLICY.deadlines, quoteTtlMs: 42 },
      },
      price: TEST_PRICE,
    };

    expect(at(order, "quote_expiry")).toBe(T0 + 42);
  });
});
