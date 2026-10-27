/** Prices persist with the buyer; only a presented payment creates an order. */
import type { Card, ShipTo } from "@nuanu-ai/agentify-contracts";
import { ShipToSchema } from "@nuanu-ai/agentify-contracts";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Harness, harness, type Served, serve, workUntilStopped } from "../testing/harness.js";
import { aWallet, signedPayment } from "../testing/signed-payment.js";
import { PAYMENT_REQUIRED_HEADER, PAYMENT_SIGNATURE_HEADER } from "./x402.js";

const CARD: Card = {
  merchant_item_id: "room-101",
  title: "A room for the night",
  description: "One night in room 101",
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
  price_check: "handler",
};
const BUYER = aWallet("the buyer");
const ADDRESS = ShipToSchema.parse(ShipToSchema.meta()?.examples?.[0]);
let h: Harness;
let served: Served;
let itemId: string;
let worker: { stop(): Promise<void> };
let releaseVerification: (() => void) | undefined;

afterEach(async () => {
  releaseVerification?.();
  releaseVerification = undefined;
  await worker.stop();
  await served.close();
  await h.stop();
});
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
async function pay(offer: PaymentRequirements, nonce: string, shipTo?: ShipTo) {
  const payment = await signedPayment(BUYER, offer, {
    nonce,
    validBefore: h.now() + offer.maxTimeoutSeconds * 1000,
  });
  return served.call("POST", `/x402/${itemId}/purchase`, {
    body: body(shipTo),
    headers: { [PAYMENT_SIGNATURE_HEADER]: payment },
  });
}

describe("a stamped price and an order born at payment", () => {
  it.each(["sync", "async"] as const)(
    "prices a %s purchase without a stored order",
    async (fulfillment) => {
      await started({ ...CARD, fulfillment });
      const offer = await quote();
      expect(offer.amount).toBe("75000000");
      expect(offer.extra).toMatchObject({ price_stamp: expect.any(String) });
      expect(offer.extra).not.toHaveProperty("order_id");
      expect(await h.store.orders(h.merchant.id)).toStrictEqual([]);
      expect(h.facilitator.verifies).toHaveLength(0);
      expect(h.facilitator.settles).toHaveLength(0);
    },
  );

  it("refuses a changed stamp before creating or charging an order", async () => {
    await started();
    const offer = await quote();
    const extra = { ...offer.extra, price_stamp: `${offer.extra?.price_stamp ?? "invalid"}x` };
    delete extra.order_id;
    const refused = await pay({ ...offer, extra }, "0x01");
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      error: { code: "payment_not_verified", retryable: false },
    });
    expect(await h.store.orders(h.merchant.id)).toStrictEqual([]);
    expect(h.facilitator.verifies).toHaveLength(0);
    expect(h.facilitator.settles).toHaveLength(0);
  });

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
    await vi.waitFor(() => expect(h.facilitator.verifies).toHaveLength(1));
    h.advance(31_000);
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
    const answers = await Promise.all(Array.from({ length: 5 }, (_, index) => pay(offer, `0x${index + 1}`)));
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

  it("does not consume a price when the first signature fails verification", async () => {
    await started();
    const offer = await quote();
    h.facilitator.willRefuseVerification("signature");
    expect((await pay(offer, "0x01")).status).toBe(409);
    h.facilitator.willVerify();
    const paid = await pay(offer, "0x02");
    expect(paid.status).toBe(200);
    expect(paid.body).toMatchObject({ status: "delivered", payment_status: "paid" });
    expect(h.facilitator.settles).toHaveLength(1);
  });

  it("does not let an unverified parcel request fix another buyer's full address", async () => {
    await started({
      merchant_item_id: "beans-1kg",
      title: "Coffee beans, one kilogram",
      description: "Roasted in Bali this week and sent by courier.",
      price: { amount: "18.00", currency: "USD" },
      fulfillment: "ship",
      price_check: "handler",
      ship_within_seconds: 172800,
    });
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
