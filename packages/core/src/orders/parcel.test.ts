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
import { deadlines } from "./deadlines.js";
import { must, newOrder, sampleEvent, T0, TEST_POLICY, walk } from "./fixtures.js";
import { transition } from "./machine.js";
import type { Effect, Order, OrderEvent, OrderMode, TransitionResult } from "./model.js";
import { DEADLINE_KINDS, holdsShipTo, modeOf, ORDER_EVENT_KINDS } from "./model.js";

const PARCEL: OrderMode = { needsConfirmation: false, settle: "on_purchase", parcel: true };

/**
 * A parcel as ADR-0033 sells one: its price, shipping included, is the
 * merchant's own handler's answer, so the order is born waiting for it.
 */
const parcel = (): Order => newOrder("async", { mode: PARCEL, priceCheck: "merchant" });

const PRICED: OrderEvent = sampleEvent("quote_answered");

const PAID: readonly OrderEvent[] = [
  PRICED,
  { kind: "payment_verified", at: T0 + 2 },
  { kind: "payment_settled", at: T0 + 3 },
];

const paid = (order: Order): Order => walk(order, PAID);

const handedOver = (order: Order): Order =>
  walk(order, [...PAID, { kind: "order_dispatched", at: T0 + 4 }]);

const takenOn = (): Order =>
  must(handedOver(parcel()), { kind: "handler_accepted", at: T0 + 5 }).order;

const erasures = (effects: readonly Effect[]): number =>
  effects.filter((effect) => effect.kind === "erase_ship_to").length;

describe("a parcel's address", () => {
  it("is held from the priced request until the merchant has it", () => {
    expect(parcel().state).toBe("created");
    expect(holdsShipTo(parcel())).toBe(true);
    expect(holdsShipTo(walk(parcel(), [PRICED]))).toBe(true);
    expect(holdsShipTo(paid(parcel()))).toBe(true);
    expect(holdsShipTo(handedOver(parcel()))).toBe(true);
  });

  it("is let go when the merchant takes the order on, and the gateway is told so once", () => {
    // The merchant stores the address before answering `accepted`, so that
    // answer is the moment our copy stops being needed.
    const { order, effects } = must(handedOver(parcel()), {
      kind: "handler_accepted",
      at: T0 + 5,
    });

    expect(holdsShipTo(order)).toBe(false);
    expect(erasures(effects)).toBe(1);
  });

  it("is let go when the shipment is recorded on an order nobody took on first", () => {
    const { order, effects } = must(handedOver(parcel()), {
      kind: "deliver_called",
      at: T0 + 5,
    });

    expect(order.state).toBe("delivered");
    expect(holdsShipTo(order)).toBe(false);
    expect(erasures(effects)).toBe(1);
  });

  it("is let go when the order becomes a refund owed without having been taken on", () => {
    const refused = must(handedOver(parcel()), {
      kind: "handler_refused",
      at: T0 + 5,
      code: "cannot_fulfill",
      message: "we do not send parcels there",
    });
    const departed = must(paid(parcel()), { kind: "merchant_departed", at: T0 + 5 });
    const ranOut = must(handedOver(parcel()), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "async_fulfillment",
    });

    for (const { order, effects } of [refused, departed, ranOut]) {
      expect(order.state).toBe("refund_due");
      expect(erasures(effects)).toBe(1);
    }
  });

  it("is let go when the order closes before any money moved", () => {
    const unavailable = must(parcel(), { kind: "quote_answered", at: T0 + 1, available: false });
    const silent = must(parcel(), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "quote_response",
    });
    const stale = must(walk(parcel(), [PRICED]), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "quote_expiry",
    });

    expect(unavailable.order.state).toBe("rejected");
    for (const { order, effects } of [unavailable, silent, stale]) {
      expect(holdsShipTo(order)).toBe(false);
      expect(erasures(effects)).toBe(1);
    }
  });

  it("is let go once: what follows an acceptance asks for nothing more", () => {
    const shipped = must(takenOn(), { kind: "deliver_called", at: T0 + 6 });
    const ranOut = must(takenOn(), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "async_fulfillment",
    });

    expect(erasures(shipped.effects)).toBe(0);
    expect(ranOut.order.state).toBe("refund_due");
    expect(erasures(ranOut.effects)).toBe(0);
  });

  it("is nothing the machine speaks of on an order that is not a parcel", () => {
    // The negative control: the same walk on an ordinary asynchronous order
    // holds no address and asks for no erasure anywhere along it.
    const ordinary = walk(newOrder("async", { priceCheck: "merchant" }), [
      ...PAID,
      { kind: "order_dispatched", at: T0 + 4 },
    ]);
    const { order, effects } = must(ordinary, { kind: "handler_accepted", at: T0 + 5 });

    expect(holdsShipTo(ordinary)).toBe(false);
    expect(erasures(effects)).toBe(0);
    expect(erasures(must(order, { kind: "deliver_called", at: T0 + 6 }).effects)).toBe(0);
  });
});

