/**
 * What a payment names its order by. The payment requirements go to the
 * payment facilitator on every verification and charge, and a discovery
 * listing can publish them as the last paying request carried them, so they
 * name the order by a payment reference, which nothing answers with the
 * order. The order's identifier, the key to the order and its goods, is in
 * none of it.
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
import { afterEach, describe, expect, it, vi } from "vitest";
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
  CHALLENGE_REASONS,
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

const started = async (overrides: Record<string, string> = {}) => {
  const harnessed = await harness({ PAY_TO_ADDRESS: PAY_TO, ...overrides });
  const served = await serve(harnessed);
  open = { harnessed, served };
  return open;
};

afterEach(async () => {
  vi.restoreAllMocks();
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

/** A payment that is not one, carrying only the reference, as anyone who read it could send. */
const onlyTheReference = (challenge: string): string =>
  encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: { extra: { [PAYMENT_REF_IN_EXTRA]: referenceIn(challenge) } } as never,
    payload: {},
  });

/** Neither the order's identifier nor the address built from it is in an answer. */
const expectNoOrderIn = (body: unknown, orderId: string) => {
  const text = JSON.stringify(body);
  expect(text).not.toContain(orderId);
  expect(text).not.toContain("status_url");
  expect(text).not.toContain("/x402/orders/");
};

/** Waits, briefly, for an order to reach a state a timer moves it to. */
const reaching = async (harnessed: Harness, orderId: string, state: string) => {
  for (let tries = 0; tries < 200; tries += 1) {
    if ((await harnessed.store.orderById(orderId))?.order.state === state) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`the order never reached ${state}`);
};

/**
 * A refusal says what became of the order in the words its status gives,
 * read here by its identifier as its buyer would.
 */
const expectToSayWhatBecameOf = async (
  body: unknown,
  served: Served,
  orderId: string,
  expected: { readonly retryable: boolean },
) => {
  const status = await served.call("GET", `/x402/orders/${orderId}/status`);
  const reason = (status.body as { reason?: { message: string } }).reason?.message;
  expect(typeof reason).toBe("string");
  const { error } = body as { error: { message: string; retryable: boolean } };
  expect(error.message).toContain(reason);
  expect(error.retryable).toBe(expected.retryable);
};

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
    // Two orders for one card are open at once, and the payment is for the
    // older one: a gateway binding to the newest open order would pay the
    // other.
    const { harnessed, served } = await started();
    const itemId = await publish(harnessed, asyncCard);
    const first = await challengeFor(served, itemId);
    const [older] = await harnessed.store.orders(harnessed.merchant.id);
    await challengeFor(served, itemId);
    const newer = (await harnessed.store.orders(harnessed.merchant.id)).find(
      (held) => held.order.id !== older?.order.id,
    );

    const bought = await present(served, itemId, paymentAgainst(first, BUYER, "0x01"));

    expect(bought.status).toBe(200);
    expect((bought.body as { order_id: string }).order_id).toBe(older?.order.id);
    expect((await harnessed.store.orderById(newer?.order.id ?? ""))?.order.state).toBe("quoted");
  });

  it("is the only thing a payment is bound by: one naming its order's identifier pays nothing", async () => {
    // No fallback to the identifier, whether a payment names the order under
    // `order_id` or puts the identifier where the reference goes: either is a
    // payment for no order, and gets a fresh price.
    const { harnessed, served } = await started();
    const itemId = await publish(harnessed, asyncCard);
    const challenge = await challengeFor(served, itemId);
    const [opened] = await harnessed.store.orders(harnessed.merchant.id);
    const accepted = decodePaymentRequiredHeader(challenge).accepts[0];
    if (accepted === undefined || opened === undefined) throw new Error("nothing was priced");
    const { [PAYMENT_REF_IN_EXTRA]: _reference, ...rest } = accepted.extra ?? {};

    for (const [nonce, named] of [
      ["0x01", { order_id: opened.order.id }],
      ["0x02", { [PAYMENT_REF_IN_EXTRA]: opened.order.id }],
    ] as const) {
      const answered = await present(
        served,
        itemId,
        encodePaymentSignatureHeader({
          x402Version: 2,
          accepted: { ...accepted, extra: { ...rest, ...named } },
          payload: { signature: `0xsigned${nonce}`, authorization: { from: BUYER, nonce } },
        }),
      );

      expect(answered.status, JSON.stringify(named)).toBe(402);
      expect(
        decodePaymentRequiredHeader(answered.headers.get(PAYMENT_REQUIRED_HEADER) ?? "").error,
      ).toBe(CHALLENGE_REASONS.noHeldOrder);
    }
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

  it.each([
    ["in progress", asyncCard, undefined, "paid"],
    ["delivered on the call", syncCard, { delivered: { access_code: "SESAME" } }, "delivered"],
    [
      "owing a refund",
      asyncCard,
      { refused: { code: "out_of_stock", message: "gone" } },
      "refund_due",
    ],
  ] as const)(
    "of a paid order %s is refused to another payer and to a payment that is not one, in words that name no order",
    async (_case, card, answer, state) => {
      // A listing publishes the reference of a request that was charged, so
      // mostly of an order delivered or owing a refund. Holding it buys nothing
      // and learns nothing: the order stays its payer's.
      const { harnessed, served } = await started();
      const itemId = await publish(harnessed, card);
      const worker =
        answer === undefined ? null : workUntilStopped(harnessed, { onOrder: () => answer });
      try {
        const challenge = await challengeFor(served, itemId);
        expect(typeof referenceIn(challenge)).toBe("string");
        const bought = await present(served, itemId, paymentAgainst(challenge, BUYER, "0x01"));
        expect(bought.status).toBe(200);
        const orderId = (bought.body as { order_id: string }).order_id;
        await reaching(harnessed, orderId, state);
        const charged = harnessed.facilitator.settles.length;

        const stranger = await present(served, itemId, paymentAgainst(challenge, STRANGER, "0x02"));
        const notOne = await present(served, itemId, onlyTheReference(challenge));

        expect(stranger.status).toBe(409);
        expect((stranger.body as { error: { code: string } }).error.code).toBe("not_this_purchase");
        expect(notOne.status).toBe(409);
        for (const answered of [stranger, notOne]) {
          expectNoOrderIn(answered.body, orderId);
          expect(JSON.stringify(answered.body)).not.toContain("SESAME");
        }
        expect(harnessed.facilitator.settles).toHaveLength(charged);
        expect((await harnessed.store.orderById(orderId))?.paidBy?.toLowerCase()).toBe(BUYER);
      } finally {
        await worker?.stop();
      }
    },
  );
});

