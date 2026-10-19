/**
 * What a payment names its order by. The payment requirements go to the
 * payment facilitator on every verification and charge, and a discovery
 * listing can publish them as the last paying request carried them, so they
 * name the order by a payment reference that opens nothing. The order's
 * identifier, the key to the order and its goods, is in none of it.
 */

import type { Card } from "@nuanu-ai/agentify-contracts";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryQueue } from "../adapters/memory/queue.js";
import { MemoryStore } from "../adapters/memory/store.js";
import { X402Facilitator } from "../adapters/x402/facilitator.js";
import { Gateway } from "../app/gateway.js";
import { setPayoutWallet, setServiceName } from "../app/merchants.js";
import { nobodyAnnounces } from "../ports/announcer.js";
import { randomIds } from "../ports/clock.js";
import {
  type Harness,
  harness,
  type Served,
  serve,
  testConfig,
  workUntilStopped,
} from "../testing/harness.js";
import {
  PAYMENT_REF_IN_EXTRA,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  PaymentEdge,
  widestChallengeOn,
} from "./x402.js";

const PAY_TO = "0x0000000000000000000000000000000000000001";
const BUYER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const STRANGER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const syncCard: Card = {
  merchant_item_id: "room-101",
  title: "A room for the night",
  description: "One night in room 101",
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
};

const asyncCard: Card = {
  ...syncCard,
  merchant_item_id: "esim-7-days",
  title: "A seven day eSIM",
  description: "Seven days of data, activated by code",
  fulfillment: "async",
};

/** The whole of a header, decoded from base64 and nothing more, so no field is left unread. */
const plainly = (header: string): string => Buffer.from(header, "base64").toString("utf8");

/** The reference a challenge names its order by, or undefined where it names none. */
const referenceIn = (challenge: string): unknown =>
  decodePaymentRequiredHeader(challenge).accepts[0]?.extra?.[PAYMENT_REF_IN_EXTRA];

/**
 * What an x402 client sends back: the offer it accepted, the resource and the
 * extensions it was offered, and an authorisation signed by `from`.
 */
const paymentAgainst = (challenge: string, from: string, nonce: string): string => {
  const offered = decodePaymentRequiredHeader(challenge);
  const accepted = offered.accepts[0];
  if (accepted === undefined) throw new Error("the challenge offered no way to pay");
  return encodePaymentSignatureHeader({
    x402Version: offered.x402Version,
    resource: offered.resource,
    accepted,
    ...(offered.extensions === undefined ? {} : { extensions: offered.extensions }),
    payload: {
      signature: `0xsigned${nonce.slice(2)}`,
      authorization: {
        from,
        to: accepted.payTo,
        value: accepted.amount,
        validAfter: "0",
        validBefore: String(Math.floor(Date.now() / 1_000) + 3_600),
        nonce,
      },
    },
  });
};

/** A facilitator that says yes to everything and keeps, whole, everything it was sent. */
class Recording implements FacilitatorClient {
  readonly sent: string[] = [];

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    this.sent.push(JSON.stringify({ verify: { payload, requirements } }));
    return { isValid: true };
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    this.sent.push(JSON.stringify({ settle: { payload, requirements } }));
    return { success: true, transaction: "0xtx", network: requirements.network };
  }

  async getSupported(): Promise<SupportedResponse> {
    return { kinds: [], extensions: [], signers: {} };
  }
}

/**
 * A gateway whose payments go through the facilitator adapter production uses,
 * with only the network behind it swapped, and identifiers as production
 * issues them, so an identifier found in a call is that order's and no other's.
 */