describe("a card sold as a parcel", () => {
  it("makes a parcel order, whose money moves as the asynchronous mode's does", () => {
    // The mode a card names is what the order records at purchase (ADR-0033),
    // so a republished card changes no order in flight.
    expect(modeOf("ship")).toStrictEqual(PARCEL);
  });
});

describe("a parcel whose address is gone", () => {
  it("is not handed to a handler again once the merchant has taken it on", () => {
    // A repeat already on the merchant's stream when the acceptance landed
    // would hand them the parcel with no address in it.
    const refused = transition(takenOn(), { kind: "order_dispatched", at: T0 + 6 });

    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("a parcel with no address was handed over");
    expect(refused.rejection.code).toBe("event_not_applicable");
  });

  it("is not handed over even when the acceptance came before the hand-over was recorded", () => {
    // The merchant may answer through the `accept` call while the record of
    // the hand-over is still on its way. That record is refused like any other
    // repeat, so the order never says when it was handed over.
    const accepted = must(paid(parcel()), { kind: "handler_accepted", at: T0 + 4 });

    expect(erasures(accepted.effects)).toBe(1);
    expect(transition(accepted.order, { kind: "order_dispatched", at: T0 + 5 }).ok).toBe(false);
    expect(accepted.order.timestamps.dispatchedAt).toBeNull();
  });

  it("is not handed to a handler again once it owes a refund, though its shipment still closes the debt", () => {
    const owing = must(handedOver(parcel()), {
      kind: "handler_refused",
      at: T0 + 5,
      code: "cannot_fulfill",
      message: "out of stock",
    }).order;

    expect(transition(owing, { kind: "order_dispatched", at: T0 + 6 }).ok).toBe(false);
    // A merchant who ships after all, from their own copy of the address,
    // still closes what they owe.
    expect(must(owing, { kind: "deliver_called", at: T0 + 7 }).order.state).toBe("delivered");
  });

  it("is a parcel's rule only: an ordinary order owing a refund is still handed over", () => {
    // The negative control: late goods close an ordinary debt, and handing the
    // order over again is how a merchant's worker gets the chance to send them.
    const owing = must(
      walk(newOrder("async"), [...PAID.slice(1), { kind: "order_dispatched", at: T0 + 4 }]),
      { kind: "handler_refused", at: T0 + 5, code: "cannot_fulfill", message: "out of stock" },
    ).order;

    expect(transition(owing, { kind: "order_dispatched", at: T0 + 6 }).ok).toBe(true);
  });
});

/**
 * Every order a parcel can reach, and every event at each of them.
 *
 * The cases above name the moments ADR-0032 names; this asks the questions a
 * list of cases cannot, because it does not know which states exist. The
 * order is kept by what the machine decides on and not by its clock, so the
 * search ends, and each event arrives a step later than the last or, for an
 * expiry, long enough after it that whatever clock is running is due.
 */