describe("a payer whose answer was lost", () => {
  it("is not told nothing was charged when it presents a used payment again, and a fresh one returns the order uncharged", async () => {
    // Without the identifier in the challenge, paying again is how a payer
    // gets back to an order whose answer it lost.
    const { harnessed, served } = await started();
    const itemId = await publish(harnessed, asyncCard);
    const challenge = await challengeFor(served, itemId);
    const payment = paymentAgainst(challenge, BUYER, "0x01");
    harnessed.facilitator.willVerify(
      { verified: true, payer: BUYER, validUntil: null },
      {
        verified: false,
        reason: "signature",
        message: "invalid_exact_evm_nonce_already_used",
      },
      { verified: true, payer: BUYER, validUntil: null },
    );
    const bought = await present(served, itemId, payment);
    expect(bought.status).toBe(200);
    const orderId = (bought.body as { order_id: string }).order_id;

    const again = await present(served, itemId, payment);

    expect(again.status).toBe(409);
    expect((again.body as { error: { message: string } }).error.message).not.toMatch(
      /nothing was charged/i,
    );
    const fresh = await present(served, itemId, paymentAgainst(challenge, BUYER, "0x02"));
    expect(fresh.status).toBe(200);
    expect((fresh.body as { order_id: string }).order_id).toBe(orderId);
    expect(harnessed.facilitator.settles).toHaveLength(1);
  });
});

