/**
 * The operator's one-time approval at the live publish door.
 *
 * A merchant may prove their address, choose a seller name and choose where
 * their money goes without the operator having admitted their products to the
 * shared live catalogue. The publish refusal is the useful boundary: it names
 * every missing prerequisite before writing a card, while the sandbox remains
 * a place a merchant can exercise the integration without this production
 * decision.
 */

import type { Card } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { grantLiveApproval } from "../app/merchants.js";
import { SANDBOX_FACILITATOR } from "../config.js";
import {
  type Harness,
  harness,
  type Served,
  serve,
  workOnce,
  workUntilStopped,
} from "../testing/harness.js";

const INVITATION = "the-code-from-the-invitation";
const WALLET = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const LIVE_CHAIN = {
  PAYMENT_NETWORK: "eip155:8453",
  FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
  CDP_API_KEY_ID: "key-id",
  CDP_API_KEY_SECRET: "key-secret",
};

const card = (merchantItemId: string): Card => ({
  merchant_item_id: merchantItemId,
  title: "A room",
  description: "A room sold by the merchant who published this card",
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
});

const asyncCard = (merchantItemId: string): Card => ({
  ...card(merchantItemId),
  result: { activation_code: { type: "string" } },
  fulfillment: "async",
  fulfill_deadline_seconds: 3_600,
});

let open: { harnessed: Harness; served: Served } | null = null;

const started = async (overrides: Record<string, string> = {}) => {
  const harnessed = await harness({
    REGISTRATION_INVITATION: INVITATION,
    ...LIVE_CHAIN,
    ...overrides,
  });
  const served = await serve(harnessed);
  open = { harnessed, served };
  return open;
};

afterEach(async () => {
  await open?.served.close();
  await open?.harnessed.stop();
  open = null;
});

const bearer = (key: string): Record<string, string> => ({ authorization: `Bearer ${key}` });

const freshMerchant = async (served: Served): Promise<string> => {
  const made = await served.call("POST", "/v0/merchants", {
    body: { invitation: INVITATION },
  });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  return (made.body as { secret: string }).secret;
};

const name = async (served: Served, key: string): Promise<void> => {
  const named = await served.call("POST", "/v0/seller-name", {
    body: { seller_name: "Their own shop" },
    headers: bearer(key),
  });
  expect(named.status, JSON.stringify(named.body)).toBe(200);
};

const payTo = async (served: Served, key: string): Promise<void> => {
  const paid = await served.call("POST", "/v0/payout-wallet", {
    body: { payout_wallet: WALLET },
    headers: bearer(key),
  });
  expect(paid.status, JSON.stringify(paid.body)).toBe(200);
};

const publish = (served: Served, key: string, body: unknown) =>
  served.call("POST", "/v0/catalog/publish", { body, headers: bearer(key) });

/**
 * A card that predates approval, as the migration leaves it.
 *
 * The publish door cannot create this state, so the row is written directly.
 * That is the production state this guard is for: existing cards remain in the
 * store, while every buying projection reads the newly denied merchant.
 */
const existingCardWithoutApproval = async (
  harnessed: Harness,
  served: Served,
  body: Card = card("existing-room"),
): Promise<{ readonly itemId: string; readonly key: string; readonly merchantId: string }> => {
  const key = await freshMerchant(served);
  await name(served, key);
  await payTo(served, key);
  const opened = await harnessed.gateway.keyBehind(key);
  if (opened === null) {
    throw new Error("the key this test just registered opens nothing");
  }
  const stored = await harnessed.store.publishCard(opened.merchantId, body, harnessed.now());
  return { itemId: stored.id, key, merchantId: opened.merchantId };
};

/**
 * An order accepted before the approval column existed, attached to a merchant
 * the migration leaves unapproved. The real order machine creates the record;
 * only its stable ownership is changed to model the historical row.
 */
