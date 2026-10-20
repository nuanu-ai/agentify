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
import type { VerifyOutcome } from "../ports/facilitator.js";
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
 * extensions it was offered, and an authorisation signed by `from`. `terms`
 * stands in for a client that changed the offer before signing, or signed one
 * whose window has already passed.
 */
const paymentAgainst = (
  challenge: string,
  from: string,
  nonce: string,
  terms: {
    readonly payTo?: string;
    readonly validBefore?: number;
    /** The signer's clock, in milliseconds, where it is not the test's own. */
    readonly signedAt?: number;
  } = {},
): string => {
  const offered = decodePaymentRequiredHeader(challenge);
  const asked = offered.accepts[0];
  if (asked === undefined) throw new Error("the challenge offered no way to pay");
  const accepted = { ...asked, payTo: terms.payTo ?? asked.payTo };
  return encodePaymentSignatureHeader({
    x402Version: offered.x402Version,
    resource: offered.resource,
    accepted,
    ...(offered.extensions === undefined ? {} : { extensions: offered.extensions }),
    payload: {
      signature: `0x${"ab".repeat(65)}`,
      authorization: {
        from,
        to: accepted.payTo,
        value: accepted.amount,
        validAfter: "0",
        validBefore: String(
          terms.validBefore ??
            Math.floor((terms.signedAt ?? Date.now()) / 1_000) + accepted.maxTimeoutSeconds,
        ),
        nonce: `0x${nonce.slice(2).padStart(64, "0")}`,
      },
    },
  });
};

/** Where a challenge asks to be paid. */
const payToIn = (challenge: string): string | undefined =>
  decodePaymentRequiredHeader(challenge).accepts[0]?.payTo;

/** The signer and nonce of a payment's authorisation, where it carries one. */
const signedBy = (payload: PaymentPayload) =>
  (payload.payload as { authorization?: { from?: string; nonce?: string } }).authorization;

/**
 * A facilitator that says yes to every authorisation it has not charged,
 * names its signer as the payer, and keeps, whole, everything it was sent. An
 * authorisation it charged is used, and it refuses that one as the chain does.
 * Told to, it refuses the first charges it is asked for, before anything is
 * sent to the chain.
 */
class Recording implements FacilitatorClient {
  readonly sent: string[] = [];
  /** Where each charge it executed was paid to. */
  readonly charged: string[] = [];
  readonly #used = new Set<string | undefined>();
  #refusing: number;

