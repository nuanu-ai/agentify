import { describe, expect, it } from "vitest";
import { deadlines } from "./deadlines.js";
import {
  must,
  newOrder,
  reach,
  sampleEvent,
  T0,
  TEST_POLICY,
  TEST_PRICE,
  walk,
} from "./fixtures.js";
import { transition } from "./machine.js";
import type { Effect, Order, OrderEvent, OrderEventKind, OrderState, Price } from "./model.js";
import {
  CLOSED_ORDER_STATES,
  ORDER_EVENT_KINDS,
  ORDER_STATES,
  PAYMENT_STAGES,
  PAYMENT_VERIFICATION_FAILURES,
} from "./model.js";
import { ORDER_OUTCOMES, outcomeFor } from "./outcome.js";

const MERCHANT_PRICE: Price = { amount: "6.50", currency: "USD", asOf: T0 + 1 };

function kinds(effects: readonly Effect[]): readonly string[] {
  return effects.map((effect) => effect.kind);
}

/**
 * Which events each state answers at all, written down rather than measured.
 *
 * A kind is listed for a state when the machine takes it as meaningful there.
 * That is not the same as taking it: a refusal with a reason of its own —
 * goods offered before anything was charged, a charge still in flight, a timer
 * that is not the one running — is an answer to the event, and only
 * `event_not_applicable` says the event has no meaning in that state at all.
 *
 * The list is read against the portal's tables: a row is what a merchant's
 * call, an agent's move or a redelivery off the queue gets back for an order
 * sitting in that state.
 *
 * Two things the table deliberately does not say. Some of these answers turn
 * on the card's mode and on where the payment has got to — a settle can only
 * report back on an order that has one in flight — so what is pinned is the
 * order `reach` walks to for each state, and where that matters the row says
 * which order it is. And `deadline_expired` is answered in every state because
 * it is answered centrally, before any state is consulted; whether the timer
 * that fired is the one running is `deadlines(order)`'s answer rather than
 * this table's, and `deadlines.test.ts` is where that is pinned.
 */
const ANSWERED: Record<OrderState, readonly OrderEventKind[]> = {
  // Waiting for the price. The answer and the silence are the two ways that
  // wait can end.
  created: ["quote_answered", "quote_silent", "purchase_repeated", "deadline_expired"],
  // Priced, and nothing charged: a synchronous card, whose money is verified
  // here and executed after the goods. The settle's own outcomes are not
  // answered because nothing has been sent for execution yet — on the
  // asynchronous card, whose charge goes out from this state, they are.
  quoted: [
    "payment_verified",
    "payment_verification_failed",
    "purchase_repeated",
    "deadline_expired",
  ],
  // Queued for the merchant. Every answer of his is taken here as well as in
  // `dispatched`: he is plainly holding the order, because he is answering,
  // and our own record of the hand-over has simply not landed yet.
  paid: [
    "purchase_repeated",
    "order_dispatched",
    "handler_accepted",
    "handler_delivered",
    "handler_refused",
    "handler_undelivered",
    "deliver_called",
    "refuse_called",
    "deadline_expired",
  ],
  dispatched: [
    "purchase_repeated",
    "order_dispatched",
    "handler_accepted",
    "handler_delivered",
    "handler_refused",
    "handler_undelivered",
    "deliver_called",
    "refuse_called",
    "deadline_expired",
  ],
  // The whole row, and not because this state is permissive. Both ways into it
  // hand the payment over for execution, so an order here is always mid-charge
  // and the settling guard answers everything the state itself would have
  // dismissed — with "come back once the charge reports" rather than "this
  // means nothing here". Which of the two a caller gets is the subject of the
  // settle-in-flight tests below.
  fulfilled: [...ORDER_EVENT_KINDS],
  // Closed as a success. A redelivered acceptance is ordinary here and is
  // answered with the state he is in. The hand-over that would have carried it
  // is not: the worker's poll gives out exactly what this row takes, so a
  // delivered order taking `order_dispatched` is the gateway putting a
  // finished purchase back in front of a handler. A refusal is heard and
  // refused — an order that ended in goods may not take one.
  delivered: [
    "purchase_repeated",
    "handler_accepted",
    "handler_delivered",
    "deliver_called",
    "refuse_called",
    "deadline_expired",
  ],
  // The goods are made and the money never came. A repeat brings a fresh
  // payment, which is why the verification's failure is answered here; the
  // charge this fixture is carrying has already reported, so its outcomes are
  // not.
  delivered_unpaid: [
    "payment_verification_failed",
    "purchase_repeated",
    "handler_delivered",
    "deliver_called",
    "refuse_called",
    "deadline_expired",
  ],
  // A debt, and the widest row in the table. Everything the merchant can say
  // about the order is heard: late goods close the debt, and the rest are
  // taken and change nothing rather than being dismissed as meaningless.
  unfulfilled: [
    "purchase_repeated",
    "order_dispatched",
    "handler_accepted",
    "handler_delivered",
    "handler_refused",
    "handler_undelivered",
    "deliver_called",
    "refuse_called",
    "close_called",
    "deadline_expired",
  ],
  // The debt is paid back. There is nothing left to deliver against, and
  // saying so is the answer.
  fulfillment_closed: [
    "purchase_repeated",
    "handler_delivered",
    "deliver_called",
    "refuse_called",
    "deadline_expired",
  ],
  // He refused this order himself. Goods arriving afterwards are not a late
  // fulfillment of it but a contradiction, which is why `handler_delivered` is
  // missing from a row that otherwise looks like the three below.
  failed: ["purchase_repeated", "deliver_called", "refuse_called", "deadline_expired"],
  // Closed before the handler ever saw the order, and nobody was charged. The
  // settle's outcomes are answered on one of these — the order closed on the
  // guess that a silent charge did not move — and this fixture is not that
  // one: it closed because the goods were gone.
  rejected: ["purchase_repeated", "deliver_called", "refuse_called", "deadline_expired"],
  // Out of time. Late goods and the repeat that collects them are answered
  // only where the purchase was closed by the synchronous budget, and this
  // fixture ran out of a price instead.
  expired: ["purchase_repeated", "deliver_called", "refuse_called", "deadline_expired"],
};

describe("the shape of the machine", () => {
  it("reaches every state in the vocabulary through legal events alone", () => {
    // A state nothing can walk to is a claim the machine cannot back up. This
    // test is what keeps the vocabulary honest.
    for (const state of ORDER_STATES) {
      expect(reach(state).state, `walking to ${state}`).toBe(state);
    }
  });

  it("answers every pairing of a state and an event without throwing", () => {
    // The gateway feeds this machine events from a redelivered order, a
    // reminder the queue tried twice, and a merchant's own repeated call, so it
    // will see pairings nobody planned. Each one gets either a transition or a
    // named refusal — never an exception, and never a silent nothing.
    let accepted = 0;

    for (const state of ORDER_STATES) {
      for (const kind of ORDER_EVENT_KINDS) {
        const before = reach(state);
        const result = transition(before, sampleEvent(kind));
        const where = `${state} on ${kind}`;

        if (!result.ok) {
          expect(result.rejection.state, where).toBe(state);
          expect(result.rejection.event, where).toBe(kind);
          expect(result.rejection.message.length, where).toBeGreaterThan(0);
          continue;
        }

        accepted += 1;
        // Whatever it did, what came back has to be an order: a real state, a
        // real payment stage, an outcome the agent can be told, and the same
        // order it was handed. Whether the money and the state agree is the
        // same sweep in `money.test.ts`, which is where the rules that decide
        // it live and where the controls proving they fire live with them.
        expect(ORDER_STATES, where).toContain(result.order.state);
        expect(PAYMENT_STAGES, where).toContain(result.order.payment);
        expect(ORDER_OUTCOMES, where).toContain(outcomeFor(result.order));
        expect(result.order.id, where).toBe(before.id);
        expect(result.order.mode, where).toStrictEqual(before.mode);
      }
    }

    // A floor under the loop: if a change made every pairing illegal, the
    // checks above would pass while exercising nothing at all.
    expect(accepted).toBeGreaterThan(60);
  });

  it("answers exactly the events each state has a meaning for", () => {
    // The sweep above holds if a delivered order starts taking a refusal: it
    // pins that something comes back, never what. This pins what, and what is
    // the promise — the portal's tables tell a merchant which of his calls an
    // order in each state will hear, and an agent reads the same table from
    // the other side. A pairing that quietly became meaningful, or quietly
    // stopped being, is one of those rows changing with nobody saying so.
    for (const state of ORDER_STATES) {
      const answered = new Set([...ANSWERED[state], "close_called"]);

      for (const kind of ORDER_EVENT_KINDS) {
        const result = transition(reach(state), sampleEvent(kind));
        const meaningful = result.ok || result.rejection.code !== "event_not_applicable";

        expect(meaningful, `${state} on ${kind}`).toBe(answered.has(kind));
      }
    }
  });

  it("never changes the order it was given", () => {
    // The gateway keeps the previous order around to write an audit row. A
    // machine that mutated its input would rewrite history under it.
    const order = reach("dispatched");
    const before = structuredClone(order);

    must(order, { kind: "handler_delivered", at: T0 + 9 });

    expect(order).toStrictEqual(before);
  });
});

