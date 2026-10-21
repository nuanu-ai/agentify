/**
 * The product analytics an order gives as it lives: one event when it is
 * written, one per result of each payment attempt, and one each time the
 * outcome its buyer reads changes. They are read back from the memory store,
 * where the flows record them through the same store methods Postgres runs.
 */

import { deadlines } from "@agentify/core";
import { type Card, CardSchema, type ShipTo } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { AnalyticsEvent } from "../analytics/index.js";
import type { PaymentRecoveryContext } from "../ports/facilitator.js";
import type { StoredOrder } from "../ports/store.js";
import {
  type Harness,
  harness,
  type Served,
  serve,
  theMerchantKey,
  workOnce,
  workUntilStopped,
} from "../testing/harness.js";
import { channelOf, orderChanged } from "./order-analytics.js";

const PAYER = "0x0000000000000000000000000000000000000008";
const TRANSACTION = `0x${"a".repeat(64)}`;

const card: Card = {
  merchant_item_id: "esim-7d",
  title: "Seven days of data",
  description: "Seven days of mobile data",
  price: { amount: "12.00", currency: "USD" },
  result: { activation_code: { type: "string" } },
  fulfillment: "async",
};

const parcelCard: Card = CardSchema.parse({
  merchant_item_id: "beans-1kg",
  title: "Coffee beans, one kilogram",
  description: "Roasted in Bali this week and sent by courier.",
  price: { amount: "18.00", currency: "USD" },
  fulfillment: "ship",
  ship_within_seconds: 172_800,
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

/** The live channel, as the gateway derives it from the chain it is paid on. */
const LIVE = {
  PAYMENT_NETWORK: "eip155:8453",
  FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
  CDP_API_KEY_ID: "key-id",
  CDP_API_KEY_SECRET: "secret",
};

let open: Harness | null = null;
let served: Served | null = null;
afterEach(async () => {
  await served?.close();
  served = null;
  await open?.stop();
  open = null;
});

const recorded = (h: Harness, name: AnalyticsEvent["name"]): AnalyticsEvent[] =>
  h.store.recordedAnalytics.map(({ event }) => event).filter((event) => event.name === name);

const outcomes = (h: Harness): unknown[] =>
  recorded(h, "agc_order_outcome_changed").map((event) => event.fields);

const payments = (h: Harness): unknown[] =>
  recorded(h, "agc_payment_result").map((event) => event.fields);

const published = async (
  h: Harness,
  fulfillment: Card["fulfillment"] = "async",
  integration: "api" | "woocommerce" = "api",
): Promise<string> => {
  const made = await h.gateway.publishCard(h.merchant.id, { ...card, fulfillment }, integration);
  if (!made.ok) throw new Error(`the card was refused: ${JSON.stringify(made.error)}`);
  return made.id;
};

/** An order priced and waiting for its payment. */
const priced = async (h: Harness, itemId: string): Promise<string> => {
  const offered = await h.gateway.beginPurchase(itemId, {});
  if (offered.step !== "pay") throw new Error(`no price was offered: ${offered.step}`);
  return offered.order.order.id;
};

const stored = async (h: Harness, orderId: string): Promise<StoredOrder> => {
  const found = await h.store.orderById(orderId);
  if (found === null) throw new Error(`${orderId} is not written down`);
  return found;
};

/** A harness whose payments carry what chain recovery needs to find them later. */
async function recoverable(fulfillment: "async" | "sync") {
  const h = await harness({ SETTLE_RESPONSE_MS: "5000" });
  open = h;
  const itemId = await published(h, fulfillment);
  const merchant = await h.store.merchantById(h.merchant.id);
  const payTo = merchant?.payoutWallet.split?.address;
  if (payTo === undefined) throw new Error("the merchant has no split");
  const recovery: PaymentRecoveryContext = {
    kind: "evm-exact-eip3009",
    network: "eip155:84532",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    payer: PAYER,
    payTo,
    amount: "12000000",
    validAfter: "0",
    validBefore: String(Math.floor(h.now() / 1000) + 600),
    nonce: `0x${"1".repeat(64)}`,
    notBefore: String(Math.floor(h.now() / 1000) - 30),
  };
  h.facilitator.willVerify({ verified: true, payer: PAYER, validUntil: null, recovery });
  return { h, recovery, payTo, orderId: await priced(h, itemId) };
}

/** Every deadline the order is waiting on, run out, as its reminders would. */
async function runOut(h: Harness, orderId: string): Promise<void> {
  for (const deadline of deadlines((await stored(h, orderId)).order)) {
    await h.gateway.runner.apply(orderId, {
      kind: "deadline_expired",
      deadline: deadline.kind,
      at: deadline.at,
    });
  }
}

describe("the order an agent's purchase writes", () => {
  it("is recorded once, naming the order, its merchant and its card, as the buying agent's", async () => {
    open = await harness();
    const itemId = await published(open);

    const orderId = await priced(open, itemId);

    const created = recorded(open, "agc_order_created");
    expect(created).toStrictEqual([
      {
        name: "agc_order_created",
        actor: "buyer_agent",
        source: "gateway",
        refs: { order: orderId, merchant: open.merchant.id, item: itemId },
        fields: { integration: "api", money_mode: "test", network: "base_sepolia" },
      },
    ]);
    const at = open.store.recordedAnalytics.find(({ event }) => event.name === "agc_order_created");
    expect(at?.at).toStrictEqual(
      new Date((await stored(open, orderId)).order.timestamps.createdAt),
    );
  });

  it("is not recorded again when the agent repeats the purchase or reads its status", async () => {
    open = await harness();
    const orderId = await priced(open, await published(open));

    await open.gateway.payPurchase(orderId, "PAYMENT", "fp-1");
    await open.gateway.payPurchase(orderId, "PAYMENT", "fp-1");
    await open.gateway.orderById(orderId);

    expect(recorded(open, "agc_order_created")).toHaveLength(1);
  });

  it("is not recorded for a catalog read or a purchase refused before any order is written", async () => {
    open = await harness();
    const itemId = await published(open);

    await open.gateway.catalog();
    await open.gateway.paidResource(itemId);
    expect((await open.gateway.beginPurchase("item_nope", {})).step).toBe("no_such_item");
    await open.gateway.setSelling(open.merchant.id, "paused");
    expect((await open.gateway.beginPurchase(itemId, {})).step).toBe("not_selling");

    expect(recorded(open, "agc_order_created")).toStrictEqual([]);
  });

  it("names the WooCommerce connector as the integration of an order for a card it published", async () => {
    open = await harness();
    await open.gateway.sellThrough(open.merchant.id, "woocommerce");
    const itemId = await published(open, "async", "woocommerce");

    await priced(open, itemId);

    expect(recorded(open, "agc_order_created")[0]?.fields).toMatchObject({
      integration: "woocommerce",
    });
  });

  it("calls the money real on the live channel's mainnet, and test everywhere else", async () => {
    open = await harness(LIVE);
    await priced(open, await published(open));
    expect(recorded(open, "agc_order_created")[0]?.fields).toStrictEqual({
      integration: "api",
      money_mode: "real",
      network: "base",
    });
    await open.stop();

    open = await harness({ FACILITATOR_URL: "sandbox:scripted" });
    await priced(open, await published(open));
    expect(recorded(open, "agc_order_created")[0]?.fields).toMatchObject({
      money_mode: "test",
      network: "base_sepolia",
    });
  });
});

describe("a payment attempt's result", () => {
  it("is recorded paid once, with the stored price's exact amount and currency, when the charge settles", async () => {
    open = await harness();
    const orderId = await priced(open, await published(open));

    await open.gateway.payPurchase(orderId, "PAYMENT", "fp-1");
    await open.gateway.payPurchase(orderId, "PAYMENT", "fp-1");

    const attempt = (await stored(open, orderId)).paymentAttempt;
    expect(recorded(open, "agc_payment_result")).toStrictEqual([
      {
        name: "agc_payment_result",
        actor: "system",
        source: "gateway",
        refs: { order: orderId, merchant: open.merchant.id, attempt: attempt?.id },
        fields: {
          payment_state: "paid",
          money_mode: "test",
          network: "base_sepolia",
          amount: "12.00",
          currency: "USD",
        },
      },
    ]);
  });

  it("is recorded not paid, with the reason, when the charge is reported failed", async () => {
    open = await harness();
    const orderId = await priced(open, await published(open));
    open.facilitator.willSettle({ settled: false, reason: "insufficient funds" });

    await open.gateway.payPurchase(orderId, "PAYMENT", "fp-1");

    expect(payments(open)).toStrictEqual([
      {
        payment_state: "not_paid",
        money_mode: "test",
        network: "base_sepolia",
        reason_code: "payment_not_settled",
      },
    ]);
  });

  it("is recorded unresolved when the outcome becomes unknown, and paid for the same attempt when recovery finds it, with one charge", async () => {
    const { h, orderId } = await recoverable("async");
    h.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
    await h.gateway.payPurchase(orderId, "PAYMENT", "fp-original");
    h.advance(20_000);
    await runOut(h, orderId);
    h.runtime.facilitator.reconcile = async () => ({
      settled: true,
      transaction: TRANSACTION,
      executedAt: h.now() - 1_000,
    });

    await h.gateway.runner.reconcilePayments();

    const results = recorded(h, "agc_payment_result");
    expect(results.map((event) => event.fields)).toStrictEqual([
      {
        payment_state: "unresolved",
        money_mode: "test",
        network: "base_sepolia",
        reason_code: "timeout",
      },
      {
        payment_state: "paid",
        money_mode: "test",
        network: "base_sepolia",
        amount: "12.00",
        currency: "USD",
      },
    ]);
    const attempt = (await stored(h, orderId)).paymentAttempt?.id;
    expect(results.map((event) => event.refs)).toStrictEqual([
      { order: orderId, merchant: h.merchant.id, attempt },
      { order: orderId, merchant: h.merchant.id, attempt },
    ]);
    expect(h.facilitator.settles).toHaveLength(1);
  });

  it("is not recorded again while recovery keeps finding the outcome unknown", async () => {
    const { h, orderId } = await recoverable("async");
    h.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
    await h.gateway.payPurchase(orderId, "PAYMENT", "fp-original");
    h.advance(20_000);
    await runOut(h, orderId);
    let block = 100;
    h.runtime.facilitator.reconcile = async () => {
      block += 50;
      return { settled: "unknown", reason: "more blocks to read", nextBlock: String(block) };
    };

    await h.gateway.runner.reconcilePayments();
    await h.gateway.runner.reconcilePayments();

    expect(payments(h)).toStrictEqual([
      {
        payment_state: "unresolved",
        money_mode: "test",
        network: "base_sepolia",
        reason_code: "timeout",
      },
    ]);
  });

  it("is not recorded for a price, a verified payment or a charge still in flight", async () => {
    const { h, orderId, recovery, payTo } = await recoverable("sync");
    await h.store.claimPayment("fp-original", orderId);

    await h.gateway.runner.presentVerifiedPayment(orderId, PAYER, "PAYMENT", payTo, h.now(), {
      recovery,
      fingerprint: "fp-original",
    });

    expect(payments(h)).toStrictEqual([]);
  });

  it("is not recorded paid off a payment stage that says settled with no saved completion behind it", async () => {
    open = await harness();
    const quoted = await stored(open, await priced(open, await published(open)));
    const { paymentAttempt: _none, ...unattempted } = quoted;

    const events = orderChanged(
      { ...unattempted, order: { ...quoted.order, state: "fulfilled", payment: "settling" } },
      { ...unattempted, order: { ...quoted.order, state: "delivered", payment: "settled" } },
      channelOf(open.runtime.config),
      "system",
    );

    expect(events.map((event) => event.name)).toStrictEqual(["agc_order_outcome_changed"]);
    expect(events[0]?.fields).toMatchObject({ outcome: "delivered", payment_state: "unresolved" });
  });

  it("leaves the amount out, and never says zero, where the order holds no price", async () => {
    open = await harness();
    const orderId = await priced(open, await published(open));
    await open.gateway.payPurchase(orderId, "PAYMENT", "fp-1");
    const paid = await stored(open, orderId);
    const attempt = paid.paymentAttempt;
    if (attempt === undefined) throw new Error("no attempt");
    const unpriced = { ...paid.order, price: null };

    const events = orderChanged(
      { ...paid, order: unpriced, paymentAttempt: { ...attempt, completion: null } },
      { ...paid, order: unpriced },
      channelOf(open.runtime.config),
      "system",
    );

    expect(events.find((event) => event.name === "agc_payment_result")?.fields).toStrictEqual({
      payment_state: "paid",
      money_mode: "test",
      network: "base_sepolia",
    });
  });
});

describe("the outcome the buyer reads", () => {
  it("is recorded delivered, with the payment as it stands, when the goods arrive", async () => {
    open = await harness();
    const orderId = await priced(open, await published(open));
    await open.gateway.payPurchase(orderId, "PAYMENT", "fp-1");

    await workOnce(open, { onOrder: () => ({ delivered: { activation_code: "CODE-1" } }) });

    expect((await stored(open, orderId)).order.state).toBe("delivered");
    expect(recorded(open, "agc_order_outcome_changed")).toStrictEqual([
      {
        name: "agc_order_outcome_changed",
        actor: "unknown",
        source: "gateway",
        refs: { order: orderId, merchant: open.merchant.id },
        fields: { outcome: "delivered", payment_state: "paid", money_mode: "test" },
      },
    ]);
  });

  it("is not recorded at the order's birth, nor for a step that leaves it in progress", async () => {
    open = await harness();
    const orderId = await priced(open, await published(open));
    await open.gateway.payPurchase(orderId, "PAYMENT", "fp-1");

    await workOnce(open, { onOrder: () => ({ accepted: {} }) });

    expect((await stored(open, orderId)).order.state).toBe("dispatched");
    expect(outcomes(open)).toStrictEqual([]);
  });

  it("is attributed to the merchant's worker when the goods come through their key", async () => {
    open = await harness();
    served = await serve(open);
    const orderId = await priced(open, await published(open));
    await open.gateway.payPurchase(orderId, "PAYMENT", "fp-1");

    const delivered = await served.call("POST", `/v0/orders/${orderId}/deliver`, {
      headers: { authorization: `Bearer ${theMerchantKey("test")}` },
      body: { activation_code: "CODE-1" },
    });

    expect(delivered.status).toBe(200);
    expect(recorded(open, "agc_order_outcome_changed").map((event) => event.actor)).toStrictEqual([
      "merchant_worker",
    ]);
  });

  it("is recorded delivered_unpaid, with the reason, when goods were made and the charge failed", async () => {
    const { h, orderId, recovery, payTo } = await recoverable("sync");
    await h.store.claimPayment("fp-original", orderId);
    await h.gateway.runner.presentVerifiedPayment(orderId, PAYER, "PAYMENT", payTo, h.now(), {
      recovery,
      fingerprint: "fp-original",
    });
    h.facilitator.willSettle({ settled: false, reason: "payment failed" });

    await h.gateway.runner.apply(
      orderId,
      { kind: "handler_delivered", at: h.now() },
      { delivery: { activation_code: "KEPT" } },
    );

    expect((await stored(h, orderId)).order.state).toBe("delivered_unpaid");
    expect(outcomes(h)).toStrictEqual([
      {
        outcome: "delivered_unpaid",
        payment_state: "not_paid",
        money_mode: "test",
        reason_code: "payment_not_settled",
      },
    ]);
  });

  it("is recorded shipped when a parcel's shipment is recorded", async () => {
    open = await harness();
    const h = open;
    const itemId = (await h.store.publishCard(h.merchant.id, parcelCard, h.now())).id;
    const worker = workUntilStopped(h, {
      onQuote: () => ({
        available: true,
        price: { amount: "21.00", currency: "USD" },
        as_of: "2026-08-26T10:15:00Z",
      }),
    });
    const offered = await h.gateway.beginPurchase(itemId, {}, address);
    await worker.stop();
    if (offered.step !== "pay") throw new Error(`no price was offered: ${offered.step}`);
    const orderId = offered.order.order.id;
    await h.gateway.payPurchase(orderId, "PAYMENT", "fp-1", address);
    await h.gateway.acceptOrder(h.merchant.id, orderId, {});

    await h.gateway.deliverOrder(h.merchant.id, orderId, {
      carrier: "JNE",
      tracking_number: "0000000000000000",
    });

    expect(outcomes(h)).toStrictEqual([
      { outcome: "shipped", payment_state: "paid", money_mode: "test" },
    ]);
    expect(payments(h)).toMatchObject([{ payment_state: "paid", amount: "21.00" }]);
  });

  it("is recorded fulfillment_closed, claiming no refund, when the merchant closes a paid order", async () => {
    open = await harness();
    const orderId = await priced(open, await published(open));
    await open.gateway.payPurchase(orderId, "PAYMENT", "fp-1");

    await open.gateway.closeOrder(open.merchant.id, orderId, { message: "We agreed an offset." });

    expect(outcomes(open)).toStrictEqual([
      { outcome: "fulfillment_closed", payment_state: "paid", money_mode: "test" },
    ]);
  });

  it("goes expired, back to in progress, then delivered when a late charge is found, with one payment", async () => {
    const { h, orderId, recovery, payTo } = await recoverable("sync");
    await h.store.claimPayment("fp-original", orderId);
    await h.gateway.runner.presentVerifiedPayment(orderId, PAYER, "PAYMENT", payTo, h.now(), {
      recovery,
      fingerprint: "fp-original",
    });
    h.advance(60_000);
    await runOut(h, orderId);
    h.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
    await h.gateway.runner.apply(
      orderId,
      { kind: "handler_delivered", at: h.now() },
      { delivery: { activation_code: "LATE" } },
    );
    await h.gateway.runner.presentVerifiedPayment(orderId, PAYER, "PAYMENT", payTo, h.now(), {
      recovery,
      fingerprint: "fp-original",
    });
    h.advance(60_000);
    await runOut(h, orderId);
    h.runtime.facilitator.reconcile = async () => ({
      settled: true,
      transaction: TRANSACTION,
      executedAt: h.now() - 59_000,
    });

    await h.gateway.runner.reconcilePayments();

    expect((await stored(h, orderId)).order.state).toBe("delivered");
    expect(outcomes(h)).toStrictEqual([
      {
        outcome: "expired",
        payment_state: "not_paid",
        money_mode: "test",
        reason_code: "deadline_expired",
      },
      { outcome: "in_progress", payment_state: "unresolved", money_mode: "test" },
      { outcome: "delivered", payment_state: "paid", money_mode: "test" },
    ]);
    expect(
      payments(h).map((fields) => (fields as { payment_state: string }).payment_state),
    ).toEqual(["unresolved", "paid"]);
    expect(h.facilitator.settles).toHaveLength(1);
  });
});

describe("what an order's analytics carry", () => {
  it("names the order, the payment and the charge only by reference, never in a property", async () => {
    open = await harness();
    const orderId = await priced(open, await published(open));
    await open.gateway.payPurchase(orderId, "PAYMENT-AUTHORIZATION", "fp-secret");
    await workOnce(open, { onOrder: () => ({ delivered: { activation_code: "CODE-1" } }) });
    const order = await stored(open, orderId);

    const events = open.store.recordedAnalytics.map(({ event }) => event);
    expect(events.map((event) => event.name)).toStrictEqual([
      "agc_order_created",
      "agc_payment_result",
      "agc_order_outcome_changed",
    ]);
    const secrets = [
      orderId,
      order.paymentRef,
      "PAYMENT-AUTHORIZATION",
      "fp-secret",
      order.settlement?.transaction ?? "no transaction",
      order.merchantId,
      order.itemId,
    ];
    for (const event of events) {
      const properties = JSON.stringify(event.fields);
      for (const secret of secrets) expect(properties).not.toContain(secret);
    }
    const attempt = events.find((event) => event.name === "agc_payment_result")?.refs;
    expect(attempt).toMatchObject({ attempt: order.paymentAttempt?.id });
    for (const secret of secrets.slice(1, 5)) {
      expect(Object.values(attempt ?? {})).not.toContain(secret);
    }
  });

  it("records nothing about a change whose write is rolled back", async () => {
    const h = await harness();
    open = h;
    const orderId = await priced(h, await published(h));
    const before = h.store.recordedAnalytics.length;
    const found = await stored(h, orderId);
    const channel = channelOf(h.runtime.config);

    await expect(
      h.store.withOrder(
        orderId,
        () => ({
          save: { ...found, order: { ...found.order, state: "expired" } },
          alongside: [{ kind: "retain_payment", fingerprint: "nobody's", orderId }],
          result: null,
        }),
        undefined,
        (was, now) =>
          orderChanged(was, now, channel, "system").map((event) => ({ event, at: h.now() })),
      ),
    ).rejects.toThrow("the payment claim no longer belongs to this order");

    expect(h.store.recordedAnalytics).toHaveLength(before);
    expect((await stored(h, orderId)).order.state).toBe(found.order.state);
  });
});
