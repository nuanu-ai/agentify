import type { OrderWithStatus } from "@nuanu-ai/agentify-contracts";
import { describe, expect, it } from "vitest";
import { recoverWooOrder, type WooRecoveryParts } from "./woo-recovery.js";
import type { EligibleWooProduct, OrderMade, WooOrderRead } from "./woo-shop.js";
import { memoryWooShops, type WooOrderFacts } from "./woo-shops.js";

const NOW = new Date("2026-09-18T10:00:00.000Z");
const EMAIL = "merchant@example.com";
const FACTS: WooOrderFacts = {
  shopOrigin: "https://shop.example.com",
  connectionRevision: "grant_1",
  merchantItemId: "woo_merchant_22",
  productId: "22",
  productFingerprint: "accepted-download-fingerprint",
  amount: "0.01",
  currency: "USD",
};
const PRODUCT: EligibleWooProduct = {
  productId: "22",
  downloadId: "download_owned",
  fileName: "agentify-test.txt",
  price: { amount: "0.01", currency: "USD" },
  fingerprint: "accepted-download-fingerprint",
};

const gatewayOrder = (status: OrderWithStatus["status"]): OrderWithStatus => ({
  id: "ord_1",
  merchant_item_id: FACTS.merchantItemId,
  params: {},
  price: {
    amount: FACTS.amount,
    currency: FACTS.currency,
    at: "2026-09-18T09:59:00.000Z",
    as_of: "2026-09-18T09:58:00.000Z",
  },
  test: true,
  status,
});

const shopOrder = (changes: Partial<WooOrderRead> = {}): WooOrderRead => ({
  id: "13",
  number: "WOO-13",
  orderKey: "wc_order_13",
  status: "processing",
  currency: "USD",
  total: "0.01",
  totalTax: "0.00",
  paymentMethod: "agentify",
  transactionId: "ord_1",
  billingEmail: EMAIL,
  productId: "22",
  quantity: 1,
  subtotal: "0.01",
  lineTotal: "0.01",
  lineTax: "0.00",
  agentifyOrderIds: ["ord_1"],
  ...changes,
});

const setup = async (phase: "precreate_refused" | "create_unknown") => {
  const shops = memoryWooShops();
  await shops.connect({
    accountId: "acc_1",
    shopUrl: FACTS.shopOrigin,
    consumerKey: "ck_new",
    consumerSecret: "cs_new",
    permissions: "read_write",
    revision: "grant_2",
    connectedAt: NOW,
  });
  if (phase === "precreate_refused") {
    await shops.recordPrecreateRefusal("acc_1", "ord_1", FACTS, NOW);
  } else {
    await shops.claimOrder("acc_1", "ord_1", FACTS, NOW);
  }
  return shops;
};

const parts = (
  shops: Awaited<ReturnType<typeof setup>>,
  overrides: Partial<WooRecoveryParts> = {},
) => {
  let delivered = 0;
  let created = 0;
  let read = 0;
  let gatewayReads = 0;
  const made: OrderMade = {
    ok: true,
    id: "13",
    number: "WOO-13",
    orderKey: "wc_order_13",
    downloadId: PRODUCT.downloadId,
  };
  const value: WooRecoveryParts = {
    shops,
    identity: {
      byId: async () => ({
        id: "acc_1",
        email: EMAIL,
        confirmed: true,
        merchant: { id: "m_1", key: "csk_test_merchant" },
      }),
    },
    gatewayForKey: () => ({
      getOrder: async () => {
        gatewayReads += 1;
        return {
          ok: true as const,
          document: gatewayOrder(gatewayReads === 1 ? "refund_due" : "delivered"),
        };
      },
      deliverOrder: async () => {
        delivered += 1;
        return {
          ok: true as const,
          document: { ok: true as const, result: "debt_closed_by_delivery" as const },
        };
      },
    }),
    inspectProduct: async () => ({ ok: true, product: PRODUCT }),
    createOrder: async () => {
      created += 1;
      return made;
    },
    readOrder: async () => {
      read += 1;
      return { ok: true, order: shopOrder() };
    },
    now: () => NOW,
    ...overrides,
  };
  return { value, counts: () => ({ delivered, created, read }) };
};