describe("pricing the purchase", () => {
  it("takes the merchant's price over the card's snapshot", () => {
    // The live answer outranks the snapshot and carries its own `as_of`, which
    // is what the receipt later points at.
    const { order, effects } = must(newOrder("sync", { priceCheck: "merchant" }), {
      kind: "quote_answered",
      at: T0 + 1,
      available: true,
      price: MERCHANT_PRICE,
    });

    expect(order.state).toBe("quoted");
    expect(order.price).toStrictEqual(MERCHANT_PRICE);
    expect(order.quoteSource).toBe("merchant_answer");
    expect(kinds(effects)).toStrictEqual(["verify_payment"]);
  });

  it("takes a merchant's price in the currency the card was published in", () => {
    // The positive half of the rule below: moving the number is what a price
    // check is for, and a card priced in dollars answered in dollars is the
    // ordinary case. Without this, refusing every quote would satisfy the test
    // that follows.
    const { order } = must(newOrder("sync", { priceCheck: "merchant" }), {
      kind: "quote_answered",
      at: T0 + 1,
      available: true,
      price: { amount: "6.50", currency: TEST_PRICE.currency, asOf: T0 + 1 },
    });

    expect(order.state).toBe("quoted");
    expect(order.price?.currency).toBe(TEST_PRICE.currency);
  });

  it("refuses a quote that answers in a currency the card does not carry", () => {
    // A quote may move the number and never the unit. The agent chose this
    // card at the price the catalog showed, in the currency the card declares;
    // a check that came back in another one and was taken would charge his
    // wallet in a unit nobody agreed on and write a receipt pointing at a
    // price the card never carried. There is no conversion here to fall back
    // on — this package holds money as a decimal string and knows no rates —
    // so the only honest answer is to refuse the answer, not to guess at it.
    const created = newOrder("sync", { priceCheck: "merchant" });
    const before = structuredClone(created);

    const result = transition(created, {
      kind: "quote_answered",
      at: T0 + 1,
      available: true,
      price: { amount: "6.50", currency: "EUR", asOf: T0 + 1 },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("currency_changed");
    // Sending the same answer again gives the same refusal: what clears it is
    // the merchant quoting the card's own currency.
    expect(result.rejection.retryable).toBe(false);
    expect(result.rejection.message).toContain("EUR");
    expect(created).toStrictEqual(before);
  });

  it("closes the purchase before any money when the goods are not there", () => {
    // Goods reported gone in time: the buyer's money does not move.
    const { order } = must(newOrder("async", { priceCheck: "merchant" }), {
      kind: "quote_answered",
      at: T0 + 1,
      available: false,
    });

    expect(order.state).toBe("rejected");
    expect(order.payment).toBe("none");
    expect(order.closure).toStrictEqual({ cause: "unavailable" });
  });

  it("sells a synchronous card at its snapshot price when the check goes silent", () => {
    // The merchant's live answer still stands between the price and the money,
    // so a second of silence must not cancel a sale that can be carried out
    // honestly at a known price.
    const { order, effects } = must(newOrder("sync", { priceCheck: "merchant" }), {
      kind: "quote_silent",
      at: T0 + 1,
    });

    expect(order.state).toBe("quoted");
    expect(order.price).toStrictEqual(TEST_PRICE);
    expect(order.quoteSource).toBe("card_snapshot");
    expect(kinds(effects)).toStrictEqual(["verify_payment"]);
  });

  it("treats running out of patience with the price check as the same silence", () => {
    // The wait for an answer and the life of an answer are two different waits.
    // Running out of the first is the merchant being silent, which is answered
    // by mode: it must not close a synchronous purchase that should go on to a
    // sale at the card's own price.
    const sync = must(newOrder("sync", { priceCheck: "merchant" }), {
      kind: "deadline_expired",
      at: T0 + TEST_POLICY.deadlines.quoteResponseMs,
      deadline: "quote_response",
    });
    const async = must(newOrder("async", { priceCheck: "merchant" }), {
      kind: "deadline_expired",
      at: T0 + TEST_POLICY.deadlines.quoteResponseMs,
      deadline: "quote_response",
    });

    expect(sync.order.state).toBe("quoted");
    expect(sync.order.quoteSource).toBe("card_snapshot");
    expect(kinds(sync.effects)).toStrictEqual(["verify_payment"]);
    expect(async.order.state).toBe("rejected");
    expect(async.order.closure).toStrictEqual({ cause: "quote_silent" });
  });

  it("refuses to start an asynchronous purchase when the check goes silent", () => {
    // Here the money moves before the merchant is asked anything, so failing
    // open would manufacture debts to buyers.
    const { order } = must(newOrder("async", { priceCheck: "merchant" }), {
      kind: "quote_silent",
      at: T0 + 1,
    });

    expect(order.state).toBe("rejected");
    expect(order.payment).toBe("none");
    expect(order.closure).toStrictEqual({ cause: "quote_silent" });
  });
});

describe("the synchronous mode: refusal before the charge", () => {
  it("verifies the payment before the order goes anywhere near the merchant", () => {
    const { order, effects } = must(newOrder("sync"), { kind: "payment_verified", at: T0 + 1 });

    expect(order.state).toBe("paid");
    expect(order.payment).toBe("verified");
    expect(kinds(effects)).toStrictEqual(["dispatch_order"]);
  });

  it("rejects a purchase whose payment did not verify and records what the layer said", () => {
    // `rejected` also follows a merchant's "there is none" and a charge that
    // did not go through, so the state alone does not say why this purchase
    // stopped; the closure does, and the store keeps it with the order. A
    // rejected order with no cause would read as "I know there is none" where
    // the truth is "I did not write it down". Every reason the layer can give
    // is sent, so the record must carry the layer's word and not one the test
    // happened to choose.
    //
    // The gateway's purchase door verifies before it touches the order, so
    // nothing sends this event into a quoted order; the row is the machine's
    // own contract. The portal's ending "the payment failed its check" is held
    // to `rejected` through this event in `portal-tables.test.ts`.
    for (const reason of PAYMENT_VERIFICATION_FAILURES) {
      const { order, effects } = must(newOrder("sync"), {
        kind: "payment_verification_failed",
        at: T0 + 1,
        reason,
      });

      expect(order.state, reason).toBe("rejected");
      expect(order.payment, reason).toBe("none");
      expect(order.closure, reason).toStrictEqual({ cause: "payment_not_verified", reason });
      // The merchant was never asked, so he is not told either.
      expect(effects, reason).toStrictEqual([]);
    }
  });

  it("executes the payment only after the goods have come back", () => {
    const dispatched = reach("dispatched");
    const fulfilled = must(dispatched, { kind: "handler_delivered", at: T0 + 4 });

    expect(fulfilled.order.state).toBe("fulfilled");
    expect(fulfilled.order.payment).toBe("settling");
    expect(kinds(fulfilled.effects)).toStrictEqual(["execute_payment"]);

    const delivered = must(fulfilled.order, { kind: "payment_settled", at: T0 + 5 });

    expect(delivered.order.state).toBe("delivered");
    expect(delivered.order.payment).toBe("settled");
    expect(kinds(delivered.effects)).toStrictEqual(["release_goods_to_agent", "issue_receipt"]);
  });

  it("leaves the buyer untouched when the handler refuses", () => {
    // You refused in the synchronous mode: the money did not move, and the
    // agent sees a refusal with a reason.
    const { order } = must(reach("dispatched"), {
      kind: "handler_refused",
      at: T0 + 4,
      code: "out_of_stock",
      message: "no SIM left",
    });

    expect(order.state).toBe("failed");
    expect(order.payment).toBe("verified");
    expect(order.closure).toStrictEqual({
      cause: "merchant_refused",
      code: "out_of_stock",
      message: "no SIM left",
    });
  });

  it("does not take an order on", () => {
    // The goods of this mode travel in the handler's answer and nowhere else,
    // so a promise of goods later has nothing to be kept with: there is no
    // `deliver` call here to keep it. Told his acceptance landed, the merchant
    // would write the order down as under way while it ran out its seconds and
    // closed with nothing sold.
    const dispatched = reach("dispatched");
    const { order, effects } = must(dispatched, { kind: "handler_accepted", at: T0 + 4 });

    expect(effects).toStrictEqual([
      {
        kind: "answer_merchant",
        answer: { ok: false, error: "not_applicable_in_mode", retryable: false },
      },
    ]);
    expect(order).toStrictEqual(dispatched);
  });

  it("does not take one on before our record of handing it over, either", () => {
    // The same answer arriving ahead of our own record of the hand-over. It
    // is answered the same way, and leaves no record of a hand-over behind
    // on the strength of an answer it refused.
    const paid = walk(newOrder("sync"), [{ kind: "payment_verified", at: T0 + 1 }]);
    const { order, effects } = must(paid, { kind: "handler_accepted", at: T0 + 2 });

    expect(effects).toStrictEqual([
      {
        kind: "answer_merchant",
        answer: { ok: false, error: "not_applicable_in_mode", retryable: false },
      },
    ]);
    expect(order).toStrictEqual(paid);
  });

  it("has no separate deliver call at all", () => {
    // Portal: in the synchronous mode the handler answers with the goods
    // themselves. A `deliver` call there is a typed answer, not an exception.
    const { effects } = must(reach("dispatched"), { kind: "deliver_called", at: T0 + 4 });

    expect(effects).toStrictEqual([
      {
        kind: "answer_merchant",
        answer: { ok: false, error: "not_applicable_in_mode", retryable: false },
      },
    ]);
  });
});

describe("the asynchronous mode: the money moves first", () => {
  it("executes the payment at the purchase, before the merchant is asked", () => {
    const verified = must(newOrder("async"), { kind: "payment_verified", at: T0 + 1 });

    expect(verified.order.state).toBe("quoted");
    expect(verified.order.payment).toBe("settling");
    expect(kinds(verified.effects)).toStrictEqual(["execute_payment"]);

    const paid = must(verified.order, { kind: "payment_settled", at: T0 + 2 });

    expect(paid.order.state).toBe("paid");
    expect(paid.order.payment).toBe("settled");
    expect(kinds(paid.effects)).toStrictEqual(["dispatch_order"]);
  });

  it("makes no order out of a purchase whose charge did not go through", () => {
    const verified = walk(newOrder("async"), [{ kind: "payment_verified", at: T0 + 1 }]);
    const { order } = must(verified, { kind: "payment_settle_failed", at: T0 + 2 });

    expect(order.state).toBe("rejected");
    expect(order.payment).toBe("settle_failed");
    expect(order.closure).toStrictEqual({ cause: "payment_not_settled" });
  });

  it("remembers that the handler took the order on", () => {
    const dispatched = walk(newOrder("async"), [
      { kind: "payment_verified", at: T0 + 1 },
      { kind: "payment_settled", at: T0 + 2 },
      { kind: "order_dispatched", at: T0 + 3 },
    ]);
    const { order, effects } = must(dispatched, { kind: "handler_accepted", at: T0 + 4 });

    expect(order.state).toBe("dispatched");
    expect(order.dispatch.accepted).toBe(true);
    // And he is told his answer landed, in the word for it. An acceptance is a
    // merchant's answer like the other two, and a machine that stayed silent
    // here would leave whoever answers him with nothing to say but no.
    expect(effects).toStrictEqual([
      { kind: "answer_merchant", answer: { ok: true, result: "accepted" } },
    ]);
  });

  it("closes the order with the separate deliver call", () => {
    const accepted = walk(newOrder("async"), [
      { kind: "payment_verified", at: T0 + 1 },
      { kind: "payment_settled", at: T0 + 2 },
      { kind: "order_dispatched", at: T0 + 3 },
      { kind: "handler_accepted", at: T0 + 4 },
    ]);
    const { order, effects } = must(accepted, { kind: "deliver_called", at: T0 + 60 });

    expect(order.state).toBe("delivered");
    expect(kinds(effects)).toStrictEqual([
      "release_goods_to_agent",
      "issue_receipt",
      "answer_merchant",
    ]);
  });

  it("marks the order unfulfilled the moment the merchant refuses after the charge", () => {
    // Waiting for the deadline to reach the same result by silence helps
    // nobody: the buyer learns of the debt the minute the merchant does.
    const sync = must(reach("dispatched"), {
      kind: "handler_refused",
      at: T0 + 4,
      code: "out_of_stock",
      message: "none left",
    });
    expect(sync.order.state).toBe("failed");
    expect(sync.effects).toStrictEqual([]);

    const async = walk(newOrder("async"), [
      { kind: "payment_verified", at: T0 + 1 },
      { kind: "payment_settled", at: T0 + 2 },
      { kind: "order_dispatched", at: T0 + 3 },
      { kind: "handler_accepted", at: T0 + 4 },
    ]);
    const refused = must(async, {
      kind: "refuse_called",
      at: T0 + 5,
      code: "out_of_stock",
      message: "the supplier did not confirm the number",
    });

    expect(refused.order.state).toBe("unfulfilled");
    expect(refused.order.payment).toBe("settled");
    expect(kinds(refused.effects)).toStrictEqual([
      "mark_unfulfilled",
      "emit_merchant_event",
      "answer_merchant",
    ]);
  });
});

describe("when the time runs out", () => {
  it("lets a price die of its own age", () => {
    const { order } = must(newOrder("sync"), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "quote_expiry",
    });

    expect(order.state).toBe("expired");
    expect(order.payment).toBe("none");
  });

  it("closes a synchronous purchase without a charge", () => {
    const { order } = must(reach("dispatched"), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "sync_response",
    });

    expect(order.state).toBe("expired");
    expect(order.payment).toBe("verified");
    expect(order.closure).toStrictEqual({ cause: "deadline_expired", deadline: "sync_response" });
  });

  it("marks an asynchronous order unfulfilled when it misses its fulfillment deadline", () => {
    const dispatched = walk(newOrder("async"), [
      { kind: "payment_verified", at: T0 + 1 },
      { kind: "payment_settled", at: T0 + 2 },
      { kind: "order_dispatched", at: T0 + 3 },
      { kind: "handler_accepted", at: T0 + 4 },
    ]);
    const { order, effects } = must(dispatched, {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "async_fulfillment",
    });

    expect(order.state).toBe("unfulfilled");
    expect(kinds(effects)).toStrictEqual(["mark_unfulfilled", "emit_merchant_event"]);
  });

  it("refuses a deadline that is not running", () => {
    // The money hole: a quote expiring while the settle of that very order is
    // in flight would close a purchase that is about to be paid for.
    const settling = walk(newOrder("async"), [{ kind: "payment_verified", at: T0 + 1 }]);
    const result = transition(settling, {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "quote_expiry",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("deadline_not_armed");
  });

  it("refuses a deadline that has not come due yet", () => {
    // A timer that fired early, or fired twice, must not close an order the
    // merchant is still honestly inside his deadline of: in the asynchronous
    // mode that would mark a refund due against somebody who is not late.
    const dispatched = reach("dispatched");
    // The instant read off the order rather than written in: this clock starts
    // when the payment was taken, and a boundary spelled from T0 would be
    // asserting where the fixture happened to pay rather than where the
    // deadline is.
    const due = (dispatched.timestamps.paidAt ?? 0) + TEST_POLICY.deadlines.syncResponseMs;
    const early = transition(dispatched, {
      kind: "deadline_expired",
      at: due - 1,
      deadline: "sync_response",
    });
    const onTime = transition(dispatched, {
      kind: "deadline_expired",
      at: due,
      deadline: "sync_response",
    });

    expect(early.ok).toBe(false);
    if (early.ok) return;
    expect(early.rejection.code).toBe("deadline_not_yet_due");
    expect(onTime.ok).toBe(true);
  });
});

describe("an order that never reached the handler", () => {
  it("is delivered again rather than closed", () => {
    // An exception is not an answer.
    const { order, effects } = must(reach("dispatched"), {
      kind: "handler_undelivered",
      at: T0 + 4,
    });

    expect(order.state).toBe("dispatched");
    expect(order.dispatch.attempts).toBe(1);
    expect(effects).toStrictEqual([{ kind: "redeliver_order", attempt: 2, delayMs: 1_000 }]);
  });

  it("stops repeating once the mode's deadline is too close, and waits it out", () => {
    // The synchronous budget is ten seconds in the fixtures, so by the ninth
    // second another attempt could only arrive late. The order is not closed
    // for that: the agent was promised the whole of the deadline, and a slow
    // handler's answer inside it still counts.
    const dispatched = reach("dispatched");
    const due = (dispatched.timestamps.paidAt ?? 0) + TEST_POLICY.deadlines.syncResponseMs;
    const silent = must(dispatched, {
      kind: "handler_undelivered",
      at: due - 500,
    });

    expect(silent.order.state).toBe("dispatched");
    expect(silent.effects).toStrictEqual([]);

    const late = must(silent.order, {
      kind: "handler_delivered",
      at: due - 100,
    });
    expect(late.order.state).toBe("fulfilled");

    const closed = must(silent.order, {
      kind: "deadline_expired",
      at: due,
      deadline: "sync_response",
    });
    expect(closed.order.state).toBe("expired");
    expect(closed.order.payment).toBe("verified");
  });

  it("leaves an asynchronous order open when the repeats run out, unfulfilled only at its deadline", () => {
    // Out of repeats is not out of time. The merchant may still deliver until
    // the deadline the card named, and the refund owed after it says the
    // deadline passed because it did.
    const dispatched = walk(newOrder("async"), [
      { kind: "payment_verified", at: T0 + 1 },
      { kind: "payment_settled", at: T0 + 2 },
      { kind: "order_dispatched", at: T0 + 3 },
    ]);
    const exhausted = { ...dispatched, dispatch: { attempts: 5, accepted: false } };
    const silent = must(exhausted, { kind: "handler_undelivered", at: T0 + 4 });

    expect(silent.order.state).toBe("dispatched");
    expect(silent.effects).toStrictEqual([]);

    const due = deadlines(silent.order).find((running) => running.kind === "async_fulfillment");
    if (due === undefined) throw new Error("no delivery deadline is running on the order");
    const { order } = must(silent.order, {
      kind: "deadline_expired",
      at: due.at,
      deadline: due.kind,
    });
    expect(order.state).toBe("unfulfilled");
    expect(order.closure).toStrictEqual({
      cause: "deadline_expired",
      deadline: "async_fulfillment",
    });
  });
});

describe("delivering twice, and delivering late", () => {
  it("answers a second deliver with the same success and no second fulfillment", () => {
    // Portal: repeating the call after a broken connection is safe, and the
    // merchant does not have to keep a note that he already sent it.
    const delivered = reach("delivered");
    const { order, effects } = must(delivered, { kind: "deliver_called", at: T0 + 99 });

    expect(order).toStrictEqual(delivered);
    expect(effects).toStrictEqual([
      { kind: "answer_merchant", answer: { ok: true, result: "already_delivered" } },
    ]);
  });

  it("delivers an unfulfilled order late", () => {
    // Portal: the money for the goods has been paid, and to the buyer late
    // goods are better than a refund.
    const { order, effects } = must(reach("unfulfilled"), { kind: "deliver_called", at: T0 + 999 });

    expect(order.state).toBe("delivered");
    expect(order.payment).toBe("settled");
    expect(effects).toContainEqual({
      kind: "answer_merchant",
      answer: { ok: true, result: "delivered_late" },
    });
  });

  it("hands the buyer the goods and the receipt when the handler delivers to an unfulfilled order", () => {
    // The late delivery can come from the handler as well as from the
    // merchant's separate call, and the buyer is owed the same either way: he
    // paid, so the goods go to him and the receipt says so. A debt closed on
    // paper with nothing handed over loses him the refund and the goods both.
    const { order, effects } = must(reach("unfulfilled"), {
      kind: "handler_delivered",
      at: T0 + 999,
    });

    expect(order.state).toBe("delivered");
    expect(order.closure).toBeNull();
    expect(effects).toStrictEqual([{ kind: "release_goods_to_agent" }, { kind: "issue_receipt" }]);
  });

  it("tells a merchant refusing an unfulfilled order that his refusal stands", () => {
    // Portal: repeating a call after a broken connection is safe. The order is
    // exactly where his handler's refusal put it, so a refusal called in on top
    // of it is answered `ok: true`. An error here would have his code retrying
    // or escalating an order on which he has nothing left to do.
    const debt = reach("unfulfilled");
    const { order, effects } = must(debt, sampleEvent("refuse_called"));

    expect(order).toStrictEqual(debt);
    expect(effects).toStrictEqual([
      { kind: "answer_merchant", answer: { ok: true, result: "refused" } },
    ]);
  });

  it("has nothing left to deliver once the merchant closed fulfillment", () => {
    const { order, effects } = must(reach("fulfillment_closed"), {
      kind: "deliver_called",
      at: T0 + 999,
    });

    expect(order.state).toBe("fulfillment_closed");
    expect(effects).toStrictEqual([
      {
        kind: "answer_merchant",
        answer: { ok: false, error: "fulfillment_closed", retryable: false },
      },
    ]);
  });

  it("keeps the goods a merchant produced after the purchase was already closed", () => {
    // He started before the deadline and finished after it, and the work is not
    // thrown away.
    const closed = walk(reach("dispatched"), [
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "sync_response" },
    ]);
    const { order, effects } = must(closed, { kind: "handler_delivered", at: T0 + 1_000_000 });

    expect(order.state).toBe("expired");
    expect(order.heldFulfillment).toBe(true);
    expect(effects).toStrictEqual([
      { kind: "hold_fulfillment" },
      { kind: "answer_merchant", answer: { ok: true, result: "purchase_already_closed" } },
    ]);
  });

  it("lets a repeat of the purchase pick up goods that were produced too late", () => {
    const held = walk(reach("dispatched"), [
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "sync_response" },
      { kind: "handler_delivered", at: T0 + 1_000_000 },
    ]);
    const { order, effects } = must(held, { kind: "purchase_repeated", at: T0 + 1_000_001 });

    // Asking for the repeat's payment does not by itself reopen the purchase.
    expect(order.state).toBe("expired");
    expect(kinds(effects)).toStrictEqual(["verify_payment"]);

    const reopened = must(order, { kind: "payment_verified", at: T0 + 1_000_002 });

    expect(reopened.order.state).toBe("fulfilled");
    expect(kinds(reopened.effects)).toStrictEqual(["execute_payment"]);

    const paid = walk(reopened.order, [{ kind: "payment_settled", at: T0 + 1_000_003 }]);

    expect(paid.state).toBe("delivered");
    expect(paid.payment).toBe("settled");
  });

  it("does not charge for held goods on the verification that ran out of time with the purchase", () => {
    // The verification that went with the closed purchase is spent with it.
    // Reported once more on the held order, it starts nothing: the goods wait
    // in the drawer for a repeat, which resets the payment and brings its own
    // verification, and only that one charges the buyer.
    const held = walk(reach("dispatched"), [
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "sync_response" },
      { kind: "handler_delivered", at: T0 + 1_000_000 },
    ]);
    expect(held.heldFulfillment).toBe(true);
    expect(held.payment).toBe("verified");

    const again = transition(held, { kind: "payment_verified", at: T0 + 1_000_001 });

    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.rejection.code).toBe("event_not_applicable");
  });

  it("has nothing to hand over when a repeat finds no goods waiting", () => {
    const closed = walk(reach("dispatched"), [
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "sync_response" },
    ]);
    const { order, effects } = must(closed, { kind: "purchase_repeated", at: T0 + 1_000_000 });

    expect(order.state).toBe("expired");
    expect(effects).toStrictEqual([]);
  });

  it("holds synchronous goods that arrive once the deadline has passed, whether or not its timer has fired", () => {
    // Portal, "You did not deliver in time": goods finished after the
    // synchronous deadline find the purchase closed and nothing charged. The
    // timer that closes the order can fire late, so the instant of the answer
    // decides, not the order in which the answer and the timer arrived.
    // From `paid` as well: the answer can beat our own record of the
    // hand-over, and the merchant answering is proof enough that it happened.
    for (const start of [reach("dispatched"), reach("paid")]) {
      const due = (start.timestamps.paidAt ?? 0) + TEST_POLICY.deadlines.syncResponseMs;

      for (const at of [due, due + 1_500]) {
        const { order, effects } = must(start, { kind: "handler_delivered", at });

        expect(order.state).toBe("expired");
        expect(order.closure).toStrictEqual({
          cause: "deadline_expired",
          deadline: "sync_response",
        });
        expect(order.heldFulfillment).toBe(true);
        expect(order.payment).toBe("verified");
        expect(effects).toStrictEqual([
          { kind: "hold_fulfillment" },
          { kind: "answer_merchant", answer: { ok: true, result: "purchase_already_closed" } },
        ]);
      }
    }
  });

  it("ends a late synchronous answer exactly where the timer and then the answer would have", () => {
    // Two arrival orders, one outcome: the answer landing before the overdue
    // timer and the timer landing first leave the same order behind. From
    // `dispatched` only: from `paid`, the answer also proves the hand-over our
    // own record had not yet noted, so it counts one delivery the timer-first
    // path never makes, and the outcome is checked in the test above instead.
    const dispatched = reach("dispatched");
    const due = (dispatched.timestamps.paidAt ?? 0) + TEST_POLICY.deadlines.syncResponseMs;
    const answerFirst = must(dispatched, { kind: "handler_delivered", at: due + 1_500 }).order;
    const timerFirst = walk(dispatched, [
      { kind: "deadline_expired", at: due, deadline: "sync_response" },
      { kind: "handler_delivered", at: due + 1_500 },
    ]);

    expect(answerFirst).toStrictEqual(timerFirst);
  });

  it("closes a synchronous order on its deadline when the refusal arrives after it", () => {
    // A refusal is the merchant's word that the purchase does not happen, and
    // past the deadline the purchase has already not happened, on the clock.
    // Whether the timer landed first or the refusal did, the order ends the
    // same way, expired, and the merchant hears that it was already closed.
    const dispatched = reach("dispatched");
    const due = (dispatched.timestamps.paidAt ?? 0) + TEST_POLICY.deadlines.syncResponseMs;
    const refusal = {
      kind: "handler_refused",
      at: due + 1_500,
      code: "out_of_stock",
      message: "none left",
    } as const;

    const { order, effects } = must(dispatched, refusal);
    const timerFirst = walk(dispatched, [
      { kind: "deadline_expired", at: due, deadline: "sync_response" },
    ]);
    const thenRefused = transition(timerFirst, refusal);

    expect(order).toStrictEqual(timerFirst);
    expect(effects).toStrictEqual([
      {
        kind: "answer_merchant",
        answer: { ok: false, error: "order_already_closed", retryable: false },
      },
    ]);
    expect(thenRefused.ok).toBe(false);
  });

  it("takes a synchronous refusal that arrives a moment before the deadline as the merchant's", () => {
    const dispatched = reach("dispatched");
    const due = (dispatched.timestamps.paidAt ?? 0) + TEST_POLICY.deadlines.syncResponseMs;
    const { order } = must(dispatched, {
      kind: "handler_refused",
      at: due - 1,
      code: "out_of_stock",
      message: "none left",
    });

    expect(order.closure).toStrictEqual({
      cause: "merchant_refused",
      code: "out_of_stock",
      message: "none left",
    });
  });

  it("charges for synchronous goods that arrive a moment before the deadline", () => {
    const dispatched = reach("dispatched");
    const due = (dispatched.timestamps.paidAt ?? 0) + TEST_POLICY.deadlines.syncResponseMs;
    const { order, effects } = must(dispatched, { kind: "handler_delivered", at: due - 1 });

    expect(order.state).toBe("fulfilled");
    expect(kinds(effects)).toStrictEqual(["execute_payment"]);
  });

  it("delivers asynchronous goods that arrive after the deadline its timer has not yet closed", () => {
    // The asynchronous buyer has already paid, and late goods are what they
    // were owed: whether the overdue timer landed first changes only whether a
    // debt was briefly recorded, not where the order ends. So the instant of
    // the answer is not weighed here the way it is for a synchronous one.
    const accepted = walk(newOrder("async"), [
      { kind: "payment_verified", at: T0 + 1 },
      { kind: "payment_settled", at: T0 + 2 },
      { kind: "order_dispatched", at: T0 + 3 },
      { kind: "handler_accepted", at: T0 + 4 },
    ]);
    const due = (accepted.timestamps.paidAt ?? 0) + TEST_POLICY.deadlines.asyncFulfillmentMs;

    for (const kind of ["deliver_called", "handler_delivered"] as const) {
      const { order, effects } = must(accepted, { kind, at: due + 1_500 });

      expect(order.state).toBe("delivered");
      expect(kinds(effects)).not.toContain("mark_unfulfilled");
    }
  });
});