async function aGatewayPayingThrough(network: FacilitatorClient) {
  const config = testConfig({ PAY_TO_ADDRESS: PAY_TO });
  const queue = new MemoryQueue();
  const store = new MemoryStore(config.payment.network, randomIds, Date.now, queue.envelopes());
  const gateway = new Gateway({
    config,
    store,
    queue,
    facilitator: new X402Facilitator(network, new PaymentEdge(config)),
    clock: Date.now,
    ids: randomIds,
    announcer: nobodyAnnounces,
    widestChallenge: widestChallengeOn(config),
  });
  await gateway.start();

  const merchant = {
    id: "mch_paid_through_the_network",
    name: "The network's merchant",
    key: "unused: this merchant's cards are published directly",
    keyId: "unused",
    wallet: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
  };
  await store.addMerchant({ id: merchant.id, name: merchant.name }, Date.now());
  await setServiceName(store, merchant.id, merchant.name, Date.now());
  await setPayoutWallet(store, config.payoutSplit, merchant.id, merchant.wallet, Date.now());
  const served = await serve({ gateway });

  return {
    gateway,
    merchant,
    served,
    async publish(card: Card): Promise<string> {
      const published = await gateway.publishCard(merchant.id, card);
      if (!published.ok)
        throw new Error(`the card would not publish: ${JSON.stringify(published)}`);
      return published.id;
    },
    async close() {
      await served.close();
      await gateway.stop();
    },
  };
}

let open: { harnessed: Harness; served: Served } | null = null;

const started = async () => {
  const harnessed = await harness({ PAY_TO_ADDRESS: PAY_TO });
  const served = await serve(harnessed);
  open = { harnessed, served };
  return open;
};

afterEach(async () => {
  await open?.served.close();
  await open?.harnessed.stop();
  open = null;
});

const publish = async (harnessed: Harness, card: Card): Promise<string> => {
  const published = await harnessed.gateway.publishCard(harnessed.merchant.id, card);
  if (!published.ok) throw new Error("the card would not publish");
  return published.id;
};

const challengeFor = async (served: Served, itemId: string): Promise<string> => {
  const priced = await served.call("POST", `/x402/${itemId}/purchase`, { body: { params: {} } });
  expect(priced.status).toBe(402);
  return priced.headers.get(PAYMENT_REQUIRED_HEADER) ?? "";
};

const present = (served: Served, itemId: string, payment: string) =>
  served.call("POST", `/x402/${itemId}/purchase`, {
    body: { params: {} },
    headers: { [PAYMENT_SIGNATURE_HEADER]: payment },
  });

