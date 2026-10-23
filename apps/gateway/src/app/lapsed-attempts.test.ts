/**
 * A purchase that ended with nothing charged and nothing held for its buyer is
 * a record of an attempt, and it is forgotten thirty days after it ended by the
 * gateway's daily work. Orders that hold money or goods are never forgotten.
 */

import { type Card, CardSchema } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  buyOverHttp,
  type Harness,
  harness,
  type Served,
  serve,
  statusPathOf,
} from "../testing/harness.js";
import { anOrder } from "../testing/store-contract.js";

const syncCard: Card = CardSchema.parse({
  merchant_item_id: "room-101",
  title: "A room for the night",
  description: "One night in room 101",
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
});

const DAY = 86_400_000;

let open: { harnessed: Harness; served: Served } | null = null;

afterEach(async () => {
  await open?.served.close();
  await open?.harnessed.stop();
  open = null;
});

const started = async () => {
  const harnessed = await harness();
  const served = await serve(harnessed);
  open = { harnessed, served };
  const stored = await harnessed.store.publishCard(
    harnessed.merchant.id,
    syncCard,
    harnessed.now(),
  );
  return { harnessed, served, itemId: stored.id };
};

/** A purchase priced and never paid, ended when its price ran out. */
const lapsedUnpaid = async (harnessed: Harness, itemId: string): Promise<string> => {
  const offered = await harnessed.gateway.beginPurchase(itemId, {});
  if (offered.step !== "pay") throw new Error(`no price was named: ${offered.step}`);
  harnessed.advance(31_000);
  await harnessed.gateway.runner.apply(offered.order.order.id, {
    kind: "deadline_expired",
    at: harnessed.now(),
    deadline: "quote_expiry",
  });
  const lapsed = await harnessed.store.orderById(offered.order.order.id);
  expect(lapsed?.order.state).toBe("expired");
  return offered.order.order.id;
};

/** Everything the gateway does once a day, as the queue would run it. */
const theDailyWork = async (harnessed: Harness): Promise<void> => {
  for (const work of harnessed.queue.daily.values()) {
    await work();
  }
};

/** The status address an order's buyer holds, read while the order is still there. */
const addressOf = (harnessed: Harness, orderId: string): Promise<string> =>
  statusPathOf(harnessed, orderId);

describe("a purchase that lapsed unpaid", () => {
  it("is gone thirty days after it ended and its status reads as an unknown order's, while a paid order of the same age stays", async () => {
    const { harnessed, served, itemId } = await started();
    const lapsed = await lapsedUnpaid(harnessed, itemId);
    const bought = await buyOverHttp(harnessed, served, itemId, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    const paid = (bought.body as { order_id: string }).order_id;
    const [lapsedAt, paidAt] = [
      await addressOf(harnessed, lapsed),
      await addressOf(harnessed, paid),
    ];

    harnessed.advance(30 * DAY + 60_000);
    await theDailyWork(harnessed);

    expect(await harnessed.store.orderById(lapsed)).toBeNull();
    const unknown = await served.call("GET", lapsedAt.replace(/bk_[^/]+/, "bk_never_made"));
    const forgotten = await served.call("GET", lapsedAt);
    expect(forgotten.status).toBe(unknown.status);
    expect(forgotten.body).toStrictEqual(unknown.body);
    expect((await served.call("GET", paidAt)).status).toBe(200);
    expect(await harnessed.store.receiptForOrder(paid)).not.toBeNull();
  });

  it("is kept until thirty days have passed since it ended", async () => {
    const { harnessed, served, itemId } = await started();
    const lapsed = await lapsedUnpaid(harnessed, itemId);

    harnessed.advance(29 * DAY);
    await theDailyWork(harnessed);

    expect(await harnessed.store.orderById(lapsed)).not.toBeNull();
    expect((await served.call("GET", await addressOf(harnessed, lapsed))).status).toBe(200);
  });
});

describe("many purchases that lapsed unpaid", () => {
  it("are all gone after one day's work, however many more there are than one statement forgets", async () => {
    const { harnessed } = await started();
    for (let one = 0; one < 1_201; one += 1) {
      await harnessed.store.addOrder(
        anOrder(`ord_lapsed_${one}`, "expired", { merchantId: harnessed.merchant.id }),
      );
    }

    harnessed.advance(30 * DAY + 60_000);
    await theDailyWork(harnessed);

    expect(await harnessed.store.orders(harnessed.merchant.id)).toStrictEqual([]);
  });
});