describe("the same order delivered to the handler twice", () => {
  it("refuses to be handed out again once it is delivered", () => {
    // The hand-over is the gateway's question, not the merchant's: the poll
    // gives a worker exactly the orders whose `order_dispatched` this machine
    // takes, so a delivered order that answered it — with nothing to do, even
    // — was the machine asking for a finished purchase to be worked on again.
    // The refusal is `event_not_applicable`, which is the kind the poll
    // finishes the envelope on rather than putting back on the stream; a
    // retryable one would have the order circling instead.
    const delivered = reach("delivered");
    const refused = transition(delivered, { kind: "order_dispatched", at: T0 + 50 });

    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("a delivered order took the hand-over");
    expect(refused.rejection.code).toBe("event_not_applicable");
    expect(refused.rejection.retryable).toBe(false);

    // What does not change: a merchant who is holding the order anyway,
    // because a redelivery raced past this, is still answered with the state
    // it is in rather than sent looking for goods he has already handed over.
    const accepted = must(delivered, { kind: "handler_accepted", at: T0 + 51 });

    expect(accepted.order.state).toBe("delivered");
    expect(accepted.effects).toStrictEqual([
      { kind: "answer_merchant", answer: { ok: true, result: "already_delivered" } },
    ]);
  });

  it("counts the deliveries so the backoff has something to count from", () => {
    const dispatched = reach("dispatched");
    const again = must(dispatched, { kind: "order_dispatched", at: T0 + 4 });

    expect(again.order.dispatch.attempts).toBe(dispatched.dispatch.attempts + 1);
  });
});

