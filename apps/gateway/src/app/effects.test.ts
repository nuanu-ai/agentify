/**
 * The effects written down with the order, and the sweep that finds what
 * slipped anyway.
 *
 * An order must not say the merchant was handed the work, or that a sale was
 * receipted, when the envelope or the receipt was never written. A test cannot
 * kill a process between two writes, so the write that goes with the order is
 * made to refuse, and the order must not have moved without it.
 *
 * The sweep will run more than once, so each of its three arms must do nothing
 * on a second run, for a reason in the data rather than in a memory of having
 * run: the receipt is still there, the overdue order is closed, the envelope is
 * still waiting on the stream. A second envelope is legal on the wire but not
 * free: every hand-over counts against the order's attempt cap, so the tests
 * follow the count as well as the stream.
 */

import type { Order } from "@agentify/core";
import type { Card } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Harness, harness, workOnce } from "../testing/harness.js";
import { SWEEP_EFFECTS, type Swept } from "./runner.js";

/** The address the payments below were verified against; its value does not matter here. */
const PAID_AT = "0x0000000000000000000000000000000000000009";

const asyncCard: Card = {
  merchant_item_id: "esim-7d",
  title: "A seven day eSIM",
  description: "Seven days of data",
  price: { amount: "12.00", currency: "USD" },
  result: { activation_code: { type: "string" } },
  fulfillment: "async",
  fulfill_deadline_seconds: 3_600,
};

const syncCard: Card = {
  merchant_item_id: "room-101",
  title: "A room for the night",
  description: "One night in room 101",
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
};

let open: Harness | null = null;

const started = async (overrides: Record<string, string> = {}) => {
  open = await harness(overrides);
  return open;
};

afterEach(async () => {
  await open?.stop();
  open = null;
});

const published = async (harnessed: Harness, card: Card): Promise<string> => {
  const result = await harnessed.gateway.publishCard(harnessed.merchant.id, card);
  if (!result.ok) throw new Error(`publishing failed: ${JSON.stringify(result.error.problems)}`);
  return result.id;
};

/** An order priced and waiting for a payment. */
const quoted = async (harnessed: Harness, card: Card): Promise<string> => {
  const itemId = await published(harnessed, card);
  const offered = await harnessed.gateway.beginPurchase(itemId, {});
  if (offered.step !== "pay") throw new Error("no price was offered");
  return offered.order.order.id;
};

/**
 * Runs the sweep the way the queue's own scheduler runs it, and hands back what
 * it says it repaired.
 */
const sweep = async (harnessed: Harness): Promise<Swept> => {
  const swept = await runSweep(harnessed);
  if (swept === null) throw new Error("the sweep found another run holding it");
  return swept;
};

/** The same, for a test that expects a run to find somebody else holding it. */
const runSweep = async (harnessed: Harness): Promise<Swept | null> => {
  const work = harnessed.queue.daily.get(SWEEP_EFFECTS);
  if (work === undefined) throw new Error("the gateway registered no sweep of effects");
  return (await work()) as Swept | null;
};

