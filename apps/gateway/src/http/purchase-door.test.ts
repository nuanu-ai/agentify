/**
 * What a purchase meets at the door, before any price is asked and before
 * anything is charged: how many of one seller's purchases may wait for payment
 * at once.
 *
 * Each test puts its card in the store directly, so that a test is about the
 * purchase and not the publishing door.
 */

import { type Card, CardSchema, type QuoteResponse } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { Integration } from "../ports/store.js";
import { type Harness, harness, type Served, serve, workUntilStopped } from "../testing/harness.js";

/** A card whose price its seller is asked at every purchase, as a shop's always is. */
const pricedCard: Card = CardSchema.parse({
  merchant_item_id: "esim-7d",
  title: "A seven day eSIM",
  description: "Seven days of data in Indonesia",
  price: { amount: "12.00", currency: "USD" },
  result: { activation_code: { type: "string" } },
  fulfillment: "async",
  fulfill_deadline_seconds: 3_600,
  price_check: "handler",
});

const priced: QuoteResponse = {
  available: true,
  price: { amount: "12.00", currency: "USD" },
  as_of: "2026-08-26T10:15:00Z",
};

interface Refused {
  readonly error: { readonly code: string; readonly message: string; readonly retryable: boolean };
}

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
  return { harnessed, served };
};

/** One of this merchant's cards, published through the integration they sell through. */
const sellingThrough = async (
  harnessed: Harness,
  merchantId: string,
  through: Integration,
): Promise<string> => {
  await harnessed.store.switchIntegration(merchantId, through);
  const stored = await harnessed.store.publishCard(
    merchantId,
    pricedCard,
    harnessed.now(),
    through,
  );
  return stored.id;
};

/** Twenty purchases priced and left unpaid, the seller answering each price. */
const twentyWaiting = async (
  harnessed: Harness,
  served: Served,
  itemId: string,
  merchantId: string,
  through: Integration,
) => {
  const worker = workUntilStopped(harnessed, { onQuote: () => priced, merchantId, through });
  try {
    for (let one = 0; one < 20; one += 1) {
      const answered = await served.call("POST", `/x402/${itemId}/purchase`, {
        body: { params: {} },
      });
      expect(answered.status).toBe(402);
    }
  } finally {
    await worker.stop();
  }
};

describe("purchases waiting for payment", () => {
  it.each<Integration>(["api", "woocommerce"])(
    "refuse the twenty-first, through %s, before the seller or their shop is asked its price",
    async (through) => {
      const { harnessed, served } = await started();
      const merchantId = harnessed.merchant.id;
      const itemId = await sellingThrough(harnessed, merchantId, through);
      await twentyWaiting(harnessed, served, itemId, merchantId, through);

      const refused = await served.call("POST", `/x402/${itemId}/purchase`, {
        body: { params: {} },
      });

      expect(refused.status).toBe(429);
      expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
      const { error } = refused.body as Refused;
      expect(error.code).toBe("seller_busy");
      expect(error.retryable).toBe(true);
      expect(error.message).toContain("nothing was charged");
      expect(error.message).toContain("a few seconds");
      // No price question went to the seller's stream, which is the only way a
      // question reaches their code or the connector that asks their shop.
      expect(await harnessed.queue.draw(merchantId, 100, 0)).toStrictEqual([]);
      expect(await harnessed.store.orders(merchantId)).toHaveLength(20);
    },
  );

  it("let a purchase through again once one of the twenty has lapsed unpaid", async () => {
    const { harnessed, served } = await started();
    const merchantId = harnessed.merchant.id;
    const itemId = await sellingThrough(harnessed, merchantId, "api");
    await twentyWaiting(harnessed, served, itemId, merchantId, "api");
    const [first] = await harnessed.store.orders(merchantId);
    if (first === undefined) throw new Error("no purchase was waiting");

    harnessed.advance(31_000);
    await harnessed.gateway.runner.apply(first.order.id, {
      kind: "deadline_expired",
      at: harnessed.now(),
      deadline: "quote_expiry",
    });
    const worker = workUntilStopped(harnessed, { onQuote: () => priced });
    const answered = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
    });
    await worker.stop();

    expect(answered.status).toBe(402);
  });

  it("are counted for each seller apart, so one seller's twenty hold up nobody else", async () => {
    const { harnessed, served } = await started();
    const busy = harnessed.merchant.id;
    const busyItem = await sellingThrough(harnessed, busy, "api");
    await twentyWaiting(harnessed, served, busyItem, busy, "api");
    const other = await harnessed.addMerchant();
    const otherItem = await sellingThrough(harnessed, other.id, "api");

    const worker = workUntilStopped(harnessed, { onQuote: () => priced, merchantId: other.id });
    const answered = await served.call("POST", `/x402/${otherItem}/purchase`, {
      body: { params: {} },
    });
    await worker.stop();

    expect(answered.status).toBe(402);
  });
});
