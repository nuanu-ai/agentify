import type { Order } from "@agentify/core";
import { afterEach, describe, expect, it } from "vitest";
import type { StoredOrder } from "../ports/store.js";
import { admitVerifiedOrder, storeAcceptedOrder } from "../testing/accepted-order.js";
import { drawEverything, type Harness, harness } from "../testing/harness.js";

/**
 * The runner refuses to write an order that breaks a money invariant: writing
 * it down would mean selling against it. The order machine never produces such
 * an order, so the tests build one by hand, the way a row from an older version
 * or an undiscovered defect would arrive.
 */

/** The address the payments below were checked against; its value does not matter here. */
const PAID_AT = "0x0000000000000000000000000000000000000009";

const impossible = (merchantId: string): StoredOrder => {
  const order: Order = {
    id: "ord_impossible",
    // A success whose money never moved. The buyer has the goods, the merchant
    // is credited, and nothing was charged.
    state: "delivered",
    payment: "verified",
    mode: { settle: "after_fulfillment" },
    policy: {
      deadlines: {
        quoteResponseMs: 5_000,
        quoteTtlMs: 30_000,
        settleResponseMs: 2_000,
        syncResponseMs: 8_000,
        asyncFulfillmentMs: 86_400_000,
      },
      redelivery: { baseDelayMs: 500, factor: 2, maxDelayMs: 30_000, maxAttempts: 5 },
    },
    cardPrice: { amount: "80.00", currency: "USD", asOf: 0 },
    price: { amount: "80.00", currency: "USD", asOf: 0 },
    quoteSource: "card_snapshot",
    dispatch: { attempts: 1, accepted: false },
    heldFulfillment: false,
    closure: null,
    test: true,
    timestamps: {
      createdAt: 0,
      quotedAt: 0,
      paymentPresentedAt: null,
      settleStartedAt: null,
      paidAt: 0,
      dispatchedAt: 0,
    },
  };

  return {
    order,
    merchantId,
    through: "api",
    itemId: "item_1",
    merchantItemId: "sku-1",
    buyerKey: "bk_the_runner",
    params: {},
    priceId: null,
    delivery: null,
    payment: "SAVED-VERIFIED",
    payTo: PAID_AT,
    paidBy: PAID_AT,
    settlement: null,
    paymentWords: [],
    paymentWordsDropped: 0,
    openDeliveryId: null,
  };
};

let open: Harness | null = null;

afterEach(async () => {
  await open?.stop();
  open = null;
});

describe("an order that cannot be true", () => {
  it("is not written down, and the work stops on it", async () => {
    open = await harness();
    await storeAcceptedOrder(open.store, impossible(open.merchant.id));

    // An event the machine takes without changing anything. What it hands back
    // is still the order that came in, and that order says a buyer got goods
    // nobody was charged for.
    const applied = open.gateway.runner.apply("ord_impossible", {
      kind: "purchase_repeated",
      at: open.now(),
    });

    const before = await open.store.orderById("ord_impossible");
    const error = await applied.catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("ord_impossible");
    expect(String(error)).toMatch(/money|payment|settle/i);
    expect(String(error)).toMatch(/success|deliver/i);
    expect(await open.store.orderById("ord_impossible")).toEqual(before);
    expect(await open.store.receipts(open.merchant.id)).toEqual([]);
  });
});

/**
 * The same check for a buyer's address: a parcel's order holds the whole
 * address exactly while its merchant does not have it yet, and afterwards only
 * the instant it was erased; no other order holds one. The orders are built by
 * hand, as above.
 */
