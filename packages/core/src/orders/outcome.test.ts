import { describe, expect, it } from "vitest";
import { newOrder, reach, T0, walk } from "./fixtures.js";
import type { OrderState } from "./model.js";
import { ORDER_STATES } from "./model.js";
import {
  ENDING_REASONS,
  endingReasonFor,
  ORDER_OUTCOMES,
  onTheMerchantsOpenList,
  outcomeFor,
} from "./outcome.js";

/**
 * The status an agent reads says exactly what the machine knows: "not known
 * yet" is a different word from "known to be none".
 */
describe("what the agent is told an order came to", () => {
  it("says the answer is not in yet while the order is still moving", () => {
    const inFlight: readonly OrderState[] = [
      "created",
      "quoted",
      "awaiting_confirmation",
      "confirmed",
      "paid",
      "dispatched",
      "fulfilled",
    ];

    for (const state of inFlight) {
      expect(outcomeFor(reach(state)), `an order in ${state}`).toBe("in_progress");
    }
  });

  it("never leaves an order without an outcome", () => {
    for (const state of ORDER_STATES) {
      expect(ORDER_OUTCOMES, `an order in ${state}`).toContain(outcomeFor(reach(state)));
    }
  });

  it("tells a refusal apart from a deadline, and both from a confirmation refused", () => {
    expect(outcomeFor(reach("failed"))).toBe("rejected");
    expect(outcomeFor(reach("rejected"))).toBe("rejected");
    expect(outcomeFor(reach("expired"))).toBe("expired");
    expect(outcomeFor(reach("declined"))).toBe("declined");
  });

  it("does not tell the agent a purchase failed when it does not know", () => {
    // A charge the payment network never answered about is not a refusal: the
    // agent's wallet may be lighter, and an agent told the purchase did not
    // happen will buy the same thing elsewhere without checking.
    const unresolved = walk(newOrder("async"), [
      { kind: "payment_verified", at: T0 + 1 },
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "settle_response" },
    ]);

    expect(unresolved.closure).toStrictEqual({ cause: "payment_outcome_unknown" });
    expect(outcomeFor(unresolved)).toBe("payment_unresolved");
    expect(outcomeFor(unresolved)).not.toBe("rejected");
  });

  it("does not say the answer is still on its way once it has stopped asking", () => {
    // Nothing is asking the payment network again, so "in progress" would claim
    // an answer is still coming. The merchant's restart list reads this same
    // word.
    const silent = walk(reach("fulfilled"), [
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "settle_response" },
    ]);

    expect(silent.payment).toBe("outcome_unknown");
    expect(silent.state).toBe("delivered_unpaid");
    expect(outcomeFor(silent)).toBe("payment_unresolved");
    expect(outcomeFor(silent)).not.toBe("in_progress");
    expect(outcomeFor(silent)).not.toBe("delivered_unpaid");
  });

  it("goes back to a plain refusal once the payment network does answer", () => {
    const answered = walk(newOrder("async"), [
      { kind: "payment_verified", at: T0 + 1 },
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "settle_response" },
      { kind: "payment_settle_failed", at: T0 + 1_000_000 },
    ]);

    expect(outcomeFor(answered)).toBe("rejected");
  });

  it("carries the difference all the way out to the agent, not only inside", () => {
    // One charge was reported as failed and the other never reported at all.
    const silent = walk(reach("fulfilled"), [
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "settle_response" },
    ]);
    const reported = walk(reach("fulfilled"), [{ kind: "payment_settle_failed", at: T0 + 5 }]);

    expect(silent.state).toBe(reported.state);
    expect(silent.payment).not.toBe(reported.payment);
    expect(outcomeFor(silent)).not.toBe(outcomeFor(reported));
  });

  it("turns a charge that finally reports in into the unfulfilled paid order it is", () => {
    // The order was closed as refused because the payment network went silent,
    // and then the money turned out to have moved. The machine reopens the
    // order as a debt, and the agent must be told that too: "nobody can say
    // whether you were charged" would hide a debt owed to the buyer.
    const silent = walk(newOrder("async"), [
      { kind: "payment_verified", at: T0 + 1 },
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "settle_response" },
    ]);

    expect(outcomeFor(silent)).toBe("payment_unresolved");

    const owed = walk(silent, [{ kind: "payment_settled", at: T0 + 1_000_000 }]);

    // The machine keeps the old closure as the record of why the order was
    // first closed. The projection must not read it as the money still being
    // lost.
    expect(owed.state).toBe("unfulfilled");
    expect(owed.payment).toBe("settled");
    expect(owed.closure).toStrictEqual({ cause: "payment_outcome_unknown" });
    expect(outcomeFor(owed)).toBe("unfulfilled");

    const repaid = walk(owed, [{ kind: "close_called", at: T0 + 1_000_001 }]);

    expect(outcomeFor(repaid)).toBe("fulfillment_closed");
  });

  it("keeps an unpaid quote off the list a restarted worker walks, and keeps one he took on", () => {
    // Both read `in_progress` to the buyer, but only one is the merchant's to
    // finish. A list holding both makes a restart deliver goods for a purchase
    // that was never paid.
    const unpaid = reach("quoted");
    const takenOn = walk(reach("dispatched"), [{ kind: "handler_accepted", at: T0 + 4 }]);
    const handed = reach("paid");
    const debt = reach("unfulfilled");
    const goodsUnpaid = reach("delivered_unpaid");
    const silent = walk(reach("fulfilled"), [
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "settle_response" },
    ]);

    expect(outcomeFor(unpaid)).toBe("in_progress");
    expect(outcomeFor(takenOn)).toBe("in_progress");
    expect(onTheMerchantsOpenList(unpaid)).toBe(false);
    expect(onTheMerchantsOpenList(reach("created"))).toBe(false);
    expect(onTheMerchantsOpenList(reach("awaiting_confirmation"))).toBe(false);
    expect(onTheMerchantsOpenList(reach("confirmed"))).toBe(false);
    expect(onTheMerchantsOpenList(takenOn)).toBe(true);
    expect(onTheMerchantsOpenList(handed)).toBe(true);
    expect(onTheMerchantsOpenList(reach("dispatched"))).toBe(true);
    expect(onTheMerchantsOpenList(reach("fulfilled"))).toBe(true);
    expect(onTheMerchantsOpenList(debt)).toBe(true);
    expect(onTheMerchantsOpenList(goodsUnpaid)).toBe(true);
    expect(onTheMerchantsOpenList(silent)).toBe(true);
    expect(onTheMerchantsOpenList(reach("delivered"))).toBe(false);
    expect(onTheMerchantsOpenList(reach("rejected"))).toBe(false);
  });

  it("shows a paid order without delivery, goods held unpaid and a merchant's closure as what they are", () => {
    expect(outcomeFor(reach("unfulfilled"))).toBe("unfulfilled");
    expect(outcomeFor(reach("delivered_unpaid"))).toBe("delivered_unpaid");
    expect(outcomeFor(reach("fulfillment_closed"))).toBe("fulfillment_closed");
  });

  it("calls a success a success only once the money has actually moved", () => {
    const delivered = reach("delivered");

    expect(outcomeFor(delivered)).toBe("delivered");
    expect(delivered.payment).toBe("settled");
  });

  it("does not call a purchase closed by the merchant's departure a refusal", () => {
    expect(outcomeFor(reach("cancelled"))).toBe("cancelled");
  });

  it("changes its answer the moment a late delivery reaches an unfulfilled order", () => {
    const closed = walk(reach("unfulfilled"), [{ kind: "deliver_called", at: T0 + 999 }]);

    expect(outcomeFor(closed)).toBe("delivered");
  });
});