describe("every parcel the machine can reach", () => {
  const ORDINARY = modeOf("async");
  const LONG_AFTER = 1_000_000_000;
  const REDELIVERY_CAP = TEST_POLICY.redelivery.maxAttempts;

  const eventsAt = (at: number): readonly OrderEvent[] => [
    ...ORDER_EVENT_KINDS.filter((kind) => kind !== "deadline_expired").map((kind) => ({
      ...sampleEvent(kind),
      at,
    })),
    { kind: "quote_answered", at, available: false },
    {
      kind: "quote_answered",
      at,
      available: true,
      price: { amount: "6.50", currency: "EUR", asOf: at },
    },
    ...DEADLINE_KINDS.map(
      (deadline): OrderEvent => ({ kind: "deadline_expired", at: at + LONG_AFTER, deadline }),
    ),
  ];

  const keyOf = (order: Order): string =>
    JSON.stringify([
      order.state,
      order.payment,
      order.dispatch.accepted,
      // A repeat already on the stream is handed over and counted without
      // limit, so past the cap on redeliveries one count reads as another.
      Math.min(order.dispatch.attempts, REDELIVERY_CAP + 1),
      order.heldFulfillment,
      order.closure?.cause ?? null,
      order.timestamps.dispatchedAt === null,
    ]);

  type Move = {
    readonly before: Order;
    readonly event: OrderEvent;
    readonly result: TransitionResult;
    readonly after: Order | null;
    readonly effects: readonly Effect[];
  };

  const moves: Move[] = [];
  const seen = new Set<string>();
  const waiting: { order: Order; at: number }[] = [{ order: parcel(), at: T0 }];
  while (waiting.length > 0) {
    const next = waiting.pop();
    if (next === undefined || seen.has(keyOf(next.order))) continue;
    seen.add(keyOf(next.order));
    for (const event of eventsAt(next.at + 1)) {
      const result = transition(next.order, event);
      moves.push({
        before: next.order,
        event,
        result,
        after: result.ok ? result.order : null,
        effects: result.ok ? result.effects : [],
      });
      if (result.ok) waiting.push({ order: result.order, at: event.at });
    }
  }

  const where = (move: Move): string =>
    `${move.event.kind} in ${move.before.state}${move.before.dispatch.accepted ? " (taken on)" : ""}`;

  it("lets the address go exactly once, and never takes it back", () => {
    for (const move of moves) {
      if (move.after === null) continue;
      const letGo = holdsShipTo(move.before) && !holdsShipTo(move.after);

      expect(holdsShipTo(move.after) && !holdsShipTo(move.before), where(move)).toBe(false);
      expect(erasures(move.effects), where(move)).toBe(letGo ? 1 : 0);
    }
  });

  it("never holds the address with no clock running to end the wait", () => {
    for (const move of moves) {
      if (move.after !== null && holdsShipTo(move.after)) {
        expect(deadlines(move.after).length, where(move)).toBeGreaterThan(0);
      }
    }
  });

  /**
   * What the machine decided, with the mode and the erasure taken out. A
   * refusal is compared by everything an interpreter acts on — above all
   * whether to send the event again — and not by its words, which are prose.
   */
  const decision = (result: TransitionResult) => {
    if (!result.ok) {
      const { message: _words, ...refusal } = result.rejection;
      return { refusal };
    }
    return {
      order: { ...result.order, mode: ORDINARY },
      effects: result.effects.filter((effect) => effect.kind !== "erase_ship_to"),
    };
  };

  it("decides everything else exactly as it decides an ordinary asynchronous order", () => {
    // ADR-0033: a parcel adds no state. Apart from the erasure and the
    // hand-over of an order whose address is gone, the switch changes nothing
    // the machine does, money and refusals included.
    for (const move of moves) {
      if (move.event.kind === "order_dispatched" && !holdsShipTo(move.before)) {
        expect(move.after, where(move)).toBeNull();
        continue;
      }
      const ordinary = transition({ ...move.before, mode: ORDINARY }, move.event);

      expect(decision(move.result), where(move)).toEqual(decision(ordinary));
    }
  });

  it("reached every state that holds the address, and let it go from each", () => {
    // A floor under the three above: a search that stopped at the first state
    // would pass all of them.
    const lettingGoFrom = new Set(
      moves
        .filter((move) => move.after !== null && erasures(move.effects) > 0)
        .map((move) => move.before.state),
    );

    expect([...lettingGoFrom].sort()).toEqual(["created", "dispatched", "paid", "quoted"]);
  });
});

/**
 * What the compiler refuses, written as code because the compiler is the only
 * thing that can assert it. None of this runs: `tsc` fails the build the day
 * a line under a `@ts-expect-error` starts compiling.
 *
 * A parcel's money moves as the asynchronous mode's does (ADR-0033), and the
 * type allows it nowhere else. A synchronous order keeps finished goods for a
 * repeat of the purchase, and that repeat would bring an erased address back
 * to a parcel that had let it go. Each of the two switches is held on its own.
 */
const compilerHoldsTheseTrue = (): void => {
  const settledAfterTheGoods = {
    needsConfirmation: false,
    settle: "after_fulfillment",
    parcel: true,
  } as const;
  const confirmedFirst = { needsConfirmation: true, settle: "on_purchase", parcel: true } as const;

  // @ts-expect-error a parcel's money moves before the goods
  const late: OrderMode = settledAfterTheGoods;
  // @ts-expect-error and nobody is asked before it moves
  const asked: OrderMode = confirmedFirst;
  void [late, asked];
};

void compilerHoldsTheseTrue;