describe("an order that holds an address it should not", () => {
  /** An address in a real place, with the person and the number taken out of it. */
  const address = {
    name: "The buyer",
    line_one: "Jl. Raya Kediri, Beraban",
    city: "Tabanan",
    country: "ID",
    phone_number: "+62 000 0000 0000",
  };

  /** A parcel the merchant has taken on. */
  const takenOn = (merchantId: string): StoredOrder => {
    const record = impossible(merchantId);
    return {
      ...record,
      order: {
        ...record.order,
        id: "ord_parcel",
        state: "dispatched",
        payment: "settled",
        mode: { settle: "on_purchase", parcel: true },
        dispatch: { attempts: 1, accepted: true },
      },
    };
  };

  it("is not written down once the merchant has it, and the words do not repeat it", async () => {
    // A parcel taken on whose address was never erased. Writing it down again
    // would keep a buyer's address nobody here needs.
    open = await harness();
    await storeAcceptedOrder(open.store, { ...takenOn(open.merchant.id), shipTo: address });

    const applied = open.gateway.runner.apply("ord_parcel", {
      kind: "handler_accepted",
      at: open.now(),
    });

    await expect(applied).rejects.toThrow(/address/i);
    const thrown = await applied.catch((error: unknown) => String(error));
    for (const part of [address.name, address.line_one, address.phone_number]) {
      expect(thrown).not.toContain(part);
    }
  });

  it("is not written down by a payment either", async () => {
    // Waiting to be paid with the address already erased: the merchant would
    // be handed a parcel with nowhere to send it once the money moved.
    open = await harness();
    const parcel = takenOn(open.merchant.id);
    const corrupt: StoredOrder = {
      ...parcel,
      order: {
        ...parcel.order,
        state: "quoted",
        payment: "none",
        dispatch: { attempts: 0, accepted: false },
        timestamps: { ...parcel.order.timestamps, paidAt: null, dispatchedAt: null },
      },
      shipTo: { erasedAt: 0 },
    };
    expect(() =>
      open?.gateway.runner.preparePurchase(corrupt, PAID_AT, "a-payment", PAID_AT, 0, {
        fingerprint: "first-authorization",
        eligible: () => true,
      }),
    ).toThrow(/address/i);
    expect(await open.store.orderById("ord_parcel")).toBeNull();
  });

  it("is written down once the address is only when it was erased", async () => {
    // The negative control: the same order with the address erased is an
    // ordinary one, so the refusal above is about the address and nothing else.
    open = await harness();
    await storeAcceptedOrder(open.store, { ...takenOn(open.merchant.id), shipTo: { erasedAt: 0 } });

    const applied = await open.gateway.runner.apply("ord_parcel", {
      kind: "handler_accepted",
      at: open.now(),
    });

    expect(applied.outcome).toBe("moved");
  });

  it("is not created without the address a parcel's merchant still needs", async () => {
    // Paid and not yet handed over: the merchant has not had the address, so
    // an order with none, or with only the instant it was erased, would hand
    // them a parcel with nowhere to send it.
    open = await harness();
    const parcel = takenOn(open.merchant.id);
    const waiting: StoredOrder = {
      ...parcel,
      order: {
        ...parcel.order,
        state: "quoted",
        payment: "none",
        dispatch: { attempts: 0, accepted: false },
        timestamps: { ...parcel.order.timestamps, dispatchedAt: null },
      },
    };

    expect(() =>
      open?.gateway.runner.preparePurchase(waiting, PAID_AT, "PAYMENT", PAID_AT, 0, {
        fingerprint: "first",
        eligible: () => true,
      }),
    ).toThrow(/address/i);
    expect(() =>
      open?.gateway.runner.preparePurchase(
        { ...waiting, shipTo: { erasedAt: 0 } },
        PAID_AT,
        "PAYMENT",
        PAID_AT,
        0,
        { fingerprint: "second", eligible: () => true },
      ),
    ).toThrow(/address/i);
    expect(await open.store.orderById("ord_parcel")).toBeNull();
  });

  it("is not created as anything but a parcel with an address on it", async () => {
    open = await harness();
    const ordinary = impossible(open.merchant.id);
    const paid: StoredOrder = {
      ...ordinary,
      order: {
        ...ordinary.order,
        state: "quoted",
        payment: "none",
        dispatch: { attempts: 0, accepted: false },
      },
      shipTo: address,
    };

    expect(() =>
      open?.gateway.runner.preparePurchase(paid, PAID_AT, "PAYMENT", PAID_AT, 0, {
        fingerprint: "first",
        eligible: () => true,
      }),
    ).toThrow(/address|parcel/i);
  });
});

