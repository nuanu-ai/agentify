/**
 * The in-memory store. What it promises as a port is checked once, in
 * `testing/store-contract.ts`, and run both here and against Postgres under
 * `pnpm test:db`. Two hand-written copies would drift, and the one left
 * unchecked would be the Postgres one a purchase actually rests on.
 *
 * What remains here is what only this adapter can be asked: that an object it
 * handed out cannot be edited, and that the writes alongside an order are all
 * or nothing by the order they are taken in rather than by a transaction.
 */

import type { Order } from "@agentify/core";
import { describe, expect, it } from "vitest";
import type { StoredOrder } from "../../ports/store.js";
import { describeStore } from "../../testing/store-contract.js";
import { MemoryStore } from "./store.js";

const counted = () => {
  let issued = 0;
  return (kind: string) => {
    issued += 1;
    return `${kind}_${issued}`;
  };
};

/** The merchant everything here belongs to, because an order needs one. */
const A = "mch_a";

const order = (id: string, state: Order["state"]): StoredOrder => ({
  order: {
    id,
    state,
    mode: { needsConfirmation: false, settle: "after_fulfillment" },
    policy: {
      deadlines: {
        quoteResponseMs: 1,
        quoteTtlMs: 1,
        settleResponseMs: 1,
        syncResponseMs: 1,
        paymentAfterConfirmationMs: 1,
        confirmationResponseMs: 1,
        asyncFulfillmentMs: 1,
      },
      redelivery: { baseDelayMs: 1, factor: 1, maxDelayMs: 1, maxAttempts: 1 },
    },
    payment: "none",
    cardPrice: { amount: "5.00", currency: "USD", asOf: 0 },
    price: null,
    quoteSource: null,
    dispatch: { attempts: 0, accepted: false },
    heldFulfillment: false,
    closure: null,
    test: true,
    timestamps: {
      createdAt: 0,
      quotedAt: null,
      confirmationRequestedAt: null,
      confirmedAt: null,
      settleStartedAt: null,
      paidAt: null,
      dispatchedAt: null,
    },
  },
  merchantId: A,
  itemId: "item_1",
  merchantItemId: "sku-1",
  params: {},
  priceId: null,
  delivery: null,
  payment: null,
  payTo: null,
  paidBy: null,
  settlement: null,
  paymentWords: [],
  paymentWordsDropped: 0,
  openDeliveryId: null,
});

describeStore("the store in memory", async () => new MemoryStore(counted()));

describe("MemoryStore, where it is not like the other one", () => {
  it("keeps what it was given, whatever the caller does with its copy afterwards", async () => {
    // If this store honoured an edit to a returned object, code that edits what
    // it read would work here and silently do nothing against Postgres, which
    // builds every object afresh from a row.
    const store = new MemoryStore(counted());
    await store.addMerchant({ id: A, name: "Merchant A" }, 0);
    await store.addOrder(order("ord_1", "created"));

    const read = await store.orderById("ord_1");
    expect(() => {
      (read as { itemId: string }).itemId = "item_other";
    }).toThrow();

    expect((await store.orderById("ord_1"))?.itemId).toBe("item_1");
  });

  it("says which merchant a key was refused for", async () => {
    // The shared suite can only check that the key is refused: under Postgres
    // the refusal is the driver's foreign-key error, whose message happens to
    // contain the identifier. Here the guard is this adapter's own, and whoever
    // runs the seed needs to know which merchant is missing.
    const store = new MemoryStore(counted());
    await store.addMerchant({ id: A, name: "Merchant A" }, 0);

    await expect(
      store.addKey(
        {
          id: "mk_1",
          merchantId: "mch_nobody",
          label: "one",
          digest: "d",
        },
        1_000,
      ),
    ).rejects.toThrow(/mch_nobody/);
  });
});

describe("MemoryStore writes that go with an order", () => {
  it("does not let an envelope be seen before the order that implies it", async () => {
    // The poll hands a merchant event over without touching the order, so an
    // envelope visible before its order is written would announce a change
    // that is not written down.
    let seenState: string | undefined;
    let store!: MemoryStore;
    store = new MemoryStore(counted(), undefined, {
      async stage(_merchantId, envelope) {
        expect(envelope.id).toBe("env_1");
        return () => {
          // Read as the envelope arrives: the order must already say what it
          // announces.
          void store.orderById("ord_1").then((found) => {
            seenState = found?.order.state;
          });
        };
      },
      async forget() {
        return () => {};
      },
    });
    await store.addMerchant({ id: A, name: "Merchant A" }, 0);
    await store.addOrder(order("ord_1", "paid"));

    await store.withOrder("ord_1", (found) => ({
      save: { ...found, order: { ...found.order, state: "dispatched" } },
      alongside: [
        {
          kind: "envelope",
          merchantId: A,
          envelope: {
            kind: "order_event",
            id: "env_1",
            sent_at: "2026-08-26T12:00:00.000Z",
            payload: {
              type: "order.refund_due",
              order_id: "ord_1",
              at: "2026-08-26T12:00:00.000Z",
              price: { amount: "5.00", currency: "USD" },
              reason: "deadline_passed",
            },
          },
        },
      ],
      result: null,
    }));

    await Promise.resolve();
    expect(seenState).toBe("dispatched");
  });

  it("writes nothing at all when one of the writes refuses", async () => {
    // All or nothing without a transaction: the write that can refuse is taken
    // first, so a refusal leaves no receipt, no envelope and the order where it
    // was.
    const store = new MemoryStore(counted(), undefined, {
      async stage() {
        throw new Error("the stream would not take it");
      },
      async forget() {
        return () => {};
      },
    });
    await store.addMerchant({ id: A, name: "Merchant A" }, 0);
    await store.addOrder(order("ord_1", "paid"));

    await expect(
      store.withOrder("ord_1", (found) => ({
        save: { ...found, order: { ...found.order, state: "delivered" } },
        alongside: [
          {
            kind: "receipt",
            merchantId: A,
            receipt: {
              id: "rcp_1",
              order_id: "ord_1",
              item_id: "item_1",
              price: {
                amount: "5.00",
                currency: "USD",
                at: "2026-08-26T12:00:00.000Z",
                as_of: "2026-08-26T12:00:00.000Z",
              },
              paid_at: "2026-08-26T12:00:00.000Z",
              outcome: "delivered",
              test: true,
            },
          },
          {
            kind: "envelope",
            merchantId: A,
            envelope: {
              kind: "order",
              id: "env_1",
              sent_at: "2026-08-26T12:00:00.000Z",
              payload: {
                id: "ord_1",
                merchant_item_id: "sku-1",
                params: {},
                price: {
                  amount: "5.00",
                  currency: "USD",
                  at: "2026-08-26T12:00:00.000Z",
                  as_of: "2026-08-26T12:00:00.000Z",
                },
                test: true,
              },
            },
          },
        ],
        result: null,
      })),
    ).rejects.toThrow("the stream would not take it");

    expect((await store.orderById("ord_1"))?.order.state).toBe("paid");
    // The receipt is listed before the envelope, but envelopes are taken
    // first, so the refusal comes before any receipt is written.
    expect(await store.receiptForOrder("ord_1")).toBeNull();
  });
});
