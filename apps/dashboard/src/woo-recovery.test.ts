import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PAYOUT_SPLIT_NETWORKS, payoutSplitFor, payoutSplitNetworkOf } from "@agentify/gateway";
import type { OrderWithStatus } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { percentOf, sharesOf } from "./shares.js";
import { recoverWooOrder, recoverWooOrderAs, type WooRecoveryParts } from "./woo-recovery.js";
import { wooRecoveryPagesFor } from "./woo-recovery-pages.js";
import {
  type EligibleWooProduct,
  type OrderMade,
  readTheOrderInTheShop,
  type SoldItem,
  type WooOrderRead,
} from "./woo-shop.js";
import { memoryWooShops, type WooOrderFacts } from "./woo-shops.js";

/** The split the sale's payment was checked against, by the gateway's own rule. */
const PAID_INTO = {
  ...payoutSplitFor(
    payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, "eip155:84532"),
    "m_1",
    "0xde3F8C4422A7F8C94bce9Cc2Ec118665108148EF",
  ),
  recordedAt: Date.parse("2026-09-18T09:00:00.000Z"),
};

const NOW = new Date("2026-09-18T10:00:00.000Z");
const EMAIL = "merchant@example.com";
const FACTS: WooOrderFacts = {
  shopOrigin: "https://shop.example.com",
  connectionRevision: "grant_1",
  merchantItemId: "woo_merchant_22",
  priceId: "prc_1",
  productId: "22",
  productFingerprint: "accepted-download-fingerprint",
  amount: "0.01",
  currency: "USD",
};
const PRODUCT: EligibleWooProduct = {
  kind: "download",
  productId: "22",
  downloadId: "download_owned",
  fileName: "agentify-test.txt",
  price: { amount: "0.01", currency: "USD" },
  fingerprint: "accepted-download-fingerprint",
};

const gatewayOrder = (status: OrderWithStatus["status"]): OrderWithStatus => ({
  payment_status: status === "payment_unresolved" ? "unresolved" : "paid",
  id: "ord_1",
  merchant_item_id: FACTS.merchantItemId,
  params: {},
  price: {
    amount: FACTS.amount,
    currency: FACTS.currency,
    at: "2026-09-18T09:59:00.000Z",
    as_of: "2026-09-18T09:58:00.000Z",
  },
  price_id: FACTS.priceId,
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
  await shops.recordQuote(
    "acc_1",
    FACTS.priceId,
    FACTS.merchantItemId,
    FACTS.productFingerprint,
    new Date("2026-09-18T11:00:00.000Z"),
    NOW,
  );
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
  let status: "unfulfilled" | "delivered" = "unfulfilled";
  const sold: SoldItem[] = [];
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
        merchant: { id: "m_1" },
      }),
    },
    gatewayFor: () => ({
      getOrder: async () => {
        return {
          ok: true as const,
          document: gatewayOrder(status),
        };
      },
      deliverOrder: async () => {
        delivered += 1;
        status = "delivered";
        return {
          ok: true as const,
          document: { ok: true as const, result: "delivered_late" as const },
        };
      },
      paidInto: async () => ({ ok: true as const, document: PAID_INTO }),
    }),
    inspectProduct: async () => ({ ok: true, product: PRODUCT }),
    createOrder: async (_keys, item) => {
      created += 1;
      sold.push(item);
      return made;
    },
    readOrder: async () => {
      read += 1;
      return { ok: true, order: shopOrder() };
    },
    now: () => NOW,
    ...overrides,
  };
  return { value, counts: () => ({ delivered, created, read }), sold };
};

const OWNER = {
  id: "acc_1",
  email: EMAIL,
  confirmed: true,
  merchant: { id: "m_1" },
};