describe("an order whose next clock could not be started", () => {
  it("is not written down at all", async () => {
    // The clock is armed before the order is written. Written first and then
    // failing to arm, the order would have moved with no clock on it, the
    // retried event would no longer apply, and the order would hang with nobody
    // waiting on it.
    open = await harness();
    const published = await open.gateway.publishCard(open.merchant.id, {
      merchant_item_id: "esim",
      title: "A seven day eSIM",
      description: "Seven days of data",
      price: { amount: "12.00", currency: "USD" },
      result: { activation_code: { type: "string" } },
      fulfillment: "async",
    });
    if (!published.ok) throw new Error("the card would not publish");

    const offered = await open.gateway.beginPurchase(published.id, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;

    // From here the queue will not take a reminder.
    open.queue.remind = async () => {
      throw new Error("the queue was briefly unreachable");
    };

    await expect(
      admitVerifiedOrder(open.gateway, offered.order, {
        owner: "alice",
        payment: "PAY-A",
        fingerprint: "PAY-A",
      }),
    ).rejects.toThrow("the queue was briefly unreachable");

    // The order is exactly where it was, so the event can simply be sent again.
    const after = await open.store.orderById(orderId);
    expect(after).toBeNull();
  });
});

describe("who an order belongs to", () => {
  /** An order that has been quoted and is waiting for a payment. */
  const waiting = async (harnessed: Harness) => {
    const published = await harnessed.gateway.publishCard(harnessed.merchant.id, {
      merchant_item_id: "esim",
      title: "A seven day eSIM",
      description: "Seven days of data",
      price: { amount: "12.00", currency: "USD" },
      result: { activation_code: { type: "string" } },
      fulfillment: "async",
    });
    if (!published.ok) throw new Error("the card would not publish");
    const offered = await harnessed.gateway.beginPurchase(published.id, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    await admitVerifiedOrder(harnessed.gateway, offered.order, {
      owner: "alice",
      payment: "PAY-A",
      fingerprint: "PAY-A",
    });
    return offered.order.order.id;
  };

  it("is settled by the first verified payment, and not taken from its owner", async () => {
    // Ownership is decided under the order's lock, so a stranger's payment is
    // turned away without a mark: the charge is never swapped for an
    // authorisation the buyer did not present.
    open = await harness();
    const orderId = await waiting(open);

    const first = await open.gateway.runner.presentVerifiedPayment(
      orderId,
      "alice",
      "PAY-A",
      PAID_AT,
      open.now(),
    );
    expect(first.kind).toBe("already_yours");

    const stranger = await open.gateway.runner.presentVerifiedPayment(
      orderId,
      "bob",
      "PAY-B",
      PAID_AT,
      open.now(),
    );
    expect(stranger.kind).toBe("not_owner");

    const after = await open.store.orderById(orderId);
    expect(after?.paidBy).toBe("alice");
    expect(after?.payment).toBe("PAY-A");
    // And with the payment, the address it was checked against: the charge that
    // runs later is the one this buyer authorised, not whatever the merchant's
    // wallet says by then.
    expect(after?.payTo).toBe(
      (await open.store.merchantById(open.merchant.id))?.payoutWallet.split?.address,
    );
  });

  it("tells the owner asking again where it stands, and changes nothing", async () => {
    // A dropped connection and a retry from the same buyer is not a second
    // purchase. It finds the order already its own and under way, and the
    // answer is wherever it has got to — the payment that is being charged is
    // still the first one.
    open = await harness();
    const orderId = await waiting(open);
    await open.gateway.runner.presentVerifiedPayment(
      orderId,
      "alice",
      "PAY-A",
      PAID_AT,
      open.now(),
    );

    const again = await open.gateway.runner.presentVerifiedPayment(
      orderId,
      "alice",
      "PAY-A-AGAIN",
      PAID_AT,
      open.now(),
    );
    expect(again.kind).toBe("already_yours");

    const after = await open.store.orderById(orderId);
    expect(after?.payment).toBe("PAY-A");
    expect(after?.paidBy).toBe("alice");
  });
});

describe("an event held to the hand-over the order is waiting on", () => {
  /** An async order that has been paid for and handed to its merchant once. */
  const handedOver = async (harnessed: Harness) => {
    const published = await harnessed.gateway.publishCard(harnessed.merchant.id, {
      merchant_item_id: "esim",
      title: "A seven day eSIM",
      description: "Seven days of data",
      price: { amount: "12.00", currency: "USD" },
      result: { activation_code: { type: "string" } },
      fulfillment: "async",
    });
    if (!published.ok) throw new Error("the card would not publish");
    const offered = await harnessed.gateway.beginPurchase(published.id, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    await harnessed.gateway.payPurchase(
      offered.order.priceOffer.stamp,
      "PAYMENT",
      "PAYMENT",
      undefined,
      { itemId: offered.order.itemId, params: offered.order.params },
    );

    // Drawn by a worker that answers nothing, which is what records a hand-over.
    const drawn = await harnessed.gateway.poll(harnessed.merchant.id, 1_000);
    if (drawn.envelopes.length !== 1) throw new Error("the order did not reach the stream");
    const handOver = (await harnessed.store.orderById(orderId))?.openDeliveryId ?? null;
    if (handOver === null) throw new Error("the hand-over was not recorded");
    return { orderId, handOver };
  };

  it("is applied while that is still the hand-over, and clears it", async () => {
    // The ordinary case: our own clock on the merchant's answer ran out, this
    // is still the delivery he was given, and the order goes out to him again.
    open = await harness({ HANDLER_ANSWER_MS: "60000", DEFAULT_ASYNC_FULFILLMENT_MS: "60000" });
    const { orderId, handOver } = await handedOver(open);

    const applied = await open.gateway.runner.apply(
      orderId,
      { kind: "handler_undelivered", at: open.now() },
      { openDeliveryId: null },
      undefined,
      handOver,
    );

    expect(applied.outcome).toBe("moved");
    expect(await open.queue.holdsOrder(open.merchant.id, orderId)).toBe(true);
    expect((await open.store.orderById(orderId))?.openDeliveryId).toBeNull();
  });

  it("writes nothing at all once the order is waiting on something else", async () => {
    // The hand-over is read under the same hold that writes the change, not by
    // the caller beforehand: in between, the merchant's answer can land or
    // another delivery of the reminder can act. A redelivery decided on a stale
    // hand-over spends one of the order's five attempts on a silence that never
    // happened, and the closure at that cap on a paid order is a debt. The
    // cleared hand-over is held back with the event too: writing it would drop
    // the hand-over the order is actually waiting on.
    open = await harness({ HANDLER_ANSWER_MS: "60000", DEFAULT_ASYNC_FULFILLMENT_MS: "60000" });
    const { orderId, handOver } = await handedOver(open);

    const applied = await open.gateway.runner.apply(
      orderId,
      { kind: "handler_undelivered", at: open.now() },
      { openDeliveryId: null },
      undefined,
      `${handOver}-somebody-else`,
    );

    expect(applied.outcome).toBe("moved_on");
    // Nothing on the merchant's stream, and the hand-over the order is actually
    // waiting on is exactly where it was.
    expect(await open.queue.holdsOrder(open.merchant.id, orderId)).toBe(false);
    const after = await open.store.orderById(orderId);
    expect(after?.openDeliveryId).toBe(handOver);
    expect(after?.order.dispatch.attempts).toBe(1);
  });
});

describe("the address a charge is sent to", () => {
  const asyncCard = {
    merchant_item_id: "esim",
    title: "A seven day eSIM",
    description: "Seven days of data",
    price: { amount: "12.00", currency: "USD" },
    result: { activation_code: { type: "string" } },
    fulfillment: "async",
  } as const;

  const quoted = async (harnessed: Harness): Promise<string> => {
    const published = await harnessed.gateway.publishCard(harnessed.merchant.id, asyncCard);
    if (!published.ok) throw new Error("the card would not publish");
    const offered = await harnessed.gateway.beginPurchase(published.id, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    await admitVerifiedOrder(harnessed.gateway, offered.order, {
      owner: "alice",
      payment: "PAY-A",
      fingerprint: "PAY-A",
    });
    return offered.order.order.id;
  };

  it("names the whole sale price when a payment to a split is left unfulfilled", async () => {
    // The merchant refunds the whole price and the commission stays with
    // Agentify, so the event naming the debt names the whole sum.
    open = await harness();
    const orderId = await quoted(open);
    expect((await open.store.orderById(orderId))?.payTo).toBe(
      (await open.store.merchantById(open.merchant.id))?.payoutWallet.split?.address,
    );
    await open.gateway.refuseOrder(open.merchant.id, orderId, {
      code: "out_of_stock",
      message: "the supplier has none",
    });

    const told = await drawEverything(open);
    const owed = told.flatMap((envelope) =>
      envelope.kind === "order_event" && envelope.payload.type === "order.unfulfilled"
        ? [envelope.payload]
        : [],
    );
    expect(owed).toHaveLength(1);
    expect(owed[0]).toMatchObject({ price: { amount: "12.00", currency: "USD" } });
  });
});
