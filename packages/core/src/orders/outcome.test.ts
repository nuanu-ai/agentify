import { describe, expect, it } from "vitest";
import { newOrder, reach, T0, walk } from "./fixtures.js";
import type { OrderState } from "./model.js";
import { ORDER_STATES } from "./model.js";
import { ORDER_OUTCOMES, onTheMerchantsOpenList, outcomeFor } from "./outcome.js";

/**
 * The projection an agent reads. The promise it carries is the fifth gate: the
 * status says exactly what the machine knows, and "I do not know yet" has to be
 * a different word from "I know there is none".
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
    // Three rows of the portal's table of endings, and they are three
    // different sentences to the agent: a refusal with a reason, an order
    // closed on time, and a merchant who said he would not fulfill.
    expect(outcomeFor(reach("failed"))).toBe("rejected");
    expect(outcomeFor(reach("rejected"))).toBe("rejected");
    expect(outcomeFor(reach("expired"))).toBe("expired");
    expect(outcomeFor(reach("declined"))).toBe("declined");
  });

  it("does not tell the agent a purchase failed when it does not know", () => {
    // The fifth gate on the most visible artifact there is. A charge the
    // payment network never answered about is not a refusal: the agent's
    // wallet may be lighter, and an agent told "the purchase did not happen"
    // will go and buy the same thing somewhere else without checking.
    const unresolved = walk(newOrder("async"), [
      { kind: "payment_verified", at: T0 + 1 },
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "settle_response" },
    ]);

    expect(unresolved.closure).toStrictEqual({ cause: "payment_outcome_unknown" });
    expect(outcomeFor(unresolved)).toBe("payment_unresolved");
    expect(outcomeFor(unresolved)).not.toBe("rejected");
  });

  it("does not say the answer is still on its way once it has stopped asking", () => {
    // The goods are made and the charge went quiet. Nothing is asking the
    // payment network again, so "in progress" would be a claim that an answer
    // is still coming. The merchant's restart list reads this same word.
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
    // The order has always carried that difference for the dispute, the error
    // text and the merchant's reconciliation; now the agent hears it too,
    // because he is the one whose wallet the answer is about.
    const silent = walk(reach("fulfilled"), [
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "settle_response" },
    ]);
    const reported = walk(reach("fulfilled"), [{ kind: "payment_settle_failed", at: T0 + 5 }]);

    expect(silent.state).toBe(reported.state);
    expect(silent.payment).not.toBe(reported.payment);
    expect(outcomeFor(silent)).not.toBe(outcomeFor(reported));
  });

  it("turns a charge that finally reports in into the debt it is", () => {
    // The order was closed as refused because the payment network went silent,
    // and then it answered: the money had moved after all. The machine reopens
    // the order as a debt and tells the merchant so. The agent has to be told
    // the same thing. "Nobody can say whether you were charged" about an order
    // the machine has just written a refund against is the fifth gate turned
    // inside out — ignorance claimed where there is knowledge — and it hides a
    // debt owed to the buyer behind a word that sounds like bad luck.
    const silent = walk(newOrder("async"), [
      { kind: "payment_verified", at: T0 + 1 },
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "settle_response" },
    ]);

    expect(outcomeFor(silent)).toBe("payment_unresolved");

    const owed = walk(silent, [{ kind: "payment_settled", at: T0 + 1_000_000 }]);

    // The machine keeps the old closure on purpose: it is the record of why
    // the order was closed in the first place. The projection may not read
    // that record as a claim that the money is still lost.
    expect(owed.state).toBe("refund_due");
    expect(owed.payment).toBe("settled");
    expect(owed.closure).toStrictEqual({ cause: "payment_outcome_unknown" });
    expect(outcomeFor(owed)).toBe("refund_due");

    // And once the debt is paid back, that is what the agent hears — not that
    // the machine still does not know where his money went.
    const repaid = walk(owed, [{ kind: "refund_settled", at: T0 + 1_000_001 }]);

    expect(outcomeFor(repaid)).toBe("refunded");
  });

  it("keeps an unpaid quote off the list a restarted worker walks, and keeps one he took on", () => {
    // Both read `in_progress` to the buyer. Only one of them is the merchant's
    // to finish. A list that holds both is how a restart delivers goods for a
    // purchase that was never paid.
    const unpaid = reach("quoted");
    const takenOn = walk(reach("dispatched"), [{ kind: "handler_accepted", at: T0 + 4 }]);
    const handed = reach("paid");
    const debt = reach("refund_due");
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

  it("shows the two endings where money is owed as what they are", () => {
    expect(outcomeFor(reach("refund_due"))).toBe("refund_due");
    expect(outcomeFor(reach("delivered_unpaid"))).toBe("delivered_unpaid");
    expect(outcomeFor(reach("refunded"))).toBe("refunded");
  });

  it("calls a success a success only once the money has actually moved", () => {
    const delivered = reach("delivered");

    expect(outcomeFor(delivered)).toBe("delivered");
    expect(delivered.payment).toBe("settled");
  });

  it("does not call a purchase closed by the merchant's departure a refusal", () => {
    expect(outcomeFor(reach("cancelled"))).toBe("cancelled");
  });

  it("changes its answer the moment a late delivery closes a debt", () => {
    const closed = walk(reach("refund_due"), [{ kind: "deliver_called", at: T0 + 999 }]);

    expect(outcomeFor(closed)).toBe("delivered");
  });
});