describe("a merchant recovering their own WooCommerce delivery", () => {
  it("answers another account's order like an unknown one before calling the gateway or shop", async () => {
    const shops = await setup("create_unknown");
    let gatewayCalls = 0;
    const test = parts(shops, {
      gatewayFor: () => {
        gatewayCalls += 1;
        throw new Error("a stranger's merchant must never become the caller");
      },
    });
    const stranger = { ...OWNER, id: "acc_other", merchant: { id: "m_other" } };

    const foreign = await recoverWooOrderAs(
      stranger,
      { orderId: "ord_1", wooOrderId: "13" },
      test.value,
    );
    const missing = await recoverWooOrderAs(
      stranger,
      { orderId: "ord_missing", wooOrderId: "13" },
      test.value,
    );

    expect(foreign).toEqual(missing);
    expect(foreign).toMatchObject({ ok: false, state: "refused" });
    expect(gatewayCalls).toBe(0);
    expect(test.counts()).toEqual({ delivered: 0, created: 0, read: 0 });
  });

  it("uses the authenticated merchant and never creates a shop order", async () => {
    const shops = await setup("create_unknown");
    const test = parts(shops, {
      identity: {
        byId: async () => {
          throw new Error("the saved account is not authority");
        },
      },
    });

    expect(
      await recoverWooOrderAs(OWNER, { orderId: "ord_1", wooOrderId: "13" }, test.value),
    ).toMatchObject({ ok: true, state: "delivered", wooOrderId: "13" });
    expect(test.counts()).toEqual({ delivered: 1, created: 0, read: 1 });
  });

  it("does not expose pre-create retry as a merchant recovery action", async () => {
    const shops = await setup("precreate_refused");
    const test = parts(shops);

    expect(await recoverWooOrderAs(OWNER, { orderId: "ord_1" }, test.value)).toMatchObject({
      ok: false,
      state: "refused",
    });
    expect(test.counts()).toEqual({ delivered: 0, created: 0, read: 0 });
    expect((await shops.recoveryOrder("ord_1"))?.phase).toBe("precreate_refused");
  });

  it("replays the same exact binding after a lost answer without reading or creating in the shop again", async () => {
    const shops = await setup("create_unknown");
    const test = parts(shops);
    const request = { orderId: "ord_1", wooOrderId: "13" };

    expect(await recoverWooOrderAs(OWNER, request, test.value)).toMatchObject({ ok: true });
    expect(await recoverWooOrderAs(OWNER, request, test.value)).toMatchObject({ ok: true });
    expect(
      await recoverWooOrderAs(OWNER, { ...request, wooOrderId: "14" }, test.value),
    ).toMatchObject({ ok: false, state: "refused" });
    expect(test.counts()).toEqual({ delivered: 2, created: 0, read: 1 });
    expect((await shops.recoveryOrder("ord_1"))?.placed?.id).toBe("13");
  });

  it("keeps an unreadable exact shop order unresolved and allows the same check again", async () => {
    const shops = await setup("create_unknown");
    let available = false;
    const test = parts(shops, {
      readOrder: async () =>
        available
          ? { ok: true, order: shopOrder() }
          : { ok: false, why: "The shop did not answer." },
    });
    const request = { orderId: "ord_1", wooOrderId: "13" };

    expect(await recoverWooOrderAs(OWNER, request, test.value)).toMatchObject({
      ok: false,
      state: "unresolved",
    });
    expect((await shops.recoveryOrder("ord_1"))?.phase).toBe("create_unknown");
    available = true;
    expect(await recoverWooOrderAs(OWNER, request, test.value)).toMatchObject({ ok: true });
    expect(test.counts().created).toBe(0);
  });
});

