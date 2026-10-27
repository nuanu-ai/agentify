import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { percentOf } from "@agentify/core/published";
import { PAYOUT_SPLIT_NETWORKS, payoutSplitFor, payoutSplitNetworkOf } from "@agentify/gateway";
import { MerchantCardListSchema, type OrderWithStatus } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sharesOf } from "./shares.js";
import { merchantItemIdFor } from "./woo-catalog.js";
import { recoverWooOrderAs, type WooRecoveryParts } from "./woo-recovery.js";
import { type WooRecoveryPageParts, wooRecoveryPagesFor } from "./woo-recovery-pages.js";
import {
  type EligibleWooProduct,
  inspectProductInTheShop,
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
  tax: { mode: "off" as const },
};

const gatewayOrder = (
  status: OrderWithStatus["status"],
  facts: WooOrderFacts = FACTS,
): OrderWithStatus => ({
  payment_status: status === "payment_unresolved" ? "unresolved" : "paid",
  id: "ord_1",
  merchant_item_id: facts.merchantItemId,
  params: {},
  price: {
    amount: facts.amount,
    currency: facts.currency,
    at: "2026-09-18T09:59:00.000Z",
    as_of: "2026-09-18T09:58:00.000Z",
  },
  price_id: FACTS.priceId,
  test: true,
  status,
});

/** The merchant's catalogue, holding the card the sale was made from. */
const CARDS = MerchantCardListSchema.parse({
  selling: "open",
  cards: [
    {
      id: "itm_22",
      as_of: "2026-09-18T09:00:00Z",
      card: {
        merchant_item_id: FACTS.merchantItemId,
        title: "Agentify test download",
        description: "A file delivered by the merchant's WooCommerce shop",
        price: { amount: FACTS.amount, currency: FACTS.currency },
        result: { download_url: { type: "string" } },
        fulfillment: "async",
      },
      selling: "open",
      paused: false,
    },
  ],
});

/** The recovery's parts, whose gateway also lists the cards the recovery page names the product from. */
type Parts = Omit<WooRecoveryParts, "gatewayFor"> & Pick<WooRecoveryPageParts, "gatewayFor">;

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

const setup = async (phase: "precreate_refused" | "create_unknown", facts = FACTS) => {
  const shops = memoryWooShops();
  await shops.recordQuote(
    "acc_1",
    facts.priceId,
    facts.merchantItemId,
    {
      fingerprint: facts.productFingerprint,
      inTheShop: { amount: facts.amount, currency: "USD" },
      paid: { amount: facts.amount, currency: "USD" },
      rateVersion: null,
    },
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
    currency: null,
  });
  if (phase === "precreate_refused") {
    await shops.recordPrecreateRefusal("acc_1", "ord_1", facts, NOW);
  } else {
    await shops.claimOrder("acc_1", "ord_1", facts, NOW);
  }
  return shops;
};