describe("an order the merchant has taken on", () => {
  // Taking an order on is the merchant saying he holds it. Our wait for his
  // answer is a few seconds and his handler can be slower than that, so the
  // silence we noticed and the acceptance that ends it can arrive in either
  // order, and a repeat decided on in between can reach him after he has
  // answered. Whichever way round it goes, a silence noticed once he holds the
  // order is not a delivery he failed: counting it spends one he never missed,
  // and enough of those close a paid order into a refund owed while he is
  // filling it.
  //
  // Both orders below have deliveries left, so a silence that counted would
  // send the order again to a merchant already filling it, and they differ in
  // nothing but whether the merchant has taken the order on.
  const withDeliveriesLeft = (accepted: boolean): Order => ({
    ...walk(newOrder("async"), [
      { kind: "payment_verified", at: T0 + 1 },
      { kind: "payment_settled", at: T0 + 2 },
      { kind: "order_dispatched", at: T0 + 3 },
    ]),
    dispatch: { attempts: 1, accepted },
  });

  it("is left as it was by a silence noticed after it", () => {
    const held = withDeliveriesLeft(true);
    const { order, effects } = must(held, { kind: "handler_undelivered", at: T0 + 10 });

    expect(effects).toStrictEqual([]);
    expect(order).toStrictEqual(held);
  });

  it("is what keeps the same silence from sending it again", () => {
    // The negative control: the same order, the same silence, nobody holding
    // it — and it goes out again.
    const { effects } = must(withDeliveriesLeft(false), {
      kind: "handler_undelivered",
      at: T0 + 10,
    });

    expect(effects).toStrictEqual([{ kind: "redeliver_order", attempt: 2, delayMs: 1_000 }]);
  });
});