describe("exact Woo order recovery", () => {
  it("retries a definite pre-create refusal once after a same-origin reconnect", async () => {
    const shops = await setup("precreate_refused");
    const test = parts(shops);

    expect(await recoverWooOrder({ orderId: "ord_1" }, test.value)).toEqual({
      ok: true,
      state: "delivered",
      orderId: "ord_1",
      wooOrderId: "13",
    });
    expect(test.counts()).toEqual({ delivered: 1, created: 1, read: 0 });
    expect(await shops.recoveryOrder("ord_1")).toMatchObject({ phase: "placed" });
  });

  it("does not reopen a definite refusal under the same grant", async () => {
    const shops = await setup("precreate_refused");
    const sameGrant = await shops.connectionOf("acc_1");
    if (sameGrant === null) throw new Error("the test shop was not connected");
    await shops.connect({
      ...sameGrant,
      revision: "grant_1",
    });
    const test = parts(shops);

    expect(await recoverWooOrder({ orderId: "ord_1" }, test.value)).toMatchObject({
      ok: false,
      state: "refused",
    });
    expect(test.counts()).toEqual({ delivered: 0, created: 0, read: 0 });
  });

  it("does not recover a changed download that no longer matches the accepted quote", async () => {
    const shops = await setup("precreate_refused");
    const test = parts(shops, {
      inspectProduct: async () => ({
        ok: true,
        product: { ...PRODUCT, fingerprint: "replacement-download-fingerprint" },
      }),
    });

    expect(await recoverWooOrder({ orderId: "ord_1" }, test.value)).toMatchObject({
      ok: false,
      state: "refused",
    });
    expect(test.counts()).toEqual({ delivered: 0, created: 0, read: 0 });
  });

  it("binds an unknown committed create by one verified Woo order id without another POST", async () => {
    const shops = await setup("create_unknown");
    const test = parts(shops);

    expect(await recoverWooOrder({ orderId: "ord_1", wooOrderId: "13" }, test.value)).toMatchObject(
      { ok: true, state: "delivered", wooOrderId: "13" },
    );
    expect(test.counts()).toEqual({ delivered: 1, created: 0, read: 1 });
  });

  it("delivers an already-bound result after the shop is disconnected", async () => {
    const shops = await setup("create_unknown");
    await shops.recordOrder(
      "ord_1",
      {
        id: "13",
        number: "WOO-13",
        permission: {
          shopOrigin: FACTS.shopOrigin,
          productId: FACTS.productId,
          orderKey: "wc_order_13",
          downloadId: PRODUCT.downloadId,
          fileName: PRODUCT.fileName,
          emailUid: "a".repeat(64),
          orderNumber: "WOO-13",
        },
      },
      NOW,
    );
    await shops.forget("acc_1");
    const test = parts(shops);

    expect(await recoverWooOrder({ orderId: "ord_1" }, test.value)).toMatchObject({
      ok: true,
      state: "delivered",
    });
    expect(test.counts()).toEqual({ delivered: 1, created: 0, read: 0 });
  });

  it("keeps an unknown create unbound when the exact Woo order does not correlate", async () => {
    const shops = await setup("create_unknown");
    const test = parts(shops, {
      readOrder: async () => ({
        ok: true,
        order: shopOrder({ transactionId: "some_other_order" }),
      }),
    });

    expect(await recoverWooOrder({ orderId: "ord_1", wooOrderId: "13" }, test.value)).toMatchObject(
      { ok: false, state: "refused" },
    );
    expect(test.counts()).toEqual({ delivered: 0, created: 0, read: 0 });
    expect(await shops.recoveryOrder("ord_1")).toMatchObject({
      phase: "create_unknown",
      placed: null,
    });
  });
});