describe("the reference of an order that ended before a payment was taken", () => {
  it("hands back no order for a price that lapsed, and asks the facilitator nothing", async () => {
    const { harnessed, served } = await started();
    const itemId = await publish(harnessed, asyncCard);
    const challenge = await challengeFor(served, itemId);
    const [opened] = await harnessed.store.orders(harnessed.merchant.id);
    const orderId = opened?.order.id ?? "";
    harnessed.advance(60_000);

    const answered = await present(served, itemId, onlyTheReference(challenge));

    expect(answered.status).toBe(409);
    expectNoOrderIn(answered.body, orderId);
    expect(harnessed.facilitator.verifies).toHaveLength(0);
    expect((await harnessed.store.orderById(orderId))?.order.state).toBe("expired");
    await expectToSayWhatBecameOf(answered.body, served, orderId, { retryable: false });
  });

  it("does not tell a payment that came after the price lapsed that nothing was charged when another took the order first", async () => {
    // The price's timer can fire late, and the order is read before the lapse
    // is applied; a payment can take it in between.
    const { harnessed, served } = await started();
    const itemId = await publish(harnessed, asyncCard);
    const challenge = await challengeFor(served, itemId);
    const [opened] = await harnessed.store.orders(harnessed.merchant.id);
    const orderId = opened?.order.id ?? "";
    harnessed.advance(60_000);
    const runner = harnessed.gateway.runner;
    const apply = runner.apply.bind(runner);
    vi.spyOn(runner, "apply").mockImplementationOnce(async (id, event, facts) => {
      await runner.presentVerifiedPayment(id, BUYER, "the buyer's payment", null, harnessed.now());
      return apply(id, event, facts);
    });

    const answered = await present(served, itemId, paymentAgainst(challenge, STRANGER, "0x02"));

    expect((await harnessed.store.orderById(orderId))?.order.payment).toBe("settled");
    expect(answered.status).toBe(409);
    expect((answered.body as { error: { code: string } }).error.code).toBe("not_this_purchase");
    expect(JSON.stringify(answered.body)).not.toMatch(/nothing was charged/i);
  });

  it("hands back no order for a synchronous purchase whose seller ran out of time, and its buyer still collects", async () => {
    // The buyer's payment took the reference to the facilitator; the seller
    // then missed the synchronous deadline, so the order closed unpaid.
    const { harnessed, served } = await started({
      SYNC_RESPONSE_MS: "80",
      SETTLE_RESPONSE_MS: "40",
      SYNC_BUDGET_MS: "1000",
      HANDLER_ANSWER_MS: "1000",
    });
    const itemId = await publish(harnessed, syncCard);
    const challenge = await challengeFor(served, itemId);
    const paid = await present(served, itemId, paymentAgainst(challenge, BUYER, "0x01"));
    const orderId = (paid.body as { order_id: string }).order_id;
    await reaching(harnessed, orderId, "expired");
    const checked = harnessed.facilitator.verifies.length;

    const answered = await present(served, itemId, onlyTheReference(challenge));

    expect(answered.status).toBe(409);
    expectNoOrderIn(answered.body, orderId);
    expect(harnessed.facilitator.verifies).toHaveLength(checked);
    await expectToSayWhatBecameOf(answered.body, served, orderId, { retryable: false });

    // The seller's goods arrive late and are held; the buyer pays again from
    // the same wallet and collects them.
    await harnessed.gateway.answerOrder(harnessed.merchant.id, orderId, {
      delivered: { access_code: "SESAME" },
    });
    const collected = await present(served, itemId, paymentAgainst(challenge, BUYER, "0x02"));
    expect(collected.status).toBe(200);
    expect(collected.body).toMatchObject({
      order_id: orderId,
      delivered: { access_code: "SESAME" },
    });
  });

  it("hands back no order for a charge that went quiet, whose money may have moved", async () => {
    // A charge carries the reference, which is what a listing publishes once
    // the charge goes through.
    const { harnessed, served } = await started({ SETTLE_RESPONSE_MS: "100" });
    harnessed.facilitator.willSettle({ settled: "unknown", reason: "timed out" });
    const itemId = await publish(harnessed, asyncCard);
    const challenge = await challengeFor(served, itemId);
    const paid = await present(served, itemId, paymentAgainst(challenge, BUYER, "0x01"));
    const orderId = (paid.body as { order_id: string }).order_id;
    // What the settle clock does when it runs out.
    await harnessed.gateway.runner.apply(orderId, {
      kind: "deadline_expired",
      at: harnessed.now() + 60_000,
      deadline: "settle_response",
    });
    const quiet = await harnessed.store.orderById(orderId);
    expect([quiet?.order.state, quiet?.order.payment]).toStrictEqual([
      "rejected",
      "outcome_unknown",
    ]);
    const checked = harnessed.facilitator.verifies.length;

    const answered = await present(served, itemId, onlyTheReference(challenge));

    expect(answered.status).toBe(409);
    expectNoOrderIn(answered.body, orderId);
    expect(harnessed.facilitator.verifies).toHaveLength(checked);
    // Nobody knows whether money moved, so the answer does not say none did,
    // and asking again may find out.
    const { error } = answered.body as { error: { message: string; retryable: boolean } };
    expect(error.message).not.toMatch(/nothing was charged/i);
    expect(error.retryable).toBe(true);
  });
});