describe("goods handed over that were never paid for", () => {
  it("records the case and tells the merchant", () => {
    // Rare, and possible only in the synchronous mode, where the money is
    // executed last.
    const { order, effects } = must(reach("fulfilled"), {
      kind: "payment_settle_failed",
      at: T0 + 5,
    });

    expect(order.state).toBe("delivered_unpaid");
    expect(effects).toStrictEqual([
      { kind: "emit_merchant_event", event: "order.payment_failed_after_delivery" },
    ]);
  });

  it("is closed by the agent repeating the purchase, with no second fulfillment", () => {
    const unpaid = reach("delivered_unpaid");
    const repeated = must(unpaid, { kind: "purchase_repeated", at: T0 + 6 });

    expect(repeated.order.state).toBe("delivered_unpaid");
    expect(kinds(repeated.effects)).toStrictEqual(["verify_payment"]);

    const verified = must(repeated.order, { kind: "payment_verified", at: T0 + 7 });

    expect(kinds(verified.effects)).toStrictEqual(["execute_payment"]);

    const settled = must(verified.order, { kind: "payment_settled", at: T0 + 8 });

    expect(settled.order.state).toBe("delivered");
    expect(kinds(settled.effects)).toStrictEqual(["release_goods_to_agent", "issue_receipt"]);
  });
});