/**
 * One status word can cover endings that call for different next steps: a
 * product that is gone, a price check nobody answered, a charge that did not go
 * through. The merchant's own words stay in the refusal and are never given a
 * reason of ours.
 */
describe("why an order ended, where its merchant did not say", () => {
  it("names the endings that one status word would otherwise blur", () => {
    const priced = newOrder("sync", { priceCheck: "merchant" });
    const asyncPriced = newOrder("async", { priceCheck: "merchant" });
    const dispatched = reach("dispatched");
    const due = (dispatched.timestamps.paidAt ?? 0) + dispatched.policy.deadlines.syncResponseMs;

    const cases = [
      [walk(priced, [{ kind: "quote_answered", at: T0 + 1, available: false }]), "unavailable"],
      [walk(asyncPriced, [{ kind: "quote_silent", at: T0 + 1 }]), "price_check_unanswered"],
      [
        walk(newOrder("async"), [
          { kind: "payment_verified", at: T0 + 1 },
          { kind: "payment_settle_failed", at: T0 + 2 },
        ]),
        "payment_not_settled",
      ],
      [
        walk(newOrder("sync"), [
          {
            kind: "deadline_expired",
            at: T0 + newOrder("sync").policy.deadlines.quoteTtlMs,
            deadline: "quote_expiry",
          },
        ]),
        "price_expired",
      ],
      [
        walk(dispatched, [{ kind: "deadline_expired", at: due, deadline: "sync_response" }]),
        "merchant_timed_out",
      ],
    ] as const;

    for (const [order, reason] of cases) {
      expect(endingReasonFor(order), reason).toBe(reason);
      expect(["rejected", "expired"]).toContain(outcomeFor(order));
    }
    expect(new Set([...cases.map(([, reason]) => reason), "merchant_closed"])).toStrictEqual(
      new Set(ENDING_REASONS),
    );
  });

  it("says in its own words what is true of a paid order whose merchant closed fulfillment", () => {
    const closedAfterPayment = reach("fulfillment_closed");
    const paidAfterClosure = walk(reach("fulfilled"), [
      { kind: "close_called", at: T0 + 10 },
      { kind: "payment_settled", at: T0 + 20 },
    ]);
    for (const order of [closedAfterPayment, paidAfterClosure]) {
      expect(order.payment).toBe("settled");
      expect(outcomeFor(order)).toBe("fulfillment_closed");
      expect(endingReasonFor(order)).toBe("merchant_closed");
    }
    const unpaid = walk(reach("quoted"), [{ kind: "close_called", at: T0 + 10 }]);
    expect(endingReasonFor(unpaid)).toBeNull();
    const unresolved = walk(reach("fulfilled"), [{ kind: "close_called", at: T0 + 10 }]);
    expect(endingReasonFor(unresolved)).toBeNull();
  });

  it("says of goods held unpaid that their charge did not go through", () => {
    expect(outcomeFor(reach("delivered_unpaid"))).toBe("delivered_unpaid");
    expect(endingReasonFor(reach("delivered_unpaid"))).toBe("payment_not_settled");
  });

  it("gives no reason of ours where the merchant refused, or where the status says it all", () => {
    expect(endingReasonFor(reach("failed"))).toBeNull();
    for (const state of ["created", "dispatched", "delivered", "unfulfilled"] as const) {
      expect(endingReasonFor(reach(state)), state).toBeNull();
    }
  });
});