  constructor({ refusingCharges = 0 }: { readonly refusingCharges?: number } = {}) {
    this.#refusing = refusingCharges;
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    this.sent.push(JSON.stringify({ verify: { payload, requirements } }));
    const signed = signedBy(payload);
    return this.#used.has(signed?.nonce)
      ? { isValid: false, invalidReason: "invalid_exact_evm_nonce_already_used" }
      : { isValid: true, ...(signed?.from === undefined ? {} : { payer: signed.from }) };
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    this.sent.push(JSON.stringify({ settle: { payload, requirements } }));
    if (this.#refusing > 0) {
      this.#refusing -= 1;
      return {
        success: false,
        errorReason: "invalid_exact_evm_payload_authorization_value_mismatch",
        network: requirements.network,
        transaction: "",
      };
    }
    this.#used.add(signedBy(payload)?.nonce);
    this.charged.push(requirements.payTo);
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
 * Its clock is the wall clock until `advance` moves it on.
 */
async function aGatewayPayingThrough(
  network: FacilitatorClient,
  overrides: Record<string, string> = {},
) {
  const config = testConfig({ PAY_TO_ADDRESS: PAY_TO, ...overrides });
  let ahead = 0;
  const clock = () => Date.now() + ahead;
  const queue = new MemoryQueue();
  const store = new MemoryStore(config.payment.network, randomIds, clock, queue.envelopes());
  const gateway = new Gateway({
    config,
    store,
    queue,
    facilitator: new X402Facilitator(network, new PaymentEdge(config), undefined, clock),
    clock,
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
  await store.addMerchant({ id: merchant.id, name: merchant.name }, clock());
  await setServiceName(store, merchant.id, merchant.name, clock());
  await setPayoutWallet(store, config.payoutSplit, merchant.id, merchant.wallet, clock());
  const served = await serve({ gateway });

  return {
    gateway,
    store,
    config,
    merchant,
    served,
    now: clock,
    advance(ms: number) {
      ahead += ms;
    },
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
const reaching = async (
  harnessed: { readonly store: Pick<MemoryStore, "orderById"> },
  orderId: string,
  state: string,
) => {
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
  it.each([false, true])(
    "answers a payment for an order its merchant closed unpaid as over and uncharged, revealing nothing of the closure (closure races verification=%s)",
    async (racing) => {
      const { harnessed, served } = await started();
      const itemId = await publish(harnessed, asyncCard);
      const challenge = await challengeFor(served, itemId);
      const [opened] = await harnessed.store.orders(harnessed.merchant.id);
      if (opened === undefined) throw new Error("no order was priced");
      const release = racing ? harnessed.facilitator.holdVerification() : () => undefined;
      let trying: ReturnType<typeof present> | undefined;
      try {
        if (racing) {
          trying = present(served, itemId, paymentAgainst(challenge, STRANGER, "0x02"));
          await vi.waitFor(() => expect(harnessed.facilitator.verifies).toHaveLength(1));
        }
        expect(
          await harnessed.gateway.closeOrder(harnessed.merchant.id, opened.order.id, {
            message: "Private merchant explanation",
          }),
        ).toEqual({ ok: true });
        release();
        const answered = await (trying ??
          present(served, itemId, paymentAgainst(challenge, STRANGER, "0x02")));
        expect(answered.status).toBe(409);
        expect(answered.body).toMatchObject({
          error: { code: "payment_not_taken", retryable: false },
        });
        expect(JSON.stringify(answered.body)).toContain("this order is over");
        expect(JSON.stringify(answered.body)).toContain("Nothing was charged");
        expectNoOrderIn(answered.body, opened.order.id);
        for (const privateWord of [
          "merchant_closure",
          "Private merchant explanation",
          "fulfillment_closed",
        ]) {
          expect(JSON.stringify(answered.body)).not.toContain(privateWord);
        }
        // Answered before the payment is checked, unless it was already
        // being checked when the merchant closed.
        expect(harnessed.facilitator.verifies).toHaveLength(racing ? 1 : 0);
        expect(harnessed.facilitator.settles).toEqual([]);
        expect((await harnessed.store.orderById(opened.order.id))?.paidBy).toBeNull();
      } finally {
        release();
        await trying;
      }
    },
  );

  it("lets the recorded payer recover a closed paid order with a fresh verified authorization and no new charge", async () => {
    const { harnessed, served } = await started();
    const itemId = await publish(harnessed, asyncCard);
    const challenge = await challengeFor(served, itemId);
    const bought = await present(served, itemId, paymentAgainst(challenge, BUYER, "0x01"));
    expect(bought.status).toBe(200);
    const orderId = (bought.body as { order_id: string }).order_id;
    expect(
      await harnessed.gateway.closeOrder(harnessed.merchant.id, orderId, {
        message: "Our agreement",
      }),
    ).toEqual({ ok: true });
    const recovered = await present(served, itemId, paymentAgainst(challenge, BUYER, "0x02"));
    expect(recovered.status).toBe(409);
    expect(recovered.body).toMatchObject({
      order_id: orderId,
      status: "fulfillment_closed",
      payment_status: "paid",
      merchant_closure: { message: "Our agreement" },
    });
    expect(harnessed.facilitator.settles).toHaveLength(1);
    const stranger = await present(served, itemId, paymentAgainst(challenge, STRANGER, "0x03"));
    expectNoOrderIn(stranger.body, orderId);
    expect(JSON.stringify(stranger.body)).not.toContain("Our agreement");
    expect(harnessed.facilitator.settles).toHaveLength(1);
  });

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
      "unfulfilled",
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
  it("cannot collect goods with the public used authorization, and a fresh verified payment returns them uncharged", async () => {
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
    await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, {
      access_code: "SESAME",
    });

    const again = await present(served, itemId, payment);

    expect(again.status).toBe(409);
    expectNoOrderIn(again.body, orderId);
    expect(JSON.stringify(again.body)).not.toContain("SESAME");
    expect((again.body as { error: { message: string } }).error.message).not.toMatch(
      /nothing was charged/i,
    );
    const fresh = await present(served, itemId, paymentAgainst(challenge, BUYER, "0x02"));
    expect(fresh.status).toBe(200);
    expect((fresh.body as { order_id: string }).order_id).toBe(orderId);
    expect(fresh.body).toMatchObject({ delivered: { access_code: "SESAME" } });
    expect(harnessed.facilitator.settles).toHaveLength(1);
  });
});

/** A wallet the seller moves to after a sale, so the split they are paid at changes. */
const MOVED_TO = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";

/** Where the seller of this product asks to be paid now, as a probe reads it. */
const paidNowFor = async (served: Served, itemId: string) => {
  const probed = await served.call("GET", `/x402/${itemId}/purchase`);
  expect(probed.status).toBe(402);
  return payToIn(probed.headers.get(PAYMENT_REQUIRED_HEADER) ?? "");
};

/**
 * A purchase delivered in the answer and charged, whose seller then replaced
 * their wallet: the payment request the buyer kept names a split the seller is
 * no longer paid at.
 */
async function deliveredThenTheWalletMoved() {
  const network = new Recording();
  const shop = await aGatewayPayingThrough(network);
  const worker = workUntilStopped(shop, {
    onOrder: () => ({ delivered: { access_code: "SESAME" } }),
  });
  const itemId = await shop.publish(syncCard);
  const challenge = await challengeFor(shop.served, itemId);
  const bought = await present(shop.served, itemId, paymentAgainst(challenge, BUYER, "0x01"));
  expect(bought.status).toBe(200);
  const orderId = (bought.body as { order_id: string }).order_id;
  await setPayoutWallet(
    shop.store,
    shop.config.payoutSplit,
    shop.merchant.id,
    MOVED_TO,
    shop.now(),
  );
  const paidTo = payToIn(challenge);
  expect(network.charged).toStrictEqual([paidTo]);
  expect(await paidNowFor(shop.served, itemId)).not.toBe(paidTo);
  return {
    network,
    shop,
    itemId,
    challenge,
    orderId,
    paidTo,
    async close() {
      await worker.stop();
      await shop.close();
    },
  };
}

describe("a payer whose answer was lost, after the seller moved their wallet", () => {
  it("gets the original order back for a fresh payment against the payment request it kept, charged nothing more", async () => {
    const sold = await deliveredThenTheWalletMoved();
    try {
      const fresh = await present(
        sold.shop.served,
        sold.itemId,
        paymentAgainst(sold.challenge, BUYER, "0x02"),
      );

      expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
      expect(fresh.body).toMatchObject({
        order_id: sold.orderId,
        delivered: { access_code: "SESAME" },
      });
      expect(sold.network.charged).toStrictEqual([sold.paidTo]);
    } finally {
      await sold.close();
    }
  });

  it("is the only one the order comes back to: another wallet's valid payment against the same request learns nothing of it", async () => {
    const sold = await deliveredThenTheWalletMoved();
    try {
      const stranger = await present(
        sold.shop.served,
        sold.itemId,
        paymentAgainst(sold.challenge, STRANGER, "0x02"),
      );

      expect(stranger.status).toBe(409);
      expect((stranger.body as { error: { code: string } }).error.code).toBe("not_this_purchase");
      expectNoOrderIn(stranger.body, sold.orderId);
      expect(JSON.stringify(stranger.body)).not.toContain("SESAME");
      expect(sold.network.charged).toStrictEqual([sold.paidTo]);
    } finally {
      await sold.close();
    }
  });

  it("opens nothing for the used authorization sent again, or for a renewal whose window has passed", async () => {
    const sold = await deliveredThenTheWalletMoved();
    try {
      const used = await present(
        sold.shop.served,
        sold.itemId,
        paymentAgainst(sold.challenge, BUYER, "0x01"),
      );
      const lapsed = await present(
        sold.shop.served,
        sold.itemId,
        paymentAgainst(sold.challenge, BUYER, "0x03", {
          validBefore: Math.floor(sold.shop.now() / 1_000) - 1,
        }),
      );

      for (const answered of [used, lapsed]) {
        expect(answered.status).toBe(409);
        expect((answered.body as { error: { code: string } }).error.code).toBe(
          "payment_not_verified",
        );
        expectNoOrderIn(answered.body, sold.orderId);
        expect(JSON.stringify(answered.body)).not.toContain("SESAME");
      }
      expect(sold.network.charged).toStrictEqual([sold.paidTo]);
    } finally {
      await sold.close();
    }
  });

  it("is told its saved payment has expired, sent again once its window passed, and the advice in that answer gets the order back", async () => {
    const sold = await deliveredThenTheWalletMoved();
    try {
      sold.shop.advance(10 * 60_000);

      const replayed = await present(
        sold.shop.served,
        sold.itemId,
        paymentAgainst(sold.challenge, BUYER, "0x01"),
      );

      expect(replayed.status).toBe(409);
      const { error } = replayed.body as { error: { code: string; message: string } };
      expect(error.code).toBe("payment_not_verified");
      expect(error.message).toMatch(/expired/);
      expect(error.message).not.toMatch(/different address/);
      expectNoOrderIn(replayed.body, sold.orderId);
      expect(JSON.stringify(replayed.body)).not.toContain("SESAME");

      const renewed = await present(
        sold.shop.served,
        sold.itemId,
        paymentAgainst(sold.challenge, BUYER, "0x02", { signedAt: sold.shop.now() }),
      );
      expect(renewed.status, JSON.stringify(renewed.body)).toBe(200);
      expect(renewed.body).toMatchObject({
        order_id: sold.orderId,
        delivered: { access_code: "SESAME" },
      });
      expect(sold.network.charged).toStrictEqual([sold.paidTo]);
    } finally {
      await sold.close();
    }
  });

  it("pays a repeat that is charged anew at the split the seller is paid at now, never at the one they left", async () => {
    // The seller ran out of time and their goods came late, so the buyer's
    // repeat is a new charge: the payment request it kept no longer says where
    // the money goes.
    const network = new Recording();
    const shop = await aGatewayPayingThrough(network, {
      SYNC_RESPONSE_MS: "80",
      SETTLE_RESPONSE_MS: "40",
      SYNC_BUDGET_MS: "1000",
      HANDLER_ANSWER_MS: "1000",
    });
    try {
      const itemId = await shop.publish(syncCard);
      const challenge = await challengeFor(shop.served, itemId);
      const paid = await present(shop.served, itemId, paymentAgainst(challenge, BUYER, "0x01"));
      const orderId = (paid.body as { order_id: string }).order_id;
      await reaching(shop, orderId, "expired");
      await setPayoutWallet(
        shop.store,
        shop.config.payoutSplit,
        shop.merchant.id,
        MOVED_TO,
        shop.now(),
      );
      await shop.gateway.answerOrder(shop.merchant.id, orderId, {
        delivered: { access_code: "SESAME" },
      });
      const paidNow = await paidNowFor(shop.served, itemId);

      const toTheOldSplit = await present(
        shop.served,
        itemId,
        paymentAgainst(challenge, BUYER, "0x02"),
      );
      expect(toTheOldSplit.status).toBe(409);
      expect((toTheOldSplit.body as { error: { code: string } }).error.code).toBe(
        "payment_not_verified",
      );
      expect(network.charged).toStrictEqual([]);

      const toTheSplitNow = await present(
        shop.served,
        itemId,
        paymentAgainst(challenge, BUYER, "0x03", { payTo: paidNow }),
      );
      expect(toTheSplitNow.status, JSON.stringify(toTheSplitNow.body)).toBe(200);
      expect(toTheSplitNow.body).toMatchObject({
        order_id: orderId,
        delivered: { access_code: "SESAME" },
      });
      expect(network.charged).toStrictEqual([paidNow]);
    } finally {
      await shop.close();
    }
  });
});

describe("a payment checked against where a paid order's money went", () => {
  it("is not charged to the split the seller left when the order comes to take a new charge while it is checked", async () => {
    // The buyer renews its payment request for a paid order whose seller has
    // moved their wallet, and while the renewal is with the payment layer the
    // order's own charge fails, so a payment would now be charged anew.
    const { harnessed, served } = await started();
    const itemId = await publish(harnessed, syncCard);
    let handOver: () => void = () => undefined;
    const goods = new Promise<void>((resolve) => {
      handOver = resolve;
    });
    const worker = workUntilStopped(harnessed, {
      onOrder: async () => {
        await goods;
        return { delivered: { access_code: "SESAME" } };
      },
    });
    let release: () => void = () => undefined;
    try {
      const challenge = await challengeFor(served, itemId);
      const [opened] = await harnessed.store.orders(harnessed.merchant.id);
      const orderId = opened?.order.id ?? "";
      const buying = present(served, itemId, paymentAgainst(challenge, BUYER, "0x01"));
      await vi.waitFor(async () =>
        expect((await harnessed.store.orderById(orderId))?.paidBy).not.toBeNull(),
      );
      const paidTo = (await harnessed.store.orderById(orderId))?.payTo;
      await setPayoutWallet(
        harnessed.store,
        harnessed.runtime.config.payoutSplit,
        harnessed.merchant.id,
        MOVED_TO,
        harnessed.now(),
      );
      release = harnessed.facilitator.holdVerification();
      const renewing = present(served, itemId, paymentAgainst(challenge, BUYER, "0x02"));
      await vi.waitFor(() => expect(harnessed.facilitator.verifies).toHaveLength(2));
      harnessed.facilitator.willSettle({ settled: false, reason: "refused in the script" });
      handOver();
      await buying;
      await reaching(harnessed, orderId, "delivered_unpaid");
      release();

      const renewed = await renewing;

      expect(harnessed.facilitator.settles.map((charge) => charge.payTo)).toStrictEqual([paidTo]);
      expect(renewed.status).toBe(409);
      expect(renewed.body).toMatchObject({ error: { code: "payment_not_verified" } });
      expect(JSON.stringify(renewed.body)).toMatch(/nothing was charged/i);
    } finally {
      handOver();
      release();
      await worker.stop();
    }
  });
});

/** A guide sent to whoever the buyer names, and a second product of the same seller. */
const guideCard: Card = {
  merchant_item_id: "wrapping-guide",
  title: "A gift wrapping guide",
  description: "A short guide to wrapping a gift, sent to the address given",
  price: { amount: "5.00", currency: "USD" },
  params: { email: { type: "string", required: true } },
  result: { guide: { type: "string" } },
  fulfillment: "sync",
};
const cardCard: Card = {
  ...guideCard,
  merchant_item_id: "greeting-card",
  title: "A greeting card",
  description: "A greeting card, sent to the address given",
};

const ORIGINAL = { email: "original-recipient@example.invalid" };
const CHANGED = { email: "changed-recipient@example.invalid" };

describe("a payment the payment layer refuses", () => {
  it("is answered the same before and after its order is paid, naming no order", async () => {
    // Anyone holding the payment request can make up a payment that is in its
    // window and send it to the payment layer, which refuses the signature;
    // its answer must not say whether the purchase was bought.
    const { harnessed, served } = await started();
    const itemId = await publish(harnessed, syncCard);
    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    try {
      const challenge = await challengeFor(served, itemId);
      const refusedSignature: VerifyOutcome = {
        verified: false,
        reason: "signature",
        message: "invalid_exact_evm_payload_signature",
      };
      harnessed.facilitator.willVerify(
        refusedSignature,
        { verified: true, payer: BUYER, validUntil: null },
        refusedSignature,
      );
      const madeUp = paymentAgainst(challenge, STRANGER, "0x09");

      const beforeTheSale = await present(served, itemId, madeUp);
      const bought = await present(served, itemId, paymentAgainst(challenge, BUYER, "0x01"));
      expect(bought.status).toBe(200);
      const orderId = (bought.body as { order_id: string }).order_id;
      const afterTheSale = await present(served, itemId, madeUp);

      expect(harnessed.facilitator.verifies).toHaveLength(3);
      expect(afterTheSale.status).toBe(409);
      expect(afterTheSale.body).toMatchObject({ error: { code: "payment_not_verified" } });
      expect(afterTheSale.body).toStrictEqual(beforeTheSale.body);
      expectNoOrderIn(afterTheSale.body, orderId);
      expect(JSON.stringify(afterTheSale.body)).not.toContain("SESAME");
      expect(harnessed.facilitator.settles).toHaveLength(1);
    } finally {
      await worker.stop();
    }
  });
});

describe("a payment whose authorization has expired", () => {
  it("is answered the same before and after its order is paid, and the buyer's renewal still returns the order", async () => {
    // The adapter refuses an expired authorization itself, without asking the
    // payment layer, so whoever holds the payment request can make one up;
    // its answer must not say whether the purchase was bought.
    const network = new Recording();
    const shop = await aGatewayPayingThrough(network);
    const worker = workUntilStopped(shop, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    try {
      const itemId = await shop.publish(syncCard);
      const challenge = await challengeFor(shop.served, itemId);
      const madeUp = paymentAgainst(challenge, STRANGER, "0x09", {
        validBefore: Math.floor(shop.now() / 1_000) - 1,
      });

      const beforeTheSale = await present(shop.served, itemId, madeUp);
      const bought = await present(shop.served, itemId, paymentAgainst(challenge, BUYER, "0x01"));
      expect(bought.status).toBe(200);
      const orderId = (bought.body as { order_id: string }).order_id;
      const afterTheSale = await present(shop.served, itemId, madeUp);

      expect(afterTheSale.status).toBe(409);
      expect(afterTheSale.body).toStrictEqual(beforeTheSale.body);
      expect(afterTheSale.body).toMatchObject({ error: { code: "payment_not_verified" } });
      expect(JSON.stringify(afterTheSale.body)).toMatch(/expired/);
      expect(JSON.stringify(afterTheSale.body)).not.toMatch(/payment layer refused/);
      expectNoOrderIn(afterTheSale.body, orderId);
      expect(network.sent.filter((call) => call.startsWith('{"verify"'))).toHaveLength(1);

      const renewed = await present(shop.served, itemId, paymentAgainst(challenge, BUYER, "0x02"));
      expect(renewed.status).toBe(200);
      expect(renewed.body).toMatchObject({
        order_id: orderId,
        delivered: { access_code: "SESAME" },
      });
      expect(network.charged).toHaveLength(1);
    } finally {
      await worker.stop();
      await shop.close();
    }
  });
});

describe("a payment presented with a request other than the one it was made for", () => {
  /** The seller's two products on sale, the guide priced for ORIGINAL, and its payment signed. */
  const pricedGuide = async (goodsReady: Promise<void> = Promise.resolve()) => {
    const { harnessed, served } = await started();
    const guide = await publish(harnessed, guideCard);
    const other = await publish(harnessed, cardCard);
    const handled: unknown[] = [];
    const worker = workUntilStopped(harnessed, {
      onOrder: async (order) => {
        handled.push(order.params);
        await goodsReady;
        return { delivered: { guide: "Fold the corners first." } };
      },
    });
    const priced = await served.call("POST", `/x402/${guide}/purchase`, {
      body: { params: ORIGINAL },
    });
    expect(priced.status).toBe(402);
    const challenge = priced.headers.get(PAYMENT_REQUIRED_HEADER) ?? "";
    const [opened] = await harnessed.store.orders(harnessed.merchant.id);
    const shopCall = (itemId: string, body: unknown, payment: string) =>
      served.call("POST", `/x402/${itemId}/purchase`, {
        body,
        headers: { [PAYMENT_SIGNATURE_HEADER]: payment },
      });
    const sendTo = (itemId: string, params: Record<string, unknown>, payment: string) =>
      shopCall(itemId, { params }, payment);
    return {
      harnessed,
      guide,
      other,
      handled,
      worker,
      challenge,
      orderId: opened?.order.id ?? "",
      sendTo,
      shopCall,
    };
  };

  it.each([
    ["at another product's address", true, ORIGINAL],
    ["at another product's address with another recipient", true, CHANGED],
    ["at its own product's address with another recipient", false, CHANGED],
  ] as const)(
    "is refused %s before anything is charged or handed over, and still buys at the request it was made for",
    async (_case, elsewhere, params) => {
      const sale = await pricedGuide();
      try {
        const payment = paymentAgainst(sale.challenge, BUYER, "0x01");

        const misplaced = await sale.sendTo(elsewhere ? sale.other : sale.guide, params, payment);

        expect(misplaced.status).toBe(409);
        expect(misplaced.body).toMatchObject({
          error: { code: "payment_not_taken", retryable: false },
        });
        expect(JSON.stringify(misplaced.body)).toMatch(/another purchase/);
        expectNoOrderIn(misplaced.body, sale.orderId);
        expect(JSON.stringify(misplaced.body)).not.toContain(ORIGINAL.email);
        expect(sale.harnessed.facilitator.settles).toHaveLength(0);
        expect(sale.handled).toStrictEqual([]);
        expect((await sale.harnessed.store.orderById(sale.orderId))?.paidBy).toBeNull();

        const bought = await sale.sendTo(sale.guide, ORIGINAL, payment);
        expect(bought.status, JSON.stringify(bought.body)).toBe(200);
        expect(bought.body).toMatchObject({ order_id: sale.orderId });
        expect(sale.handled).toStrictEqual([ORIGINAL]);
        expect(sale.harnessed.facilitator.settles).toHaveLength(1);
      } finally {
        await sale.worker.stop();
      }
    },
  );

  it("is refused with parameters that cannot be read, before anything is charged, and still buys at its own request", async () => {
    // Parameters that cannot be compared must not pass for the ones priced.
    const sale = await pricedGuide();
    try {
      const payment = paymentAgainst(sale.challenge, BUYER, "0x01");

      const unreadable = await sale.shopCall(sale.guide, { params: 5 }, payment);

      expect(unreadable.status).toBe(400);
      expect(unreadable.body).toMatchObject({ error: { code: "malformed_body" } });
      expectNoOrderIn(unreadable.body, sale.orderId);
      expect(sale.harnessed.facilitator.settles).toHaveLength(0);
      expect(sale.handled).toStrictEqual([]);

      const bought = await sale.sendTo(sale.guide, ORIGINAL, payment);
      expect(bought.status).toBe(200);
      expect(sale.harnessed.facilitator.settles).toHaveLength(1);
    } finally {
      await sale.worker.stop();
    }
  });

  it("is refused without claiming nothing was charged while the purchase it was made for is being charged", async () => {
    // Delivered in the answer, the purchase is charged after its goods, so its
    // authorization is still unused while the merchant works and verifies
    // again; the money it carries is then charged once, for its own purchase.
    let handOver: () => void = () => undefined;
    const goods = new Promise<void>((resolve) => {
      handOver = resolve;
    });
    const sale = await pricedGuide(goods);
    try {
      const payment = paymentAgainst(sale.challenge, BUYER, "0x01");
      const buying = sale.sendTo(sale.guide, ORIGINAL, payment);
      await vi.waitFor(() => expect(sale.handled).toHaveLength(1));

      const misplaced = await sale.sendTo(sale.other, ORIGINAL, payment);

      expect(misplaced.status).toBe(409);
      expect(misplaced.body).toMatchObject({
        error: { code: "payment_not_taken", retryable: false },
      });
      expect(JSON.stringify(misplaced.body)).toMatch(/another purchase/);
      expect(JSON.stringify(misplaced.body)).not.toMatch(/nothing was charged/i);
      expectNoOrderIn(misplaced.body, sale.orderId);
      handOver();
      expect((await buying).status).toBe(200);
      expect(sale.harnessed.facilitator.settles).toHaveLength(1);
    } finally {
      handOver();
      await sale.worker.stop();
    }
  });

  it("refused by the payment layer is answered the same whatever request it came with, naming no order", async () => {
    // A used authorization can be read from the chain, so presenting it with
    // a guess at another request must not confirm or deny the guess. That its
    // order is paid is said, as the chain already shows.
    const sale = await pricedGuide();
    try {
      const payment = paymentAgainst(sale.challenge, BUYER, "0x01");
      expect((await sale.sendTo(sale.guide, ORIGINAL, payment)).status).toBe(200);
      sale.harnessed.facilitator.willRefuseVerification(
        "signature",
        "invalid_exact_evm_nonce_already_used",
      );

      const guessed = await sale.sendTo(sale.other, CHANGED, payment);
      const matching = await sale.sendTo(sale.guide, ORIGINAL, payment);

      expect(guessed.status).toBe(409);
      expect(guessed.body).toMatchObject({ error: { code: "payment_not_verified" } });
      expect(guessed.body).toStrictEqual(matching.body);
      expect(JSON.stringify(guessed.body)).toMatch(/already paid/);
      expectNoOrderIn(guessed.body, sale.orderId);
      expect(sale.harnessed.facilitator.settles).toHaveLength(1);
    } finally {
      await sale.worker.stop();
    }
  });

  it("lets the payer who lost its answer recover with a fresh payment for the same request", async () => {
    const sale = await pricedGuide();
    try {
      const first = await sale.sendTo(
        sale.guide,
        ORIGINAL,
        paymentAgainst(sale.challenge, BUYER, "0x01"),
      );
      expect(first.status).toBe(200);

      const recovered = await sale.sendTo(
        sale.guide,
        ORIGINAL,
        paymentAgainst(sale.challenge, BUYER, "0x02"),
      );

      expect(recovered.status).toBe(200);
      expect(recovered.body).toMatchObject({
        order_id: sale.orderId,
        delivered: { guide: "Fold the corners first." },
      });
      expect(sale.harnessed.facilitator.settles).toHaveLength(1);
      expect(sale.handled).toStrictEqual([ORIGINAL]);
    } finally {
      await sale.worker.stop();
    }
  });
});

describe("goods made for a purchase whose charge did not go through", () => {
  /**
   * A purchase delivered in the answer whose charge the payment layer refused,
   * so the seller's goods are made and nothing was paid; read back as its buyer
   * reads it.
   */
  async function deliveredUnpaid() {
    const network = new Recording({ refusingCharges: 1 });
    const shop = await aGatewayPayingThrough(network);
    const handled: string[] = [];
    const worker = workUntilStopped(shop, {
      onOrder: (order) => {
        handled.push(order.id);
        return { delivered: { access_code: "SESAME" } };
      },
    });
    const itemId = await shop.publish(syncCard);
    const challenge = await challengeFor(shop.served, itemId);
    const bought = await present(shop.served, itemId, paymentAgainst(challenge, BUYER, "0x01"));
    const orderId = (bought.body as { order_id: string }).order_id;
    const status = await shop.served.call("GET", `/x402/orders/${orderId}/status`);
    expect(status.body).toMatchObject({
      status: "delivered_unpaid",
      payment_status: "not_paid",
      delivered: null,
    });
    return {
      network,
      shop,
      handled,
      itemId,
      challenge,
      orderId,
      reason: (status.body as { reason?: { code: string; message: string } }).reason,
      async close() {
        await worker.stop();
        await shop.close();
      },
    };
  }

  it("tells the buyer why, and paying this same purchase again as it says releases the goods with one charge", async () => {
    const sale = await deliveredUnpaid();
    try {
      expect(sale.reason?.code).toBe("payment_not_settled");
      expect(sale.reason?.message).toMatch(/nothing was taken/i);
      expect(sale.reason?.message).toMatch(/holding the goods/i);
      expect(sale.reason?.message).toMatch(/same purchase again/i);
      expect(JSON.stringify(sale.reason)).not.toContain("SESAME");

      const again = await present(
        sale.shop.served,
        sale.itemId,
        paymentAgainst(sale.challenge, BUYER, "0x02"),
      );

      expect(again.status, JSON.stringify(again.body)).toBe(200);
      expect(again.body).toMatchObject({
        order_id: sale.orderId,
        status: "delivered",
        payment_status: "paid",
        delivered: { access_code: "SESAME" },
      });
      expect(sale.network.charged).toStrictEqual([payToIn(sale.challenge)]);
      expect(sale.handled).toStrictEqual([sale.orderId]);
    } finally {
      await sale.close();
    }
  });

  it("warns that a seller who has changed where they are paid since cannot be paid this way, and that payment is refused with nothing charged", async () => {
    const sale = await deliveredUnpaid();
    try {
      expect(sale.reason?.message).toMatch(/changed where they are paid/i);
      await setPayoutWallet(
        sale.shop.store,
        sale.shop.config.payoutSplit,
        sale.shop.merchant.id,
        MOVED_TO,
        sale.shop.now(),
      );

      const again = await present(
        sale.shop.served,
        sale.itemId,
        paymentAgainst(sale.challenge, BUYER, "0x02"),
      );

      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({
        error: { code: "payment_not_verified", retryable: false },
      });
      expect(JSON.stringify(again.body)).toMatch(/nothing was charged/i);
      expect(JSON.stringify(again.body)).toMatch(/start a new purchase/i);
      expect(sale.network.charged).toStrictEqual([]);
    } finally {
      await sale.close();
    }
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
