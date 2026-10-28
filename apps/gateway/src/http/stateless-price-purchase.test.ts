/** Prices persist with the buyer; verified admission creates the order. */
import type { Card, ShipTo } from "@nuanu-ai/agentify-contracts";
import { ShipToSchema } from "@nuanu-ai/agentify-contracts";
import {
  decodePaymentRequiredHeader,
  decodePaymentSignatureHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { X402Facilitator } from "../adapters/x402/facilitator.js";
import { Gateway } from "../app/gateway.js";
import { payoutSplitFor } from "../split/parameters.js";
import {
  buyOverHttp,
  type Harness,
  harness,
  type Served,
  serve,
  workUntilStopped,
} from "../testing/harness.js";
import { aWallet, signedPayment } from "../testing/signed-payment.js";
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  PaymentEdge,
  paymentFingerprint,
} from "./x402.js";

const CARD: Card = {
  merchant_item_id: "room-101",
  title: "A room for the night",
  description: "One night in room 101",
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
  price_check: "handler",
};
const PARCEL_CARD: Card = {
  merchant_item_id: "beans-1kg",
  title: "Coffee beans, one kilogram",
  description: "Roasted in Bali this week and sent by courier.",
  price: { amount: "18.00", currency: "USD" },
  fulfillment: "ship",
  price_check: "handler",
  ship_within_seconds: 172800,
};
const BUYER = aWallet("the buyer");
// A buyer's own name on the schema's sample place: the sample itself is the
// listing's example purchase, which is answered as the listing is.
const ADDRESS = ShipToSchema.parse({
  ...((ShipToSchema.meta()?.examples as unknown[])?.[0] as object),
  name: "The buyer",
});
let h: Harness;
let served: Served;
let itemId: string;
let worker: { stop(): Promise<void> };
let releaseVerification: (() => void) | undefined;
const pending: Promise<unknown>[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await stopped();
});
async function stopped() {
  releaseVerification?.();
  releaseVerification = undefined;
  await Promise.allSettled(pending.splice(0));
  await worker.stop();
  await served.close();
  await h.stop();
}
async function started(card: Card = CARD) {
  h = await harness();
  served = await serve(h);
  itemId = (await h.store.publishCard(h.merchant.id, card, h.now())).id;
  worker = workUntilStopped(h, {
    onQuote: () => ({
      available: true,
      price: { amount: "75.00", currency: "USD" },
      as_of: new Date(h.now()).toISOString(),
    }),
    onOrder: () =>
      card.fulfillment === "ship" ? { accepted: {} } : { delivered: { access_code: "SESAME" } },
  });
}
const body = (shipTo?: ShipTo) => ({
  params: {},
  ...(shipTo === undefined ? {} : { ship_to: shipTo }),
});
async function quote(shipTo?: ShipTo) {
  const answer = await served.call("POST", `/x402/${itemId}/purchase`, { body: body(shipTo) });
  expect(answer.status).toBe(402);
  return decodePaymentRequiredHeader(answer.headers.get(PAYMENT_REQUIRED_HEADER) ?? "")
    .accepts[0] as PaymentRequirements;
}
async function pay(offer: PaymentRequirements, nonce: string, shipTo?: ShipTo, wallet = BUYER) {
  const payment = await signedPayment(wallet, offer, {
    nonce,
    validBefore: h.now() + offer.maxTimeoutSeconds * 1000,
  });
  return served.call("POST", `/x402/${itemId}/purchase`, {
    body: body(shipTo),
    headers: { [PAYMENT_SIGNATURE_HEADER]: payment },
  });
}

/**
 * A payment chain on which every wallet holds `held` and every authorization
 * is unused, or whose reads fail with `held`, standing in for the endpoint.
 */
function chainHolding(held: bigint | Error = 1_000_000_000n, used = false) {
  const chain = {
    held,
    used,
    reads: 0,
    async balance(): Promise<bigint> {
      chain.reads += 1;
      if (chain.held instanceof Error) throw chain.held;
      return chain.held;
    },
    async payerState(): Promise<{ held: bigint; used: boolean }> {
      chain.reads += 1;
      if (chain.held instanceof Error) throw chain.held;
      return { held: chain.held, used: chain.used };
    },
  };
  Object.assign(h.runtime, { balances: chain });
  return chain;
}

