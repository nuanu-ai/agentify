import { describe, expect, it } from "vitest";
import { createOrder } from "./create.js";
import { createInput, TEST_PRICE } from "./fixtures.js";
import { CLOSED_ORDER_STATES, isOpen, modeOf, OPEN_ORDER_STATES, ORDER_STATES } from "./model.js";

describe("the order vocabulary", () => {
  it("splits every state into exactly one of open and closed", () => {
    // A state in both sets, or in neither, makes either the merchant's list of
    // unclosed orders after a restart or the agent's "is my purchase over"
    // answer wrong.
    const open = new Set<string>(OPEN_ORDER_STATES);
    const closed = new Set<string>(CLOSED_ORDER_STATES);

    for (const state of ORDER_STATES) {
      expect(open.has(state) !== closed.has(state), `state ${state}`).toBe(true);
    }
    expect(open.size + closed.size).toBe(ORDER_STATES.length);
  });

  it("reads each published fulfillment mode as a pair of switches", () => {
    // If this drifts, a card sold as `sync` starts taking money before the
    // goods exist.
    expect(modeOf("sync")).toStrictEqual({ needsConfirmation: false, settle: "after_fulfillment" });
    expect(modeOf("async")).toStrictEqual({ needsConfirmation: false, settle: "on_purchase" });
    expect(modeOf("confirm")).toStrictEqual({ needsConfirmation: true, settle: "on_purchase" });
  });

  it("keeps every state that is not a resting place of the purchase open", () => {
    expect(isOpen("dispatched")).toBe(true);
    expect(isOpen("unfulfilled")).toBe(true);
    expect(isOpen("delivered_unpaid")).toBe(true);
    expect(isOpen("delivered")).toBe(false);
  });
});

describe("creating an order", () => {
  it("asks the merchant for a price when the card carries a price check", () => {
    const created = createOrder(createInput("sync", { priceCheck: "merchant" }));

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.order.state).toBe("created");
    expect(created.order.price).toBeNull();
    expect(created.effects).toStrictEqual([{ kind: "request_quote" }]);
  });

  it("prices a static card off its own snapshot and goes straight to a quote", () => {
    const created = createOrder(createInput("sync"));

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.order.state).toBe("quoted");
    expect(created.order.price).toStrictEqual(TEST_PRICE);
    expect(created.order.quoteSource).toBe("card_snapshot");
    expect(created.effects).toStrictEqual([{ kind: "verify_payment" }]);
  });

  it("asks the merchant to confirm before any money when the card needs it", () => {
    const created = createOrder(createInput("confirm"));

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.order.state).toBe("quoted");
    expect(created.effects).toStrictEqual([{ kind: "dispatch_confirmation_request" }]);
  });

  it("carries the test flag through to the order", () => {
    const created = createOrder(createInput("async", { test: true }));

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.order.test).toBe(true);
  });

  it("takes no new order while the merchant is paused", () => {
    // Pausing is not leaving: new purchases stop, and nothing else changes.
    const created = createOrder(createInput("async", { selling: "paused" }));

    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.rejection.code).toBe("selling_paused");
  });

  it("takes no new order from a merchant who left", () => {
    const created = createOrder(createInput("async", { selling: "departed" }));

    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.rejection.code).toBe("merchant_departed");
  });

  it("starts every order with untouched money and no closure", () => {
    // Creation moves no money and claims no outcome, so "not known yet" stays
    // distinguishable from "known to be none".
    const created = createOrder(createInput("async"));

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.order.payment).toBe("none");
    expect(created.order.closure).toBeNull();
    expect(created.order.heldFulfillment).toBe(false);
    expect(created.order.dispatch).toStrictEqual({ attempts: 0, accepted: false });
  });
});
