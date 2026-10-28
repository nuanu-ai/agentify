/** A seller is reachable before a buyer pays for goods that arrive later. */
import type { Card } from "@nuanu-ai/agentify-contracts";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Harness, harness, type Served, serve, workUntilStopped } from "../testing/harness.js";
import { aWallet, signedPayment } from "../testing/signed-payment.js";
import { PAYMENT_REQUIRED_HEADER, PAYMENT_SIGNATURE_HEADER } from "./x402.js";

const SITE = "https://someones.example";
const BUYER = aWallet("the buyer");
const CARD: Card = {
  merchant_item_id: "room-101",
  title: "A room for the night",
  description: "One night in room 101",
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "async",
};
const PARCEL: Card = {
  merchant_item_id: "beans-1kg",
  title: "Coffee beans, one kilogram",
  description: "Roasted in Bali this week and sent by courier.",
  price: { amount: "18.00", currency: "USD" },
  fulfillment: "ship",
  ship_within_seconds: 172_800,
  price_check: "handler",
};
let open: { harnessed: Harness; served: Served } | null = null;
const workers: { stop(): Promise<void> }[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const worker of workers.splice(0)) await worker.stop();
  await open?.served.close();
  await open?.harnessed.stop();
  open = null;
});

async function started() {
  const harnessed = await harness({}, { sellerSite: null });
  const served = await serve(harnessed);
  open = { harnessed, served };
  return open;
}
const headers = (h: Harness) => ({ authorization: `Bearer ${h.merchant.key}` });
const giveSite = (h: Harness, served: Served) =>
  served.call("POST", "/v0/seller-name", { body: { seller_site: SITE }, headers: headers(h) });
const publish = (h: Harness, served: Served, card: unknown) =>
  served.call("POST", "/v0/catalog/publish", { body: card, headers: headers(h) });

async function quote(served: Served, itemId: string) {
  const answer = await served.call("POST", `/x402/${itemId}/purchase`, { body: { params: {} } });
  expect(answer.status, JSON.stringify(answer.body)).toBe(402);
  return decodePaymentRequiredHeader(answer.headers.get(PAYMENT_REQUIRED_HEADER) ?? "")
    .accepts[0] as PaymentRequirements;
}
async function pay(
  h: Harness,
  served: Served,
  itemId: string,
  offer: PaymentRequirements,
  nonce: string,
) {
  return served.call("POST", `/x402/${itemId}/purchase`, {
    body: { params: {} },
    headers: {
      [PAYMENT_SIGNATURE_HEADER]: await signedPayment(BUYER, offer, {
        nonce,
        validBefore: h.now() + offer.maxTimeoutSeconds * 1_000,
      }),
    },
  });
}
/** The merchant row an order created before the site requirement can still have. */
function readWithoutSite(h: Harness) {
  const read = h.store.merchantById.bind(h.store);
  vi.spyOn(h.store, "merchantById").mockImplementation(async (id) => {
    const merchant = await read(id);
    return merchant === null ? null : { ...merchant, sellerSite: null };
  });
}