describe("while the settle is in flight", () => {
  /**
   * The window between the payment being sent for execution and the answer
   * coming back. It is seconds long and it is the one moment when the machine
   * genuinely does not know where the buyer's money is. Everything here is
   * about not pretending otherwise.
   */
  function settling(): Order {
    return walk(newOrder("async"), [{ kind: "payment_verified", at: T0 + 1 }]);
  }

  it("says so instead of calling the money untouched", () => {
    expect(settling().payment).toBe("settling");
  });

  it("still answers the merchant's own calls where he is holding the order", () => {
    // The guard is about where the money is; it must not also decide who is
    // allowed to speak. In `fulfilled` and `delivered_unpaid` the merchant is
    // mid-conversation with us.
    const held = reach("fulfilled");
    const delivered = must(held, { kind: "deliver_called", at: T0 + 9 });
    const refused = must(held, {
      kind: "refuse_called",
      at: T0 + 9,
      code: "out_of_stock",
      message: "none",
    });

    expect(delivered.effects).toStrictEqual([
      { kind: "answer_merchant", answer: { ok: true, result: "already_delivered" } },
    ]);
    expect(refused.effects).toStrictEqual([
      {
        kind: "answer_merchant",
        answer: { ok: false, error: "not_applicable_in_mode", retryable: false },
      },
    ]);
    expect(delivered.order).toStrictEqual(held);
    expect(refused.order).toStrictEqual(held);
  });

  it("keeps refusing them where he is holding nothing", () => {
    // In `quoted` the merchant has not been given the order at
    // all, so his calling about it is not a retry of anything.
    const result = transition(settling(), { kind: "deliver_called", at: T0 + 2 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("settle_in_flight");
  });

  it("refuses to close the order as free while it does not know", () => {
    // Every one of these would otherwise tell the buyer his purchase never
    // happened while his money was already on its way to the merchant.
    const closing: readonly OrderEvent[] = [
      { kind: "payment_verification_failed", at: T0 + 2, reason: "signature" },
      { kind: "handler_refused", at: T0 + 2, code: "out_of_stock", message: "none" },
      { kind: "refuse_called", at: T0 + 2, code: "out_of_stock", message: "none" },
    ];

    for (const event of closing) {
      const result = transition(settling(), event);
      expect(result.ok, event.kind).toBe(false);
      if (result.ok) continue;
      expect(result.rejection.code, event.kind).toBe("settle_in_flight");
    }
  });

  it("sends the payment for execution once and not twice", () => {
    // A duplicate off a queue that delivers at least once must not spend the
    // buyer's money a second time.
    const result = transition(settling(), { kind: "payment_verified", at: T0 + 2 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("settle_in_flight");
  });

  it("gives the settle a deadline of its own, and closes the purchase if it is silent", () => {
    // A silent charge is always a closed failure. Without a deadline here the
    // order would wait for an answer that never comes, and the agent would be
    // told "not yet" forever.
    const order = settling();

    expect(deadlines(order)).toStrictEqual([
      { kind: "settle_response", at: T0 + 1 + TEST_POLICY.deadlines.settleResponseMs },
    ]);

    const { order: closed } = must(order, {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "settle_response",
    });

    expect(closed.state).toBe("rejected");
    expect(closed.closure).toStrictEqual({ cause: "payment_outcome_unknown" });
  });

  it("tells the merchant nothing when a purchase he was never handed closes on a quiet charge", () => {
    // The order went from quoted straight into the charge and never reached
    // him, so its closure warrants no effect at all — the whole list is
    // asserted empty, not just the absence of one kind.
    const { order, effects } = must(settling(), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "settle_response",
    });

    expect(order.state).toBe("rejected");
    expect(effects).toStrictEqual([]);
  });

  it("does not write the same record for a guess as for a known failure", () => {
    // Both close the purchase and neither charges the buyer, but "the payment
    // layer told us it failed" and "the payment layer never answered" carry
    // very different odds that the money actually moved, and an error text, a
    // dispute and the merchant's reconciliation all read this field.
    const guessed = walk(settling(), [
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "settle_response" },
    ]);
    const known = walk(settling(), [{ kind: "payment_settle_failed", at: T0 + 2 }]);

    expect(guessed.state).toBe(known.state);
    expect(guessed.closure).toStrictEqual({ cause: "payment_outcome_unknown" });
    expect(known.closure).toStrictEqual({ cause: "payment_not_settled" });
  });

  it("will not reopen a purchase the payment layer said it had failed", () => {
    // Only the guess can be overturned by a late charge. A payment layer that
    // reports a failure and then a success is contradicting itself, and this
    // machine is not the place that resolves it.
    const known = walk(settling(), [{ kind: "payment_settle_failed", at: T0 + 2 }]);
    const late = transition(known, { kind: "payment_settled", at: T0 + 999 });

    expect(late.ok).toBe(false);
  });

  it("turns the guess into a fact once, and no more than once", () => {
    // Nothing in the machine counts charges. The counter that guards against a
    // second one is the walk's accounting in `walk.test.ts`: it goes up on
    // every charge sent for execution and down on every accepted settle
    // outcome, and it is read against a floor of nought as well as a ceiling
    // of one. So this arm is what holds that counter honest — an unbounded
    // stream of settle outcomes accepted on a closed order would drive it
    // below zero and leave room underneath it for a charge the walk would no
    // longer notice.
    const closed = walk(settling(), [
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "settle_response" },
    ]);
    const first = must(closed, { kind: "payment_settle_failed", at: T0 + 1_000_000 });

    expect(first.order.closure).toStrictEqual({ cause: "payment_not_settled" });
    expect(transition(first.order, { kind: "payment_settle_failed", at: T0 + 1_000_001 }).ok).toBe(
      false,
    );
  });

  it("answers the merchant's retry the same way wherever the settle happens to be", () => {
    // He produced the goods and his connection broke; his retry must not get a
    // raw rejection just because an internal charge is mid-flight at that
    // instant. The portal promises him the same typed success every time.
    const settlingNow = reach("fulfilled");
    const notSettling = reach("delivered_unpaid");

    expect(settlingNow.payment).toBe("settling");
    expect(notSettling.payment).not.toBe("settling");

    const whileSettling = must(settlingNow, { kind: "deliver_called", at: T0 + 9 });
    const otherwise = must(notSettling, { kind: "deliver_called", at: T0 + 9 });

    expect(whileSettling.effects).toStrictEqual(otherwise.effects);
    // And the answer reads the order's current fact without changing it.
    expect(whileSettling.order).toStrictEqual(settlingNow);
  });

  it("marks the refusal it gives during the charge as one to send again", () => {
    // The interpreter has no queue of its own for refused events; the flag is
    // how the machine asks for one.
    const result = transition(settling(), {
      kind: "handler_refused",
      at: T0 + 2,
      code: "out_of_stock",
      message: "none",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("settle_in_flight");
    expect(result.rejection.retryable).toBe(true);
  });

  it("does not ask for a second try where there is nothing to wait for", () => {
    // The flag is an instruction, and an interpreter that follows it on a
    // refusal meaning "this event does not belong here" spins forever.
    const nonsense = transition(reach("delivered"), { kind: "payment_settled", at: T0 + 1 });
    const early = transition(reach("dispatched"), {
      kind: "deadline_expired",
      at: T0 + 1_000,
      deadline: "sync_response",
    });

    expect(nonsense.ok).toBe(false);
    expect(early.ok).toBe(false);
    if (nonsense.ok || early.ok) return;
    expect(nonsense.rejection.retryable).toBe(false);
    expect(early.rejection.retryable).toBe(false);
  });

  it("turns a charge that lands after that into an unfulfilled paid order rather than losing it", () => {
    // The closed failure is a guess that the money did not move. If the guess
    // turns out wrong, the buyer is owed his money back — and the machine has
    // to record that rather than carry on insisting the purchase never was.
    const closed = walk(settling(), [
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "settle_response" },
    ]);
    const { order, effects } = must(closed, { kind: "payment_settled", at: T0 + 1_000_000 });

    expect(order.state).toBe("unfulfilled");
    expect(order.payment).toBe("settled");
    expect(kinds(effects)).toStrictEqual(["mark_unfulfilled", "emit_merchant_event"]);
  });

  it("never sends a second charge while the first one's outcome is unknown", () => {
    // Recording a silent settle as a failed one would let every repeat of the
    // purchase send the money out again, unbounded, with the first charge's
    // fate still unknown.
    const silent = walk(reach("fulfilled"), [
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "settle_response" },
    ]);

    expect(silent.state).toBe("delivered_unpaid");
    expect(silent.payment).toBe("outcome_unknown");

    const repeated = transition(silent, { kind: "purchase_repeated", at: T0 + 1_000_000 });

    expect(repeated.ok).toBe(false);
    if (repeated.ok) return;
    expect(repeated.rejection.retryable).toBe(true);
  });

  it("keeps a charge that reported nothing apart from one that reported failure", () => {
    const silent = walk(reach("fulfilled"), [
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "settle_response" },
    ]);
    const failed = walk(reach("fulfilled"), [{ kind: "payment_settle_failed", at: T0 + 5 }]);

    expect(silent.state).toBe(failed.state);
    expect(silent.payment).toBe("outcome_unknown");
    expect(failed.payment).toBe("settle_failed");
  });

  it("takes the answer when the payment layer finally speaks", () => {
    // The money did move after all, and the merchant's goods are already made.
    // Dropping this answer would leave the buyer charged for a purchase the
    // machine goes on calling "did not happen".
    const silent = walk(reach("fulfilled"), [
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "settle_response" },
    ]);
    const { order, effects } = must(silent, { kind: "payment_settled", at: T0 + 1_000_000 });

    expect(order.state).toBe("delivered");
    expect(order.payment).toBe("settled");
    expect(kinds(effects)).toStrictEqual(["release_goods_to_agent", "issue_receipt"]);
  });

  it("does not let a failed verification wipe the charge it knows nothing about", () => {
    // A payment that did not check out never became a charge, but clearing the
    // record on it would leave the order looking as though nothing were
    // outstanding, and the next repeat would send a second charge over the
    // first.
    const silent = walk(reach("fulfilled"), [
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "settle_response" },
    ]);
    const after = must(silent, {
      kind: "payment_verification_failed",
      at: T0 + 1_000_000,
      reason: "signature",
    });

    expect(after.order.payment).toBe("outcome_unknown");
    expect(transition(after.order, { kind: "purchase_repeated", at: T0 + 1_000_001 }).ok).toBe(
      false,
    );
  });

  it("lets the repeat through once the answer is in", () => {
    const known = walk(reach("fulfilled"), [
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "settle_response" },
      { kind: "payment_settle_failed", at: T0 + 1_000_000 },
    ]);

    expect(known.payment).toBe("settle_failed");

    const { effects } = must(known, { kind: "purchase_repeated", at: T0 + 1_000_001 });

    expect(kinds(effects)).toStrictEqual(["verify_payment"]);
  });

  it("closes a synchronous order whose settle went silent as goods without payment", () => {
    // The merchant produced the goods and we cannot say whether the money
    // arrived. He is told, exactly as the portal promises him.
    const fulfilled = reach("fulfilled");

    expect(fulfilled.payment).toBe("settling");

    const { order, effects } = must(fulfilled, {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "settle_response",
    });

    expect(order.state).toBe("delivered_unpaid");
    expect(effects).toStrictEqual([
      { kind: "emit_merchant_event", event: "order.payment_failed_after_delivery" },
    ]);
  });
});