describe("the order's identifier on the payment side", () => {
  it.each([
    ["delivered in the answer", syncCard],
    ["delivered later", asyncCard],
  ])("is in no challenge, payment or facilitator call for a product %s", async (_mode, card) => {
    const network = new Recording();
    const gateway = await aGatewayPayingThrough(network);
    const worker = workUntilStopped(gateway, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    try {
      const itemId = await gateway.publish(card);
      const challenge = await challengeFor(gateway.served, itemId);
      const payment = paymentAgainst(challenge, BUYER, "0x01");

      const bought = await present(gateway.served, itemId, payment);

      expect(bought.status).toBe(200);
      const orderId = (bought.body as { order_id: string }).order_id;
      // The identifier is a real one: it opens the order.
      const status = await gateway.served.call("GET", `/x402/orders/${orderId}/status`);
      expect(status.status).toBe(200);
      // Verified, then charged: two calls, and each carried the reference.
      expect(network.sent).toHaveLength(2);
      const reference = referenceIn(challenge);
      expect(typeof reference).toBe("string");
      for (const sent of [plainly(challenge), plainly(payment), ...network.sent]) {
        expect(sent).toContain(String(reference));
        expect(sent).not.toContain(orderId);
      }
    } finally {
      await worker.stop();
      await gateway.close();
    }
  });
});

describe("a payment reference", () => {
  it("binds a payment to the order whose challenge carried it", async () => {
    // Two orders for one card are open at once; the payment is for the second.
    const { harnessed, served } = await started();
    const itemId = await publish(harnessed, asyncCard);
    await challengeFor(served, itemId);
    const [first] = await harnessed.store.orders(harnessed.merchant.id);
    const second = await challengeFor(served, itemId);

    const bought = await present(served, itemId, paymentAgainst(second, BUYER, "0x01"));

    expect(bought.status).toBe(200);
    const paidFor = (bought.body as { order_id: string }).order_id;
    expect(paidFor).not.toBe(first?.order.id);
    expect((await harnessed.store.orderById(paidFor))?.paymentRef).toBe(referenceIn(second));
    expect((await harnessed.store.orderById(first?.order.id ?? ""))?.order.state).toBe("quoted");
  });

  it("is the only thing a payment is bound by: one naming its order's identifier pays nothing", async () => {
    // No fallback to the identifier: a payment that names an order the old
    // way is a payment for no order, and gets a fresh price.
    const { harnessed, served } = await started();
    const itemId = await publish(harnessed, asyncCard);
    const challenge = await challengeFor(served, itemId);
    const [opened] = await harnessed.store.orders(harnessed.merchant.id);
    const offered = decodePaymentRequiredHeader(challenge);
    const accepted = offered.accepts[0];
    if (accepted === undefined || opened === undefined) throw new Error("nothing was priced");
    const { [PAYMENT_REF_IN_EXTRA]: _reference, ...rest } = accepted.extra ?? {};

    const answered = await present(
      served,
      itemId,
      encodePaymentSignatureHeader({
        x402Version: 2,
        accepted: { ...accepted, extra: { ...rest, order_id: opened.order.id } },
        payload: { signature: "0xsigned", authorization: { from: BUYER, nonce: "0x01" } },
      }),
    );

    expect(answered.status).toBe(402);
    expect(
      decodePaymentRequiredHeader(answered.headers.get(PAYMENT_REQUIRED_HEADER) ?? "").error,
    ).toMatch(/did not name an order this gateway is holding/);
    expect(harnessed.facilitator.verifies).toHaveLength(0);
    expect((await harnessed.store.orderById(opened.order.id))?.order.state).toBe("quoted");
  });

  it("opens no order's status: the status route answers it as it answers an unknown order", async () => {
    const { harnessed, served } = await started();
    const itemId = await publish(harnessed, asyncCard);
    const challenge = await challengeFor(served, itemId);
    const bought = await present(served, itemId, paymentAgainst(challenge, BUYER, "0x01"));
    expect(bought.status).toBe(200);
    const reference = referenceIn(challenge);
    if (typeof reference !== "string") throw new Error("the challenge named no reference");
    const orderId = (bought.body as { order_id: string }).order_id;

    const answerTo = async (path: string, headers: Record<string, string> = {}) => {
      const answered = await served.call("GET", path, { headers });
      return {
        status: answered.status,
        body: answered.body,
        caching: answered.headers.get("cache-control"),
      };
    };

    // The identifier opens it, so the door is open to the right key.
    expect((await answerTo(`/x402/orders/${orderId}/status`)).status).toBe(200);
    expect(await answerTo(`/x402/orders/${reference}/status`)).toStrictEqual(
      await answerTo("/x402/orders/pay_nobody_issued_this/status"),
    );
    // Nor does the merchant's own door take it for the order.
    const asMerchant = { authorization: `Bearer ${harnessed.merchant.key}` };
    expect((await answerTo(`/v0/orders/${orderId}`, asMerchant)).status).toBe(200);
    expect(await answerTo(`/v0/orders/${reference}`, asMerchant)).toStrictEqual(
      await answerTo("/v0/orders/pay_nobody_issued_this", asMerchant),
    );
  });

  it("of an order already paid is refused to another payer, in words that name no order", async () => {
    // A listing can publish the reference of a paid order. Holding it buys
    // nothing and learns nothing: the order stays its payer's.
    const { harnessed, served } = await started();
    const itemId = await publish(harnessed, asyncCard);
    const challenge = await challengeFor(served, itemId);
    expect(typeof referenceIn(challenge)).toBe("string");
    const bought = await present(served, itemId, paymentAgainst(challenge, BUYER, "0x01"));
    expect(bought.status).toBe(200);
    const orderId = (bought.body as { order_id: string }).order_id;

    const stranger = await present(served, itemId, paymentAgainst(challenge, STRANGER, "0x02"));

    expect(stranger.status).toBe(409);
    expect((stranger.body as { error: { code: string } }).error.code).toBe("not_this_purchase");
    expect(JSON.stringify(stranger.body)).not.toContain(orderId);
    expect(harnessed.facilitator.settles).toHaveLength(1);
    expect((await harnessed.store.orderById(orderId))?.paidBy?.toLowerCase()).toBe(BUYER);
  });
});
