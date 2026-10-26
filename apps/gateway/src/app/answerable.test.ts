/**
 * Which unfulfilled orders a merchant answers for, decided once as an order
 * becomes unfulfilled and kept on it: the stop on a merchant's sales counts
 * these and nothing else. A merchant answers for an order they were given:
 * one their own code was handed, or one they refused themselves, or, for a
 * WooCommerce shop, a parcel the shop took on. Agentify's own failures, the
 * shop connector's refusals and downloads it fills itself among them, are
 * never the merchant's.
 */

import {
  type Card,
  CardSchema,
  type QuoteResponse,
  type ShipTo,
} from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { Integration } from "../ports/store.js";
import { type Harness, harness, workOnce, workUntilStopped } from "../testing/harness.js";
import { anOrder } from "../testing/store-contract.js";

/** A card charged at the purchase, its goods to follow within a second. */
const prepaidCard: Card = CardSchema.parse({
  merchant_item_id: "esim-30d",
  title: "A thirty day eSIM",
  description: "Thirty days of data in Indonesia",
  price: { amount: "25.00", currency: "USD" },
  result: { activation_code: { type: "string" } },
  fulfillment: "async",
  fulfill_deadline_seconds: 1,
});

/** A parcel whose price its shop is asked, shipped within a day. */
const parcelCard: Card = CardSchema.parse({
  merchant_item_id: "beans-1kg",
  title: "Coffee beans, one kilogram",
  description: "Roasted in Bali this week and sent by courier.",
  price: { amount: "18.00", currency: "USD" },
  fulfillment: "ship",
  ship_within_seconds: 86_400,
  price_check: "handler",
});

/** An address in a real place, with the person and the number taken out of it. */
const address: ShipTo = {
  name: "The buyer",
  line_one: "Jl. Raya Kediri, Beraban",
  city: "Tabanan",
  state: "BA",
  postal_code: "82121",
  country: "ID",
  phone_number: "+62 000 0000 0000",
};

const priced: QuoteResponse = {
  available: true,
  price: { amount: "18.00", currency: "USD" },
  as_of: "2026-08-26T10:15:00Z",
};

const REFUSAL = { code: "out_of_stock", message: "the supplier has none" } as const;

let open: Harness | null = null;

afterEach(async () => {
  await open?.stop();
  open = null;
});

const started = async (): Promise<Harness> => {
  open = await harness();
  return open;
};

/** A paid order of `card`, sold through `through`, before anything is done with it. */
const paidOrder = async (harnessed: Harness, card: Card, through: Integration): Promise<string> => {
  const merchantId = harnessed.merchant.id;
  await harnessed.store.switchIntegration(merchantId, through);
  const itemId = (await harnessed.store.publishCard(merchantId, card, harnessed.now(), through)).id;
  const parcel = card.fulfillment === "ship";
  const worker = workUntilStopped(harnessed, { onQuote: () => priced, through });
  const offered = await harnessed.gateway.beginPurchase(itemId, {}, parcel ? address : undefined);
  await worker.stop();
  if (offered.step !== "pay") throw new Error(`no price was named: ${offered.step}`);
  const orderId = offered.order.order.id;
  await harnessed.gateway.payPurchase(
    orderId,
    `PAYMENT-${orderId}`,
    `fp-${orderId}`,
    parcel ? address : undefined,
  );
  return orderId;
};

/** The merchant's process, or the shop's connector, draws the order without answering it. */
const handOver = async (harnessed: Harness, through: Integration): Promise<void> => {
  await workOnce(harnessed, { through }, 0);
};

/** The order's deadline to deliver or ship passes. */
const missed = async (harnessed: Harness, orderId: string, parcel = false): Promise<void> => {
  harnessed.advance(parcel ? 86_401_000 : 2_000);
  await harnessed.gateway.runner.apply(orderId, {
    kind: "deadline_expired",
    at: harnessed.now(),
    deadline: "async_fulfillment",
  });
};

const stored = async (harnessed: Harness, orderId: string) => {
  const record = await harnessed.store.orderById(orderId);
  if (record === null) throw new Error(`the order ${orderId} went missing`);
  return record;
};