describe("a site for purchases paid before delivery", () => {
  it.each([CARD, PARCEL])(
    "refuses a $fulfillment publication with no seller site",
    async (card) => {
      const { harnessed: h, served } = await started();
      const answer = await publish(h, served, card);
      expect(answer.body).toMatchObject({
        ok: false,
        error: {
          code: "card_rejected",
          problems: expect.arrayContaining([
            { path: [], code: "no_seller_site", message: expect.any(String) },
          ]),
        },
      });
      expect(await h.store.cards(h.merchant.id)).toHaveLength(0);
    },
  );

  it("reports a missing site together with a malformed asynchronous card", async () => {
    const { harnessed: h, served } = await started();
    const answer = await publish(h, served, { ...CARD, price: null });
    expect(answer.body).toMatchObject({
      ok: false,
      error: {
        problems: expect.arrayContaining([
          expect.objectContaining({ code: "no_seller_site", path: [] }),
          expect.objectContaining({ path: ["price"] }),
        ]),
      },
    });
  });

  it.each([
    ["GET", "api"],
    ["POST", "api"],
    ["GET", "woocommerce"],
    ["POST", "woocommerce"],
  ] as const)(
    "refuses an existing card on %s through %s until its seller gives a site",
    async (method, through) => {
      const { harnessed: h, served } = await started();
      if (through === "woocommerce") {
        await h.gateway.sellThrough(h.merchant.id, through);
        await h.store.setSelling(h.merchant.id, "open");
      }
      const stored = await h.store.publishCard(
        h.merchant.id,
        { ...CARD, price_check: "handler" },
        h.now(),
        through,
      );
      let questions = 0;
      workers.push(
        workUntilStopped(h, {
          through,
          onQuote: () => {
            questions += 1;
            return { available: true, price: CARD.price, as_of: new Date(h.now()).toISOString() };
          },
        }),
      );
      expect((await served.call("GET", "/x402/catalog")).body).toMatchObject({ items: [] });
      const ask = () =>
        served.call(
          method,
          `/x402/${stored.id}/purchase`,
          method === "POST" ? { body: { params: {} } } : {},
        );
      const blocked = await ask();
      expect(blocked.status).toBe(409);
      expect(blocked.body).toMatchObject({ error: { code: "not_selling", retryable: false } });
      expect(await h.store.orders(h.merchant.id)).toHaveLength(0);
      expect(questions).toBe(0);
      expect(h.facilitator.verifies).toHaveLength(0);
      const own = await served.call("GET", "/v0/cards", { headers: headers(h) });
      expect(own.body).toMatchObject({
        cards: [{ id: stored.id, selling: "paused", paused: false }],
      });

      expect((await giveSite(h, served)).status).toBe(200);
      const catalog = await served.call("GET", "/x402/catalog");
      expect(catalog.body).toMatchObject({ items: [{ id: stored.id, seller: { site: SITE } }] });
      expect((await ask()).status).toBe(402);
      expect(await h.store.orders(h.merchant.id)).toStrictEqual([]);
      expect(questions).toBe(method === "POST" ? 1 : 0);
    },
  );

  it("sells a synchronous product without a site", async () => {
    const { harnessed: h, served } = await started();
    const published = await publish(h, served, { ...CARD, fulfillment: "sync" });
    expect(published.body).toMatchObject({ ok: true });
    const id = (published.body as { id: string }).id;
    workers.push(
      workUntilStopped(h, { onOrder: () => ({ delivered: { access_code: "SESAME" } }) }),
    );
    const bought = await pay(h, served, id, await quote(served, id), "0x01");
    expect(bought.status).toBe(200);
    expect(bought.body).toMatchObject({
      status: "delivered",
      payment_status: "paid",
      seller: { site: null },
    });
    expect(h.facilitator.settles).toHaveLength(1);
  });

  it("publishes an asynchronous card once the merchant supplies a site", async () => {
    const { harnessed: h, served } = await started();
    expect((await giveSite(h, served)).status).toBe(200);
    const published = await publish(h, served, CARD);
    expect(published.body).toMatchObject({ ok: true });
    const id = (published.body as { id: string }).id;
    expect((await served.call("GET", "/x402/catalog")).body).toMatchObject({
      items: [{ id, seller: { site: SITE } }],
    });
    expect(await quote(served, id)).toMatchObject({ extra: { price_stamp: expect.any(String) } });
  });

  it("refuses a previously quoted unpaid purchase before verification if the merchant has no site", async () => {
    const { harnessed: h, served } = await started();
    await giveSite(h, served);
    const published = await publish(h, served, CARD);
    const id = (published.body as { id: string }).id;
    const offer = await quote(served, id);
    readWithoutSite(h);
    const refused = await pay(h, served, id, offer, "0x01");
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: { code: "not_selling", retryable: false } });
    expect(h.facilitator.verifies).toHaveLength(0);
    expect(h.facilitator.settles).toHaveLength(0);
  });

  it("recovers and delivers an already paid order whose seller has no site", async () => {
    const { harnessed: h, served } = await started();
    await giveSite(h, served);
    const published = await publish(h, served, CARD);
    const id = (published.body as { id: string }).id;
    let release = () => {};
    const later = new Promise<void>((resolve) => {
      release = resolve;
    });
    workers.push(
      workUntilStopped(h, {
        onOrder: async () => {
          await later;
          return { delivered: { access_code: "SESAME" } };
        },
      }),
    );
    try {
      const offer = await quote(served, id);
      const paid = await pay(h, served, id, offer, "0x01");
      expect(paid.status).toBe(200);
      readWithoutSite(h);
      const recovered = await pay(h, served, id, offer, "0x02");
      expect(recovered.status).toBe(200);
      expect(recovered.body).toMatchObject({
        order_id: (paid.body as { order_id: string }).order_id,
        payment_status: "paid",
        seller: { site: null },
      });
      release();
      const path = new URL((paid.body as { status_url: string }).status_url).pathname;
      await vi.waitFor(async () => {
        expect((await served.call("GET", path)).body).toMatchObject({
          status: "delivered",
          delivered: { access_code: "SESAME" },
        });
      });
      expect(h.facilitator.verifies).toHaveLength(1);
      expect(h.facilitator.settles).toHaveLength(1);
    } finally {
      release();
    }
  });

  it("preserves an unresolved payment outcome when the merchant has no site", async () => {
    const { harnessed: h, served } = await started();
    await giveSite(h, served);
    const published = await publish(h, served, CARD);
    const id = (published.body as { id: string }).id;
    h.facilitator.willSettle({ settled: "unknown", reason: "timed out" });
    const offer = await quote(served, id);
    const first = await pay(h, served, id, offer, "0x01");
    await h.gateway.runner.apply((first.body as { order_id: string }).order_id, {
      kind: "deadline_expired",
      at: h.now() + 60_000,
      deadline: "settle_response",
    });
    readWithoutSite(h);
    const again = await pay(h, served, id, offer, "0x02");
    expect(again.body).toMatchObject({ error: { code: "payment_not_taken", retryable: true } });
    expect(h.facilitator.settles).toHaveLength(1);
  });
});
