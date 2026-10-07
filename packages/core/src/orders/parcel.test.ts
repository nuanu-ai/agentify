/**
 * A parcel's address, as the order machine keeps track of it (ADR-0032).
 *
 * A buyer's address is held only while the merchant still needs it from us:
 * from the priced request until the merchant takes the order on, records its
 * shipment, or the order closes or becomes a refund owed without having been
 * taken on. The machine says the moment that happens, once, so the gateway
 * erases its copy; and an order whose copy is gone is never handed to a
 * handler again, because the handler would be handed a parcel with nowhere to
 * send it.
 */

import { describe, expect, it } from "vitest";
import { must, newOrder, T0, walk } from "./fixtures.js";
import { transition } from "./machine.js";
import type { Effect, Order, OrderEvent } from "./model.js";
import { holdsShipTo, modeOf } from "./model.js";

const ERASE: Effect = { kind: "erase_ship_to" };

/** A parcel sold the way the asynchronous mode sells: the money moves first. */
const parcel = (): Order => newOrder("async", { mode: { ...modeOf("async"), parcel: true } });

const PAID: readonly OrderEvent[] = [
  { kind: "payment_verified", at: T0 + 1 },
  { kind: "payment_settled", at: T0 + 2 },
];

const handedOver = (order: Order): Order =>
  walk(order, [...PAID, { kind: "order_dispatched", at: T0 + 3 }]);

const erasures = (effects: readonly Effect[]): number =>
  effects.filter((effect) => effect.kind === "erase_ship_to").length;

describe("a parcel's address", () => {
  it("is held from the priced request until the merchant has it", () => {
    expect(holdsShipTo(parcel())).toBe(true);
    expect(holdsShipTo(handedOver(parcel()))).toBe(true);
  });

  it("is let go when the merchant takes the order on, and the gateway is told so", () => {
    // The merchant stores the address before answering `accepted`, so that
    // answer is the moment our copy stops being needed.
    const { order, effects } = must(handedOver(parcel()), {
      kind: "handler_accepted",
      at: T0 + 4,
    });

    expect(holdsShipTo(order)).toBe(false);
    expect(effects).toContainEqual(ERASE);
  });

  it("is let go when the shipment is recorded on an order nobody took on first", () => {
    const { order, effects } = must(handedOver(parcel()), {
      kind: "deliver_called",
      at: T0 + 4,
    });

    expect(order.state).toBe("delivered");
    expect(holdsShipTo(order)).toBe(false);
    expect(erasures(effects)).toBe(1);
  });

  it("is let go when the order becomes a refund owed without having been taken on", () => {
    const { order, effects } = must(handedOver(parcel()), {
      kind: "handler_refused",
      at: T0 + 4,
      code: "cannot_fulfill",
      message: "we do not send parcels there",
    });

    expect(order.state).toBe("refund_due");
    expect(erasures(effects)).toBe(1);
  });

  it("is let go when the order closes before any money moved", () => {
    const { order, effects } = must(parcel(), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "quote_expiry",
    });

    expect(order.state).toBe("expired");
    expect(erasures(effects)).toBe(1);
  });

  it("is let go once: the shipment after an acceptance asks for nothing more", () => {
    const takenOn = must(handedOver(parcel()), { kind: "handler_accepted", at: T0 + 4 }).order;

    const { effects } = must(takenOn, { kind: "deliver_called", at: T0 + 5 });

    expect(erasures(effects)).toBe(0);
  });

  it("is nothing the machine speaks of on an order that is not a parcel", () => {
    // The negative control: the same walk on an ordinary asynchronous order
    // holds no address and asks for no erasure anywhere along it.
    const ordinary = walk(newOrder("async"), [...PAID, { kind: "order_dispatched", at: T0 + 3 }]);
    const { order, effects } = must(ordinary, { kind: "handler_accepted", at: T0 + 4 });

    expect(holdsShipTo(ordinary)).toBe(false);
    expect(erasures(effects)).toBe(0);
    expect(erasures(must(order, { kind: "deliver_called", at: T0 + 5 }).effects)).toBe(0);
  });
});

describe("a parcel whose address is gone", () => {
  it("is not handed to a handler again once the merchant has taken it on", () => {
    // A repeat already on the merchant's stream when the acceptance landed
    // would hand them the parcel with no address in it.
    const takenOn = must(handedOver(parcel()), { kind: "handler_accepted", at: T0 + 4 }).order;

    const refused = transition(takenOn, { kind: "order_dispatched", at: T0 + 5 });

    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("a parcel with no address was handed over");
    expect(refused.rejection.code).toBe("event_not_applicable");
  });

  it("is not handed to a handler again once it owes a refund, though its shipment still closes the debt", () => {
    const owing = must(handedOver(parcel()), {
      kind: "handler_refused",
      at: T0 + 4,
      code: "cannot_fulfill",
      message: "out of stock",
    }).order;

    expect(transition(owing, { kind: "order_dispatched", at: T0 + 5 }).ok).toBe(false);
    // A merchant who ships after all, from their own copy of the address,
    // still closes what they owe.
    expect(must(owing, { kind: "deliver_called", at: T0 + 6 }).order.state).toBe("delivered");
  });

  it("is a parcel's rule only: an ordinary order owing a refund is still handed over", () => {
    // The negative control: late goods close an ordinary debt, and handing the
    // order over again is how a merchant's worker gets the chance to send them.
    const owing = must(
      walk(newOrder("async"), [...PAID, { kind: "order_dispatched", at: T0 + 3 }]),
      { kind: "handler_refused", at: T0 + 4, code: "cannot_fulfill", message: "out of stock" },
    ).order;

    expect(transition(owing, { kind: "order_dispatched", at: T0 + 5 }).ok).toBe(true);
  });
});