describe("a merchant's own code", () => {
  it("answers for an order it was handed and refused", async () => {
    const harnessed = await started();
    const orderId = await paidOrder(harnessed, prepaidCard, "api");
    await workOnce(harnessed, { onOrder: () => ({ refused: REFUSAL }) }, 0);

    const record = await stored(harnessed, orderId);
    expect(record.order.state).toBe("unfulfilled");
    expect(record.answerable).toBe(true);
  });

  it("answers for an order its merchant refused by a call before it was handed over", async () => {
    const harnessed = await started();
    const orderId = await paidOrder(harnessed, prepaidCard, "api");
    await harnessed.gateway.refuseOrder(harnessed.merchant.id, orderId, REFUSAL);

    const record = await stored(harnessed, orderId);
    expect(record.order.state).toBe("unfulfilled");
    expect(record.answerable).toBe(true);
  });

  it("answers for an order it was handed and let run past its deadline", async () => {
    const harnessed = await started();
    const orderId = await paidOrder(harnessed, prepaidCard, "api");
    await handOver(harnessed, "api");
    await missed(harnessed, orderId);

    const record = await stored(harnessed, orderId);
    expect(record.order.state).toBe("unfulfilled");
    expect(record.answerable).toBe(true);
  });

  it("does not answer for an order never handed over before its deadline", async () => {
    // Nothing records why the hand-over did not happen, and Agentify failing
    // to make it is one of the reasons.
    const harnessed = await started();
    const orderId = await paidOrder(harnessed, prepaidCard, "api");
    await missed(harnessed, orderId);

    const record = await stored(harnessed, orderId);
    expect(record.order.state).toBe("unfulfilled");
    expect(record.answerable).toBe(false);
  });

  it("is not decided for an order that was unfulfilled before the fact was kept, whatever happens to it later", async () => {
    // Such an order counts for nobody: what made it unfulfilled is no longer
    // on hand to decide by.
    const harnessed = await started();
    const merchantId = harnessed.merchant.id;
    const itemId = (await harnessed.store.publishCard(merchantId, prepaidCard, harnessed.now())).id;
    const base = anOrder("ord_before", "unfulfilled", { merchantId });
    await harnessed.store.addOrder({
      ...base,
      itemId,
      order: {
        ...base.order,
        payment: "settled",
        closure: { cause: "merchant_refused", ...REFUSAL },
        timestamps: { ...base.order.timestamps, dispatchedAt: 2_000 },
      },
    });

    await harnessed.gateway.refuseOrder(merchantId, "ord_before", REFUSAL);

    expect((await stored(harnessed, "ord_before")).answerable).toBeUndefined();
  });

  it("keeps nothing of it once the order is delivered late", async () => {
    const harnessed = await started();
    const orderId = await paidOrder(harnessed, prepaidCard, "api");
    await harnessed.gateway.refuseOrder(harnessed.merchant.id, orderId, REFUSAL);

    await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, {
      activation_code: "LATE-1",
    });

    const record = await stored(harnessed, orderId);
    expect(record.order.state).toBe("delivered");
    expect(record.answerable).toBeUndefined();
  });
});

describe("a WooCommerce shop", () => {
  it("answers for a parcel the shop took on and did not ship in time", async () => {
    const harnessed = await started();
    const orderId = await paidOrder(harnessed, parcelCard, "woocommerce");
    await handOver(harnessed, "woocommerce");
    await harnessed.gateway.acceptOrder(harnessed.merchant.id, orderId, {});
    await missed(harnessed, orderId, true);

    const record = await stored(harnessed, orderId);
    expect(record.order.state).toBe("unfulfilled");
    expect(record.answerable).toBe(true);
  });

  it("does not answer for a parcel the connector refused before the shop's order was made", async () => {
    const harnessed = await started();
    const orderId = await paidOrder(harnessed, parcelCard, "woocommerce");
    await handOver(harnessed, "woocommerce");
    await harnessed.gateway.refuseOrder(harnessed.merchant.id, orderId, REFUSAL);

    const record = await stored(harnessed, orderId);
    expect(record.order.state).toBe("unfulfilled");
    expect(record.answerable).toBe(false);
  });

  it("does not answer for a download the connector was handed and did not deliver", async () => {
    // The connector delivers a download itself, inside Agentify.
    const harnessed = await started();
    const orderId = await paidOrder(harnessed, prepaidCard, "woocommerce");
    await handOver(harnessed, "woocommerce");
    await missed(harnessed, orderId);

    const record = await stored(harnessed, orderId);
    expect(record.order.state).toBe("unfulfilled");
    expect(record.answerable).toBe(false);
  });
});