describe("an effect that could not be written down", () => {
  it("leaves no order saying the merchant was handed work he never got", async () => {
    // Otherwise the money moves, the order says paid and nothing reaches the
    // merchant, and no retry repairs it: the state is already past the
    // transition that emits the dispatch.
    const harnessed = await started();
    const orderId = await quoted(harnessed, asyncCard);

    harnessed.queue.stage = async () => {
      throw new Error("the queue would not take the envelope");
    };

    await expect(
      harnessed.gateway.runner.presentVerifiedPayment(
        orderId,
        "alice",
        "PAY-A",
        PAID_AT,
        harnessed.now(),
      ),
    ).rejects.toThrow("the queue would not take the envelope");

    const after = await harnessed.store.orderById(orderId);
    expect(after?.order.state).not.toBe("paid");
  });

  it("leaves no order calling itself delivered with no receipt behind it", async () => {
    // A merchant reconciles a wallet against receipts, so a delivered order
    // without one is a sale invisible to them.
    const harnessed = await started();
    const orderId = await quoted(harnessed, asyncCard);
    await harnessed.gateway.runner.presentVerifiedPayment(
      orderId,
      "alice",
      "PAY-A",
      PAID_AT,
      harnessed.now(),
    );

    harnessed.store.putReceipt = async () => {
      throw new Error("the receipt would not be written");
    };

    await expect(
      workOnce(harnessed, { onOrder: () => ({ delivered: { activation_code: "CODE" } }) }, 0),
    ).rejects.toThrow("the receipt would not be written");

    const after = await harnessed.store.orderById(orderId);
    expect(after?.order.state).not.toBe("delivered");
  });

  it("is the only reason those orders do not move, with nothing broken", async () => {
    // The negative control: both cases above pass trivially if a purchase never
    // reaches those states at all.
    const harnessed = await started();
    const orderId = await quoted(harnessed, asyncCard);

    await harnessed.gateway.runner.presentVerifiedPayment(
      orderId,
      "alice",
      "PAY-A",
      PAID_AT,
      harnessed.now(),
    );

    const after = await harnessed.store.orderById(orderId);
    expect(after?.order.state).toBe("paid");
    const drawn = await harnessed.queue.draw(harnessed.merchant.id, 10, 0);
    expect(drawn.map((delivery) => delivery.envelope.kind)).toStrictEqual(["order"]);
  });
});