const acceptedOrderWithoutApproval = async (
  harnessed: Harness,
  served: Served,
  body: Card,
): Promise<{ readonly merchantId: string; readonly orderId: string }> => {
  const published = await harnessed.gateway.publishCard(harnessed.merchant.id, body);
  if (!published.ok) {
    throw new Error("the approved fixture merchant could not publish the source card");
  }
  const offered = await harnessed.gateway.beginPurchase(published.id, {});
  if (offered.step !== "pay") {
    throw new Error("the source order was not accepted and priced");
  }
  const historical = await existingCardWithoutApproval(harnessed, served, body);
  const orderId = harnessed.runtime.ids("ord");
  await harnessed.store.addOrder({
    ...offered.order,
    merchantId: historical.merchantId,
    itemId: historical.itemId,
    merchantItemId: body.merchant_item_id,
    order: { ...offered.order.order, id: orderId },
  });
  return { merchantId: historical.merchantId, orderId };
};

describe("live publication before operator approval", () => {
  it("refuses an otherwise ready merchant and writes no card", async () => {
    const { served } = await started();
    const key = await freshMerchant(served);
    await name(served, key);
    await payTo(served, key);

    const refused = await publish(served, key, card("a-room"));

    expect(refused.status).toBe(422);
    const { problems } = (
      refused.body as { error: { problems: { code: string; path: string[] }[] } }
    ).error;
    expect(problems).toContainEqual({
      code: "no_operator_approval",
      path: [],
      message: expect.any(String),
    });

    const own = await served.call("GET", "/v0/cards", { headers: bearer(key) });
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect((own.body as { cards: unknown[] }).cards).toStrictEqual([]);
  });

  it("reports every missing prerequisite beside an invalid card", async () => {
    const { served } = await started();
    const key = await freshMerchant(served);

    const refused = await publish(served, key, {
      ...card("another-room"),
      price: { amount: "not a number", currency: "USD" },
    });

    expect(refused.status).toBe(422);
    const { problems } = (
      refused.body as { error: { problems: { code: string; path: string[] }[] } }
    ).error;
    const codes = problems.map((problem) => problem.code);
    expect(codes).toContain("no_seller_name");
    expect(codes).toContain("no_payout_wallet");
    expect(codes).toContain("no_operator_approval");
    expect(problems.some((problem) => problem.path.includes("price"))).toBe(true);
  });

  it("does not require operator approval or a wallet in the sandbox", async () => {
    const { served } = await started({
      PAYMENT_NETWORK: "eip155:84532",
      FACILITATOR_URL: SANDBOX_FACILITATOR,
      CDP_API_KEY_ID: "",
      CDP_API_KEY_SECRET: "",
    });
    const key = await freshMerchant(served);
    await name(served, key);

    const published = await publish(served, key, card("sandbox-room"));

    expect(published.status, JSON.stringify(published.body)).toBe(200);
  });
});

