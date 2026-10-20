import { describe, expect, it } from "vitest";
import { deadlines } from "./deadlines.js";
import { must, newOrder, reach, T0, walk } from "./fixtures.js";
import { transition } from "./machine.js";
import { ORDER_STATES, type OrderState } from "./model.js";
import { moneyInvariantViolations } from "./money.js";
import { onTheMerchantsOpenList, outcomeFor, paidAfterClosure } from "./outcome.js";

const ENDED_WITHOUT_A_CHARGE: readonly OrderState[] = [
  "failed",
  "rejected",
  "declined",
  "expired",
  "cancelled",
];

describe("the merchant closes Agentify fulfillment without deciding the money", () => {
  it("records the first merchant action and preserves the original payment and reason", () => {
    const original = reach("unfulfilled");
    const first = must(original, {
      kind: "close_called",
      at: T0 + 10,
      message: "We agreed an offset.",
    });
    expect(first.order).toMatchObject({
      state: "fulfillment_closed",
      payment: original.payment,
      closure: original.closure,
      merchantClosure: { at: T0 + 10, message: "We agreed an offset." },
    });
    const repeated = must(first.order, { kind: "close_called", at: T0 + 20, message: "Changed" });
    expect(repeated.order).toStrictEqual(first.order);
    expect(moneyInvariantViolations(repeated.order)).toEqual([]);
  });

  it("closes every order whose fulfillment can still be stopped", () => {
    for (const state of ORDER_STATES) {
      if (state === "delivered" || ENDED_WITHOUT_A_CHARGE.includes(state)) continue;
      const original = reach(state);
      const closed = must(original, { kind: "close_called", at: T0 + 100 });
      expect(closed.order.state, state).toBe("fulfillment_closed");
      expect(closed.order.payment, state).toBe(original.payment);
      expect(closed.order.heldFulfillment, state).toBe(original.heldFulfillment);
      expect(moneyInvariantViolations(closed.order), state).toEqual([]);
    }
  });

  it("refuses to close a delivered order, saying its fulfillment is complete", () => {
    const delivered = reach("delivered");
    const attempted = must(delivered, { kind: "close_called", at: T0 + 100 });
    expect(attempted.order).toStrictEqual(delivered);
    expect(attempted.effects).toStrictEqual([
      {
        kind: "answer_merchant",
        answer: { ok: false, error: "fulfillment_complete", retryable: false },
      },
    ]);
  });

  it.each(ENDED_WITHOUT_A_CHARGE)(
    "refuses to close an order that ended without a charge, leaving its ending as it was (%s)",
    (state) => {
      const ended = reach(state);
      const attempted = must(ended, { kind: "close_called", at: T0 + 100 });
      expect(attempted.order).toStrictEqual(ended);
      expect(attempted.effects).toStrictEqual([
        {
          kind: "answer_merchant",
          answer: { ok: false, error: "nothing_to_close", retryable: false },
        },
      ]);
    },
  );

  it("closes an ended order whose charge went unanswered, since that payment may still complete", () => {
    const silent = walk(newOrder("async"), [
      { kind: "payment_verified", at: T0 + 1 },
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "settle_response" },
    ]);
    expect(silent).toMatchObject({ state: "rejected", payment: "outcome_unknown" });
    const closed = must(silent, { kind: "close_called", at: T0 + 1_000_000 });
    expect(closed.order.state).toBe("fulfillment_closed");
  });

  it("closes an expired order holding goods its buyer could still pay to collect", () => {
    const held = walk(reach("dispatched"), [
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "sync_response" },
      { kind: "handler_delivered", at: T0 + 1_000_000 },
    ]);
    expect(held).toMatchObject({ state: "expired", heldFulfillment: true });
    const closed = must(held, { kind: "close_called", at: T0 + 1_000_001 });
    expect(closed.order.state).toBe("fulfillment_closed");
    expect(must(closed.order, { kind: "purchase_repeated", at: T0 + 1_000_002 }).effects).toEqual(
      [],
    );
  });

  it("blocks delivery, dispatch and charging after closure while retaining held goods", () => {
    const closed = must(reach("delivered_unpaid"), { kind: "close_called", at: T0 + 10 }).order;
    for (const kind of [
      "deliver_called",
      "handler_delivered",
      "order_dispatched",
      "purchase_repeated",
    ] as const) {
      const result = transition(closed, { kind, at: T0 + 20 });
      if (kind === "order_dispatched") {
        expect(result.ok).toBe(false);
      }
      if (result.ok) {
        expect(result.order).toStrictEqual(closed);
        for (const forbidden of [
          "execute_payment",
          "release_goods_to_agent",
          "dispatch_order",
          "issue_receipt",
        ]) {
          expect(result.effects.map((effect) => effect.kind)).not.toContain(forbidden);
        }
      } else {
        expect(result.rejection.retryable).toBe(false);
      }
    }
  });

  it.each([true, false])(
    "keeps the original pending payment recoverable after closure (settled=%s)",
    (settled) => {
      const pending = reach("fulfilled");
      const closed = must(pending, { kind: "close_called", at: T0 + 10 }).order;
      expect(outcomeFor(closed)).toBe("payment_unresolved");
      const [deadline] = deadlines(closed);
      expect(deadline?.kind).toBe("settle_response");
      if (deadline === undefined) throw new Error("pending charge lost its deadline");
      const unknown = must(closed, {
        kind: "deadline_expired",
        at: deadline.at,
        deadline: "settle_response",
      }).order;
      expect(unknown.state).toBe("fulfillment_closed");
      expect(unknown.payment).toBe("outcome_unknown");
      const completed = must(unknown, {
        kind: settled ? "payment_settled" : "payment_settle_failed",
        at: T0 + 100_000,
      });
      expect(completed.order.state).toBe("fulfillment_closed");
      expect(completed.order.payment).toBe(settled ? "settled" : "settle_failed");
      expect(completed.order.closure).toStrictEqual(pending.closure);
      expect(moneyInvariantViolations(completed.order)).toEqual([]);
    },
  );

  it.each(["settling", "outcome_unknown"] as const)(
    "tells the merchant when a payment unresolved at closure completes afterwards, and lists the order for them (%s)",
    (unresolved) => {
      const closed = must(reach("fulfilled"), {
        kind: "close_called",
        at: T0 + 10,
        message: "Your payment did not go through.",
      }).order;
      const waiting =
        unresolved === "settling"
          ? closed
          : must(closed, {
              kind: "deadline_expired",
              at: deadlines(closed)[0]?.at ?? Number.NaN,
              deadline: "settle_response",
            }).order;
      expect(waiting.payment).toBe(unresolved);
      expect(onTheMerchantsOpenList(waiting)).toBe(false);

      const paid = must(waiting, { kind: "payment_settled", at: T0 + 100_000 });
      expect(paid.order).toMatchObject({
        state: "fulfillment_closed",
        payment: "settled",
        merchantClosure: {
          at: T0 + 10,
          message: "Your payment did not go through.",
          paymentCompletedAt: T0 + 100_000,
        },
      });
      expect(paid.effects).toStrictEqual([
        { kind: "emit_merchant_event", event: "order.unfulfilled" },
      ]);
      expect(paidAfterClosure(paid.order)).toBe(true);
      expect(onTheMerchantsOpenList(paid.order)).toBe(true);
      expect(moneyInvariantViolations(paid.order)).toEqual([]);
    },
  );

  it("tells nobody and lists nothing when a payment unresolved at closure fails afterwards", () => {
    const closed = must(reach("fulfilled"), { kind: "close_called", at: T0 + 10 }).order;
    const failed = must(closed, { kind: "payment_settle_failed", at: T0 + 100_000 });
    expect(failed.effects).toStrictEqual([]);
    expect(failed.order.merchantClosure).toStrictEqual(closed.merchantClosure);
    expect(paidAfterClosure(failed.order)).toBe(false);
    expect(onTheMerchantsOpenList(failed.order)).toBe(false);
  });

  it("does not list a paid order the merchant closed after its payment had completed", () => {
    const closed = reach("fulfillment_closed");
    expect(closed.payment).toBe("settled");
    expect(paidAfterClosure(closed)).toBe(false);
    expect(onTheMerchantsOpenList(closed)).toBe(false);
  });

  it("records a new closure once the merchant closes again after the late payment, and keeps that one on repeat", () => {
    const closed = must(reach("fulfilled"), {
      kind: "close_called",
      at: T0 + 10,
      message: "Your payment did not go through.",
    }).order;
    const paid = must(closed, { kind: "payment_settled", at: T0 + 100_000 }).order;
    const again = must(paid, {
      kind: "close_called",
      at: T0 + 200_000,
      message: "Your payment arrived late; we returned it to your wallet.",
    });
    expect(again.order).toStrictEqual({
      ...paid,
      merchantClosure: {
        at: T0 + 200_000,
        message: "Your payment arrived late; we returned it to your wallet.",
      },
    });
    expect(again.effects).toStrictEqual([
      { kind: "answer_merchant", answer: { ok: true, result: "purchase_already_closed" } },
    ]);
    expect(onTheMerchantsOpenList(again.order)).toBe(false);
    const repeated = must(again.order, { kind: "close_called", at: T0 + 300_000, message: "x" });
    expect(repeated.order).toStrictEqual(again.order);
  });
});