describe("an answer that arrives before we recorded handing the order over", () => {
  it("is taken, not thrown away", () => {
    // One order goes to one instance of the handler, and that instance can
    // answer before our own record of the dispatch has landed. Dropping the
    // answer would run the order to its deadline and refund a buyer who was
    // holding the goods.
    const paid = walk(newOrder("async"), [
      { kind: "payment_verified", at: T0 + 1 },
      { kind: "payment_settled", at: T0 + 2 },
    ]);

    expect(paid.state).toBe("paid");

    const { order, effects } = must(paid, { kind: "deliver_called", at: T0 + 3 });

    expect(order.state).toBe("delivered");
    expect(kinds(effects)).toContain("release_goods_to_agent");
  });

  it("writes no record of a hand-over on the strength of a call it refused", () => {
    // A synchronous order has no separate deliver call at all. Answering that
    // must not leave the order claiming it was handed to a merchant it was
    // never handed to: a support view, a latency metric and a dispute all read
    // those fields.
    const paid = walk(newOrder("sync"), [{ kind: "payment_verified", at: T0 + 1 }]);
    const { order, effects } = must(paid, { kind: "deliver_called", at: T0 + 2 });

    expect(order).toStrictEqual(paid);
    expect(effects).toStrictEqual([
      {
        kind: "answer_merchant",
        answer: { ok: false, error: "not_applicable_in_mode", retryable: false },
      },
    ]);
  });

  it("claims a hand-over only from an answer that proves the handler ran", () => {
    // A `refuse` call can be made from anywhere at any time; a handler answer
    // can only come from a handler that was invoked. Counting the first as a
    // delivery credits the order round with a delivery it never had.
    const paid = walk(newOrder("async"), [
      { kind: "payment_verified", at: T0 + 3 },
      { kind: "payment_settled", at: T0 + 4 },
    ]);

    expect(paid.state).toBe("paid");
    expect(paid.dispatch.attempts).toBe(0);

    const { order } = must(paid, {
      kind: "refuse_called",
      at: T0 + 5,
      code: "out_of_stock",
      message: "none",
    });

    expect(order.state).toBe("unfulfilled");
    expect(order.dispatch.attempts).toBe(0);
  });

  it("does not invent the instant of a hand-over it only heard about", () => {
    // That it happened is known, because the merchant is answering. When it
    // happened is not, and a made-up number in that field is worse than an
    // empty one.
    const paid = walk(newOrder("async"), [
      { kind: "payment_verified", at: T0 + 1 },
      { kind: "payment_settled", at: T0 + 2 },
    ]);
    const { order } = must(paid, { kind: "handler_accepted", at: T0 + 3 });

    expect(order.state).toBe("dispatched");
    expect(order.timestamps.dispatchedAt).toBeNull();
    expect(order.dispatch.attempts).toBe(1);
  });

  it("counts one hand-over once, however we learn of it", () => {
    // Both the backoff exponent and the attempt cap read this counter, so
    // counting the same hand-over twice costs the order a retry against a
    // merchant who is already struggling.
    const paid = walk(newOrder("async"), [
      { kind: "payment_verified", at: T0 + 1 },
      { kind: "payment_settled", at: T0 + 2 },
    ]);
    const heardOfIt = must(paid, { kind: "handler_accepted", at: T0 + 3 }).order;
    const recorded = must(heardOfIt, { kind: "order_dispatched", at: T0 + 4 }).order;

    expect(recorded.dispatch.attempts).toBe(1);
    expect(recorded.timestamps.dispatchedAt).toBe(T0 + 4);

    // A genuinely second hand-over still counts.
    const again = must(recorded, { kind: "order_dispatched", at: T0 + 5 }).order;

    expect(again.dispatch.attempts).toBe(2);
  });

  it("takes a refusal in that same gap", () => {
    const paid = walk(newOrder("async"), [
      { kind: "payment_verified", at: T0 + 1 },
      { kind: "payment_settled", at: T0 + 2 },
    ]);
    const { order } = must(paid, {
      kind: "refuse_called",
      at: T0 + 3,
      code: "out_of_stock",
      message: "none",
    });

    expect(order.state).toBe("unfulfilled");
  });
});