describe("merchant recovery pages", () => {
  it("hides unknown and other-account sales before any gateway or shop call", async () => {
    const shops = await setup("create_unknown");
    const test = parts(shops, {
      gatewayFor: () => {
        throw new Error("a stranger must not reach the gateway");
      },
    });
    const pages = wooRecoveryPagesFor(test.value);
    const stranger = { ...OWNER, id: "acc_other" };
    const form = new FormData();
    form.set("woo_order_id", "13");

    expect(await pages.page(stranger, "ord_1")).toEqual(await pages.page(stranger, "ord_missing"));
    expect(await pages.recover(stranger, "ord_1", form)).toEqual(
      await pages.recover(stranger, "ord_missing", form),
    );
    expect(await pages.page(stranger, "ord_1")).toMatchObject({
      kind: "problem",
      problem: { status: 404 },
    });
    expect(test.counts()).toEqual({ delivered: 0, created: 0, read: 0 });
  });

  it("only reads our saved sale on GET and tells the merchant which exact shop ID to enter", async () => {
    const shops = await setup("create_unknown");
    const test = parts(shops);
    const page = await wooRecoveryPagesFor(test.value).page(OWNER, "ord_1");

    expect(page).toMatchObject({
      kind: "view",
      view: {
        mode: "link",
        orderId: "ord_1",
        product: FACTS.merchantItemId,
        shopOrigin: FACTS.shopOrigin,
        amount: "0.01 USD",
        test: true,
        wooOrderId: "",
      },
    });
    expect(test.counts()).toEqual({ delivered: 0, created: 0, read: 0 });
  });

  it("reads back a durable binding when delivery is unknown, then offers retry rather than another binding", async () => {
    const shops = await setup("create_unknown");
    const base = parts(shops);
    const test = parts(shops, {
      gatewayFor: (acting) => ({
        ...base.value.gatewayFor(acting),
        getOrder: async () => ({ ok: true, document: gatewayOrder("unfulfilled") }),
        deliverOrder: async () => ({ ok: false, status: 0, why: "the answer was lost" }),
      }),
    });
    const pages = wooRecoveryPagesFor(test.value);
    const form = new FormData();
    form.set("woo_order_id", "13");

    expect(await pages.recover(OWNER, "ord_1", form)).toMatchObject({
      kind: "view",
      view: {
        mode: "retry",
        wooOrderId: "13",
        message: expect.stringMatching(/not confirm/i),
      },
    });
    expect(await pages.page(OWNER, "ord_1")).toMatchObject({
      kind: "view",
      view: {
        mode: "retry",
        wooOrderId: "13",
      },
    });
    expect((await shops.recoveryOrder("ord_1"))?.placed?.id).toBe("13");
    expect(test.counts().created).toBe(0);
  });

  it("does not call an unreadable gateway result a missing sale", async () => {
    const shops = await setup("create_unknown");
    const base = parts(shops);
    const test = parts(shops, {
      gatewayFor: (acting) => ({
        ...base.value.gatewayFor(acting),
        getOrder: async () => ({ ok: false, status: 0, why: "not answered" }),
      }),
    });

    expect(await wooRecoveryPagesFor(test.value).page(OWNER, "ord_1")).toMatchObject({
      kind: "problem",
      problem: { status: 504 },
    });
    expect(test.counts()).toEqual({ delivered: 0, created: 0, read: 0 });
  });

  it("uses confirmed delivered readback after the delivery response was lost", async () => {
    const shops = await setup("create_unknown");
    const base = parts(shops);
    let landed = false;
    const test = parts(shops, {
      gatewayFor: (acting) => ({
        ...base.value.gatewayFor(acting),
        getOrder: async () => ({
          ok: true,
          document: gatewayOrder(landed ? "delivered" : "unfulfilled"),
        }),
        deliverOrder: async () => {
          landed = true;
          return { ok: false, status: 0, why: "the response was lost" };
        },
      }),
    });
    const form = new FormData();
    form.set("woo_order_id", "13");
    const result = await wooRecoveryPagesFor(test.value).recover(OWNER, "ord_1", form);

    expect(result).toMatchObject({ kind: "view", view: { mode: "delivered", wooOrderId: "13" } });
    expect(result.kind === "view" && result.status).not.toBe(503);
    expect(result.kind === "view" && result.view.message).not.toMatch(/unknown|not confirm/i);
  });

  it("keeps the saved binding visible when the final gateway reread is unavailable", async () => {
    const shops = await setup("create_unknown");
    const base = parts(shops);
    let submitted = false;
    const test = parts(shops, {
      gatewayFor: (acting) => ({
        ...base.value.gatewayFor(acting),
        getOrder: async () =>
          submitted
            ? { ok: false, status: 0, why: "the gateway is unavailable" }
            : { ok: true, document: gatewayOrder("unfulfilled") },
        deliverOrder: async () => {
          submitted = true;
          return { ok: false, status: 0, why: "no response" };
        },
      }),
    });
    const form = new FormData();
    form.set("woo_order_id", "13");

    expect(await wooRecoveryPagesFor(test.value).recover(OWNER, "ord_1", form)).toMatchObject({
      kind: "view",
      status: 503,
      view: { mode: "retry", wooOrderId: "13" },
    });
    expect((await shops.recoveryOrder("ord_1"))?.placed?.id).toBe("13");
  });
});

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

  it("makes the order again with the payout contract the sale's payment went to, for its commission lines", async () => {
    const shops = await setup("precreate_refused");
    const test = parts(shops);

    await recoverWooOrder({ orderId: "ord_1" }, test.value);

    expect(test.sold.map((item) => item.paidInto)).toStrictEqual([PAID_INTO]);
  });

  it("makes no order where it cannot read where the payment went, and can be asked again", async () => {
    const shops = await setup("precreate_refused");
    const base = parts(shops);
    const test = parts(shops, {
      gatewayFor: (acting) => ({
        ...base.value.gatewayFor(acting),
        paidInto: async () => ({ ok: false as const, status: 0, why: "nothing answered" }),
      }),
    });

    expect(await recoverWooOrder({ orderId: "ord_1" }, test.value)).toMatchObject({
      ok: false,
      state: "unresolved",
    });
    expect(test.counts()).toMatchObject({ created: 0 });
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

  it("leaves a recovery unresolved while the shop does not answer, rather than refused", async () => {
    // "Refused" would say the product no longer matches, which nobody knows of
    // a shop that timed out; "unresolved" lets the same recovery be asked
    // again.
    const shops = await setup("precreate_refused");
    const test = parts(shops, {
      inspectProduct: async () => ({
        ok: false,
        why: "The shop did not answer the protected product check.",
        again: true,
      }),
    });

    expect(await recoverWooOrder({ orderId: "ord_1" }, test.value)).toMatchObject({
      ok: false,
      state: "unresolved",
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

  it("does not bind an exact Woo order with a malformed duplicate Agentify id", async () => {
    const shops = await setup("create_unknown");
    const test = parts(shops, {
      readOrder: async () => ({
        ok: true,
        order: shopOrder({ agentifyOrderIds: ["ord_1", { malformed: true }] }),
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

describe("a parcel's order", () => {
  it("is not recovered: its address was erased when it became an unfulfilled order", async () => {
    // Nothing of where a parcel goes is kept, so recovery has nothing to create
    // an order from.
    const shops = memoryWooShops();
    await shops.recordPrecreateRefusal("acc_1", "ord_1", { ...FACTS, kind: "parcel" }, NOW);

    const outcome = await recoverWooOrder({ orderId: "ord_1" }, parts(shops).value);

    expect(outcome).toMatchObject({
      ok: false,
      state: "refused",
      why: expect.stringContaining("parcel"),
    });
  });
});

describe("a parcel's order the shop holds", () => {
  it("is not recovered, and the operator is not told to withhold it", async () => {
    // A placed parcel is a sale taken on, followed in the shop until completed;
    // recovery must not read as a reason not to ship it.
    const shops = memoryWooShops();
    await shops.claimOrder("acc_1", "ord_1", { ...FACTS, kind: "parcel" }, NOW);
    await shops.recordOrder("ord_1", { id: "30", number: "30", permission: null }, NOW);

    const outcome = await recoverWooOrder({ orderId: "ord_1" }, parts(shops).value);

    expect(outcome).toMatchObject({ ok: false, state: "refused" });
    expect(outcome.ok === false && outcome.why).not.toContain("do not ship");
  });
});

describe("an operator-named shop order, read back", () => {
  // Orders made before the commission lines existed carry none, and those
  // made after carry two; neither is a fact of the sale the recovery matches.
  let stand: Server | null = null;

  afterEach(async () => {
    await new Promise<void>((resolve) =>
      stand === null ? resolve() : stand.close(() => resolve()),
    );
    stand = null;
  });

  const aShopHolding = async (meta: readonly { key: string; value: unknown }[]) => {
    stand = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: 13,
          number: "WOO-13",
          order_key: "wc_order_13",
          status: "processing",
          currency: "USD",
          total: "0.01",
          total_tax: "0.00",
          payment_method: "agentify",
          transaction_id: "ord_1",
          billing: { email: EMAIL },
          line_items: [
            { product_id: 22, quantity: 1, subtotal: "0.01", total: "0.01", total_tax: "0.00" },
          ],
          meta_data: meta,
        }),
      );
    });
    stand.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => stand?.once("listening", resolve));
    return `http://127.0.0.1:${(stand.address() as AddressInfo).port}`;
  };

  /** The lines the shop order of this very sale carries, the commission on what was paid among them. */
  const LINES = [
    {
      key: "agentify_commission",
      value: `${sharesOf({ amount: FACTS.amount, currency: FACTS.currency }, PAID_INTO).commission} (${percentOf(PAID_INTO.commissionAllocation, PAID_INTO.totalAllocation)})`,
    },
    { key: "agentify_payout_contract", value: PAID_INTO.address },
  ];

  for (const [what, meta, binds] of [
    ["without the commission lines", [{ key: "agentify_order_id", value: "ord_1" }], true],
    ["with the commission lines", [{ key: "agentify_order_id", value: "ord_1" }, ...LINES], true],
    [
      "naming another sale, whatever lines it carries",
      [{ key: "agentify_order_id", value: "ord_2" }, ...LINES],
      false,
    ],
  ] as const) {
    it(`${binds ? "binds" : "does not bind"} one ${what}`, async () => {
      const shopUrl = await aShopHolding(meta);
      const shops = await setup("create_unknown");
      const test = parts(shops, {
        readOrder: (keys, wooOrderId) =>
          readTheOrderInTheShop({ ...keys, shopUrl }, wooOrderId, fetch),
      });

      const outcome = await recoverWooOrder({ orderId: "ord_1", wooOrderId: "13" }, test.value);

      expect(outcome).toMatchObject(binds ? { ok: true, state: "delivered" } : { ok: false });
    });
  }
});