const parts = (
  shops: Awaited<ReturnType<typeof setup>>,
  overrides: Partial<Parts> = {},
  facts = FACTS,
) => {
  let delivered = 0;
  let read = 0;
  let created = 0;
  let status: OrderWithStatus["status"] = "unfulfilled";
  /** What each create asked the shop's order to hold. */
  const sold: SoldItem[] = [];
  const made: OrderMade = {
    ok: true,
    id: "13",
    number: "WOO-13",
    orderKey: "wc_order_13",
    downloadId: PRODUCT.downloadId,
    total: facts.amount,
  };
  const value: Parts = {
    shops,
    gatewayFor: () => ({
      getOrder: async () => {
        return {
          ok: true as const,
          document: gatewayOrder(status, facts),
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
      cards: async () => ({ ok: true as const, document: CARDS }),
    }),
    inspectProduct: async () => ({ ok: true, product: PRODUCT }),
    placeOrder: async (_keys, item) => {
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
  return {
    value,
    counts: () => ({ delivered, read }),
    created: () => created,
    sold,
    /** The Agentify order as the merchant's own actions, or a delivery, left it. */
    becomes: (now: OrderWithStatus["status"]) => {
      status = now;
    },
  };
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
    expect(test.counts()).toEqual({ delivered: 0, read: 0 });
  });

  it("binds the exact shop order for the authenticated merchant", async () => {
    const shops = await setup("create_unknown");
    const test = parts(shops);

    expect(
      await recoverWooOrderAs(OWNER, { orderId: "ord_1", wooOrderId: "13" }, test.value),
    ).toMatchObject({ ok: true, state: "delivered", wooOrderId: "13" });
    expect(test.counts()).toEqual({ delivered: 1, read: 1 });
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
    expect(test.counts()).toEqual({ delivered: 2, read: 1 });
    expect((await shops.recoveryOrder("ord_1"))?.placed?.id).toBe("13");
  });

  it("names each fact of a typed shop order that differs from the sale, and only those", async () => {
    const shops = await setup("create_unknown");
    const test = parts(shops, {
      readOrder: async () => ({
        ok: true,
        order: shopOrder({ status: "cancelled", paymentMethod: "bacs" }),
      }),
    });

    const outcome = await recoverWooOrderAs(
      OWNER,
      { orderId: "ord_1", wooOrderId: "13" },
      test.value,
    );

    expect(outcome).toMatchObject({ ok: false, state: "refused", typed: true });
    const why = outcome.ok ? "" : outcome.why;
    expect(why).toContain("cancelled");
    expect(why).toContain("not paid with Agentify");
    expect(why).not.toContain("Transaction ID");
    expect(why).not.toContain("billing email");
    expect(why).not.toContain("total");
    expect((await shops.recoveryOrder("ord_1"))?.placed).toBeNull();
  });

  it("names the total it expected in the shop's own currency, kept beside the amount", async () => {
    const converted: WooOrderFacts = {
      ...FACTS,
      converted: {
        inTheShop: { amount: "0.01", currency: "EUR" },
        rate: { version: 2, rate: "0.92", setAt: "2026-09-18T08:00:00.000Z" },
      },
    };
    const shops = await setup("create_unknown", converted);
    const test = parts(
      shops,
      {
        inspectProduct: async () => ({
          ok: true,
          product: { ...PRODUCT, price: { amount: "0.01", currency: "EUR" } },
        }),
        readOrder: async () => ({ ok: true, order: shopOrder({ currency: "EUR", total: "0.05" }) }),
      },
      converted,
    );

    const outcome = await recoverWooOrderAs(
      OWNER,
      { orderId: "ord_1", wooOrderId: "13" },
      test.value,
    );

    expect(outcome.ok ? "" : outcome.why).toContain("its total is not 0.01\u00a0EUR");
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
  });
});

describe("a merchant creating the shop order of a download refused before creation", () => {
  it("creates the shop order once and delivers the download when the shop places it", async () => {
    const shops = await setup("precreate_refused");
    const test = parts(shops);

    expect(await recoverWooOrderAs(OWNER, { orderId: "ord_1" }, test.value)).toEqual({
      ok: true,
      state: "delivered",
      orderId: "ord_1",
      wooOrderId: "13",
    });
    expect(test.created()).toBe(1);
    expect(test.counts()).toEqual({ delivered: 1, read: 0 });
    expect(await shops.recoveryOrder("ord_1")).toMatchObject({
      phase: "placed",
      placed: { id: "13" },
    });
  });

  it.each([true, false])(
    "puts on the shop's order what the buyer paid, the merchant's email, the split the payment went to and whether it was a test purchase (%s)",
    async (testPurchase) => {
      const shops = await setup("precreate_refused");
      const test = parts(shops);
      const value: Parts = {
        ...test.value,
        gatewayFor: (acting) => {
          const gateway = test.value.gatewayFor(acting);
          return {
            ...gateway,
            getOrder: async (orderId) => {
              const read = await gateway.getOrder(orderId);
              return read.ok
                ? { ...read, document: { ...read.document, test: testPurchase } }
                : read;
            },
          };
        },
      };

      await recoverWooOrderAs(OWNER, { orderId: "ord_1" }, value);

      expect(test.sold).toStrictEqual([
        {
          orderId: "ord_1",
          test: testPurchase,
          productId: FACTS.productId,
          email: EMAIL,
          price: { amount: FACTS.amount, currency: FACTS.currency },
          download: { id: PRODUCT.downloadId, name: PRODUCT.fileName },
          paidInto: PAID_INTO,
          tax: PRODUCT.tax,
        },
      ]);
    },
  );

  it("creates nothing more on a second press, a double click or a press from a stale page", async () => {
    const shops = await setup("precreate_refused");
    const waiting: ((made: OrderMade) => void)[] = [];
    const test = parts(shops, {
      placeOrder: async () => await new Promise<OrderMade>((resolve) => waiting.push(resolve)),
    });

    // Two presses at once: whichever moves the ledger first sends the one
    // request, and the other meets the moved ledger without waiting for it.
    const presses = [
      recoverWooOrderAs(OWNER, { orderId: "ord_1" }, test.value),
      recoverWooOrderAs(OWNER, { orderId: "ord_1" }, test.value),
    ];
    const first = await Promise.race([
      ...presses,
      new Promise((resolve) => setTimeout(() => resolve("both presses are still waiting"), 500)),
    ]);
    await vi.waitFor(() => expect(waiting.length).toBeGreaterThan(0));
    for (const answer of waiting) {
      answer({
        ok: true,
        id: "13",
        number: "WOO-13",
        orderKey: "wc_order_13",
        downloadId: PRODUCT.downloadId,
        total: FACTS.amount,
      });
    }
    expect(first).toMatchObject({ ok: false });
    expect((await Promise.all(presses)).filter((outcome) => outcome.ok)).toHaveLength(1);
    // A third press, from the page drawn before any of them.
    const stale = await wooRecoveryPagesFor(test.value).recover(OWNER, "ord_1", new FormData());

    expect(stale).toMatchObject({ kind: "view", view: { mode: "delivered", wooOrderId: "13" } });
    expect(waiting).toHaveLength(1);
  });

  it("leaves a create whose answer was lost to linking, and never sends it again", async () => {
    const shops = await setup("precreate_refused");
    let sent = 0;
    const test = parts(shops, {
      placeOrder: async () => {
        sent += 1;
        return { ok: false, why: "no answer", again: true };
      },
    });
    const pages = wooRecoveryPagesFor(test.value);

    const pressed = await pages.recover(OWNER, "ord_1", new FormData());
    const again = await pages.recover(OWNER, "ord_1", new FormData());

    expect(pressed).toMatchObject({
      kind: "view",
      view: { mode: "link", message: expect.any(String) },
    });
    expect(pressed.kind === "view" && pressed.view.message).not.toMatch(/fail/i);
    expect(again).toMatchObject({ kind: "view", status: 400, view: { mode: "link" } });
    expect(await pages.page(OWNER, "ord_1")).toMatchObject({
      kind: "view",
      view: { mode: "link" },
    });
    expect(sent).toBe(1);
    expect((await shops.recoveryOrder("ord_1"))?.phase).toBe("create_unknown");
  });

  it("creates nothing until the same shop is connected again, and says so", async () => {
    const shops = await setup("precreate_refused");
    const sameGrant = await shops.connectionOf("acc_1");
    if (sameGrant === null) throw new Error("the test shop was not connected");
    await shops.connect({ ...sameGrant, revision: FACTS.connectionRevision });
    const test = parts(shops);

    expect(await recoverWooOrderAs(OWNER, { orderId: "ord_1" }, test.value)).toMatchObject({
      ok: false,
      state: "refused",
      why: expect.stringMatching(/connect/i),
    });
    expect(await wooRecoveryPagesFor(test.value).page(OWNER, "ord_1")).toMatchObject({
      kind: "view",
      view: { mode: "unavailable", unavailable: { shopOrder: "none", instead: "reconnect" } },
    });
    expect(test.created()).toBe(0);
    expect((await shops.recoveryOrder("ord_1"))?.phase).toBe("precreate_refused");
  });

  it("creates nothing in another shop connected since", async () => {
    const shops = await setup("precreate_refused");
    const connected = await shops.connectionOf("acc_1");
    if (connected === null) throw new Error("the test shop was not connected");
    await shops.forget("acc_1");
    await shops.connect({ ...connected, shopUrl: "https://other-shop.example.com" });
    const test = parts(shops);

    expect(await recoverWooOrderAs(OWNER, { orderId: "ord_1" }, test.value)).toMatchObject({
      ok: false,
      state: "refused",
    });
    expect(test.created()).toBe(0);
  });

  it("creates nothing through a shop connected with read access alone", async () => {
    const shops = await setup("precreate_refused");
    const connected = await shops.connectionOf("acc_1");
    if (connected === null) throw new Error("the test shop was not connected");
    await shops.connect({ ...connected, permissions: "read" });
    const test = parts(shops);

    expect(await recoverWooOrderAs(OWNER, { orderId: "ord_1" }, test.value)).toMatchObject({
      ok: false,
      state: "refused",
      why: expect.stringMatching(/read/i),
    });
    expect(await wooRecoveryPagesFor(test.value).page(OWNER, "ord_1")).toMatchObject({
      kind: "view",
      view: { mode: "unavailable", unavailable: { instead: "reconnect" } },
    });
    expect(test.created()).toBe(0);
    expect((await shops.recoveryOrder("ord_1"))?.phase).toBe("precreate_refused");
  });

  it("creates nothing when fulfillment is closed while the shop is being checked", async () => {
    const shops = await setup("precreate_refused");
    const test = parts(shops, {
      inspectProduct: async () => {
        test.becomes("fulfillment_closed");
        return { ok: true, product: PRODUCT };
      },
    });

    expect(await recoverWooOrderAs(OWNER, { orderId: "ord_1" }, test.value)).toMatchObject({
      ok: false,
      state: "refused",
    });
    expect(test.created()).toBe(0);
    expect((await shops.recoveryOrder("ord_1"))?.phase).toBe("precreate_refused");
  });

  it("asks the shop of a sale paid in dollars for its own currency's amount, at the rate fixed at the sale", async () => {
    const converted: WooOrderFacts = {
      ...FACTS,
      converted: {
        inTheShop: { amount: "180", currency: "IDR" },
        rate: { version: 3, rate: "18000", setAt: "2026-09-18T08:00:00.000Z" },
      },
    };
    const shops = await setup("precreate_refused", converted);
    const test = parts(
      shops,
      {
        inspectProduct: async () => ({
          ok: true,
          product: { ...PRODUCT, price: { amount: "180", currency: "IDR" } },
        }),
      },
      converted,
    );

    expect(await recoverWooOrderAs(OWNER, { orderId: "ord_1" }, test.value)).toMatchObject({
      ok: true,
    });
    expect(test.sold.map(({ price, converted }) => ({ price, converted }))).toStrictEqual([
      {
        price: { amount: "180", currency: "IDR" },
        converted: {
          paid: { amount: FACTS.amount, currency: "USD" },
          rate: {
            version: 3,
            currency: "IDR",
            rate: "18000",
            setAt: new Date("2026-09-18T08:00:00.000Z"),
          },
        },
      },
    ]);
  });

  it("creates nothing at a price the shop changed since the sale, and can be pressed again once it matches", async () => {
    const shops = await setup("precreate_refused");
    let price = "0.02";
    const test = parts(shops, {
      inspectProduct: async () => ({
        ok: true,
        product: { ...PRODUCT, price: { amount: price, currency: "USD" } },
      }),
    });

    expect(await recoverWooOrderAs(OWNER, { orderId: "ord_1" }, test.value)).toMatchObject({
      ok: false,
      state: "refused",
    });
    expect(test.created()).toBe(0);
    expect((await shops.recoveryOrder("ord_1"))?.phase).toBe("precreate_refused");
    price = FACTS.amount;
    expect(await recoverWooOrderAs(OWNER, { orderId: "ord_1" }, test.value)).toMatchObject({
      ok: true,
    });
    expect(test.created()).toBe(1);
  });

  it("says the shop's own reason when it no longer sells the product", async () => {
    const shops = await setup("precreate_refused");
    const test = parts(shops, {
      inspectProduct: async () => ({
        ok: false,
        why: "The shop has no product 22 any more.",
        again: false,
        saidNo: true,
      }),
    });

    expect(await recoverWooOrderAs(OWNER, { orderId: "ord_1" }, test.value)).toMatchObject({
      ok: false,
      state: "refused",
      why: expect.stringContaining("The shop has no product 22 any more."),
    });
    expect(test.created()).toBe(0);
  });

  it("makes no order where it cannot read where the payment went, and can be pressed again", async () => {
    const shops = await setup("precreate_refused");
    const base = parts(shops);
    const test = parts(shops, {
      gatewayFor: (acting) => ({
        ...base.value.gatewayFor(acting),
        paidInto: async () => ({ ok: false as const, status: 0, why: "nothing answered" }),
      }),
    });

    expect(await recoverWooOrderAs(OWNER, { orderId: "ord_1" }, test.value)).toMatchObject({
      ok: false,
      state: "unresolved",
    });
    expect(test.created()).toBe(0);
    expect((await shops.recoveryOrder("ord_1"))?.phase).toBe("precreate_refused");
  });

  it("takes no shop order ID for a sale its shop never received", async () => {
    const shops = await setup("precreate_refused");
    const test = parts(shops);

    expect(
      await recoverWooOrderAs(OWNER, { orderId: "ord_1", wooOrderId: "13" }, test.value),
    ).toMatchObject({ ok: false, state: "refused" });
    expect(test.created()).toBe(0);
    expect(test.counts()).toEqual({ delivered: 0, read: 0 });
  });

  for (const status of ["fulfillment_closed", "delivered"] as const) {
    it(`offers no create for an order that is ${status.replace("_", " ")}, and a press creates nothing`, async () => {
      const shops = await setup("precreate_refused");
      const test = parts(shops);
      test.becomes(status);
      const pages = wooRecoveryPagesFor(test.value);

      expect(await pages.page(OWNER, "ord_1")).toMatchObject({
        kind: "view",
        view: { mode: "unavailable", unavailable: { shopOrder: "none", instead: "nothing" } },
      });
      expect(await pages.recover(OWNER, "ord_1", new FormData())).toMatchObject({
        kind: "view",
        status: 409,
      });
      expect(test.created()).toBe(0);
      expect((await shops.recoveryOrder("ord_1"))?.phase).toBe("precreate_refused");
    });
  }

  it("answers another account's refused sale like a missing one, creating nothing", async () => {
    const shops = await setup("precreate_refused");
    const test = parts(shops);
    const pages = wooRecoveryPagesFor(test.value);
    const stranger = { ...OWNER, id: "acc_other", merchant: { id: "m_other" } };

    expect(await pages.page(stranger, "ord_1")).toEqual(await pages.page(stranger, "ord_missing"));
    expect(await pages.recover(stranger, "ord_1", new FormData())).toEqual(
      await pages.recover(stranger, "ord_missing", new FormData()),
    );
    expect(test.created()).toBe(0);
    expect((await shops.recoveryOrder("ord_1"))?.phase).toBe("precreate_refused");
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
    expect(test.counts()).toEqual({ delivered: 0, read: 0 });
  });

  it("offers the create for a download refused before creation once its shop is connected again", async () => {
    const shops = await setup("precreate_refused");
    const test = parts(shops);
    const pages = wooRecoveryPagesFor(test.value);

    expect(await pages.page(OWNER, "ord_1")).toMatchObject({
      kind: "view",
      view: { mode: "create", wooOrderId: "", unavailable: null },
    });
    expect(await pages.recover(OWNER, "ord_1", new FormData())).toMatchObject({
      kind: "view",
      view: { mode: "delivered", wooOrderId: "13", message: null },
    });
    expect(test.created()).toBe(1);
  });

  it("says the shop's reason at the top and keeps the create offered when the shop refuses again before creating", async () => {
    const shops = await setup("precreate_refused");
    const test = parts(shops, {
      inspectProduct: async () => ({
        ok: false,
        why: "The shop has no product 22 any more.",
        again: false,
        saidNo: true,
      }),
    });

    expect(
      await wooRecoveryPagesFor(test.value).recover(OWNER, "ord_1", new FormData()),
    ).toMatchObject({
      kind: "view",
      status: 409,
      view: { mode: "create", message: expect.stringContaining("no product 22") },
    });
    expect(test.created()).toBe(0);
  });

  it("says the shop order was just created when fulfillment was closed before its download went", async () => {
    const shops = await setup("precreate_refused");
    let closed = false;
    const base = parts(shops);
    const test = parts(shops, {
      gatewayFor: (acting) => ({
        ...base.value.gatewayFor(acting),
        getOrder: async () => ({
          ok: true,
          document: gatewayOrder(closed ? "fulfillment_closed" : "unfulfilled"),
        }),
        deliverOrder: async () => ({ ok: false, status: 409, why: "the order is closed" }),
      }),
      placeOrder: async () => {
        closed = true;
        return {
          ok: true,
          id: "13",
          number: "WOO-13",
          orderKey: "wc_order_13",
          downloadId: PRODUCT.downloadId,
          total: FACTS.amount,
        };
      },
    });

    const pages = wooRecoveryPagesFor(test.value);
    const pressed = await pages.recover(OWNER, "ord_1", new FormData());
    const reloaded = await pages.page(OWNER, "ord_1");

    expect((await shops.recoveryOrder("ord_1"))?.placed?.id).toBe("13");
    for (const drawn of [pressed, reloaded]) {
      expect(drawn).toMatchObject({
        kind: "view",
        view: {
          mode: "unavailable",
          wooOrderId: "13",
          unavailable: { shopOrder: { id: "13" }, instead: "nothing" },
        },
      });
    }
  });

  it("keeps saying nobody knows whether the shop created the order when fulfillment was closed meanwhile", async () => {
    const shops = await setup("precreate_refused");
    let closed = false;
    const base = parts(shops);
    const test = parts(shops, {
      gatewayFor: (acting) => ({
        ...base.value.gatewayFor(acting),
        getOrder: async () => ({
          ok: true,
          document: gatewayOrder(closed ? "fulfillment_closed" : "unfulfilled"),
        }),
      }),
      placeOrder: async () => {
        closed = true;
        return { ok: false, why: "no answer", again: true };
      },
    });

    const pages = wooRecoveryPagesFor(test.value);
    const pressed = await pages.recover(OWNER, "ord_1", new FormData());
    const reloaded = await pages.page(OWNER, "ord_1");

    expect((await shops.recoveryOrder("ord_1"))?.phase).toBe("create_unknown");
    for (const drawn of [pressed, reloaded]) {
      expect(drawn).toMatchObject({
        kind: "view",
        view: { mode: "unavailable", unavailable: { shopOrder: "unknown", instead: "nothing" } },
      });
    }
  });

  it("asks for a reload, still not knowing the shop order, when a create broke inside Agentify and fulfillment was closed meanwhile", async () => {
    const shops = await setup("precreate_refused");
    let closed = false;
    const base = parts(shops);
    const test = parts(shops, {
      gatewayFor: (acting) => ({
        ...base.value.gatewayFor(acting),
        getOrder: async () => ({
          ok: true,
          document: gatewayOrder(closed ? "fulfillment_closed" : "unfulfilled"),
        }),
      }),
      placeOrder: async () => {
        closed = true;
        throw new Error("the connection to the shop broke");
      },
    });

    const pressed = await wooRecoveryPagesFor(test.value).recover(OWNER, "ord_1", new FormData());

    expect((await shops.recoveryOrder("ord_1"))?.phase).toBe("create_unknown");
    expect(pressed).toMatchObject({
      kind: "view",
      status: 503,
      view: {
        mode: "unavailable",
        unknown: true,
        unavailable: { shopOrder: "unknown", instead: "nothing" },
      },
    });
  });

  it("says nobody knows whether the shop holds a parcel whose create is unknown, and sends the merchant to close it", async () => {
    const facts: WooOrderFacts = { ...FACTS, kind: "parcel" };
    const shops = await setup("create_unknown", facts);
    const test = parts(shops, {}, facts);

    expect(await wooRecoveryPagesFor(test.value).page(OWNER, "ord_1")).toMatchObject({
      kind: "view",
      view: {
        mode: "unavailable",
        unavailable: { shopOrder: "unknown", instead: "close" },
      },
    });
  });

  it("offers no create for an order whose create is unknown, only linking", async () => {
    const shops = await setup("create_unknown");
    const test = parts(shops);
    const pages = wooRecoveryPagesFor(test.value);

    expect(await pages.page(OWNER, "ord_1")).toMatchObject({
      kind: "view",
      view: { mode: "link" },
    });
    expect(await pages.recover(OWNER, "ord_1", new FormData())).toMatchObject({
      kind: "view",
      status: 400,
      view: { mode: "link" },
    });
    expect(await recoverWooOrderAs(OWNER, { orderId: "ord_1" }, test.value)).toMatchObject({
      ok: false,
    });
    expect(test.created()).toBe(0);
    expect((await shops.recoveryOrder("ord_1"))?.phase).toBe("create_unknown");
  });

  it("offers no create for a parcel refused before creation, and leads to closing its fulfillment", async () => {
    const shops = await setup("precreate_refused", { ...FACTS, kind: "parcel" });
    const test = parts(shops, {}, { ...FACTS, kind: "parcel" });
    const pages = wooRecoveryPagesFor(test.value);

    const page = await pages.page(OWNER, "ord_1");
    expect(page).toMatchObject({
      kind: "view",
      view: {
        mode: "unavailable",
        unavailable: { shopOrder: "none", instead: "close" },
      },
    });
    expect(await pages.recover(OWNER, "ord_1", new FormData())).toMatchObject({
      kind: "view",
      status: 409,
    });
    expect(test.created()).toBe(0);
    expect((await shops.recoveryOrder("ord_1"))?.phase).toBe("precreate_refused");
  });

  it("offers nothing on a parcel its shop never got once its fulfillment is closed", async () => {
    const facts: WooOrderFacts = { ...FACTS, kind: "parcel" };
    const shops = await setup("precreate_refused", facts);
    const test = parts(shops, {}, facts);
    test.becomes("fulfillment_closed");

    expect(await wooRecoveryPagesFor(test.value).page(OWNER, "ord_1")).toMatchObject({
      kind: "view",
      view: { mode: "unavailable", unavailable: { shopOrder: "none", instead: "nothing" } },
    });
  });

  it("names the shop's order of a placed parcel and offers nothing once its fulfillment is closed", async () => {
    const facts: WooOrderFacts = { ...FACTS, kind: "parcel" };
    const shops = await setup("create_unknown", facts);
    await shops.recordOrder(
      "ord_1",
      { id: "30", number: "30", permission: null, total: "0.01" },
      NOW,
    );
    const test = parts(shops, {}, facts);
    test.becomes("fulfillment_closed");

    expect(await wooRecoveryPagesFor(test.value).page(OWNER, "ord_1")).toMatchObject({
      kind: "view",
      view: {
        mode: "unavailable",
        unavailable: { shopOrder: { id: "30" }, instead: "nothing" },
      },
    });
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
        product: "Agentify test download",
        shopOrigin: FACTS.shopOrigin,
        amount: "0.01\u00a0USD",
        wooOrderId: "",
      },
    });
    expect(test.counts()).toEqual({ delivered: 0, read: 0 });
  });

  it("says a refused shop order under its box and keeps what was typed, with nothing linked", async () => {
    const shops = await setup("create_unknown");
    const test = parts(shops, {
      readOrder: async () => ({ ok: true, order: shopOrder({ paymentMethod: "bacs" }) }),
    });
    const form = new FormData();
    form.set("woo_order_id", "13");

    expect(await wooRecoveryPagesFor(test.value).recover(OWNER, "ord_1", form)).toMatchObject({
      kind: "view",
      status: 409,
      view: {
        mode: "link",
        wooOrderId: "13",
        message: null,
        typedRefusal: expect.stringContaining("not paid with Agentify"),
      },
    });
    expect((await shops.recoveryOrder("ord_1"))?.placed).toBeNull();
  });

  it("names the product by its product code when the catalogue cannot be read, and still offers recovery", async () => {
    const shops = await setup("create_unknown");
    const base = parts(shops);
    const test = parts(shops, {
      gatewayFor: (acting) => ({
        ...base.value.gatewayFor(acting),
        cards: async () => ({ ok: false, status: 0, why: "not answered" }),
      }),
    });

    expect(await wooRecoveryPagesFor(test.value).page(OWNER, "ord_1")).toMatchObject({
      kind: "view",
      view: { mode: "link", product: FACTS.merchantItemId },
    });
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
    expect(test.counts()).toEqual({ delivered: 0, read: 0 });
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
    expect(result.kind === "view" && result.view.message).toBeNull();
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
  it("leaves a recovery unresolved while the shop does not answer, rather than refused", async () => {
    // "Refused" would say the product no longer matches, which nobody knows of
    // a shop that timed out; "unresolved" lets the same recovery be asked
    // again.
    const shops = await setup("create_unknown");
    const test = parts(shops, {
      inspectProduct: async () => ({
        ok: false,
        why: "The shop did not answer the protected product check.",
        again: true,
      }),
    });

    expect(await recoverWooOrderAs(OWNER, { orderId: "ord_1" }, test.value)).toMatchObject({
      ok: false,
      state: "unresolved",
    });
    expect(test.counts()).toEqual({ delivered: 0, read: 0 });
  });

  it("leaves a recovery unresolved when the shop's product answer broke off, without calling the shop silent", async () => {
    const shops = await setup("create_unknown");
    const test = parts(shops, {
      inspectProduct: (keys) =>
        inspectProductInTheShop(
          keys,
          merchantItemIdFor(keys.shopUrl, "22"),
          async () =>
            new Response(
              new ReadableStream({ start: (controller) => controller.error(new Error("cut off")) }),
              { status: 200 },
            ),
        ),
    });

    const recovered = await recoverWooOrderAs(OWNER, { orderId: "ord_1" }, test.value);

    expect(recovered).toMatchObject({ ok: false, state: "unresolved" });
    expect(JSON.stringify(recovered)).not.toMatch(/did not answer/i);
    expect(test.counts()).toEqual({ delivered: 0, read: 0 });
  });

  it("leaves a recovery unresolved when the shop's product answer could not be read, rather than saying the product changed", async () => {
    // A revoked key or a page in front of the shop said nothing about the
    // product. The merchant is to reconnect and ask again, not to go looking
    // for a change to the product.
    for (const [what, answer] of [
      [
        "a revoked key",
        () => Response.json({ code: "woocommerce_rest_cannot_view" }, { status: 401 }),
      ],
      ["a page that is not JSON", () => new Response("not-json", { status: 200 })],
    ] as const) {
      const shops = await setup("create_unknown");
      const test = parts(shops, {
        // The fixture's item id is not one the shop would name, so the check is
        // asked of this shop's own id for the product.
        inspectProduct: (keys) =>
          inspectProductInTheShop(keys, merchantItemIdFor(keys.shopUrl, "22"), async () =>
            answer(),
          ),
      });

      expect(await recoverWooOrderAs(OWNER, { orderId: "ord_1" }, test.value), what).toMatchObject({
        ok: false,
        state: "unresolved",
      });
      expect(test.counts(), what).toEqual({ delivered: 0, read: 0 });
    }

    // The shop's own no is still a refusal.
    const shops = await setup("create_unknown");
    const test = parts(shops, {
      inspectProduct: async () => ({
        ok: false,
        why: "This product cannot be imported: it is out of stock.",
        again: false,
        saidNo: true,
      }),
    });
    expect(await recoverWooOrderAs(OWNER, { orderId: "ord_1" }, test.value)).toMatchObject({
      ok: false,
      state: "refused",
    });
  });

  it("does not recover a changed download that no longer matches the accepted quote", async () => {
    const shops = await setup("create_unknown");
    const test = parts(shops, {
      inspectProduct: async () => ({
        ok: true,
        product: { ...PRODUCT, fingerprint: "replacement-download-fingerprint" },
      }),
    });

    expect(await recoverWooOrderAs(OWNER, { orderId: "ord_1" }, test.value)).toMatchObject({
      ok: false,
      state: "refused",
    });
    expect(test.counts()).toEqual({ delivered: 0, read: 0 });
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
        total: "25.00",
      },
      NOW,
    );
    await shops.forget("acc_1");
    const test = parts(shops);

    expect(await recoverWooOrderAs(OWNER, { orderId: "ord_1" }, test.value)).toMatchObject({
      ok: true,
      state: "delivered",
    });
    expect(test.counts()).toEqual({ delivered: 1, read: 0 });
  });

  /**
   * A sale of the Bali shop's download at 1.00 and the order the tax probe
   * got for it with the line left to the shop: 1.00 with 0.10 of tax inside.
   */
  const TAXED_FACTS: WooOrderFacts = { ...FACTS, amount: "1.00" };
  const INCLUSIVE: EligibleWooProduct = {
    ...PRODUCT,
    price: { amount: "1.00", currency: "USD" },
    tax: { mode: "included" },
  };
  const BALI_ORDER = {
    total: "1.00",
    totalTax: "0.10",
    subtotal: "0.90",
    lineTotal: "0.90",
    lineTax: "0.10",
  };
  const recoveringWith = async (product: EligibleWooProduct, order: Partial<WooOrderRead>) => {
    const shops = await setup("create_unknown", TAXED_FACTS);
    const test = parts(
      shops,
      {
        inspectProduct: async () => ({ ok: true, product }),
        readOrder: async () => ({ ok: true, order: shopOrder(order) }),
      },
      TAXED_FACTS,
    );
    return {
      shops,
      outcome: await recoverWooOrderAs(OWNER, { orderId: "ord_1", wooOrderId: "13" }, test.value),
    };
  };

  it("binds an inclusive shop's order holding the price paid with its tax inside", async () => {
    const { outcome } = await recoveringWith(INCLUSIVE, BALI_ORDER);

    expect(outcome).toMatchObject({ ok: true, state: "delivered", wooOrderId: "13" });
  });

  it("binds an inclusive shop's order totalled within a cent of the price paid", async () => {
    // The German shop with a 5% compound rate, rounding per line: 1.01 with
    // 0.14 of tax for a price of 1.00.
    const { outcome, shops } = await recoveringWith(INCLUSIVE, {
      total: "1.01",
      totalTax: "0.14",
      subtotal: "0.87",
      lineTotal: "0.87",
      lineTax: "0.14",
    });

    expect(outcome).toMatchObject({ ok: true, state: "delivered" });
    expect(await shops.shopTotals("acc_1", ["ord_1"])).toStrictEqual({
      ord_1: { total: "1.01", converted: null },
    });
  });

  it("does not bind an inclusive shop's order whose total is more than a cent from the price paid", async () => {
    // The Bali shop's order with its line totals taxed on top: 1.11 for 1.00.
    const { outcome, shops } = await recoveringWith(INCLUSIVE, {
      total: "1.11",
      totalTax: "0.11",
      subtotal: "1.00",
      lineTotal: "1.00",
      lineTax: "0.11",
    });

    expect(outcome).toMatchObject({ ok: false, state: "refused", typed: true });
    expect(outcome.ok ? "" : outcome.why).toContain("total");
    expect((await shops.recoveryOrder("ord_1"))?.placed).toBeNull();
  });

  it("binds an order a cent from the price paid from a shop calculating no tax too, and no more", async () => {
    const untaxed = { ...INCLUSIVE, tax: { mode: "off" } as const };
    const order = { totalTax: "0.00", subtotal: "1.00", lineTotal: "1.00", lineTax: "0.00" };

    expect((await recoveringWith(untaxed, { ...order, total: "1.01" })).outcome).toMatchObject({
      ok: true,
      state: "delivered",
    });
    expect((await recoveringWith(untaxed, { ...order, total: "1.02" })).outcome).toMatchObject({
      ok: false,
      state: "refused",
      typed: true,
    });
  });

  it("does not bind an order carrying tax for a sale from a shop that calculated none", async () => {
    const { outcome } = await recoveringWith({ ...INCLUSIVE, tax: { mode: "off" } }, BALI_ORDER);

    expect(outcome).toMatchObject({ ok: false, state: "refused", typed: true });
  });

  it("keeps an unknown create unbound when the exact Woo order does not correlate", async () => {
    const shops = await setup("create_unknown");
    const test = parts(shops, {
      readOrder: async () => ({
        ok: true,
        order: shopOrder({ transactionId: "some_other_order" }),
      }),
    });

    expect(
      await recoverWooOrderAs(OWNER, { orderId: "ord_1", wooOrderId: "13" }, test.value),
    ).toMatchObject({ ok: false, state: "refused" });
    expect(test.counts()).toEqual({ delivered: 0, read: 0 });
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

    expect(
      await recoverWooOrderAs(OWNER, { orderId: "ord_1", wooOrderId: "13" }, test.value),
    ).toMatchObject({ ok: false, state: "refused" });
    expect(test.counts()).toEqual({ delivered: 0, read: 0 });
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
    const test = parts(shops);

    const outcome = await recoverWooOrderAs(OWNER, { orderId: "ord_1" }, test.value);

    expect(outcome).toMatchObject({
      ok: false,
      state: "refused",
      why: expect.stringMatching(/address/i),
    });
    expect(test.counts()).toEqual({ delivered: 0, read: 0 });
    expect(test.created()).toBe(0);
  });
});

describe("a parcel's order the shop holds", () => {
  it("is not recovered, and the operator is not told to withhold it", async () => {
    // A placed parcel is a sale taken on, followed in the shop until completed;
    // recovery must not read as a reason not to ship it.
    const shops = memoryWooShops();
    await shops.claimOrder("acc_1", "ord_1", { ...FACTS, kind: "parcel" }, NOW);
    await shops.recordOrder(
      "ord_1",
      { id: "30", number: "30", permission: null, total: "25.00" },
      NOW,
    );

    const outcome = await recoverWooOrderAs(OWNER, { orderId: "ord_1" }, parts(shops).value);

    expect(outcome).toMatchObject({
      ok: false,
      state: "refused",
      why: expect.stringMatching(
        /order is placed.*read in the shop.*marked Completed.*cancelled.*refunded.*thirty days/i,
      ),
    });
    expect(outcome.ok === false && outcome.why).not.toContain("do not ship");
  });
});

describe("a shop order the merchant names, read back", () => {
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

      const outcome = await recoverWooOrderAs(
        OWNER,
        { orderId: "ord_1", wooOrderId: "13" },
        test.value,
      );

      expect(outcome).toMatchObject(binds ? { ok: true, state: "delivered" } : { ok: false });
    });
  }
});