describe("records that would say something untrue", () => {
  it("does not leave a refusal written on an order that ended in success", () => {
    // The closure is what a receipt, a dispute and the merchant's dashboard
    // render from. "The merchant refused" on a delivered order is a lie.
    const { order } = must(reach("unfulfilled"), { kind: "deliver_called", at: T0 + 999 });

    expect(order.state).toBe("delivered");
    expect(order.closure).toBeNull();
  });

  it("does not carry the reason a purchase ran out of time onto its second life", () => {
    // Two orders in the same state must not differ in the field a dispute and
    // the merchant's dashboard render from, for no reason but which path they
    // took to get there.
    const revived = walk(reach("dispatched"), [
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "sync_response" },
      { kind: "handler_delivered", at: T0 + 1_000_000 },
      { kind: "purchase_repeated", at: T0 + 1_000_001 },
      { kind: "payment_verified", at: T0 + 1_000_002 },
      { kind: "payment_settle_failed", at: T0 + 1_000_003 },
    ]);

    expect(revived.state).toBe("delivered_unpaid");
    expect(revived.closure).toBeNull();
  });

  it("does not carry a dead verification into a repeated purchase", () => {
    // The repeat brings its own payment. Claiming the old one is verified
    // while asking for the new one to be verified is two answers at once.
    const held = walk(reach("dispatched"), [
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "sync_response" },
      { kind: "handler_delivered", at: T0 + 1_000_000 },
    ]);
    const { order } = must(held, { kind: "purchase_repeated", at: T0 + 1_000_001 });

    expect(order.state).toBe("expired");
    expect(order.payment).toBe("none");
  });

  it("will not settle a repeated purchase whose payment nobody verified", () => {
    const reopened = walk(reach("dispatched"), [
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "sync_response" },
      { kind: "handler_delivered", at: T0 + 1_000_000 },
      { kind: "purchase_repeated", at: T0 + 1_000_001 },
    ]);
    const result = transition(reopened, { kind: "payment_settled", at: T0 + 1_000_002 });

    expect(result.ok).toBe(false);
  });
});

describe("an order whose goods are out and whose money is not", () => {
  it("answers nobody and writes nothing when a payment fails to verify", () => {
    // A verification that failed belongs to the payment layer, not to any call
    // of the merchant's: no charge was made, so there is nothing to write down,
    // and nobody is waiting for an answer. The arm sits above the delivery
    // calls, which answer `already_delivered`; an internal event falling into
    // them would produce a merchant's answer for a call nobody made.
    const unpaid = reach("delivered_unpaid");
    const { order, effects } = must(unpaid, {
      kind: "payment_verification_failed",
      at: T0 + 6,
      reason: "signature",
    });

    expect(order).toStrictEqual(unpaid);
    expect(effects).toStrictEqual([]);
  });

  // The repeat the portal promises will close this order sends a charge of
  // its own, and that charge can fail or say nothing like any other. What is
  // written down about it decides whether the buyer can try again, and the
  // two answers must not be confused: a charge nobody heard from bars the
  // next repeat, a charge that reported failure does not.
  function repeatInFlight(): Order {
    const repeated = walk(reach("delivered_unpaid"), [
      { kind: "purchase_repeated", at: T0 + 6 },
      { kind: "payment_verified", at: T0 + 7 },
    ]);

    expect(repeated.state).toBe("delivered_unpaid");
    expect(repeated.payment).toBe("settling");
    return repeated;
  }

  it("stays an unpaid delivery when the repeat's charge goes silent, and bars the next repeat", () => {
    // Not the generic close: a purchase whose goods are out would read as
    // refused, and a late "the money did move" would then mark a refund
    // instead of releasing what was bought. The merchant was told when the
    // order first went unpaid, so nothing is emitted here.
    const { order, effects } = must(repeatInFlight(), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "settle_response",
    });

    expect(order.state).toBe("delivered_unpaid");
    expect(order.payment).toBe("outcome_unknown");
    expect(order.closure).toBeNull();
    expect(effects).toStrictEqual([]);

    const again = transition(order, { kind: "purchase_repeated", at: T0 + 1_000_000 });

    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.rejection.code).toBe("settle_in_flight");
    expect(again.rejection.retryable).toBe(true);
  });

  it("records the repeat's failed charge as failed and leaves the door open to the next repeat", () => {
    // The payment layer said plainly that the money did not move. Refusing
    // that answer would leave the charge "in flight" until its timer ran out,
    // then write it down as unknown and turn the next repeat away.
    const { order, effects } = must(repeatInFlight(), {
      kind: "payment_settle_failed",
      at: T0 + 8,
    });

    expect(order.state).toBe("delivered_unpaid");
    expect(order.payment).toBe("settle_failed");
    expect(order.closure).toBeNull();
    expect(effects).toStrictEqual([]);

    const again = must(order, { kind: "purchase_repeated", at: T0 + 9 });

    expect(again.order.state).toBe("delivered_unpaid");
    expect(again.order.payment).toBe("none");
    expect(kinds(again.effects)).toStrictEqual(["verify_payment"]);
  });
});

describe("a merchant calling about an order that is already closed", () => {
  // `retryable` is a claim his code acts on. A `true` there would have a
  // well-behaved handler repeating a call that gets the same answer forever,
  // and the answer is the same from every closed state, because the fact it
  // states is the same.
  for (const state of CLOSED_ORDER_STATES) {
    it(`tells him from ${state} that it is closed, and not to try again`, () => {
      const before = reach(state);
      const { order, effects } = must(before, sampleEvent("refuse_called"));

      expect(order).toStrictEqual(before);
      expect(effects).toStrictEqual([
        {
          kind: "answer_merchant",
          answer: { ok: false, error: "order_already_closed", retryable: false },
        },
      ]);
    });
  }
});

describe("events that do not belong where they arrived", () => {
  const illegal: readonly [OrderState, OrderEvent, string][] = [
    ["created", { kind: "payment_verified", at: T0 + 1 }, "a payment before there is a price"],
    ["quoted", { kind: "order_dispatched", at: T0 + 1 }, "a dispatch before the payment"],
    ["quoted", { kind: "payment_settled", at: T0 + 1 }, "a settle nobody verified first"],
    [
      "fulfilled",
      { kind: "handler_refused", at: T0 + 1, code: "x", message: "y" },
      "a refusal after the goods",
    ],
    ["delivered", { kind: "payment_settled", at: T0 + 1 }, "a second charge on a closed order"],
    [
      "rejected",
      { kind: "handler_accepted", at: T0 + 1 },
      "an acceptance of a purchase that never happened",
    ],
    [
      "fulfillment_closed",
      { kind: "payment_settled", at: T0 + 1 },
      "a second charge on a paid order the merchant closed",
    ],
    [
      "failed",
      { kind: "handler_delivered", at: T0 + 1 },
      "goods from a handler that refused this very order",
    ],
  ];

  for (const [state, event, why] of illegal) {
    it(`refuses ${why}`, () => {
      const result = transition(reach(state), event);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.rejection.state).toBe(state);
      expect(result.rejection.event).toBe(event.kind);
    });
  }

  it("names the refusal instead of throwing it", () => {
    // The gateway turns this into an answer for whoever sent the event. An
    // exception here would become a five hundred on somebody's purchase.
    const result = transition(reach("delivered"), { kind: "payment_settled", at: T0 + 1 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("event_not_applicable");
    expect(result.rejection.message).toContain("delivered");
  });
});