describe("the sweep of what an order is still owed", () => {
  it("writes the receipt a delivered order has none of, and writes it once", async () => {
    // A delivered order with no receipt, as a defect could leave one. After the
    // second run the receipt is still the one the first run wrote, identifier
    // and all.
    const harnessed = await started();
    const orderId = await quoted(harnessed, syncCard);
    await harnessed.store.withOrder(orderId, (found) => ({
      save: { ...found, order: deliveredWithMoneyIn(found.order) },
      result: null,
    }));
    expect(await harnessed.store.receiptForOrder(orderId)).toBeNull();

    await sweep(harnessed);
    const written = await harnessed.store.receiptForOrder(orderId);
    expect(written?.outcome).toBe("delivered");
    expect(written?.price.amount).toBe("80.00");

    await sweep(harnessed);
    expect(await harnessed.store.receiptForOrder(orderId)).toStrictEqual(written);
  });

  it("leaves an assertion-only saved charge without a receipt", async () => {
    const harnessed = await started();
    const orderId = await quoted(harnessed, syncCard);
    await harnessed.store.withOrder(orderId, (found) => ({
      save: {
        ...found,
        order: deliveredWithMoneyIn(found.order),
        paymentWords: [
          { about: "settle", at: harnessed.now(), said: "the facilitator was not asked" },
        ],
      },
      result: null,
    }));

    const repaired = await sweep(harnessed);

    expect(repaired.receipted).toBe(0);
    expect(await harnessed.store.receiptForOrder(orderId)).toBeNull();
  });

  it("starts the clock again on an open order whose deadline has passed", async () => {
    // Only a reminder declares an order overdue. A reminder lost to a handler
    // that kept throwing leaves an order nothing will close and a buyer nothing
    // will refund.
    const harnessed = await started();
    const orderId = await quoted(harnessed, asyncCard);
    expect((await harnessed.store.orderById(orderId))?.order.state).toBe("quoted");

    // Past the life of the price. The reminder armed when the order was made
    // waits on real time, none of which passed, so nothing has fired.
    harnessed.advance(harnessed.runtime.config.deadlines.quoteTtlMs + 1_000);

    expect((await sweep(harnessed)).rearmed).toBe(1);
    await vi.waitFor(async () => {
      expect((await harnessed.store.orderById(orderId))?.order.state).toBe("expired");
    });

    // The order is closed, so the second run has nothing to ask about it.
    expect((await sweep(harnessed)).rearmed).toBe(0);
    expect((await harnessed.store.orderById(orderId))?.order.state).toBe("expired");
  });

  it("leaves alone a clock that is still running", async () => {
    // Otherwise every run would re-arm every open order. The machine refuses an
    // early expiry, so the cost is invisible: a queue full of work that can only
    // be refused.
    const harnessed = await started();
    await quoted(harnessed, asyncCard);

    // Still inside the life of the price, unlike the case above.
    harnessed.advance(harnessed.runtime.config.deadlines.quoteTtlMs - 1_000);

    expect(await sweep(harnessed)).toStrictEqual({
      dispatched: 0,
      receipted: 0,
      rearmed: 0,
      refused: 0,
    });
  });

  it("hands a paid order to its merchant again when nobody has taken it", async () => {
    // Left alone, a paid order with nothing on the merchant's stream runs out
    // its fulfillment deadline and turns into a debt nobody meant to owe.
    const harnessed = await started();
    const orderId = await paidWithNothingOnTheStream(harnessed);

    await sweep(harnessed);

    const drawn = await harnessed.queue.draw(harnessed.merchant.id, 10, 0);
    expect(drawn).toHaveLength(1);
    const sent = drawn[0]?.envelope;
    // The order itself, not some other merchant's and not an event about it.
    expect(sent?.kind).toBe("order");
    expect(sent?.kind === "order" ? sent.payload.id : null).toBe(orderId);
  });

  it("leaves alone an order whose envelope is still waiting to be drawn", async () => {
    // Each hand-over counts against the attempt cap, so with a second envelope
    // a merchant merely between polls would find two deliveries spent without
    // having failed one.
    const harnessed = await started();
    const orderId = await quoted(harnessed, asyncCard);
    await harnessed.gateway.runner.presentVerifiedPayment(
      orderId,
      "alice",
      "PAY-A",
      PAID_AT,
      harnessed.now(),
    );

    // Long past the grace period, with the envelope still on the stream.
    harnessed.advance(harnessed.runtime.config.sweepDispatchGraceMs * 10);
    expect((await sweep(harnessed)).dispatched).toBe(0);

    // The merchant comes back and draws once: one hand-over counted.
    await workOnce(harnessed, { onOrder: () => ({ accepted: {} }) }, 0);
    const after = await harnessed.store.orderById(orderId);
    expect(after?.order.state).toBe("dispatched");
    expect(after?.order.dispatch.attempts).toBe(1);
  });

  it("leaves alone an order whose envelope is in a worker's hands", async () => {
    // A drawn envelope is off the stream, and the worker holding it may simply
    // be working on it. That is what the grace period is for.
    const harnessed = await started();
    const orderId = await quoted(harnessed, asyncCard);
    await harnessed.gateway.runner.presentVerifiedPayment(
      orderId,
      "alice",
      "PAY-A",
      PAID_AT,
      harnessed.now(),
    );
    expect(await harnessed.queue.draw(harnessed.merchant.id, 10, 0)).toHaveLength(1);
    expect((await harnessed.store.orderById(orderId))?.order.state).toBe("paid");

    harnessed.advance(harnessed.runtime.config.sweepDispatchGraceMs - 1_000);

    expect((await sweep(harnessed)).dispatched).toBe(0);
    expect(await harnessed.queue.draw(harnessed.merchant.id, 10, 0)).toStrictEqual([]);
  });

  it("never sends a merchant event a second time", async () => {
    // The contract delivers an order at least once and an event at most once.
    // A handler is told to expect a repeated order, not a repeated event, and a
    // debt announced twice is a second refund somebody may act on.
    const harnessed = await started();
    const orderId = await quoted(harnessed, asyncCard);
    await harnessed.gateway.runner.presentVerifiedPayment(
      orderId,
      "alice",
      "PAY-A",
      PAID_AT,
      harnessed.now(),
    );

    // The fulfillment deadline runs out, so the money is owed back and the
    // merchant is told once.
    harnessed.advance(harnessed.runtime.config.deadlines.defaultAsyncFulfillmentMs + 1_000);
    await harnessed.gateway.runner.apply(orderId, {
      kind: "deadline_expired",
      at: harnessed.now(),
      deadline: "async_fulfillment",
    });
    expect((await harnessed.store.orderById(orderId))?.order.state).toBe("unfulfilled");

    // Drain the stream, as a running worker would.
    const said = await harnessed.queue.draw(harnessed.merchant.id, 10, 0);
    expect(said.map((delivery) => delivery.envelope.kind)).toContain("order_event");

    // From here nothing may put that debt on the stream again.
    await sweep(harnessed);
    await sweep(harnessed);
    expect(await harnessed.queue.draw(harnessed.merchant.id, 10, 0)).toStrictEqual([]);
  });

  it("stops asking once the merchant has actually taken it", async () => {
    // The order's own state makes the second run a no-op: the worker moved it
    // out of paid, and the sweep asks only about paid orders.
    const harnessed = await started();
    const orderId = await paidWithNothingOnTheStream(harnessed);

    await sweep(harnessed);
    await workOnce(harnessed, { onOrder: () => ({ accepted: {} }) }, 0);
    expect((await harnessed.store.orderById(orderId))?.order.state).toBe("dispatched");

    await sweep(harnessed);
    expect(await harnessed.queue.draw(harnessed.merchant.id, 10, 0)).toStrictEqual([]);
  });

  it("lets only one run happen at a time, whatever starts it", async () => {
    // Two concurrent runs would both find the order unheld and both send it,
    // the double hand-over the sweep exists to avoid; the receipt arm races the
    // same way. The overlap is real across processes: a run that outlasts the
    // queue's job expiry is failed and retried, and another process's worker
    // takes it while the first is still going. Starting two by hand reproduces
    // that in one process.
    const harnessed = await started();
    const orderId = await paidWithNothingOnTheStream(harnessed);

    const [first, second] = await Promise.all([runSweep(harnessed), runSweep(harnessed)]);

    // One ran and one found the work already in hand; which is which is a race.
    const ran = [first, second].filter((swept) => swept !== null);
    expect(ran).toHaveLength(1);
    expect(ran[0]?.dispatched).toBe(1);

    const drawn = await harnessed.queue.draw(harnessed.merchant.id, 10, 0);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]?.envelope.kind === "order" ? drawn[0]?.envelope.payload.id : null).toBe(
      orderId,
    );
  });

  it("does nothing at all on the second run, with nobody drawing in between", async () => {
    // The first run's envelope is still waiting, so the second run must do
    // nothing at all rather than repeat harmlessly, and the merchant who finally
    // polls is handed the order once.
    const harnessed = await started();
    const orderId = await paidWithNothingOnTheStream(harnessed);

    expect((await sweep(harnessed)).dispatched).toBe(1);
    expect(await sweep(harnessed)).toStrictEqual({
      dispatched: 0,
      receipted: 0,
      rearmed: 0,
      refused: 0,
    });

    const answered = await workOnce(
      harnessed,
      { onOrder: () => ({ delivered: { activation_code: "CODE" } }) },
      0,
    );
    expect(answered).toBe(1);

    const after = await harnessed.store.orderById(orderId);
    expect(after?.order.state).toBe("delivered");
    expect(after?.order.dispatch.attempts).toBe(1);
    expect(after?.delivery).toStrictEqual({ activation_code: "CODE" });
    expect((await harnessed.store.receiptForOrder(orderId))?.outcome).toBe("delivered");
  });
});

/**
 * An order paid for past the grace period, with nothing on its merchant's
 * stream. The envelope is drawn and thrown away because the gateway commits it
 * with the order and cannot be made to skip it.
 */
async function paidWithNothingOnTheStream(harnessed: Harness): Promise<string> {
  const orderId = await quoted(harnessed, asyncCard);
  await harnessed.gateway.runner.presentVerifiedPayment(
    orderId,
    "alice",
    "PAY-A",
    PAID_AT,
    harnessed.now(),
  );
  const lost = await harnessed.queue.draw(harnessed.merchant.id, 10, 0);
  expect(lost).toHaveLength(1);

  harnessed.advance(harnessed.runtime.config.sweepDispatchGraceMs + 1_000);
  return orderId;
}

/**
 * The same order, delivered and paid for, built by hand: the gateway itself
 * cannot produce a delivered order with no receipt, which is the record the
 * sweep exists for.
 */
function deliveredWithMoneyIn(order: Order): Order {
  return {
    ...order,
    state: "delivered",
    payment: "settled",
    closure: null,
    timestamps: { ...order.timestamps, paidAt: order.timestamps.quotedAt },
  };
}
