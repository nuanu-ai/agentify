import { describe, expect, it } from "vitest";
import { deadlines } from "./deadlines.js";
import { must, reach, T0 } from "./fixtures.js";
import { transition } from "./machine.js";
import { ORDER_STATES } from "./model.js";
import { moneyInvariantViolations } from "./money.js";
import { outcomeFor } from "./outcome.js";

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

  it("closes every state except an order whose goods were already handed over", () => {
    for (const state of ORDER_STATES) {
      const original = reach(state);
      const closed = must(original, { kind: "close_called", at: T0 + 100 });
      if (state === "delivered") {
        expect(closed.order).toStrictEqual(original);
        expect(closed.effects).toContainEqual({
          kind: "answer_merchant",
          answer: { ok: false, error: "order_already_closed", retryable: false },
        });
      } else {
        expect(closed.order.state, state).toBe("fulfillment_closed");
        expect(closed.order.payment, state).toBe(original.payment);
        expect(closed.order.heldFulfillment, state).toBe(original.heldFulfillment);
        expect(moneyInvariantViolations(closed.order), state).toEqual([]);
      }
    }
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
      expect(completed.order.merchantClosure).toStrictEqual(closed.merchantClosure);
      expect(completed.effects).toEqual([]);
      expect(moneyInvariantViolations(completed.order)).toEqual([]);
    },
  );
});
