/**
 * Where an order's buyer key travels: to the agent that bought, inside the
 * `status_url` of the purchase answer and of the status document, and nowhere
 * else. The merchant's views of the order, the worker's envelopes, receipts,
 * the payment requirements and what the payment layer is sent all carry the
 * order's identifier, which opens nothing, and never the key, which opens the
 * goods. A field added to any of them that copied the key would hand the
 * buyer's goods to whoever reads the merchant's systems.
 */

import { type AgentOrderStatus, API_ROUTES, type Card } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { randomIds } from "../ports/clock.js";
import {
  buyOverHttp,
  type Harness,
  harness,
  type Served,
  serve,
  theMerchantKey,
} from "../testing/harness.js";
import { PAYMENT_REQUIRED_HEADER } from "./x402.js";

const PAY_TO = "0x0000000000000000000000000000000000000001";

const laterCard: Card = {
  merchant_item_id: "esim-30d",
  title: "An eSIM for thirty days",
  description: "Thirty days of data, delivered to the address given at purchase",
  price: { amount: "80.00", currency: "USD" },
  result: { activation_code: { type: "string" } },
  fulfillment: "async",
  fulfill_deadline_seconds: 3_600,
};

let open: { harnessed: Harness; served: Served } | null = null;

afterEach(async () => {
  await open?.served.close();
  await open?.harnessed.stop();
  open = null;
});

const merchantHeaders = () => ({ authorization: `Bearer ${theMerchantKey("test")}` });

/** The key in a status address: the one path segment the route table puts it in. */
const keyIn = (address: string): string => {
  const segments = new URL(address).pathname.split("/");
  const at = API_ROUTES.get_order_status.path.split("/").indexOf(":buyer_key");
  return decodeURIComponent(segments[at] ?? "");
};

describe("the buyer's key", () => {
  it("reaches the agent that bought and no view of the merchant's, no envelope, no receipt and nothing the payment side is sent", async () => {
    const harnessed = await harness({ PAY_TO_ADDRESS: PAY_TO });
    const served = await serve(harnessed);
    open = { harnessed, served };
    const published = await served.call("POST", "/v0/catalog/publish", {
      body: laterCard,
      headers: merchantHeaders(),
    });
    const itemId = (published.body as { id: string }).id;

    const envelopes: unknown[] = [];
    const challenge = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
    });
    const bought = await buyOverHttp(harnessed, served, itemId, {
      onOrder: (order) => {
        envelopes.push(order);
        return { accepted: {} };
      },
    });
    expect(bought.status, JSON.stringify(bought.body)).toBe(200);
    const { order_id: orderId, status_url: address } = bought.body as AgentOrderStatus;
    const key = keyIn(address);
    expect(key).toMatch(/^bk_/);

    const delivered = await served.call("POST", `/v0/orders/${orderId}/deliver`, {
      body: { activation_code: "LPA:1$example.com$ACTIVATE" },
      headers: merchantHeaders(),
    });
    expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
    const collected = await served.call("GET", new URL(address).pathname);
    expect((collected.body as AgentOrderStatus).status_url).toBe(address);

    const merchantSees = {
      order: (await served.call("GET", `/v0/orders/${orderId}`, { headers: merchantHeaders() }))
        .body,
      orders: (await served.call("GET", "/v0/orders", { headers: merchantHeaders() })).body,
      receipts: (await served.call("GET", "/v0/receipts", { headers: merchantHeaders() })).body,
      delivered: delivered.body,
      envelopes,
    };
    const paymentSideSees = {
      challenge: Buffer.from(
        challenge.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
        "base64",
      ).toString("utf8"),
      verified: harnessed.facilitator.verifies,
      charged: harnessed.facilitator.settles,
    };

    // The views are read, not empty: the order is in every one of them.
    expect(JSON.stringify(merchantSees.order)).toContain(orderId);
    expect(JSON.stringify(merchantSees.receipts)).toContain(orderId);
    expect(JSON.stringify(merchantSees.envelopes)).toContain(orderId);
    expect(paymentSideSees.verified).not.toHaveLength(0);
    expect(JSON.stringify(merchantSees)).not.toContain(key);
    expect(JSON.stringify(paymentSideSees)).not.toContain(key);
    expect(JSON.stringify(harnessed.store.recordedAnalytics)).not.toContain(key);
  });
});

/** Whether `a` and `b` share any run of `length` characters. */
const shareARun = (a: string, b: string, length: number): boolean => {
  for (let at = 0; at + length <= a.length; at += 1) {
    if (b.includes(a.slice(at, at + length))) return true;
  }
  return false;
};

describe("the buyer's key, as production issues it", () => {
  it("cannot be worked out from the order's identifier, or from another order's key", async () => {
    // The identifier reaches the merchant, their shop, their logs and the
    // payment side. A key derived from it, or counted along with the orders,
    // would let whoever holds an identifier, or a key of their own, open
    // somebody else's goods.
    const harnessed = await harness({ PAY_TO_ADDRESS: PAY_TO }, { ids: randomIds });
    open = { harnessed, served: await serve(harnessed) };
    const published = await harnessed.gateway.publishCard(harnessed.merchant.id, laterCard);
    if (!published.ok) throw new Error("the card would not publish");

    const orders: { readonly id: string; readonly key: string }[] = [];
    for (let made = 0; made < 5; made += 1) {
      const offered = await harnessed.gateway.beginPurchase(published.id, {});
      if (offered.step !== "pay") throw new Error(`no price was offered: ${offered.step}`);
      orders.push({ id: offered.order.order.id, key: offered.order.buyerKey });
    }

    const randomPart = (value: string) => value.slice(value.indexOf("_") + 1);
    for (const { id, key } of orders) {
      expect(key).toMatch(/^bk_[0-9a-f]{32}$/);
      expect(shareARun(randomPart(key), randomPart(id), 8), `${key} beside ${id}`).toBe(false);
    }
    for (const [at, { key }] of orders.entries()) {
      for (const { key: other } of orders.slice(at + 1)) {
        expect(shareARun(randomPart(key), randomPart(other), 8), `${key} beside ${other}`).toBe(
          false,
        );
        const apart = BigInt(`0x${randomPart(key)}`) - BigInt(`0x${randomPart(other)}`);
        expect(apart < 0n ? -apart : apart).toBeGreaterThan(2n ** 64n);
      }
    }
  });
});