describe("a stamped price and an order born at payment", () => {
  it.each([undefined, "handler"] as const)(
    "keeps a %s price stateless while the original payment is being verified",
    async (price_check) => {
      await started({ ...CARD, price_check });
      const offer = await quote();
      const payment = await signedPayment(BUYER, offer, {
        nonce: "0x01",
        validBefore: h.now() + offer.maxTimeoutSeconds * 1000,
      });
      const fingerprint = paymentFingerprint(
        decodePaymentSignatureHeader(payment),
        new PaymentEdge(h.runtime.config).token(),
      );
      const analyticsBefore = h.store.recordedAnalytics;
      releaseVerification = h.facilitator.holdVerification();
      const paying = served.call("POST", `/x402/${itemId}/purchase`, {
        body: body(),
        headers: { [PAYMENT_SIGNATURE_HEADER]: payment },
      });
      pending.push(paying);
      await vi.waitFor(() => expect(h.facilitator.verifies).toHaveLength(1));

      expect(await h.store.orders(h.merchant.id)).toStrictEqual([]);
      expect(h.store.recordedAnalytics).toStrictEqual(analyticsBefore);
      expect(await h.store.paymentClaimHolder(fingerprint)).toBeNull();
      expect(h.facilitator.settles).toHaveLength(0);

      releaseVerification();
      const paid = await paying;
      expect(paid.status).toBe(200);
      expect(paid.body).toMatchObject({ status: "delivered", payment_status: "paid" });
      expect(await h.store.orders(h.merchant.id)).toHaveLength(1);
      expect(h.facilitator.settles).toHaveLength(1);
    },
  );

  it.each(["missing", "nonhex", "odd"] as const)(
    "refuses a %s payment signature before verification or durable admission",
    async (malformed) => {
      await started({ ...CARD, price_check: undefined });
      const offer = await quote();
      const analyticsBefore = h.store.recordedAnalytics;
      const original = decodePaymentSignatureHeader(
        await signedPayment(BUYER, offer, {
          nonce: "0x01",
          validBefore: h.now() + offer.maxTimeoutSeconds * 1000,
        }),
      );
      const { signature: _signature, ...unsigned } = original.payload as Record<string, unknown>;
      const payment = encodePaymentSignatureHeader({
        ...original,
        payload: {
          ...unsigned,
          ...(malformed === "missing"
            ? {}
            : { signature: malformed === "odd" ? "0x1" : "0xnot-a-signature" }),
        },
      });
      const fingerprint = paymentFingerprint(
        decodePaymentSignatureHeader(payment),
        new PaymentEdge(h.runtime.config).token(),
      );
      const sent: string[] = [];
      Object.assign(h.runtime, {
        facilitator: new X402Facilitator({
          async verify() {
            sent.push("verify");
            return { isValid: false };
          },
          async settle() {
            sent.push("settle");
            return { success: false, network: "eip155:84532", transaction: "" };
          },
          async getSupported() {
            return { kinds: [], extensions: [], signers: {} };
          },
        }),
      });
      const refused = await served.call("POST", `/x402/${itemId}/purchase`, {
        body: body(),
        headers: { [PAYMENT_SIGNATURE_HEADER]: payment },
      });

      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ error: { code: "payment_not_verified" } });
      expect(await h.store.orders(h.merchant.id)).toStrictEqual([]);
      expect(h.store.recordedAnalytics).toStrictEqual(analyticsBefore);
      expect(await h.store.paymentClaimHolder(fingerprint)).toBeNull();
      expect(sent).toStrictEqual([]);
    },
  );

  it("lets an honest payment through after forged stamps naming its merchant", async () => {
    await started({ ...CARD, price_check: undefined });
    const offer = await quote();
    const [, payload] = String(offer.extra?.price_stamp).split(".");
    // Any price of this merchant's, under a signature Agentify never made,
    // all at once and ahead of the honest payment: a gate entered before the
    // stamp is checked would be full when the honest payment reaches it.
    const forgeries = Array.from({ length: 32 }, (_, one) => {
      const facts = JSON.parse(Buffer.from(payload ?? "", "base64url").toString()) as unknown[];
      facts[1] = `prc_forged_${one}`;
      const forged = `v1.${Buffer.from(JSON.stringify(facts)).toString("base64url")}.${"A".repeat(43)}`;
      return pay(
        { ...offer, extra: { ...offer.extra, price_stamp: forged } },
        `0x${(one + 100).toString(16)}`,
      );
    });
    const paying = pay(offer, "0x01");

    for (const refused of await Promise.all(forgeries)) {
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({
        error: { code: "payment_not_verified", retryable: false },
      });
    }
    const paid = await paying;
    expect(paid.status).toBe(200);
    expect(paid.body).toMatchObject({ status: "delivered", payment_status: "paid" });
    expect(h.facilitator.verifies).toHaveLength(1);
  });

  it.each([
    { price_check: undefined, mismatched: false },
    { price_check: "handler", mismatched: false },
    { price_check: undefined, mismatched: true },
    { price_check: "handler", mismatched: true },
  ] as const)(
    "lets four payments at one merchant be checked at once and makes a fifth wait, for price_check=$price_check and mismatched=$mismatched",
    async ({ price_check, mismatched }) => {
      await started({
        ...CARD,
        price_check,
        params: { email: { type: "string", required: false } },
      });
      chainHolding();
      const offers: PaymentRequirements[] = [];
      for (let one = 0; one < 5; one += 1) offers.push(await quote());
      const presented = await Promise.all(
        offers.map((offer, index) =>
          signedPayment(aWallet(`buyer ${index}`), offer, {
            nonce: `0x${index + 1}`,
            validBefore: h.now() + offer.maxTimeoutSeconds * 1000,
          }),
        ),
      );
      const stampOf = (offer: PaymentRequirements | undefined) => String(offer?.extra?.price_stamp);
      const present = (index: number) => {
        const payment = presented[index] ?? "";
        return h.gateway.payPurchase(
          stampOf(offers[index]),
          payment,
          paymentFingerprint(
            decodePaymentSignatureHeader(payment),
            new PaymentEdge(h.runtime.config).token(),
          ),
          undefined,
          { itemId, params: mismatched && index === 4 ? { email: "buyer@example.com" } : {} },
        );
      };
      releaseVerification = h.facilitator.holdVerification();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const paying = [0, 1, 2, 3].map(present);
      pending.push(...paying);
      await vi.waitFor(() => expect(h.facilitator.verifies).toHaveLength(4));
      let fifthLanded = false;
      const fifth = present(4).finally(() => {
        fifthLanded = true;
      });
      pending.push(fifth);
      await vi.advanceTimersByTimeAsync(0);
      expect(fifthLanded).toBe(false);
      expect(h.facilitator.verifies).toHaveLength(4);

      // Whatever the wait for a place is, it is a timer, and it ends.
      await vi.runOnlyPendingTimersAsync();

      expect(await fifth).toMatchObject({ step: "seller_busy" });
      expect(h.facilitator.verifies).toHaveLength(4);
      expect(await h.store.orders(h.merchant.id)).toStrictEqual([]);
      vi.useRealTimers();
      releaseVerification();
      for (const answer of await Promise.all(paying)) expect(answer.step).toBe("settled");
      expect(h.facilitator.settles).toHaveLength(4);
    },
  );

  it("lets another merchant complete a purchase while four of one merchant's payments are being checked", async () => {
    await started({ ...CARD, price_check: undefined });
    chainHolding();
    const offers: PaymentRequirements[] = [];
    for (let one = 0; one < 4; one += 1) offers.push(await quote());
    const payTo = offers[0]?.payTo;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    releaseVerification = release;
    Object.assign(h.runtime, {
      facilitator: {
        verify: async (charge: Parameters<typeof h.facilitator.verify>[0]) => {
          const verified = await h.facilitator.verify(charge);
          if (charge.payTo === payTo) await held;
          return verified;
        },
        settle: h.facilitator.settle.bind(h.facilitator),
      },
    });
    const paying = offers.map((offer, index) =>
      pay(offer, `0x${index + 1}`, undefined, aWallet(`buyer ${index}`)),
    );
    pending.push(...paying);
    await vi.waitFor(() => expect(h.facilitator.verifies).toHaveLength(4));
    const other = await h.addMerchant("Another merchant");
    const card = await h.store.publishCard(other.id, { ...CARD, price_check: undefined }, h.now());
    const bought = await buyOverHttp(h, served, card.id, {
      merchantId: other.id,
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    expect(bought.status).toBe(200);
    expect(bought.body).toMatchObject({ status: "delivered", payment_status: "paid" });
    expect(h.facilitator.settles).toHaveLength(1);
    expect(await h.store.orders(h.merchant.id)).toStrictEqual([]);
    releaseVerification();
    for (const answer of await Promise.all(paying)) expect(answer.status).toBe(200);
    expect(h.facilitator.settles).toHaveLength(5);
  });

  /** A well-formed payment for `offer` from a wallet nobody holds the key of, signed with noise. */
  async function junk(offer: PaymentRequirements, nonce: string): Promise<string> {
    const genuine = decodePaymentSignatureHeader(
      await signedPayment(BUYER, offer, {
        nonce,
        validBefore: h.now() + offer.maxTimeoutSeconds * 1000,
      }),
    );
    const signed = genuine.payload as { authorization: Record<string, unknown> };
    return encodePaymentSignatureHeader({
      ...genuine,
      payload: {
        authorization: { ...signed.authorization, from: `0x${nonce.slice(2).padStart(40, "7")}` },
        signature: `0x${"5a".repeat(65)}`,
      },
    });
  }

  it("refuses an empty wallet's payment at once, before it takes a place or reaches the payment layer", async () => {
    await started({ ...CARD, price_check: undefined });
    const offer = await quote();
    chainHolding(0n);

    const refused = await pay(offer, "0x01");

    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      error: { code: "payment_not_verified", retryable: false },
    });
    expect(JSON.stringify(refused.body)).toMatch(/fund the paying wallet/);
    expect(h.facilitator.verifies).toHaveLength(0);
    expect(await h.store.orders(h.merchant.id)).toStrictEqual([]);
  });

  it("lets a buyer whose wallet can pay through while payments nobody can prove fill its merchant's lane", async () => {
    await started({ ...CARD, price_check: undefined });
    chainHolding();
    const offers: PaymentRequirements[] = [];
    for (let one = 0; one < 9; one += 1) offers.push(await quote());
    const junked = await Promise.all(
      offers.slice(0, 8).map((offer, index) => junk(offer, `0x${(index + 10).toString(16)}`)),
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    releaseVerification = release;
    Object.assign(h.runtime, {
      facilitator: {
        verify: async (charge: Parameters<typeof h.facilitator.verify>[0]) => {
          const verified = await h.facilitator.verify(charge);
          if (junked.includes(charge.payment)) {
            await held;
            return { verified: false, reason: "signature", message: "not the wallet's" };
          }
          return verified;
        },
        settle: h.facilitator.settle.bind(h.facilitator),
      },
    });
    const sending = junked.map((payment, index) =>
      served
        .call("POST", `/x402/${itemId}/purchase`, {
          body: body(),
          headers: { [PAYMENT_SIGNATURE_HEADER]: payment },
        })
        .then((answer) => ({ index, answer })),
    );
    pending.push(...sending);
    await vi.waitFor(() => expect(h.facilitator.verifies.length).toBeGreaterThan(0));
    const honest = offers[8];
    if (honest === undefined) throw new Error("no honest price was issued");

    const paid = await pay(honest, "0x01");

    expect(paid.status).toBe(200);
    expect(paid.body).toMatchObject({ status: "delivered", payment_status: "paid" });
    // The lane has a few places and a short line; the rest are turned away at once.
    expect(
      h.facilitator.verifies.filter((charge) => junked.includes(charge.payment)).length,
    ).toBeLessThan(junked.length);
    releaseVerification();
    const turnedAway = (await Promise.all(sending)).filter(({ answer }) => answer.status === 429);
    expect(turnedAway.length).toBeGreaterThan(0);
    expect(h.facilitator.settles).toHaveLength(1);
  });

  it("sends a payment whose wallet's balance cannot be read to the lane nobody can vouch for", async () => {
    await started({ ...CARD, price_check: undefined });
    const offers: PaymentRequirements[] = [];
    for (let one = 0; one < 7; one += 1) offers.push(await quote());
    chainHolding(new Error("the chain endpoint did not answer"));
    const junked = await Promise.all(
      offers.slice(0, 6).map((offer, index) => junk(offer, `0x${(index + 10).toString(16)}`)),
    );
    releaseVerification = h.facilitator.holdVerification();
    const sending = junked.map((payment) =>
      served.call("POST", `/x402/${itemId}/purchase`, {
        body: body(),
        headers: { [PAYMENT_SIGNATURE_HEADER]: payment },
      }),
    );
    pending.push(...sending);
    await vi.waitFor(() => expect(h.facilitator.verifies).toHaveLength(2));
    const unread = offers[6];
    if (unread === undefined) throw new Error("no price was issued");

    // Its signature is its wallet's, but nothing shows the wallet can pay, so
    // it waits where payments nobody can vouch for wait, and that line is full.
    const refused = await pay(unread, "0x01");

    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ error: { code: "seller_busy", retryable: true } });
    releaseVerification();
  });

  it("asks the chain again for a wallet that held less than the price, so a buyer who tops up can pay", async () => {
    await started({ ...CARD, price_check: undefined });
    const first = await quote();
    const second = await quote();
    const chain = chainHolding(0n);
    expect((await pay(first, "0x01")).status).toBe(409);

    chain.held = 1_000_000_000n;
    const paid = await pay(second, "0x02");

    expect(paid.status).toBe(200);
    expect(h.facilitator.settles).toHaveLength(1);
  });

  it("holds one place and one place in line per wallet, however many prices it signs for", async () => {
    // One signed header sent again under many stamps: the stamp is not part
    // of what the wallet signs, and the facilitator refuses every copy but
    // after its round trip. Each copy beyond the second is turned away here.
    await started({ ...CARD, price_check: undefined });
    chainHolding();
    const offers: PaymentRequirements[] = [];
    for (let one = 0; one < 25; one += 1) offers.push(await quote());
    const attacker = aWallet("one funded wallet");
    const signed = decodePaymentSignatureHeader(
      await signedPayment(attacker, offers[0] as PaymentRequirements, {
        nonce: "0xa1",
        validBefore: h.now() + (offers[0]?.maxTimeoutSeconds ?? 0) * 1000,
      }),
    );
    const replays = offers.slice(0, 24).map((offer) =>
      encodePaymentSignatureHeader({
        ...signed,
        accepted: { ...signed.accepted, extra: { ...offer.extra } },
      }),
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    releaseVerification = release;
    const fromAttacker = (payment: string) =>
      (decodePaymentSignatureHeader(payment).payload as { authorization?: { from?: string } })
        .authorization?.from === attacker.address;
    Object.assign(h.runtime, {
      facilitator: {
        verify: async (charge: Parameters<typeof h.facilitator.verify>[0]) => {
          const verified = await h.facilitator.verify(charge);
          if (!fromAttacker(charge.payment)) return verified;
          await held;
          return { verified: false, reason: "signature", message: "already used" };
        },
        settle: h.facilitator.settle.bind(h.facilitator),
      },
    });
    const sending = replays.map((payment) =>
      served.call("POST", `/x402/${itemId}/purchase`, {
        body: body(),
        headers: { [PAYMENT_SIGNATURE_HEADER]: payment },
      }),
    );
    pending.push(...sending);
    await vi.waitFor(() => expect(h.facilitator.verifies).toHaveLength(1));
    const honest = offers[24];
    if (honest === undefined) throw new Error("no honest price was issued");

    const paid = await pay(honest, "0x01", undefined, aWallet("an honest buyer"));

    expect(paid.status).toBe(200);
    expect(h.facilitator.verifies.filter((charge) => fromAttacker(charge.payment))).toHaveLength(1);
    releaseVerification();
    const answers = await Promise.all(sending);
    expect(answers.filter((answer) => answer.status === 429).length).toBeGreaterThanOrEqual(22);
  });

  it.each([
    ["is not valid yet", "validAfter"],
    ["is a high-s copy of a valid signature", "high-s"],
    ["names an authorization the token has already used", "used"],
  ] as const)(
    "refuses at once, taking no place, a payment whose authorization %s",
    async (_what, fault) => {
      await started({ ...CARD, price_check: undefined });
      const offer = await quote();
      chainHolding(1_000_000_000n, fault === "used");
      let payment = await signedPayment(BUYER, offer, {
        nonce: "0x01",
        validBefore: h.now() + offer.maxTimeoutSeconds * 1000,
        ...(fault === "validAfter" ? { validAfter: h.now() + 120_000 } : {}),
      });
      if (fault === "high-s") {
        const decoded = decodePaymentSignatureHeader(payment);
        const signed = decoded.payload as { signature: string };
        const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
        const r = signed.signature.slice(2, 66);
        const s = BigInt(`0x${signed.signature.slice(66, 130)}`);
        const v = Number.parseInt(signed.signature.slice(130, 132), 16);
        payment = encodePaymentSignatureHeader({
          ...decoded,
          payload: {
            ...decoded.payload,
            signature: `0x${r}${(n - s).toString(16).padStart(64, "0")}${(v === 27 ? 28 : 27).toString(16)}`,
          },
        });
      }

      const refused = await served.call("POST", `/x402/${itemId}/purchase`, {
        body: body(),
        headers: { [PAYMENT_SIGNATURE_HEADER]: payment },
      });

      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({
        error: { code: "payment_not_verified", retryable: false },
      });
      expect(h.facilitator.verifies).toHaveLength(0);
    },
  );

  it("charges two buyers of one merchant whose payments are checked at the same time", async () => {
    await started({ ...CARD, price_check: undefined });
    const first = await quote();
    const second = await quote();
    releaseVerification = h.facilitator.holdVerification();
    const paying = [
      pay(first, "0x01", undefined, aWallet("the first buyer")),
      pay(second, "0x02", undefined, aWallet("the second buyer")),
    ];
    pending.push(...paying);
    await vi.waitFor(() => expect(h.facilitator.verifies).toHaveLength(2));
    releaseVerification();
    for (const answer of await Promise.all(paying)) {
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ status: "delivered", payment_status: "paid" });
    }
    expect(await h.store.orders(h.merchant.id)).toHaveLength(2);
    expect(h.facilitator.settles).toHaveLength(2);
  });

  it.each(["sync", "async"] as const)(
    "prices a %s purchase without a stored order",
    async (fulfillment) => {
      await started({ ...CARD, fulfillment });
      h.store.admitOrder = () =>
        Promise.reject(new Error("a price response must not need order storage"));
      const offer = await quote();
      expect(offer.amount).toBe("75000000");
      expect(offer.extra).toMatchObject({ price_stamp: expect.any(String) });
      expect(offer.extra).not.toHaveProperty("order_id");
      expect(await h.store.orders(h.merchant.id)).toStrictEqual([]);
      expect(h.facilitator.verifies).toHaveLength(0);
      expect(h.facilitator.settles).toHaveLength(0);
    },
  );

  it.each(["malformed", "amount", "quoteReference"])(
    "refuses a changed %s stamp before creating or charging an order",
    async (changed) => {
      await started();
      const offer = await quote();
      const original = String(offer.extra?.price_stamp);
      const parts = original.split(".");
      let stamp = `${original}x`;
      if (changed !== "malformed") {
        const facts = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString()) as unknown[];
        facts[changed === "amount" ? 8 : 20] = changed === "amount" ? "1.00" : "changed-reference";
        stamp = `${parts[0]}.${Buffer.from(JSON.stringify(facts)).toString("base64url")}.${parts[2]}`;
      }
      const extra: Record<string, unknown> = { ...offer.extra, price_stamp: stamp };
      delete extra.order_id;
      const refused = await pay({ ...offer, extra }, "0x01");
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({
        error: { code: "payment_not_verified", retryable: false },
      });
      expect(await h.store.orders(h.merchant.id)).toStrictEqual([]);
      expect(h.facilitator.verifies).toHaveLength(0);
      expect(h.facilitator.settles).toHaveLength(0);
    },
  );

  it("refuses an expired unconsumed price without creating an order", async () => {
    await started();
    const offer = await quote();
    h.advance(31_000);
    const refused = await pay(offer, "0x01");
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: { code: "payment_not_taken", retryable: false } });
    expect(await h.store.orders(h.merchant.id)).toStrictEqual([]);
    expect(h.facilitator.verifies).toHaveLength(0);
  });

  it("honours an in-term payment when verification finishes after the price expires", async () => {
    await started();
    const offer = await quote();
    releaseVerification = h.facilitator.holdVerification();
    const paying = pay(offer, "0x01");
    pending.push(paying);
    await vi.waitFor(() => expect(h.facilitator.verifies).toHaveLength(1));
    h.advance(31_000);
    const replay = await pay(offer, "0x02");
    expect(replay.status).toBe(409);
    expect(replay.headers.get("retry-after")).toBe("2");
    expect(replay.body).toMatchObject({
      error: { code: "payment_not_taken", retryable: true },
    });
    expect(replay.body).not.toHaveProperty("order_id");
    expect(replay.body).not.toHaveProperty("status_url");
    expect(JSON.stringify(replay.body)).not.toMatch(/nothing was charged|request a new price/i);
    const checked = h.facilitator.verifies[0];
    if (checked === undefined) throw new Error("no payment was presented for verification");
    await h.gateway.runner.apply(checked.orderId, {
      kind: "deadline_expired",
      at: h.now(),
      deadline: "quote_expiry",
    });
    releaseVerification();
    const paid = await paying;
    expect(paid.status).toBe(200);
    expect(paid.body).toMatchObject({ status: "delivered", payment_status: "paid" });
    expect(h.facilitator.settles).toHaveLength(1);
    const recovered = await pay(offer, "0x03");
    expect(recovered.body).toMatchObject({
      order_id: (paid.body as { order_id: string }).order_id,
      status_url: (paid.body as { status_url: string }).status_url,
    });
    expect(h.facilitator.settles).toHaveLength(1);
  });

  it("recovers the same paid order with a fresh signature after price expiry", async () => {
    await started();
    const offer = await quote();
    const first = await pay(offer, "0x01");
    expect(first.status).toBe(200);
    h.advance(31_000);
    const recovered = await pay(offer, "0x02");
    expect(recovered.status).toBe(200);
    expect(recovered.body).toMatchObject({
      order_id: (first.body as { order_id: string }).order_id,
      status_url: (first.body as { status_url: string }).status_url,
      status: "delivered",
      payment_status: "paid",
    });
    expect(await h.store.orders(h.merchant.id)).toHaveLength(1);
    expect(h.facilitator.settles).toHaveLength(1);
  });

  it("converges concurrent payments on one order and one private status address", async () => {
    await started();
    const offer = await quote();
    const presented = await Promise.all(
      Array.from({ length: 5 }, (_, index) => pay(offer, `0x${index + 1}`)),
    );
    const answers = [];
    for (const [index, answer] of presented.entries()) {
      if (answer.status !== 200) {
        expect(answer.body).toMatchObject({
          error: { code: "payment_not_taken", retryable: true },
        });
        answers.push(await pay(offer, `0x${index + 10}`));
      } else answers.push(answer);
    }
    expect(answers.every((answer) => answer.status === 200)).toBe(true);
    const identifiers = new Set(
      answers.map((answer) => (answer.body as { order_id: string }).order_id),
    );
    const addresses = new Set(
      answers.map((answer) => (answer.body as { status_url: string }).status_url),
    );
    expect(identifiers.size).toBe(1);
    expect(addresses.size).toBe(1);
    expect(await h.store.orders(h.merchant.id)).toHaveLength(1);
    expect(h.facilitator.settles).toHaveLength(1);
  });

  it("leaves one order when a second gateway process admits the same price at the same time", async () => {
    // Each process checks one request per price; only the store's admission
    // keeps two processes from making two orders of one price.
    await started({ ...CARD, fulfillment: "async", price_check: undefined });
    const offer = await quote();
    const another = new Gateway(h.runtime);
    const present = async (gateway: Gateway, nonce: string) => {
      const payment = await signedPayment(BUYER, offer, {
        nonce,
        validBefore: h.now() + offer.maxTimeoutSeconds * 1000,
      });
      return gateway.payPurchase(
        String(offer.extra?.price_stamp),
        payment,
        paymentFingerprint(
          decodePaymentSignatureHeader(payment),
          new PaymentEdge(h.runtime.config).token(),
        ),
        undefined,
        { itemId, params: {} },
      );
    };
    releaseVerification = h.facilitator.holdVerification();
    const paying = [present(h.gateway, "0x01"), present(another, "0x02")];
    pending.push(...paying);
    await vi.waitFor(() => expect(h.facilitator.verifies).toHaveLength(2));
    releaseVerification();

    const steps = (await Promise.all(paying)).map((answer) => answer.step).sort();
    expect(steps).toStrictEqual(["payment_being_checked", "under_way"]);
    expect(await h.store.orders(h.merchant.id)).toHaveLength(1);
    expect(h.facilitator.settles).toHaveLength(1);
  });

  it("does not consume a price when the first signature fails verification", async () => {
    await started();
    const offer = await quote();
    const analyticsBefore = h.store.recordedAnalytics;
    h.facilitator.willRefuseVerification("signature");
    expect((await pay(offer, "0x01")).status).toBe(409);
    expect(await h.store.orders(h.merchant.id)).toStrictEqual([]);
    expect(h.store.recordedAnalytics).toStrictEqual(analyticsBefore);
    h.facilitator.willVerify();
    const paid = await pay(offer, "0x02");
    expect(paid.status).toBe(200);
    expect(paid.body).toMatchObject({ status: "delivered", payment_status: "paid" });
    expect(h.facilitator.settles).toHaveLength(1);
  });

  it("does not let an unverified parcel request fix another buyer's full address", async () => {
    await started(PARCEL_CARD);
    const offer = await quote(ADDRESS);
    h.facilitator.willRefuseVerification("signature");
    expect(
      (await pay(offer, "0x01", { ...ADDRESS, line_one: `${ADDRESS.line_one} Unit 2` })).status,
    ).toBe(409);
    h.facilitator.willVerify();
    const paid = await pay(offer, "0x02", ADDRESS);
    expect(paid.status).toBe(200);
    expect(paid.body).toMatchObject({ payment_status: "paid" });
    const [order] = await h.store.orders(h.merchant.id);
    if (order === undefined) throw new Error("the verified parcel was not stored");
    // Before the worker's acceptance erases it, or already erased after acceptance.
    expect(order.paidBy).toBe(BUYER.address.toLowerCase());
    expect(h.facilitator.settles).toHaveLength(1);
  });

  it("refuses a concurrent same-wallet request that changes the first verified full address", async () => {
    await started(PARCEL_CARD);
    const offer = await quote(ADDRESS);
    await worker.stop();
    releaseVerification = h.facilitator.holdVerification();
    const first = pay(offer, "0x01", ADDRESS);
    pending.push(first);
    await vi.waitFor(() => expect(h.facilitator.verifies).toHaveLength(1));
    const changed = { ...ADDRESS, line_one: `${ADDRESS.line_one} Unit 2` };
    let secondAnswered = false;
    const second = pay(offer, "0x02", changed).then((answer) => {
      secondAnswered = true;
      return answer;
    });
    pending.push(second);
    await vi.waitFor(() => {
      expect(secondAnswered || h.facilitator.verifies.length === 2).toBe(true);
    });
    releaseVerification();

    const paid = await first;
    const refused = await second;
    expect(paid.status).toBe(200);
    expect(refused.status).toBe(409);
    expect(["ship_to_changed", "payment_not_taken"]).toContain(
      (refused.body as { error: { code: string } }).error.code,
    );
    const retried = await pay(offer, "0x03", changed);
    expect(retried.status).toBe(409);
    expect(retried.body).toMatchObject({ error: { code: "ship_to_changed" } });
    const [order] = await h.store.orders(h.merchant.id);
    expect(order?.shipTo).toStrictEqual(ADDRESS);
    expect(h.facilitator.settles).toHaveLength(1);
  });

  /** One purchase whose terms change before its payment arrives or while it is being checked. */
  async function changedWhilePaying(
    changed: "card" | "payee" | "selling" | "integration" | "site",
    when: "before arrival" | "during verification",
  ) {
    await started({ ...CARD, fulfillment: "async", price_check: undefined });
    if (changed === "payee") {
      const next = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
      await h.store.setPayoutWallet(
        h.merchant.id,
        { address: h.merchant.wallet, pending: null },
        {
          address: h.merchant.wallet,
          split: payoutSplitFor(h.runtime.config.payoutSplit, h.merchant.id, h.merchant.wallet),
          pending: {
            address: next,
            takesEffectAt: h.now() + 1_000,
            split: payoutSplitFor(h.runtime.config.payoutSplit, h.merchant.id, next),
          },
        },
        h.now(),
      );
    }
    const offer = await quote();
    const change = async () => {
      if (changed === "card") {
        h.advance(1);
        await h.store.publishCard(
          h.merchant.id,
          { ...CARD, fulfillment: "async", price_check: undefined, title: "A room for two nights" },
          h.now(),
        );
      } else if (changed === "site") {
        await h.store.setSellerSite(h.merchant.id, "https://another-shop.example", h.now());
      } else if (changed === "selling") {
        await h.store.setSelling(h.merchant.id, "paused");
      } else if (changed === "integration") {
        expect(await h.store.switchIntegration(h.merchant.id, "woocommerce")).toMatchObject({
          switched: true,
        });
      } else h.advance(1_001);
    };
    let answer: Awaited<ReturnType<typeof pay>>;
    if (when === "before arrival") {
      await change();
      answer = await pay(offer, "0x01");
    } else {
      releaseVerification = h.facilitator.holdVerification();
      const paying = pay(offer, "0x01");
      pending.push(paying);
      await vi.waitFor(() => expect(h.facilitator.verifies).toHaveLength(1));
      await change();
      releaseVerification();
      answer = await paying;
    }
    const outcome = {
      status: answer.status,
      error: (answer.body as { error?: unknown }).error,
      orders: (await h.store.orders(h.merchant.id)).length,
      settles: h.facilitator.settles.length,
      created: h.store.recordedAnalytics.filter(({ event }) => event.name === "agc_order_created")
        .length,
    };
    await stopped();
    return outcome;
  }

  it.each(["card", "payee"] as const)(
    "refuses a price whose %s terms changed, in the same words before arrival and during verification",
    async (changed) => {
      const before = await changedWhilePaying(changed, "before arrival");
      const during = await changedWhilePaying(changed, "during verification");
      await started();

      expect(before).toMatchObject({
        status: 409,
        error: { code: "payment_not_taken", retryable: false },
        orders: 0,
        settles: 0,
        created: 0,
      });
      expect(during).toStrictEqual(before);
    },
  );

  it.each(["selling", "integration"] as const)(
    "refuses a price whose seller stopped selling through %s as not on sale, before arrival and during verification",
    async (changed) => {
      const before = await changedWhilePaying(changed, "before arrival");
      const during = await changedWhilePaying(changed, "during verification");
      await started();

      expect(before).toMatchObject({
        status: 409,
        error: { code: "not_selling", retryable: false },
        orders: 0,
        settles: 0,
        created: 0,
      });
      // The buyer has signed, and the answer is about the money too.
      expect(JSON.stringify(before.error)).toMatch(/nothing was charged/);
      expect(during).toStrictEqual(before);
    },
  );

  it("tells a paying buyer when the seller gives no site for a card paid before its goods", async () => {
    await started({ ...CARD, fulfillment: "async", price_check: undefined });
    const offer = await quote();
    const read = h.store.merchantById.bind(h.store);
    h.store.merchantById = async (id) => {
      const merchant = await read(id);
      return merchant === null ? null : { ...merchant, sellerSite: null };
    };
    const refused = await pay(offer, "0x01");
    h.store.merchantById = read;

    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toMatch(/site/);
    expect(JSON.stringify(refused.body)).toMatch(/nothing was charged/);
    expect(h.facilitator.verifies).toHaveLength(0);
  });

  it("keeps a price whose seller only moved their site, before arrival and during verification", async () => {
    const before = await changedWhilePaying("site", "before arrival");
    const during = await changedWhilePaying("site", "during verification");
    await started();

    expect(before).toMatchObject({ status: 200, orders: 1, settles: 1, created: 1 });
    expect(during).toStrictEqual(before);
  });

  /** A store failure as the database adapter describes one that can pass by itself. */
  const passing = (nothingWritten = false) =>
    Object.assign(new Error("the store's call failed in the database"), {
      passing: true,
      nothingWritten,
    });

  it("tells a payment Agentify failed to check before writing anything to come again", async () => {
    await started();
    const offer = await quote();
    const read = h.store.merchantById.bind(h.store);
    h.store.merchantById = () => Promise.reject(passing());
    const refused = await pay(offer, "0x01");
    h.store.merchantById = read;

    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("2");
    expect(refused.body).toMatchObject({ error: { code: "gateway_failed", retryable: true } });
    expect(await h.store.orders(h.merchant.id)).toStrictEqual([]);
    expect(h.facilitator.verifies).toHaveLength(0);
    const paid = await pay(offer, "0x01");
    expect(paid.status).toBe(200);
    expect(h.facilitator.settles).toHaveLength(1);
  });

  it("tells a payment whose admission could not get a connection to come again", async () => {
    await started();
    const offer = await quote();
    const admit = h.store.admitOrder.bind(h.store);
    h.store.admitOrder = () => Promise.reject(passing(true));
    const refused = await pay(offer, "0x01");
    h.store.admitOrder = admit;

    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("2");
    expect(refused.body).toMatchObject({ error: { code: "gateway_failed", retryable: true } });
    expect(await h.store.orders(h.merchant.id)).toStrictEqual([]);
    expect(h.facilitator.settles).toHaveLength(0);
  });

  it("refuses for good, saying nothing was charged, a payment Agentify fails on for a reason that will not pass", async () => {
    await started();
    const offer = await quote();
    const read = h.store.merchantById.bind(h.store);
    h.store.merchantById = () => Promise.reject(new TypeError("a defect, the same every time"));
    const refused = await pay(offer, "0x01");
    h.store.merchantById = read;

    expect(refused.status).toBe(500);
    expect(refused.headers.get("retry-after")).toBeNull();
    expect(refused.body).toMatchObject({ error: { code: "gateway_failed", retryable: false } });
    expect(JSON.stringify(refused.body)).toMatch(/nothing was charged/);
    expect(h.facilitator.verifies).toHaveLength(0);
  });

  it("keeps a price valid when its card is published again unchanged", async () => {
    await started();
    const offer = await quote();
    h.advance(1);
    await h.store.publishCard(h.merchant.id, CARD, h.now());
    const paid = await pay(offer, "0x01");
    expect(paid.status).toBe(200);
    expect(paid.body).toMatchObject({ status: "delivered", payment_status: "paid" });
    expect(h.facilitator.settles).toHaveLength(1);
  });

  it("refuses a new payment after the priced card is republished", async () => {
    await started();
    const offer = await quote();
    h.advance(1);
    await h.store.publishCard(h.merchant.id, { ...CARD, title: "A room for two nights" }, h.now());
    const refused = await pay(offer, "0x01");
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: { code: "payment_not_taken", retryable: false } });
    expect(h.facilitator.verifies).toHaveLength(0);
    expect(h.facilitator.settles).toHaveLength(0);
  });
});