describe("an existing card before operator approval", () => {
  it("is absent from discovery and refuses both probe and purchase without opening an order", async () => {
    const { served, harnessed } = await started();
    const { itemId, merchantId } = await existingCardWithoutApproval(harnessed, served);

    const catalog = (await served.call("GET", "/x402/catalog")).body as {
      items: { id: string }[];
    };
    const probe = await served.call("GET", `/x402/${itemId}/purchase`);
    const purchase = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
    });

    expect(catalog.items.map((item) => item.id)).not.toContain(itemId);
    expect(probe.status).toBe(409);
    expect(probe.body).toMatchObject({ error: { code: "not_selling" } });
    expect(purchase.status).toBe(409);
    expect(purchase.body).toMatchObject({ error: { code: "not_selling" } });
    expect(await harnessed.gateway.orders(merchantId, undefined)).toStrictEqual([]);
  });

  it("opens neither an order nor a quote request for a handler-priced card", async () => {
    const { served, harnessed } = await started();
    const quoted = { ...card("quoted-room"), price_check: "handler" as const };
    const { itemId, merchantId } = await existingCardWithoutApproval(harnessed, served, quoted);

    const purchase = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
    });

    expect(purchase.status).toBe(409);
    expect(purchase.body).toMatchObject({ error: { code: "not_selling" } });
    expect(await harnessed.gateway.orders(merchantId, undefined)).toStrictEqual([]);
    expect((await harnessed.gateway.poll(merchantId, 10, 0)).envelopes).toStrictEqual([]);
  });

  it("cannot be reopened by either resume switch or changed by republishing", async () => {
    const { served, harnessed } = await started();
    const { itemId, key } = await existingCardWithoutApproval(harnessed, served);

    await served.call("POST", "/v0/selling/pause", { headers: bearer(key) });
    const allResumed = await served.call("POST", "/v0/selling/resume", {
      headers: bearer(key),
    });
    const cardResumed = await served.call("POST", `/v0/cards/${itemId}/resume`, {
      headers: bearer(key),
    });
    const republished = await publish(served, key, {
      ...card("existing-room"),
      price: { amount: "90.00", currency: "USD" },
    });
    const own = (await served.call("GET", "/v0/cards", { headers: bearer(key) })).body as {
      cards: { id: string; selling: string; card: Card }[];
    };
    const stored = own.cards.find((entry) => entry.id === itemId);

    expect(allResumed.body).toMatchObject({
      selling: "open",
      cards: expect.arrayContaining([expect.objectContaining({ id: itemId, selling: "paused" })]),
    });
    expect(cardResumed.body).toMatchObject({ selling: "paused" });
    expect(republished.status).toBe(422);
    expect(stored?.selling).toBe("paused");
    expect(stored?.card.price).toStrictEqual({ amount: "80.00", currency: "USD" });
    expect((await served.call("GET", `/x402/${itemId}/purchase`)).status).toBe(409);
  });

  it("becomes sellable immediately after the private grant without republishing", async () => {
    const { served, harnessed } = await started();
    const { itemId, merchantId } = await existingCardWithoutApproval(harnessed, served);
    expect((await served.call("GET", `/x402/${itemId}/purchase`)).status).toBe(409);

    const granted = await grantLiveApproval(harnessed.store, merchantId, harnessed.now());

    expect(granted).toMatchObject({ changed: true, merchant: { id: merchantId } });
    expect((await served.call("GET", `/x402/${itemId}/purchase`)).status).toBe(402);
    const catalog = (await served.call("GET", "/x402/catalog")).body as {
      items: { id: string }[];
    };
    expect(catalog.items.map((item) => item.id)).toContain(itemId);
  });
});

describe("an order accepted before operator approval existed", () => {
  it("still verifies payment, delivers, settles and writes its receipt", async () => {
    const { served, harnessed } = await started();
    const { merchantId, orderId } = await acceptedOrderWithoutApproval(
      harnessed,
      served,
      card("accepted-room"),
    );
    expect((await harnessed.store.merchantById(merchantId))?.liveApprovedAt).toBeNull();

    const worker = workUntilStopped(harnessed, {
      merchantId,
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    const bought = await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    await worker.stop();

    expect(bought.step).toBe("settled");
    if (bought.step !== "settled") throw new Error("the accepted order did not settle");
    expect(bought.order.order.state).toBe("delivered");
    expect(bought.delivery).toStrictEqual({ access_code: "SESAME" });
    expect((await harnessed.store.receiptForOrder(orderId))?.outcome).toBe("delivered");
    expect(harnessed.facilitator.verifies).toHaveLength(1);
    expect(harnessed.facilitator.settles).toHaveLength(1);
    expect((await harnessed.store.merchantById(merchantId))?.liveApprovedAt).toBeNull();
  });

  it("still reaches refund due when a paid asynchronous order is refused", async () => {
    const { served, harnessed } = await started();
    const { merchantId, orderId } = await acceptedOrderWithoutApproval(
      harnessed,
      served,
      asyncCard("accepted-esim"),
    );
    expect((await harnessed.store.merchantById(merchantId))?.liveApprovedAt).toBeNull();

    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    await workOnce(harnessed, { merchantId, onOrder: () => ({ accepted: {} }) });
    const refused = await harnessed.gateway.refuseOrder(merchantId, orderId, {
      code: "out_of_stock",
      message: "the supplier has none",
    });

    expect(refused).toStrictEqual({ ok: true, result: "refused" });
    expect((await harnessed.store.orderById(orderId))?.order.state).toBe("refund_due");
    expect(await harnessed.store.receiptForOrder(orderId)).toBeNull();
    expect(harnessed.facilitator.verifies).toHaveLength(1);
    expect(harnessed.facilitator.settles).toHaveLength(1);
    expect((await harnessed.store.merchantById(merchantId))?.liveApprovedAt).toBeNull();
  });
});
