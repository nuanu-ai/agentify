/**
 * The shop is a small server on loopback, and what is asserted is what we sent
 * it: a Store API read with no credential at all, and a `wc/v3` order carrying
 * `set_paid` and the key pair as HTTP Basic.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { merchantItemIdFor } from "./woo-catalog.js";

const readCatalogue = (url: string, atMost?: number) => catalogueOf(url, atMost, fetch);
const createOrder = (
  keys: Parameters<typeof createTheOrderInTheShop>[0],
  sold: Parameters<typeof createTheOrderInTheShop>[1],
) => createTheOrderInTheShop(keys, sold, fetch);
const inspectProduct = (keys: Parameters<typeof inspectProductInTheShop>[0], itemId: string) =>
  inspectProductInTheShop(keys, itemId, fetch);
const readOrder = (keys: Parameters<typeof readTheOrderInTheShop>[0], orderId: string) =>
  readTheOrderInTheShop(keys, orderId, fetch);
const ratesFor = (url: string, productId: string, place: ShipToLocality) =>
  shippingRatesInTheShop(url, productId, place, fetch);
const shipmentOf = (keys: Parameters<typeof shipmentInTheShop>[0], wooOrderId: string) =>
  shipmentInTheShop(keys, wooOrderId, "ord_9", fetch);
const createParcel = (
  keys: Parameters<typeof createTheParcelInTheShop>[0],
  sold: Parameters<typeof createTheParcelInTheShop>[1],
) => createTheParcelInTheShop(keys, sold, fetch);

import { PAYOUT_SPLIT_NETWORKS, payoutSplitFor, payoutSplitNetworkOf } from "@agentify/gateway";
import { wooRefusal } from "@agentify/recorded";
import type { ShipToLocality } from "@nuanu-ai/agentify-contracts";
import type { WooRequest } from "./woo-request.js";
import {
  catalogueOf,
  createTheOrderInTheShop,
  createTheParcelInTheShop,
  inspectProductInTheShop,
  inspectProductsInTheShop,
  readTheOrderInTheShop,
  shipmentInTheShop,
  shippingRatesInTheShop,
  WooShopRuntime,
} from "./woo-shop.js";
import { memoryWooShops } from "./woo-shops.js";

interface Asked {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly cartToken: string | undefined;
  readonly nonce: string | undefined;
  readonly range: string | undefined;
  readonly body: string;
}

interface Stand {
  readonly url: string;
  readonly asked: Asked[];
  close(): Promise<void>;
}

interface ShopAnswer {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly raw?: string;
}
const shopAnswering = async (
  answer: (asked: Asked) => ShopAnswer | Promise<ShopAnswer>,
): Promise<Stand> => {
  const asked: Asked[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", async () => {
      const call: Asked = {
        method: request.method ?? "GET",
        url: request.url ?? "/",
        authorization: request.headers.authorization,
        cartToken: request.headers["cart-token"] as string | undefined,
        nonce: request.headers.nonce as string | undefined,
        range: request.headers.range,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      asked.push(call);
      const said = await answer(call);
      response.writeHead(said.status, { "content-type": "application/json", ...said.headers });
      response.end(said.raw ?? JSON.stringify(said.body));
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    asked,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
};

let stand: Stand | null = null;

/**
 * An answer a check fails on: one the shop gives, one whose body breaks off
 * after its status, or none at all.
 */
interface Failure {
  readonly status: number;
  readonly body?: unknown;
  readonly raw?: string;
  readonly kind?: "broken" | "unanswered";
}

/**
 * The real request, except for the address a failure is made at: `exact`
 * where the address must be the whole of it, since one cart address begins
 * the others.
 */
const failing =
  (where: string, failure: Failure, exact = false): WooRequest =>
  async (url, init) => {
    const href = String(url);
    const here = exact ? href === where : href.includes(where);
    if (here && failure.kind === "unanswered") throw new TypeError("fetch failed");
    if (here && failure.kind === "broken") {
      const cut = new ReadableStream({
        start: (controller) => controller.error(new Error("the answer broke off")),
      });
      return new Response(cut, { status: failure.status });
    }
    return await fetch(url, init);
  };

/** The split a merchant's payment goes to on the test channel, by the gateway's own rule. */
const PAID_INTO = payoutSplitFor(
  payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, "eip155:84532"),
  "mch_0123456789abcdef0123456789abcdef",
  "0xde3F8C4422A7F8C94bce9Cc2Ec118665108148EF",
);

/** The terms of the Base Sepolia experiment's splits, 97% and 3%, as they were created on chain. */
const AT_THREE_PERCENT = {
  ...PAID_INTO,
  merchantAllocation: 970_000,
  commissionAllocation: 30_000,
};

afterEach(async () => {
  await stand?.close();
  stand = null;
});

const aProduct = (id: number) => ({
  id,
  name: `Product ${id}`,
  sku: `sku-${id}`,
  type: "simple",
  description: "<p>Something.</p>",
  short_description: "",
  is_purchasable: true,
  is_in_stock: true,
  prices: { price: "500", currency_code: "USD", currency_minor_unit: 2 },
});

const connectionTo = (url: string) => ({
  shopUrl: url,
  consumerKey: "ck_abc",
  consumerSecret: "cs_def",
});

describe("reading the catalogue", () => {
  it("asks the Store API and carries no credential at all", async () => {
    stand = await shopAnswering(() => ({ status: 200, body: [aProduct(1)] }));
    const read = await readCatalogue(stand.url);

    expect(read.ok).toBe(true);
    expect(read.ok === true && read.products).toHaveLength(1);
    const asked = stand.asked[0];
    expect(asked?.url.startsWith("/wp-json/wc/store/v1/products")).toBe(true);
    // The Store API is public, and a key sent there is a merchant's secret sent
    // where it buys nothing.
    expect(asked?.authorization).toBeUndefined();
  });

  it("keeps asking while the shop is still filling pages", async () => {
    const page = (n: number) =>
      n === 1 ? Array.from({ length: 100 }, (_, i) => aProduct(i + 1)) : [aProduct(101)];
    stand = await shopAnswering((asked) => ({
      status: 200,
      body: page(Number(new URL(asked.url, "http://x").searchParams.get("page") ?? "1")),
    }));

    const read = await readCatalogue(stand.url);
    expect(read.ok === true && read.products).toHaveLength(101);
  });

  it("stops as soon as the shop has more products than the caller wants", async () => {
    // Read whole and refused at the end, a five-thousand-product shop is fifty
    // requests for one "no".
    stand = await shopAnswering(() => ({
      status: 200,
      body: Array.from({ length: 100 }, (_, i) => aProduct(i + 1)),
    }));

    const read = await readCatalogue(stand.url, 150);

    expect(read.ok).toBe(false);
    expect(read.ok === false && read.why).toContain("150");
    // Two pages to know there are more than a hundred and fifty, and no more.
    expect(stand.asked).toHaveLength(2);
  });

  it("refuses on the first page a shop whose own count is over the ceiling", async () => {
    // The shops over the ceiling are the largest ones, and reading them a page
    // past it keeps the merchant waiting for a "no" the first page could give.
    stand = await shopAnswering(() => ({
      status: 200,
      body: Array.from({ length: 100 }, (_, i) => aProduct(i + 1)),
      headers: { "x-wp-total": "3380" },
    }));

    const read = await readCatalogue(stand.url, 2_000);

    expect(read).toMatchObject({ ok: false, why: expect.stringContaining("more than 2,000") });
    expect(stand.asked).toHaveLength(1);
  });

  it("takes a catalogue whose short page settles it, whatever count the shop gives", async () => {
    // A count cached apart from the page, or one written in some other form,
    // never outweighs a page that shows the catalogue is complete.
    for (const total of ["2100", "1e5", " 2001 "]) {
      stand = await shopAnswering(() => ({
        status: 200,
        body: Array.from({ length: 30 }, (_, i) => aProduct(i + 1)),
        headers: { "x-wp-total": total },
      }));

      const read = await readCatalogue(stand.url, 2_000);

      expect(read.ok === true && read.products, total).toHaveLength(30);
      await stand.close();
      stand = null;
    }
  });

  it("refuses early only on a count written as a plain number", async () => {
    stand = await shopAnswering((asked) => ({
      status: 200,
      body:
        Number(new URL(asked.url, "http://x").searchParams.get("page")) === 1
          ? Array.from({ length: 100 }, (_, i) => aProduct(i + 1))
          : [],
      headers: { "x-wp-total": "1e5" },
    }));

    const read = await readCatalogue(stand.url, 2_000);

    expect(read.ok === true && read.products).toHaveLength(100);
  });

  it("reads on past a count at or under the ceiling, which only the pages settle", async () => {
    // A count is the shop's word, which a cache can leave stale: it may refuse
    // early, never admit a catalogue the pages show is too large.
    const page = (n: number) =>
      n <= 2 ? Array.from({ length: 100 }, (_, i) => aProduct(i + 1)) : [aProduct(201)];
    stand = await shopAnswering((asked) => ({
      status: 200,
      body: page(Number(new URL(asked.url, "http://x").searchParams.get("page") ?? "1")),
      headers: { "x-wp-total": "150" },
    }));

    const read = await readCatalogue(stand.url, 200);

    expect(read.ok).toBe(false);
    expect(stand.asked).toHaveLength(3);
  });

  it("refuses a catalogue over the ceiling whose last page is a short one", async () => {
    // The likeliest shape: a catalogue that is not a multiple of the page size.
    // With the short page checked first, it would come over whole past the
    // ceiling.
    const page = (n: number) =>
      n <= 2
        ? Array.from({ length: 100 }, (_, i) => aProduct(i + 1))
        : Array.from({ length: 50 }, (_, i) => aProduct(200 + i + 1));
    stand = await shopAnswering((asked) => ({
      status: 200,
      body: page(Number(new URL(asked.url, "http://x").searchParams.get("page") ?? "1")),
    }));

    const read = await readCatalogue(stand.url, 200);

    expect(read.ok).toBe(false);
    expect(read.ok === false && read.why).toContain("200");
  });

  it("takes a catalogue that is exactly the ceiling", async () => {
    // Exactly the ceiling fits; refusing it would turn away a shop of exactly
    // the size we said we take.
    const page = (n: number) =>
      n <= 2 ? Array.from({ length: 100 }, (_, i) => aProduct(i + 1)) : [];
    stand = await shopAnswering((asked) => ({
      status: 200,
      body: page(Number(new URL(asked.url, "http://x").searchParams.get("page") ?? "1")),
    }));

    const read = await readCatalogue(stand.url, 200);

    expect(read.ok).toBe(true);
    expect(read.ok === true && read.products).toHaveLength(200);
  });

  it("says what a shop that refused looked like rather than showing nothing", async () => {
    stand = await shopAnswering(() => ({
      status: 404,
      body: { code: "rest_no_route", message: "No route was found matching the URL" },
    }));
    const read = await readCatalogue(stand.url);
    expect(read.ok).toBe(false);
    expect(read.ok === false && read.why).toContain("No route was found");
  });

  it("does not pretend a document it cannot read is an empty catalogue", async () => {
    // An empty catalogue and an unreadable answer are different news; a
    // merchant told the first would go looking for their products.
    stand = await shopAnswering(() => ({ status: 200, body: { products: "all of them" } }));
    const read = await readCatalogue(stand.url);
    expect(read.ok).toBe(false);
  });
});

describe("creating the order", () => {
  const order = {
    orderId: "ord_7",
    test: false,
    productId: "11",
    email: "merchant@example.com",
    price: { amount: "25.00", currency: "USD" },
    download: { id: "dl_guide", name: "Guide" },
    // Checked against the wallet itself, before payments went to splits.
    paidInto: null,
    tax: { mode: "off" as const },
  };
  const madeOrder = (overrides: Record<string, unknown> = {}) => ({
    id: 13,
    number: "13",
    order_key: "wc_order_13",
    status: "processing",
    currency: "USD",
    total: "25.00",
    total_tax: "0.00",
    payment_method: "agentify",
    transaction_id: "ord_7",
    billing: { email: "merchant@example.com" },
    meta_data: [{ key: "agentify_order_id", value: "ord_7" }],
    line_items: [
      { product_id: 11, quantity: 1, subtotal: "25.00", total: "25.00", total_tax: "0.00" },
    ],
    ...overrides,
  });

  it("sends a paid order, with the keys as Basic authentication", async () => {
    stand = await shopAnswering(() => ({
      status: 201,
      body: madeOrder(),
    }));

    const made = await createOrder(connectionTo(stand.url), order);

    expect(made).toEqual({
      ok: true,
      id: "13",
      number: "13",
      orderKey: "wc_order_13",
      downloadId: "dl_guide",
      total: "25.00",
    });
    const asked = stand.asked[0];
    expect(asked?.method).toBe("POST");
    expect(asked?.url).toBe("/wp-json/wc/v3/orders");
    expect(asked?.authorization).toBe(`Basic ${Buffer.from("ck_abc:cs_def").toString("base64")}`);

    const sent = JSON.parse(asked?.body ?? "{}");
    // Without it the order sits in the shop's pending list and the merchant
    // never ships it.
    expect(sent.set_paid).toBe(true);
    // The customer-facing name and both stored identifiers share one namespace,
    // so the merchant never has to translate our name in WooCommerce.
    expect(sent.payment_method).toBe("agentify");
    expect(sent.payment_method_title).toBe("Agentify");
    // Paid to the wallet itself, before payments went to splits: no commission
    // was taken, so the order says none.
    expect(sent.meta_data).toEqual([
      { key: "agentify_order_id", value: "ord_7" },
      { key: "agentify_paid", value: "25.00 USD" },
    ]);
    expect(sent.line_items).toEqual([
      { product_id: 11, quantity: 1, subtotal: "25.00", total: "25.00" },
    ]);
    // The only thread between the two systems.
    expect(sent.transaction_id).toBe("ord_7");
    expect(sent.billing.email).toBe("merchant@example.com");
  });

  it("writes the commission and the payout contract on the shop's order in the request that creates it", async () => {
    // The shop's reports show revenue before the commission, and these two
    // visible lines are the merchant's record of it, sent in the one request
    // so there is no new way to fail between creating the order and noting it.
    const lines = [
      { key: "agentify_order_id", value: "ord_7" },
      { key: "agentify_paid", value: "25.00 USD" },
      { key: "agentify_commission", value: "≈ 0.025 USD (0.1%)" },
      { key: "agentify_payout_contract", value: PAID_INTO.address },
    ];
    stand = await shopAnswering(() => ({ status: 201, body: madeOrder({ meta_data: lines }) }));

    const made = await createOrder(connectionTo(stand.url), { ...order, paidInto: PAID_INTO });

    // The shop echoes all three, and the order is placed.
    expect(made.ok).toBe(true);
    expect(stand.asked).toHaveLength(1);
    const sent = JSON.parse(stand.asked[0]?.body ?? "{}");
    expect(sent.meta_data).toStrictEqual(lines);
    // WooCommerce hides a key that starts with an underscore.
    expect(
      (sent.meta_data as { key: string }[]).filter((one) => one.key.startsWith("_")),
    ).toStrictEqual([]);
    // The order is still the whole price the buyer paid.
    expect(sent.line_items).toEqual([
      { product_id: 11, quantity: 1, subtotal: "25.00", total: "25.00" },
    ]);
  });

  it("says on a test channel's order that it was paid in test USDC, which is not real money", async () => {
    // A merchant may connect their real shop on the test channel, whose paid
    // orders look like any other in WooCommerce unless the order says so.
    stand = await shopAnswering(() => ({ status: 201, body: madeOrder() }));

    await createOrder(connectionTo(stand.url), { ...order, test: true });

    const lines = JSON.parse(stand.asked[0]?.body ?? "{}").meta_data;
    expect(lines).toContainEqual({ key: "agentify_channel", value: "test" });
    expect(lines).toContainEqual({
      key: "agentify_paid",
      value: "25.00 USD in test USDC, not real money",
    });
  });

  it("writes the commission at the rate of the split the payment went to", async () => {
    stand = await shopAnswering(() => ({ status: 201, body: madeOrder() }));

    await createOrder(connectionTo(stand.url), { ...order, paidInto: AT_THREE_PERCENT });

    expect(JSON.parse(stand.asked[0]?.body ?? "{}").meta_data).toContainEqual({
      key: "agentify_commission",
      value: "≈ 0.75 USD (3%)",
    });
  });

  it("reads the number the shop gave the order rather than its row id", async () => {
    // A shop with a renumbering plugin answers a `number` that is not the id,
    // and the number is what the merchant sees.
    stand = await shopAnswering(() => ({
      status: 201,
      body: madeOrder({ number: "WOO-0013" }),
    }));
    const made = await createOrder(connectionTo(stand.url), order);
    expect(made).toMatchObject({ ok: true, id: "13", number: "WOO-0013" });
  });

  it("reads only the exact Woo order named for uncertain-create recovery", async () => {
    stand = await shopAnswering(() => ({
      status: 200,
      body: madeOrder({
        number: "WOO-0013",
        payment_method: "agentify",
        transaction_id: "ord_7",
        billing: { email: "merchant@example.com" },
        meta_data: [{ key: "agentify_order_id", value: "ord_7" }],
      }),
    }));

    const read = await readOrder(connectionTo(stand.url), "13");

    expect(read).toMatchObject({
      ok: true,
      order: {
        id: "13",
        number: "WOO-0013",
        transactionId: "ord_7",
        agentifyOrderIds: ["ord_7"],
      },
    });
    expect(stand.asked).toHaveLength(1);
    expect(stand.asked[0]?.method).toBe("GET");
    expect(stand.asked[0]?.url).toBe("/wp-json/wc/v3/orders/13");
  });

  it("keeps every Agentify metadata entry so duplicate correlation cannot look unique", async () => {
    stand = await shopAnswering(() => ({
      status: 200,
      body: madeOrder({
        meta_data: [
          { key: "agentify_order_id", value: "ord_7" },
          { key: "agentify_order_id", value: { malformed: true } },
        ],
      }),
    }));

    const read = await readOrder(connectionTo(stand.url), "13");

    expect(read.ok && read.order.agentifyOrderIds).toHaveLength(2);
  });

  it("does not carry an authenticated shop's response into the error", async () => {
    const secret = `Basic ${Buffer.from("ck_abc:cs_def").toString("base64")}`;
    const refused = wooRefusal("woocommerce_rest_required_product_reference");
    // WooCommerce's refusal, in words that repeat the request's credentials.
    stand = await shopAnswering(() => ({
      status: refused.status,
      body: { ...refused.body, message: `reflected ${secret}` },
    }));
    const made = await createOrder(connectionTo(stand.url), order);
    expect(made.ok).toBe(false);
    expect(made.ok === false && made.why).not.toContain(secret);
    // A shop that says the product is wrong says it every time.
    expect(made.ok === false && made.again).toBe(false);
  });

  it("refuses a successful order response whose Agentify correlation changed", async () => {
    const commission = [
      { key: "agentify_commission", value: "≈ 0.025 USD (0.1%)" },
      { key: "agentify_payout_contract", value: PAID_INTO.address },
    ];
    for (const extra of [[], commission]) {
      for (const changed of [
        { payment_method: "other" },
        { transaction_id: "ord_other" },
        { billing: { email: "somebody@example.com" } },
        { meta_data: [] },
        { meta_data: [{ key: "agentify_order_id", value: "ord_other" }] },
        {
          meta_data: [
            { key: "agentify_order_id", value: "ord_7" },
            { key: "agentify_order_id", value: "ord_7" },
          ],
        },
      ]) {
        stand = await shopAnswering(() => ({
          status: 201,
          body: madeOrder({
            ...changed,
            meta_data: [
              ...(changed.meta_data ?? [{ key: "agentify_order_id", value: "ord_7" }]),
              ...extra,
            ],
          }),
        }));
        const made = await createOrder(connectionTo(stand.url), {
          ...order,
          paidInto: extra.length === 0 ? null : PAID_INTO,
        });
        expect(made).toMatchObject({ ok: false, again: true });
        await stand.close();
        stand = null;
      }
    }
  });

  /**
   * The tax probe's answers for a download left to WooCommerce to price, as
   * the shop in Bali gave them: the gross price paid, the tax inside it.
   */
  const ANSWERED_IN_BALI = [
    {
      productId: 20,
      paid: "1.00",
      answer: { total: "1.00", total_tax: "0.10", subtotal: "0.90", line: "0.90", lineTax: "0.10" },
    },
    {
      productId: 28,
      paid: "99.99",
      answer: {
        total: "99.99",
        total_tax: "9.91",
        subtotal: "90.08",
        line: "90.08",
        lineTax: "9.91",
      },
    },
  ] as const;
  const answeredWith = (
    productId: number,
    answer: {
      total: string;
      total_tax: string;
      subtotal: string;
      line: string;
      lineTax: string;
    },
  ) =>
    madeOrder({
      total: answer.total,
      total_tax: answer.total_tax,
      line_items: [
        {
          product_id: productId,
          quantity: 1,
          subtotal: answer.subtotal,
          total: answer.line,
          total_tax: answer.lineTax,
        },
      ],
    });

  it("leaves an inclusive shop to price its download, and takes the order on at the price paid with the tax inside", async () => {
    for (const { productId, paid, answer } of ANSWERED_IN_BALI) {
      stand = await shopAnswering(() => ({ status: 201, body: answeredWith(productId, answer) }));

      const made = await createOrder(connectionTo(stand.url), {
        ...order,
        productId: String(productId),
        price: { amount: paid, currency: "USD" },
        tax: { mode: "included" },
      });

      expect(made, paid).toMatchObject({ ok: true, id: "13" });
      // Totals sent on the line are read as amounts before tax and taxed on
      // top, so the line names the product and lets the shop price it.
      expect(JSON.parse(stand.asked[0]?.body ?? "{}").line_items, paid).toEqual([
        { product_id: productId, quantity: 1 },
      ]);
      await stand.close();
      stand = null;
    }
  });

  it("takes on an inclusive shop's order totalled within a cent of what was paid, and says what the shop recorded", async () => {
    // The German shop with a 10% rate and a 5% compound one, rounding per
    // line: paid 1.00, its order totalled 1.01 with 0.14 of tax.
    stand = await shopAnswering(() => ({
      status: 201,
      body: answeredWith(20, {
        total: "1.01",
        total_tax: "0.14",
        subtotal: "0.87",
        line: "0.87",
        lineTax: "0.14",
      }),
    }));

    const made = await createOrder(connectionTo(stand.url), {
      ...order,
      productId: "20",
      price: { amount: "1.00", currency: "USD" },
      tax: { mode: "included" },
    });

    expect(made).toMatchObject({ ok: true, total: "1.01" });
  });

  it("does not take on an inclusive shop's order whose total is more than a cent from what was paid", async () => {
    // The Bali shop's order with the totals sent on its line, taxed on top:
    // 1.11 for a price of 1.00.
    stand = await shopAnswering(() => ({
      status: 201,
      body: answeredWith(20, {
        total: "1.11",
        total_tax: "0.11",
        subtotal: "1.00",
        line: "1.00",
        lineTax: "0.11",
      }),
    }));

    const made = await createOrder(connectionTo(stand.url), {
      ...order,
      productId: "20",
      price: { amount: "1.00", currency: "USD" },
      tax: { mode: "included" },
    });

    expect(made).toMatchObject({ ok: false, again: true });
  });

  it("takes on a download's order a cent from what was paid from a shop calculating no tax too, and no more", async () => {
    stand = await shopAnswering(() => ({ status: 201, body: madeOrder({ total: "25.01" }) }));
    expect(await createOrder(connectionTo(stand.url), order)).toMatchObject({
      ok: true,
      total: "25.01",
    });
    expect(JSON.parse(stand.asked[0]?.body ?? "{}").meta_data).toContainEqual({
      key: "agentify_paid",
      value: "25.00 USD",
    });
    expect(stand.asked).toHaveLength(1);
    await stand.close();
    stand = await shopAnswering(() => ({ status: 201, body: madeOrder({ total: "25.02" }) }));
    expect(await createOrder(connectionTo(stand.url), order)).toMatchObject({
      ok: false,
      again: true,
    });
  });

  it("does not take on the order of a shop sold as calculating no tax when the order carries tax", async () => {
    for (const changed of [
      { total_tax: "0.01" },
      {
        line_items: [
          { product_id: 11, quantity: 1, subtotal: "25.00", total: "25.00", total_tax: "0.01" },
        ],
      },
    ]) {
      stand = await shopAnswering(() => ({ status: 201, body: madeOrder(changed) }));
      expect(await createOrder(connectionTo(stand.url), order)).toMatchObject({
        ok: false,
        again: true,
      });
      await stand.close();
      stand = null;
    }
  });

  it("says a shop that would not answer is worth asking again", async () => {
    const made = await createOrder(connectionTo("http://127.0.0.1:1"), order);
    expect(made.ok).toBe(false);
    expect(made.ok === false && made.again).toBe(true);
  });

  it("says a shop that is busy is worth asking again", async () => {
    // 429 and 408 are not 5xx; read as final, a busy afternoon would close the
    // sale for good.
    for (const [status, again] of [
      [408, true],
      [429, true],
      [502, true],
      [401, false],
    ] as const) {
      stand = await shopAnswering(() => ({ status, body: { message: "later" } }));
      const made = await createOrder(connectionTo(stand.url), order);
      expect(made).toMatchObject({ ok: false, again });
      await stand.close();
      stand = null;
    }
  });

  it("does not claim an order from an answer with no order in it", async () => {
    // A proxy answering 201 with its own page would otherwise become a delivery
    // naming order number "undefined".
    stand = await shopAnswering(() => ({ status: 201, body: { ok: true } }));
    const made = await createOrder(connectionTo(stand.url), order);
    expect(made).toMatchObject({ ok: false, again: true });
    expect(made).not.toHaveProperty("id");
    expect(made).not.toHaveProperty("number");
  });
});

describe("the protected product check", () => {
  const productDocument = (overrides: Record<string, unknown> = {}) => ({
    id: 11,
    type: "simple",
    status: "publish",
    purchasable: true,
    stock_status: "instock",
    manage_stock: false,
    sold_individually: false,
    virtual: true,
    downloadable: true,
    download_limit: -1,
    download_expiry: -1,
    price: "0.01",
    // WooCommerce leaves this default on ordinary products even with tax
    // calculation off and the field hidden from its editor.
    tax_status: "taxable",
    downloads: [
      {
        id: "dl_guide",
        name: "Agentify guide.txt",
        file: `${stand?.url ?? "http://127.0.0.1"}/protected/guide.txt`,
      },
    ],
    ...overrides,
  });

  const settingFor = (url: string): string => {
    if (url.includes("woocommerce_currency")) return "USD";
    if (url.includes("woocommerce_price_num_decimals")) return "2";
    if (url.includes("woocommerce_calc_taxes")) return "no";
    if (url.includes("woocommerce_file_download_method")) return "force";
    if (url.includes("woocommerce_downloads_grant_access_after_payment")) return "yes";
    return "no";
  };

  /** A physical simple product as `wc/v3` writes one. */
  const parcelDocument = (overrides: Record<string, unknown> = {}) =>
    productDocument({
      id: 28,
      virtual: false,
      downloadable: false,
      downloads: [],
      price: "20.00",
      ...overrides,
    });

  /** Shipping to the shipping address. */
  const parcelSettingFor = (url: string): string => {
    if (url.includes("woocommerce_ship_to_countries")) return "";
    if (url.includes("woocommerce_ship_to_destination")) return "shipping";
    return settingFor(url);
  };

  /** A settings document as `wc/v3` writes one: the setting's own id beside its value. */
  const settingAt = (url: string, value: string | boolean) => ({
    id: url.split("/").at(-1),
    value,
  });

  it("accepts a physical simple product as a parcel, judged by the shop's shipping settings", async () => {
    // A shop whose download settings would refuse every file, or will not show
    // them, still sells a parcel, and no file is asked for.
    stand = await shopAnswering((asked) => {
      if (asked.url.includes("woocommerce_file_download_method")) {
        return { status: 401, body: { code: "woocommerce_rest_cannot_view" } };
      }
      if (asked.url.includes("woocommerce_downloads_require_login")) {
        return { status: 200, body: settingAt(asked.url, "yes") };
      }
      if (asked.url.includes("/settings/")) {
        return { status: 200, body: settingAt(asked.url, parcelSettingFor(asked.url)) };
      }
      return { status: 200, body: parcelDocument() };
    });

    const read = await inspectProduct(connectionTo(stand.url), merchantItemIdFor(stand.url, "28"));

    expect(read).toMatchObject({
      ok: true,
      product: {
        kind: "parcel",
        productId: "28",
        price: { amount: "20.00", currency: "USD" },
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(stand.asked.every((asked) => asked.url.startsWith("/wp-json/wc/v3/"))).toBe(true);
  });

  it("refuses a parcel from a shop that ships nowhere, or only to the billing address", async () => {
    // With shipping off there is no rate; forcing the billing address keeps no
    // shipping address, so the agent's address would vanish from the order
    // screen.
    for (const [setting, value, named] of [
      ["woocommerce_ship_to_countries", "disabled", "Shipping location"],
      ["woocommerce_ship_to_destination", "billing_only", "billing address"],
    ] as const) {
      stand = await shopAnswering((asked) => {
        if (asked.url.includes(setting)) return { status: 200, body: settingAt(asked.url, value) };
        if (asked.url.includes("/settings/")) {
          return { status: 200, body: settingAt(asked.url, parcelSettingFor(asked.url)) };
        }
        return { status: 200, body: parcelDocument() };
      });

      const read = await inspectProduct(
        connectionTo(stand.url),
        merchantItemIdFor(stand.url, "28"),
      );

      expect(read, setting).toMatchObject({
        ok: false,
        again: false,
        why: expect.stringContaining(named),
      });
      await stand.close();
      stand = null;
    }
  });

  it("still sells a download from a shop that will not show its shipping settings", async () => {
    // Shipping settings are a parcel's; a shop that hides them still sells its
    // files.
    stand = await shopAnswering((asked) => {
      if (asked.url === "/protected/guide.txt") return { status: 403, body: {} };
      if (asked.url.includes("woocommerce_ship_to")) {
        return { status: 401, body: { code: "woocommerce_rest_cannot_view" } };
      }
      if (asked.url.includes("/settings/")) {
        return { status: 200, body: settingAt(asked.url, settingFor(asked.url)) };
      }
      return { status: 200, body: productDocument() };
    });

    const read = await inspectProduct(connectionTo(stand.url), merchantItemIdFor(stand.url, "11"));

    expect(read).toMatchObject({ ok: true, product: { kind: "download" } });
  });

  it("refuses a parcel whose shipping settings the shop will not show", async () => {
    stand = await shopAnswering((asked) => {
      if (asked.url.includes("woocommerce_ship_to_destination")) {
        return { status: 401, body: { code: "woocommerce_rest_cannot_view" } };
      }
      if (asked.url.includes("/settings/")) {
        return { status: 200, body: settingAt(asked.url, parcelSettingFor(asked.url)) };
      }
      return { status: 200, body: parcelDocument() };
    });

    const read = await inspectProduct(connectionTo(stand.url), merchantItemIdFor(stand.url, "28"));

    // Refused, and not as the shop ruling the product out: it said nothing.
    expect(read).toMatchObject({ ok: false, again: false, saidNo: false });
  });

  /**
   * `fetch`, except that a request whose address contains `lost` is dropped
   * before any answer, or answered with a body that breaks off.
   */
  const losing =
    (lost: string, how: "request" | "body"): WooRequest =>
    async (url, init) => {
      if (!String(url).includes(lost)) return fetch(url, init);
      if (how === "request") throw new TypeError("fetch failed");
      const broken = new ReadableStream({
        start: (controller) => controller.error(new Error("connection reset")),
      });
      return new Response(broken, { status: 200 });
    };

  const shopSellingBoth = () =>
    shopAnswering((asked) => {
      if (asked.url === "/protected/guide.txt") return { status: 403, body: {} };
      if (asked.url.includes("/settings/")) {
        return { status: 200, body: settingAt(asked.url, parcelSettingFor(asked.url)) };
      }
      return {
        status: 200,
        body: asked.url.endsWith("/28") ? parcelDocument() : productDocument(),
      };
    });

  it("judges a product by its class's settings when the shop loses its answer about another class's", async () => {
    stand = await shopSellingBoth();
    for (const [requested, lost] of [
      ["11", "woocommerce_ship_to_destination"],
      ["28", "woocommerce_downloads_require_login"],
    ] as const) {
      for (const how of ["request", "body"] as const) {
        const read = await inspectProductInTheShop(
          connectionTo(stand.url),
          merchantItemIdFor(stand.url, requested),
          losing(lost, how),
        );

        expect(read, `${lost}, ${how}`).toMatchObject({ ok: true });
      }
    }
  });

  it("asks again when the shop drops the request for a setting the product's class needs", async () => {
    stand = await shopSellingBoth();
    for (const [requested, lost] of [
      ["11", "woocommerce_downloads_require_login"],
      ["28", "woocommerce_ship_to_destination"],
    ] as const) {
      const read = await inspectProductInTheShop(
        connectionTo(stand.url),
        merchantItemIdFor(stand.url, requested),
        losing(lost, "request"),
      );

      expect(read, lost).toMatchObject({ ok: false, again: true });
    }
  });

  it("refuses a product document that names another product, as a parcel or a download", async () => {
    for (const [document, requested] of [
      [() => productDocument({ id: 12 }), "11"],
      [() => parcelDocument({ id: 29 }), "28"],
    ] as const) {
      stand = await shopAnswering((asked) => {
        if (asked.url === "/protected/guide.txt") return { status: 403, body: {} };
        if (asked.url.includes("/settings/")) {
          return { status: 200, body: settingAt(asked.url, parcelSettingFor(asked.url)) };
        }
        return { status: 200, body: document() };
      });

      const read = await inspectProduct(
        connectionTo(stand.url),
        merchantItemIdFor(stand.url, requested),
      );

      expect(read, requested).toMatchObject({ ok: false, again: false, saidNo: false });
      await stand.close();
      stand = null;
    }
  });

  it("keeps private credentials and cached product answers separate when connections share anonymous carts", async () => {
    stand = await shopAnswering((asked) => {
      if (asked.url.includes("/settings/"))
        return { status: 200, body: settingAt(asked.url, parcelSettingFor(asked.url)) };
      const accountA =
        asked.authorization ===
        `Basic ${Buffer.from("ck_account_a:cs_account_a").toString("base64")}`;
      return { status: 200, body: parcelDocument({ price: accountA ? "20.00" : "30.00" }) };
    });
    const owner = new WooShopRuntime(connectionTo(stand.url), fetch);
    const a = owner.forConnection({
      ...connectionTo(stand.url),
      consumerKey: "ck_account_a",
      consumerSecret: "cs_account_a",
    });
    const b = owner.forConnection({
      ...connectionTo(stand.url),
      consumerKey: "ck_account_b",
      consumerSecret: "cs_account_b",
    });
    const item = merchantItemIdFor(stand.url, "28");
    const [first, second] = await Promise.all([a.inspectForQuote(item), b.inspectForQuote(item)]);
    expect(first).toMatchObject({ ok: true, product: { price: { amount: "20.00" } } });
    expect(second).toMatchObject({ ok: true, product: { price: { amount: "30.00" } } });
    expect(await a.inspectForQuote(item)).toMatchObject({
      ok: true,
      product: { price: { amount: "20.00" } },
    });
  });

  it("coalesces short product reads and longer settings reads for quotes while paid inspection stays fresh", async () => {
    let price = "20.00";
    let refuseProduct = false;
    stand = await shopAnswering((asked) =>
      asked.url.includes("/settings/")
        ? { status: 200, body: settingAt(asked.url, parcelSettingFor(asked.url)) }
        : refuseProduct
          ? { status: 503, body: {} }
          : { status: 200, body: parcelDocument({ price }) },
    );
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    try {
      const keys = connectionTo(stand.url);
      const runtime = new WooShopRuntime(keys, fetch);
      const item = merchantItemIdFor(stand.url, "28");
      const first = await Promise.all([
        runtime.inspectForQuote(item),
        runtime.inspectForQuote(item),
      ]);
      expect(first.every((read) => read.ok && read.product.price.amount === "20.00")).toBe(true);
      expect(stand.asked.filter((call) => /\/products\/28$/.test(call.url))).toHaveLength(1);
      const settings = stand.asked.filter((call) =>
        /\/settings\/[^/]+\/woocommerce_/.test(call.url),
      ).length;
      price = "21.00";
      expect(await inspectProductInTheShop(keys, item, fetch)).toMatchObject({
        ok: true,
        product: { price: { amount: "21.00" } },
      });
      clock.mockReturnValue(1_800_000_006_000);
      refuseProduct = true;
      expect(await runtime.inspectForQuote(item)).toMatchObject({ ok: false, again: true });
      refuseProduct = false;
      expect(await runtime.inspectForQuote(item)).toMatchObject({
        ok: true,
        product: { price: { amount: "21.00" } },
      });
      expect(
        stand.asked.filter((call) => /\/settings\/[^/]+\/woocommerce_/.test(call.url)),
      ).toHaveLength(settings * 2);
      clock.mockReturnValue(1_800_000_181_000);
      await runtime.inspectForQuote(item);
      expect(
        stand.asked.filter((call) => /\/settings\/[^/]+\/woocommerce_/.test(call.url)),
      ).toHaveLength(settings * 3);
    } finally {
      clock.mockRestore();
    }
  });

  it("asks the shop again for a product document too large to keep", async () => {
    stand = await shopAnswering((asked) =>
      asked.url.includes("/settings/")
        ? { status: 200, body: settingAt(asked.url, parcelSettingFor(asked.url)) }
        : {
            status: 200,
            // Under 256 Ki characters, over 256 KiB as bytes.
            body: parcelDocument({ description: "<p>Холст и нить.</p>".repeat(12_000) }),
          },
    );
    const runtime = new WooShopRuntime(connectionTo(stand.url), fetch);
    const item = merchantItemIdFor(stand.url, "28");
    expect(await runtime.inspectForQuote(item)).toMatchObject({ ok: true });
    expect(await runtime.inspectForQuote(item)).toMatchObject({ ok: true });
    expect(stand.asked.filter((call) => /\/products\/28$/.test(call.url))).toHaveLength(2);
  });

  it("refuses a settings document that names another setting, or none", async () => {
    // A cache that took one setting's address for another's would lend the
    // other setting's answer to the one asked for.
    for (const answered of [
      { id: "woocommerce_downloads_redirect_fallback_allowed", value: "no" },
      { value: "no" },
    ]) {
      stand = await shopAnswering((asked) => {
        if (asked.url === "/protected/guide.txt") return { status: 403, body: {} };
        if (asked.url.includes("woocommerce_downloads_require_login")) {
          return { status: 200, body: answered };
        }
        if (asked.url.includes("/settings/")) {
          return { status: 200, body: settingAt(asked.url, settingFor(asked.url)) };
        }
        return { status: 200, body: productDocument() };
      });

      const read = await inspectProduct(
        connectionTo(stand.url),
        merchantItemIdFor(stand.url, "11"),
      );

      expect(read, JSON.stringify(answered)).toMatchObject({
        ok: false,
        again: false,
        saidNo: false,
      });
      await stand.close();
      stand = null;
    }
  });

  it("says a shop that would not answer the product check is worth asking again", async () => {
    // The order this check guards is still live while the shop is down or busy,
    // and a refusal read off a timeout would close it with an untrue reason.
    const down = await inspectProduct(
      connectionTo("http://127.0.0.1:1"),
      merchantItemIdFor("http://127.0.0.1:1", "11"),
    );
    expect(down).toMatchObject({ ok: false, again: true });

    for (const status of [408, 429, 503]) {
      stand = await shopAnswering(() => ({ status, body: { message: "later" } }));
      const busy = await inspectProduct(
        connectionTo(stand.url),
        merchantItemIdFor(stand.url, "11"),
      );
      expect(busy, String(status)).toMatchObject({ ok: false, again: true });
      await stand.close();
      stand = null;
    }
  });

  it("names in the reason for every failed answer which check it was and the status it came with", async () => {
    // The reason is what the operator's log says of the shop; the status and
    // the address it came from are what they take to the merchant's host. An
    // answer that broke off is asked again, as one never given is.
    const failures: readonly Failure[] = [
      { status: 503, body: { message: "later" } },
      { status: 429, body: { message: "later" } },
      { status: 408, body: { message: "later" } },
      { status: 401, body: { code: "woocommerce_rest_cannot_view" } },
      { status: 403, body: { code: "forbidden" } },
      { status: 404, body: { code: "rest_no_route" } },
      { status: 200, raw: "not-json" },
      { status: 200, body: { id: 28 } },
      { status: 200, body: productDocument({ id: 99 }) },
      { status: 200, kind: "broken" },
      { status: 0, kind: "unanswered" },
    ];
    const file = "/protected/guide.txt";
    const checks = [
      ["/wc/v3/products/", productDocument],
      ["woocommerce_downloads_require_login", productDocument],
      ["woocommerce_calc_taxes", productDocument],
      ["woocommerce_ship_to_destination", parcelDocument],
      [file, productDocument],
    ] as const;
    for (const failure of failures) {
      // Every answer from the raw file is a verdict except a refusal.
      const asked = checks.filter(
        ([where]) => where !== file || ![401, 403].includes(failure.status),
      );
      for (const [where, product] of asked) {
        stand = await shopAnswering((one) => {
          if (one.url.includes(where)) return failure;
          if (one.url === file) return { status: 403, body: {} };
          if (one.url.includes("/settings/")) {
            const setting = product === parcelDocument ? parcelSettingFor : settingFor;
            return { status: 200, body: settingAt(one.url, setting(one.url)) };
          }
          return { status: 200, body: product() };
        });

        const read = await inspectProductInTheShop(
          connectionTo(stand.url),
          merchantItemIdFor(stand.url, product === parcelDocument ? "28" : "11"),
          failing(where, failure),
        );

        const said = `${where} ${failure.kind ?? failure.status}`;
        expect(read.ok, said).toBe(false);
        if (!read.ok) {
          if (failure.kind !== "unanswered") {
            expect(read.why, said).toContain(String(failure.status));
          }
          expect(read.why, said).toMatch(
            where === file
              ? /download|file/i
              : where === "/wc/v3/products/"
                ? /product/i
                : new RegExp(where),
          );
          const busy = [408, 429, 503].includes(failure.status);
          expect(read.again, said).toBe(busy || (where !== file && failure.kind !== undefined));
          if (!read.again)
            expect(read.saidNo, said).toBe(where === file && failure.kind === undefined);
        }
        await stand.close();
        stand = null;
      }
    }
  });

  it("says the shop ruled a product out only where its own readable answer did", async () => {
    // What the buyer is told hangs on this: "not available" is the seller's
    // word, and a revoked key or a page that is not WooCommerce's said nothing
    // about the product.
    for (const [what, answered, saidNo] of [
      ["out of stock", { status: 200, body: parcelDocument({ stock_status: "outofstock" }) }, true],
      ["not purchasable", { status: 200, body: parcelDocument({ purchasable: false }) }, true],
      ["unpublished", { status: 200, body: parcelDocument({ status: "draft" }) }, true],
      [
        "deleted",
        {
          status: 404,
          body: {
            code: "woocommerce_rest_product_invalid_id",
            message: "Invalid ID.",
            data: { status: 404 },
          },
        },
        true,
      ],
      [
        "a revoked key",
        {
          status: 401,
          body: {
            code: "woocommerce_rest_cannot_view",
            message: "Sorry, you cannot view this resource.",
          },
        },
        false,
      ],
      ["a page that is not JSON", { status: 200, raw: "not-json" }, false],
      ["a route that is not there", { status: 404, body: { code: "rest_no_route" } }, false],
      ["an incomplete document", { status: 200, body: { id: 28, type: "simple" } }, false],
      ["another product's document", { status: 200, body: parcelDocument({ id: 29 }) }, false],
    ] as const) {
      stand = await shopAnswering((asked) =>
        asked.url.includes("/settings/")
          ? { status: 200, body: settingAt(asked.url, parcelSettingFor(asked.url)) }
          : answered,
      );

      const read = await inspectProduct(
        connectionTo(stand.url),
        merchantItemIdFor(stand.url, "28"),
      );

      expect(read, what).toMatchObject({ ok: false, again: false, saidNo });
      await stand.close();
      stand = null;
    }

    // A card left from a shop connected before is settled without asking this
    // one: it cannot be sold here.
    expect(
      await inspectProduct(
        connectionTo("http://127.0.0.1:1"),
        merchantItemIdFor("https://another-shop.example", "28"),
      ),
    ).toMatchObject({ ok: false, again: false, saidNo: true });
  });

  it("accepts only the one protected native download the agent can receive", async () => {
    stand = await shopAnswering((asked) => {
      if (asked.url === "/protected/guide.txt") return { status: 403, body: {} };
      if (asked.url.includes("/settings/")) {
        return { status: 200, body: settingAt(asked.url, settingFor(asked.url)) };
      }
      return { status: 200, body: productDocument() };
    });
    const keys = connectionTo(stand.url);

    const read = await inspectProduct(keys, merchantItemIdFor(stand.url, "11"));

    expect(read).toMatchObject({
      ok: true,
      product: {
        productId: "11",
        downloadId: "dl_guide",
        fileName: "Agentify guide.txt",
        price: { amount: "0.01", currency: "USD" },
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    // The key goes only with questions to the shop's API; the raw file is asked
    // for as a stranger would.
    const api = stand.asked.filter((asked) => asked.url.startsWith("/wp-json/"));
    expect(api.length).toBeGreaterThan(0);
    expect(api.every((asked) => asked.authorization !== undefined)).toBe(true);
    expect(
      stand.asked.find((asked) => asked.url === "/protected/guide.txt")?.authorization,
    ).toBeUndefined();
  });

  it("refuses public raw bytes and finite or stock-managed products", async () => {
    for (const [overrides, reason] of [
      [{ manage_stock: true }, /managed stock/i],
      [{ sold_individually: true }, /sold individually/i],
      [{ download_limit: 1 }, /download count.*limited/i],
      [{ download_expiry: 1 }, /download access expires/i],
    ] as const) {
      stand = await shopAnswering((asked) => {
        if (asked.url === "/protected/guide.txt") return { status: 403, body: {} };
        if (asked.url.includes("/settings/")) {
          return { status: 200, body: settingAt(asked.url, settingFor(asked.url)) };
        }
        return { status: 200, body: productDocument(overrides) };
      });
      const read = await inspectProduct(
        connectionTo(stand.url),
        merchantItemIdFor(stand.url, "11"),
      );
      expect(read).toMatchObject({
        ok: false,
        again: false,
        saidNo: true,
        why: expect.stringMatching(reason),
      });
      await stand.close();
      stand = null;
    }

    stand = await shopAnswering((asked) => {
      if (asked.url === "/protected/guide.txt") return { status: 200, body: "public" };
      if (asked.url.includes("/settings/")) {
        return { status: 200, body: settingAt(asked.url, settingFor(asked.url)) };
      }
      return { status: 200, body: productDocument() };
    });
    const publicFile = await inspectProduct(
      connectionTo(stand.url),
      merchantItemIdFor(stand.url, "11"),
    );
    // A file anyone can fetch is the shop's own answer, and it rules the sale out.
    expect(publicFile).toMatchObject({
      ok: false,
      saidNo: true,
      why: expect.stringContaining("public"),
    });
  });

  it("asks for a download's first byte only, so a public file is not fetched whole to learn it is public", async () => {
    // A whole catalogue of downloads checks every file; on a shop whose files
    // are public that would pull each of them from somebody else's server.
    stand = await shopAnswering((asked) => {
      if (asked.url === "/protected/guide.txt") {
        return asked.range === "bytes=0-0"
          ? { status: 206, raw: "x", headers: { "content-range": "bytes 0-0/2000000" } }
          : { status: 200, raw: "x".repeat(2_000_000) };
      }
      if (asked.url.includes("/settings/")) {
        return { status: 200, body: settingAt(asked.url, settingFor(asked.url)) };
      }
      return { status: 200, body: productDocument() };
    });

    const read = await inspectProduct(connectionTo(stand.url), merchantItemIdFor(stand.url, "11"));

    expect(read).toMatchObject({ ok: false, saidNo: true, why: expect.stringContaining("public") });
    expect(stand.asked.find((asked) => asked.url === "/protected/guide.txt")?.range).toBe(
      "bytes=0-0",
    );
  });

  it("calls a downloadable file public only where it was served without an order permission", async () => {
    // A missing file or a redirect to a login is not a file anyone can fetch;
    // either still refuses the sale, which cannot rely on it being protected.
    for (const [status, isPublic] of [
      [200, true],
      [404, false],
      [302, false],
    ] as const) {
      stand = await shopAnswering((asked) => {
        if (asked.url === "/protected/guide.txt") {
          const headers: Record<string, string> = status === 302 ? { location: "/login" } : {};
          return { status, body: {}, headers };
        }
        if (asked.url.includes("/settings/")) {
          return { status: 200, body: settingAt(asked.url, settingFor(asked.url)) };
        }
        return { status: 200, body: productDocument() };
      });

      const read = await inspectProduct(
        connectionTo(stand.url),
        merchantItemIdFor(stand.url, "11"),
      );

      expect(read, `${status}`).toMatchObject({ ok: false, saidNo: true });
      expect(!read.ok && /public/i.test(read.why), `${status}`).toBe(isPublic);
      await stand.close();
      stand = null;
    }
  });

  /**
   * The two shops of the tax probe: one in Bali entering prices with
   * Indonesia's VAT inside them, one in Seattle entering them before
   * Washington's sales tax, each showing its catalogue the way it enters it.
   */
  const BALI = {
    woocommerce_prices_include_tax: "yes",
    woocommerce_tax_display_shop: "incl",
    woocommerce_tax_based_on: "shipping",
    woocommerce_tax_round_at_subtotal: "no",
    woocommerce_default_country: "ID:BA",
    woocommerce_store_city: "Denpasar",
    woocommerce_store_postcode: "80361",
  } as const;
  const SEATTLE = {
    woocommerce_prices_include_tax: "no",
    woocommerce_tax_display_shop: "excl",
    woocommerce_tax_based_on: "shipping",
    woocommerce_tax_round_at_subtotal: "no",
    woocommerce_default_country: "US:WA",
    woocommerce_store_city: "Seattle",
    woocommerce_store_postcode: "98101",
  } as const;
  type TaxedShop = Readonly<Record<keyof typeof BALI, string>>;
  /** The two shops rounding tax at the subtotal, as every sale under tax needs. */
  const BALI_AT_SUBTOTAL: TaxedShop = { ...BALI, woocommerce_tax_round_at_subtotal: "yes" };
  const SEATTLE_AT_SUBTOTAL: TaxedShop = { ...SEATTLE, woocommerce_tax_round_at_subtotal: "yes" };

  /**
   * A shop that calculates tax, answering its tax and general settings as
   * `wc/v3` answers a settings group: every setting of the group in one list.
   */
  const taxingAnswer =
    (shop: TaxedShop, calcTaxes: string, origin?: string) =>
    (path: string): { status: number; body: unknown } => {
      if (path === "/protected/guide.txt") return { status: 403, body: {} };
      const group = (ids: readonly (keyof TaxedShop)[]) => ({
        status: 200,
        body: ids.map((id) => ({ id, value: shop[id] })),
      });
      if (path === "/wp-json/wc/v3/settings/tax") {
        return group([
          "woocommerce_prices_include_tax",
          "woocommerce_tax_display_shop",
          "woocommerce_tax_based_on",
          "woocommerce_tax_round_at_subtotal",
        ]);
      }
      if (path === "/wp-json/wc/v3/settings/general") {
        return group([
          "woocommerce_default_country",
          "woocommerce_store_city",
          "woocommerce_store_postcode",
        ]);
      }
      if (path.includes("woocommerce_calc_taxes")) {
        return { status: 200, body: settingAt(path, calcTaxes) };
      }
      if (path.includes("/settings/")) {
        return { status: 200, body: settingAt(path, parcelSettingFor(path)) };
      }
      if (path.endsWith("/28")) return { status: 200, body: parcelDocument() };
      return {
        status: 200,
        body:
          origin === undefined
            ? productDocument()
            : productDocument({
                downloads: [
                  {
                    id: "dl_guide",
                    name: "Agentify guide.txt",
                    file: `${origin}/protected/guide.txt`,
                  },
                ],
              }),
      };
    };

  /**
   * A shop that calculates tax, answering its tax and general settings as
   * `wc/v3` answers a settings group: every setting of the group in one list.
   */
  const shopTaxing = (shop: TaxedShop, calcTaxes = "yes") =>
    shopAnswering((asked) => taxingAnswer(shop, calcTaxes)(asked.url));

  /**
   * The same shop answered in process at one fixed address, because the
   * address is part of a fingerprint.
   */
  const TAXING_SHOP = "https://shop.example.com";
  const fingerprintIn = async (shop: TaxedShop, product: "11" | "28", calcTaxes = "yes") => {
    const read = await inspectProductInTheShop(
      connectionTo(TAXING_SHOP),
      merchantItemIdFor(TAXING_SHOP, product),
      async (url) => {
        const said = taxingAnswer(shop, calcTaxes, TAXING_SHOP)(new URL(url).pathname);
        return Response.json(said.body, { status: said.status });
      },
    );
    if (!read.ok) throw new Error(`the product check refused: ${read.why}`);
    return read.product.fingerprint;
  };

  const readFrom = (shop: Stand, product: "11" | "28") =>
    inspectProduct(connectionTo(shop.url), merchantItemIdFor(shop.url, product));

  it("sells a download from a shop whose prices are entered with tax inside them", async () => {
    stand = await shopTaxing(BALI_AT_SUBTOTAL);

    expect(await readFrom(stand, "11")).toMatchObject({
      ok: true,
      product: { kind: "download", tax: { mode: "included" } },
    });
  });

  it("refuses a download from a shop that enters prices before tax, as the shop's no", async () => {
    // The tax is added for the buyer's address, which a download's buyer does
    // not give, so no price quoted beforehand is the one the order charges.
    stand = await shopTaxing(SEATTLE_AT_SUBTOTAL);

    expect(await readFrom(stand, "11")).toMatchObject({ ok: false, again: false, saidNo: true });
  });

  it("sells a parcel from a shop that calculates tax either way, and knows where an inclusive shop is based", async () => {
    stand = await shopTaxing(BALI_AT_SUBTOTAL);
    const inclusive = await readFrom(stand, "28");
    await stand.close();
    stand = await shopTaxing(SEATTLE_AT_SUBTOTAL);
    const exclusive = await readFrom(stand, "28");

    expect(inclusive).toMatchObject({
      ok: true,
      product: {
        kind: "parcel",
        tax: {
          mode: "included",
          base: { country: "ID", state: "BA", city: "Denpasar", postal_code: "80361" },
        },
      },
    });
    expect(exclusive).toMatchObject({
      ok: true,
      product: { kind: "parcel", tax: { mode: "excluded" } },
    });
  });

  it("refuses a shop whose catalogue shows prices otherwise than they are entered, naming the setting", async () => {
    // The import reads the catalogue's price, and these shops show 0.90 and
    // 1.11 there for a product entered at 1.00, which is not what is charged.
    for (const shop of [
      { ...BALI, woocommerce_tax_display_shop: "excl" },
      { ...SEATTLE, woocommerce_tax_display_shop: "incl" },
    ]) {
      stand = await shopTaxing(shop);
      for (const product of ["11", "28"] as const) {
        expect(
          await readFrom(stand, product),
          `${shop.woocommerce_default_country} ${product}`,
        ).toMatchObject({
          ok: false,
          saidNo: true,
          why: expect.stringContaining("Display prices in the shop"),
        });
      }
      await stand.close();
      stand = null;
    }
  });

  it("refuses a parcel from a shop that calculates tax on an address other than the shipping one", async () => {
    for (const basedOn of ["billing", "base"]) {
      stand = await shopTaxing({ ...BALI_AT_SUBTOTAL, woocommerce_tax_based_on: basedOn });

      expect(await readFrom(stand, "28"), basedOn).toMatchObject({
        ok: false,
        saidNo: true,
        why: expect.stringContaining("Calculate tax based on"),
      });
      // A download's order carries no address, so it is taxed where the shop
      // is whichever address the setting names.
      expect(await readFrom(stand, "11"), basedOn).toMatchObject({ ok: true });
      await stand.close();
      stand = null;
    }
  });

  it("does not ask for a shop's tax settings to judge a product while tax calculation is off", async () => {
    // Nothing the tax settings say bears on a shop with tax off, so a shop
    // that will not show them still sells.
    stand = await shopAnswering((asked) => {
      if (asked.url === "/protected/guide.txt") return { status: 403, body: {} };
      if (asked.url.endsWith("/settings/tax") || asked.url.endsWith("/settings/general")) {
        return { status: 404, body: { code: "rest_setting_setting_group_invalid" } };
      }
      if (asked.url.includes("/settings/")) {
        return { status: 200, body: settingAt(asked.url, parcelSettingFor(asked.url)) };
      }
      return {
        status: 200,
        body: asked.url.endsWith("/28") ? parcelDocument() : productDocument(),
      };
    });

    expect(await readFrom(stand, "11")).toMatchObject({
      ok: true,
      product: { tax: { mode: "off" } },
    });
    expect(await readFrom(stand, "28")).toMatchObject({
      ok: true,
      product: { tax: { mode: "off" } },
    });
  });

  it("says it could not read the tax settings of a shop that calculates tax, not that the shop said no", async () => {
    stand = await shopAnswering((asked) => {
      if (asked.url === "/protected/guide.txt") return { status: 403, body: {} };
      if (asked.url.endsWith("/settings/tax")) {
        return { status: 401, body: { code: "woocommerce_rest_cannot_view" } };
      }
      if (asked.url.includes("woocommerce_calc_taxes")) {
        return { status: 200, body: settingAt(asked.url, "yes") };
      }
      if (asked.url.includes("/settings/")) {
        return { status: 200, body: settingAt(asked.url, settingFor(asked.url)) };
      }
      return { status: 200, body: productDocument() };
    });

    expect(await readFrom(stand, "11")).toMatchObject({ ok: false, again: false, saidNo: false });
  });

  it("gives a product a new fingerprint when its shop turns tax calculation on", async () => {
    // A quote accepted before the change is then refused before an order is
    // made, rather than filled under tax it was not priced with.
    for (const product of ["11", "28"] as const) {
      expect(await fingerprintIn(BALI_AT_SUBTOTAL, product, "yes"), product).not.toBe(
        await fingerprintIn(BALI_AT_SUBTOTAL, product, "no"),
      );
    }
  });

  it("gives a parcel a new fingerprint when any tax setting that moves its price changes", async () => {
    const accepted = await fingerprintIn(BALI_AT_SUBTOTAL, "28");
    for (const changed of [
      {
        ...BALI_AT_SUBTOTAL,
        woocommerce_prices_include_tax: "no",
        woocommerce_tax_display_shop: "excl",
      },
      {
        ...BALI_AT_SUBTOTAL,
        woocommerce_default_country: "ID:JK",
        woocommerce_store_city: "Jakarta",
      },
      { ...BALI_AT_SUBTOTAL, woocommerce_store_postcode: "80111" },
    ]) {
      expect(await fingerprintIn(changed, "28"), JSON.stringify(changed)).not.toBe(accepted);
    }
    expect(await fingerprintIn({ ...BALI_AT_SUBTOTAL }, "28")).toBe(accepted);
  });

  it("sells nothing from a shop that calculates tax unless it rounds tax at the subtotal, naming the setting", async () => {
    // Rounding per line, the cart and the order can round a tax that falls on
    // half a cent apart: a 10% rate and a 5% compound one made a parcel's cart
    // of 23.47 and its order 23.46, and a download paid at 1.00 an order of
    // 1.01. Rounding at the subtotal, every case measured agreed.
    for (const shop of [BALI, SEATTLE]) {
      stand = await shopTaxing(shop);
      for (const product of ["11", "28"] as const) {
        expect(
          await readFrom(stand, product),
          `${shop.woocommerce_default_country} ${product}`,
        ).toMatchObject({
          ok: false,
          saidNo: true,
          why: expect.stringContaining("Round tax at subtotal level"),
        });
      }
      await stand.close();
      stand = null;
    }
    // With tax off the rounding bears on nothing, and is not asked for.
    stand = await shopTaxing(BALI, "no");
    expect(await readFrom(stand, "11")).toMatchObject({ ok: true });
    expect(await readFrom(stand, "28")).toMatchObject({ ok: true });
  });

  it("names an unreadable tax-calculation setting", async () => {
    stand = await shopAnswering((asked) => {
      if (asked.url.includes("woocommerce_calc_taxes")) {
        return { status: 200, body: {} };
      }
      if (asked.url.includes("/settings/")) {
        return { status: 200, body: settingAt(asked.url, settingFor(asked.url)) };
      }
      return { status: 200, body: productDocument() };
    });

    const read = await inspectProduct(connectionTo(stand.url), merchantItemIdFor(stand.url, "11"));

    expect(read).toMatchObject({
      ok: false,
      saidNo: false,
      why: expect.stringContaining("tax calculation"),
    });
  });

  it("names a product that has no downloadable file instead of listing every rule", async () => {
    stand = await shopAnswering((asked) => {
      if (asked.url.includes("/settings/")) {
        return { status: 200, body: settingAt(asked.url, settingFor(asked.url)) };
      }
      return {
        status: 200,
        body: productDocument({ downloadable: false, downloads: [] }),
      };
    });

    const read = await inspectProduct(connectionTo(stand.url), merchantItemIdFor(stand.url, "11"));

    expect(read).toMatchObject({
      ok: false,
      why: expect.stringMatching(/downloadable.*exactly one file/i),
    });
    expect(read.ok === false && read.why).not.toContain("published, in-stock, unmanaged");
  });

  it("refuses missing raw bytes and empty permission fields", async () => {
    for (const missing of ["id", "name"] as const) {
      stand = await shopAnswering((asked) => {
        if (asked.url === "/protected/guide.txt") return { status: 403, body: {} };
        if (asked.url.includes("/settings/")) {
          return { status: 200, body: settingAt(asked.url, settingFor(asked.url)) };
        }
        return {
          status: 200,
          body: productDocument({
            downloads: [
              { id: "dl", name: "Guide", file: `${stand?.url}/protected/guide.txt`, [missing]: "" },
            ],
          }),
        };
      });
      const read = await inspectProduct(
        connectionTo(stand.url),
        merchantItemIdFor(stand.url, "11"),
      );
      expect(read).toMatchObject({
        ok: false,
        again: false,
        saidNo: true,
        why: expect.stringMatching(/download.*readable address/i),
      });
      await stand.close();
      stand = null;
    }

    stand = await shopAnswering((asked) => {
      if (asked.url === "/protected/guide.txt") return { status: 404, body: {} };
      if (asked.url.includes("/settings/")) {
        return { status: 200, body: settingAt(asked.url, settingFor(asked.url)) };
      }
      return { status: 200, body: productDocument() };
    });
    const missing = await inspectProduct(
      connectionTo(stand.url),
      merchantItemIdFor(stand.url, "11"),
    );
    expect(missing).toMatchObject({
      ok: false,
      again: false,
      saidNo: true,
      why: expect.stringContaining("HTTP 404"),
    });
  });

  it("says which of a download's refusals are the shop's no", async () => {
    // A file set up so that it cannot be handed over safely is the shop's
    // answer; a check of its protection that broke off is not.
    const shopWith = (product: Record<string, unknown>) =>
      shopAnswering((asked) => {
        if (asked.url === "/protected/guide.txt") return { status: 403, body: {} };
        if (asked.url.includes("/settings/")) {
          return { status: 200, body: settingAt(asked.url, settingFor(asked.url)) };
        }
        return { status: 200, body: productDocument(product) };
      });
    for (const [what, product] of [
      ["no file id", { downloads: [{ id: "", name: "Guide", file: "https://x.example/x" }] }],
      [
        "a file elsewhere",
        { downloads: [{ id: "dl", name: "Guide", file: "https://x.example/x" }] },
      ],
    ] as const) {
      stand = await shopWith(product);
      expect(
        await inspectProduct(connectionTo(stand.url), merchantItemIdFor(stand.url, "11")),
        what,
      ).toMatchObject({ ok: false, again: false, saidNo: true });
      await stand.close();
      stand = null;
    }

    stand = await shopWith({});
    const broken = await inspectProductInTheShop(
      connectionTo(stand.url),
      merchantItemIdFor(stand.url, "11"),
      async (url, init) => {
        if (String(url).endsWith("/protected/guide.txt")) throw new TypeError("fetch failed");
        return fetch(url, init);
      },
    );
    expect(broken).toMatchObject({ ok: false, again: false, saidNo: false });
  });

  /**
   * Stores the price as typed, and answers an order with every total at two
   * decimals, as `wc/v3` does.
   */
  const shopStoringPrice = (typed: () => string) =>
    shopAnswering((asked) => {
      if (asked.method === "POST" && asked.url === "/wp-json/wc/v3/orders") {
        const sent = JSON.parse(asked.body);
        const line = sent.line_items[0];
        const atTwoDecimals = (amount: string): string => Number(amount).toFixed(2);
        return {
          status: 201,
          body: {
            id: 13,
            number: "13",
            order_key: "wc_order_13",
            status: "processing",
            currency: sent.currency,
            total: atTwoDecimals(line.total),
            total_tax: "0.00",
            payment_method: sent.payment_method,
            transaction_id: sent.transaction_id,
            billing: sent.billing,
            meta_data: sent.meta_data,
            line_items: [
              {
                product_id: line.product_id,
                quantity: line.quantity,
                subtotal: atTwoDecimals(line.subtotal),
                total: atTwoDecimals(line.total),
                total_tax: "0.00",
              },
            ],
          },
        };
      }
      if (asked.url === "/protected/guide.txt") return { status: 403, body: {} };
      if (asked.url.includes("/settings/")) {
        return { status: 200, body: settingAt(asked.url, settingFor(asked.url)) };
      }
      return { status: 200, body: productDocument({ price: typed() }) };
    });

  it("carries the price at a dollar's two decimals, however the merchant typed it", async () => {
    // `wc/v3` hands a price back as typed ("25", "19.9") while the Store API
    // and order totals use two decimals; the card, quote and order all use the
    // second form.
    for (const [typed, amount] of [
      ["25", "25.00"],
      ["19.9", "19.90"],
      ["25.00", "25.00"],
      ["0.01", "0.01"],
      ["25.000", "25.00"],
      ["025", "25.00"],
      // Typed without its leading zero, and priced by the Store API as 99
      // cents.
      [".99", "0.99"],
      [".5", "0.50"],
    ] as const) {
      stand = await shopStoringPrice(() => typed);

      const read = await inspectProduct(
        connectionTo(stand.url),
        merchantItemIdFor(stand.url, "11"),
      );

      expect(read.ok && read.product.price, typed).toEqual({ amount, currency: "USD" });
      await stand.close();
      stand = null;
    }
  });

  it("gives one price one fingerprint, whichever way it was typed", async () => {
    // An accepted quote is held to this digest when its order is filled:
    // retyping "25.00" as "25" does not change the price and must not break
    // quoted sales, while changing it to 25.01 does.
    let typed = "25.00";
    stand = await shopStoringPrice(() => typed);
    const keys = connectionTo(stand.url);
    const item = merchantItemIdFor(stand.url, "11");

    const withCents = await inspectProduct(keys, item);
    typed = "25";
    const withoutCents = await inspectProduct(keys, item);
    typed = "25.01";
    const anotherPrice = await inspectProduct(keys, item);

    expect(withCents.ok && withoutCents.ok && anotherPrice.ok).toBe(true);
    const fingerprintOf = (read: typeof withCents) => read.ok && read.product.fingerprint;
    expect(fingerprintOf(withoutCents)).toBe(fingerprintOf(withCents));
    expect(fingerprintOf(anotherPrice)).not.toBe(fingerprintOf(withCents));
  });

  it("refuses a price with more decimals than a dollar has, rather than rounding it", async () => {
    // The Store API rounds "25.001" to 2500 cents; selling at 25.00 or 25.01
    // would be a price the merchant did not set, so the product stays in the
    // shop.
    stand = await shopStoringPrice(() => "25.001");

    const read = await inspectProduct(connectionTo(stand.url), merchantItemIdFor(stand.url, "11"));

    // The merchant's own price, which Agentify cannot sell at: the shop's no.
    expect(read).toMatchObject({
      ok: false,
      saidNo: true,
      why: expect.stringContaining("25.001"),
    });
    // The price is what the merchant changes, not the decimals setting.
    expect(read.ok === false && read.why).not.toContain("Number of decimals");
  });

  it("refuses a price that is not a decimal amount at all", async () => {
    // WooCommerce stores "5." as "5", so that form never arrives.
    for (const typed of ["", "-5", "1e3", "5.", "."]) {
      stand = await shopStoringPrice(() => typed);

      const read = await inspectProduct(
        connectionTo(stand.url),
        merchantItemIdFor(stand.url, "11"),
      );

      expect(read, typed).toMatchObject({
        ok: false,
        saidNo: false,
        why: expect.stringContaining("not a decimal amount"),
      });
      await stand.close();
      stand = null;
    }
  });

  it("sells a price typed without cents at the amount WooCommerce's own order carries", async () => {
    // The order is created at this price and the shop's answer compared
    // character for character; handing on "25" would read "25.00" back and
    // leave a paid order nothing here can say was made.
    stand = await shopStoringPrice(() => "25");
    const keys = connectionTo(stand.url);
    const read = await inspectProduct(keys, merchantItemIdFor(stand.url, "11"));
    if (!read.ok) throw new Error(`the product check refused: ${read.why}`);
    if (read.product.kind !== "download") throw new Error("the product check found a parcel");

    const made = await createOrder(keys, {
      orderId: "ord_7",
      test: false,
      productId: read.product.productId,
      email: "merchant@example.com",
      price: read.product.price,
      download: { id: read.product.downloadId, name: read.product.fileName },
      paidInto: null,
      tax: read.product.tax,
    });

    expect(made).toMatchObject({ ok: true, id: "13", orderKey: "wc_order_13" });
  });

  describe("for a whole catalogue", () => {
    const LIST = "/wp-json/wc/v3/products?";

    /** The ids a list request names, in the order it names them. */
    const includedIn = (url: string): string[] =>
      (new URL(url, "http://x").searchParams.get("include") ?? "").split(",").filter(Boolean);

    /**
     * A shop answering a list from these documents and each product on its
     * own, its files on its own origin whenever it was stood up.
     */
    const shopOf = (
      documents: ReadonlyMap<string, Record<string, unknown>>,
      answer: (asked: Asked) => ReturnType<Parameters<typeof shopAnswering>[0]> | null = () => null,
    ) =>
      shopAnswering((asked) => {
        const given = answer(asked);
        if (given !== null) return given;
        const here = (document: Record<string, unknown> | undefined) =>
          document === undefined
            ? undefined
            : (JSON.parse(
                JSON.stringify(document).replaceAll(
                  "http://127.0.0.1/protected/",
                  `${stand?.url}/protected/`,
                ),
              ) as Record<string, unknown>);
        if (asked.url === "/protected/guide.txt") return { status: 403, body: {} };
        if (asked.url.includes("/settings/")) {
          return { status: 200, body: settingAt(asked.url, parcelSettingFor(asked.url)) };
        }
        if (asked.url.startsWith(LIST)) {
          // Only the fields asked for, as WordPress answers `_fields`, so a
          // judge that read one more would find it missing here too.
          const fields = new URL(asked.url, "http://x").searchParams.get("_fields")?.split(",");
          return {
            status: 200,
            body: includedIn(asked.url).flatMap((id) => {
              const document = here(documents.get(id));
              if (document === undefined) return [];
              return [
                fields === undefined
                  ? document
                  : Object.fromEntries(
                      Object.entries(document).filter(([field]) => fields.includes(field)),
                    ),
              ];
            }),
          };
        }
        const one = /^\/wp-json\/wc\/v3\/products\/(\d+)$/.exec(asked.url)?.[1];
        const document = one === undefined ? undefined : here(documents.get(one));
        return document === undefined
          ? { status: 404, body: { code: "woocommerce_rest_product_invalid_id" } }
          : { status: 200, body: document };
      });

    /** Every third a parcel and the rest downloads. */
    const documentsOf = (count: number) =>
      new Map(
        Array.from({ length: count }, (_, index) => {
          const id = String(index + 1);
          return [
            id,
            index % 3 === 0
              ? parcelDocument({ id: index + 1 })
              : productDocument({ id: index + 1 }),
          ] as const;
        }),
      );

    const inspectAll = (keys: ReturnType<typeof connectionTo>, ids: readonly string[]) =>
      inspectProductsInTheShop(
        keys,
        ids.map((id) => merchantItemIdFor(keys.shopUrl, id)),
        fetch,
      );

    it("asks the shop for each setting once and for its products a hundred at a time", async () => {
      // Asked one product at a time with every setting beside it, a catalogue
      // of two thousand was some twenty-four thousand requests to somebody
      // else's shop.
      const documents = documentsOf(250);
      stand = await shopOf(documents);

      const read = await inspectAll(connectionTo(stand.url), [...documents.keys()]);

      expect(read).toHaveLength(250);
      expect(read.every((one) => one.ok)).toBe(true);
      const settings = stand.asked.filter((asked) => asked.url.includes("/settings/"));
      expect(settings.length).toBe(new Set(settings.map((asked) => asked.url)).size);
      expect(settings.length).toBeLessThanOrEqual(11);
      const lists = stand.asked.filter((asked) => asked.url.startsWith(LIST));
      expect(lists.map((asked) => includedIn(asked.url).length)).toEqual([100, 100, 50]);
      expect(stand.asked.some((asked) => /\/products\/\d+$/.test(asked.url))).toBe(false);
      // The key goes with every protected request, as with the single check.
      expect(
        [...settings, ...lists].every((asked) => asked.authorization?.startsWith("Basic ")),
      ).toBe(true);
    });

    it("judges every product exactly as the check of that one product does", async () => {
      // One judge for both: a catalogue read must not let through what the
      // price question at purchase refuses, nor refuse in other words.
      const documents = new Map<string, Record<string, unknown>>([
        ["11", productDocument({ id: 11 })],
        ["28", parcelDocument({ id: 28 })],
        ["30", parcelDocument({ id: 30, manage_stock: true })],
        ["31", parcelDocument({ id: 31, type: "variable" })],
        ["32", productDocument({ id: 32, download_limit: 5 })],
        ["33", parcelDocument({ id: 33, price: "20.005" })],
        ["34", productDocument({ id: 34, downloads: [] })],
      ]);
      stand = await shopOf(documents);
      const keys = connectionTo(stand.url);

      const together = await inspectAll(keys, [...documents.keys()]);
      const oneByOne = await Promise.all(
        [...documents.keys()].map((id) =>
          inspectProduct(keys, merchantItemIdFor(stand?.url ?? "", id)),
        ),
      );

      expect(together).toEqual(oneByOne);
      expect(together.filter((one) => one.ok)).toHaveLength(2);
    });

    it("asks after a product the shop's list left out on its own, and judges it as the single check does", async () => {
      // A list can leave a product out for reasons of its own, a cache in front
      // of the shop among them, and a document it carries for another product
      // never stands in for the one asked about.
      const documents = documentsOf(3);
      stand = await shopOf(documents, (asked) =>
        asked.url.startsWith(LIST)
          ? { status: 200, body: [documents.get("1"), parcelDocument({ id: 99 })] }
          : asked.url === "/wp-json/wc/v3/products/3"
            ? { status: 404, body: { code: "woocommerce_rest_product_invalid_id" } }
            : null,
      );
      const keys = connectionTo(stand.url);

      const together = await inspectAll(keys, ["1", "2", "3"]);
      const alone = await inspectProduct(keys, merchantItemIdFor(stand.url, "3"));

      expect(together[0]).toMatchObject({ ok: true });
      expect(together[1]).toMatchObject({ ok: true, product: { productId: "2" } });
      expect(together[2]).toEqual(alone);
      expect(together[2]).toMatchObject({ ok: false, saidNo: true });
      const onTheirOwn = stand.asked.filter((asked) => /\/products\/\d+$/.test(asked.url));
      expect(onTheirOwn.map((asked) => asked.url)).toEqual(
        expect.arrayContaining(["/wp-json/wc/v3/products/2", "/wp-json/wc/v3/products/3"]),
      );
    });

    it("leaves only the products of a page the shop did not answer to be asked again", async () => {
      const documents = documentsOf(150);
      const losingTheSecond: WooRequest = async (url, init) => {
        const href = String(url);
        if (href.includes(LIST) && includedIn(href)[0] === "101")
          throw new TypeError("fetch failed");
        return await fetch(url, init);
      };
      stand = await shopOf(documents);
      const keys = connectionTo(stand.url);

      const read = await inspectProductsInTheShop(
        keys,
        [...documents.keys()].map((id) => merchantItemIdFor(keys.shopUrl, id)),
        losingTheSecond,
      );

      expect(read.slice(0, 100).every((one) => one.ok)).toBe(true);
      // Told as the shop not answering, which it did not, rather than as a
      // product its list left out.
      expect(read.slice(100)).toEqual(
        Array.from({ length: 50 }, () =>
          expect.objectContaining({
            ok: false,
            again: true,
            why: expect.stringContaining("did not answer"),
          }),
        ),
      );
    });

    it("keeps at most four requests in the shop at once, products its lists left out included", async () => {
      // Somebody else's shop, often on shared hosting: a whole catalogue is
      // read at the pace of a few visitors, not all at once, even where every
      // product has to be asked after alone.
      for (const listsCarry of ["every product", "none"] as const) {
        await stand?.close();
        stand = null;
        await atMostFourAtOnce(listsCarry);
      }
    });

    const atMostFourAtOnce = async (listsCarry: "every product" | "none") => {
      const documents = documentsOf(900);
      let inFlight = 0;
      let most = 0;
      const counting: WooRequest = async (url, init) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        try {
          await new Promise((resolve) => setTimeout(resolve, 2));
          return await fetch(url, init);
        } finally {
          inFlight -= 1;
        }
      };
      stand = await shopOf(documents, (asked) =>
        listsCarry === "none" && asked.url.startsWith(LIST) ? { status: 200, body: [] } : null,
      );
      const keys = connectionTo(stand.url);

      const read = await inspectProductsInTheShop(
        keys,
        [...documents.keys()].map((id) => merchantItemIdFor(keys.shopUrl, id)),
        counting,
      );

      expect(
        read.every((one) => one.ok),
        listsCarry,
      ).toBe(true);
      expect(most, listsCarry).toBeLessThanOrEqual(4);
      expect(most, listsCarry).toBeGreaterThan(1);
    };
  });
});

describe("the shop's own shipping rate for a parcel's place", () => {
  // The exchange a live WooCommerce answered: a fresh cart, its token in place
  // of a nonce, the product added, the place set, the rates read off the
  // answer.
  const TOKEN = "cart-token-1";
  const rate = (overrides: Record<string, unknown> = {}) => ({
    rate_id: "flat_rate:3",
    name: "Standard",
    method_id: "flat_rate",
    instance_id: 3,
    price: "500",
    taxes: "0",
    currency_code: "USD",
    currency_minor_unit: 2,
    selected: true,
    ...overrides,
  });
  // A cart line and the package that ships it name each other by the line's
  // key, as WooCommerce 11.2 answered; a package's item carries no product id.
  const LINE = { key: "line-28", id: 28, quantity: 1 };
  const PACKED = { key: "line-28", name: "Canvas tote bag", quantity: 1 };
  const aPackage = (rates: unknown[], items: unknown[] = [PACKED]) => ({
    package_id: 0,
    name: "Shipment 1",
    items,
    shipping_rates: rates,
  });
  const cart = (rates: unknown[], overrides: Record<string, unknown> = {}) => ({
    items: [LINE],
    errors: [],
    needs_shipping: true,
    shipping_rates: [aPackage(rates)],
    ...overrides,
  });
  const emptyCart = () => cart([], { items: [], needs_shipping: false, shipping_rates: [] });
  const shopWithRates = (answered: () => { status: number; body: unknown }) =>
    shopAnswering((asked) => {
      if (asked.method === "GET" && asked.url === "/wp-json/wc/store/v1/cart") {
        return { status: 200, body: emptyCart(), headers: { "Cart-Token": TOKEN } };
      }
      if (asked.url.endsWith("/remove-item")) return { status: 200, body: emptyCart() };
      if (asked.url === "/wp-json/wc/store/v1/cart/add-item") {
        return { status: 201, body: cart([]) };
      }
      return answered();
    });
  const JAKARTA: ShipToLocality = { country: "ID", city: "Jakarta" };

  /**
   * WooCommerce's guest carts, one session per token it issued, asked through
   * the transport rather than a socket. `refuse` answers instead of the shop
   * where it returns a response.
   */
  const aShopOfSessions = (
    refuse: (path: string, token: string | null) => Response | null = () => null,
  ) => {
    const holds = new Map<string, boolean>();
    let issued = 0;
    const request: WooRequest = async (url, init) => {
      const path = new URL(url).pathname;
      const token = new Headers(init?.headers).get("cart-token");
      const refused = refuse(path, token);
      if (refused !== null) return refused;
      const session = token ?? `session-${++issued}`;
      if (path.endsWith("/add-item")) holds.set(session, true);
      if (path.endsWith("/remove-item")) holds.set(session, false);
      return Response.json(holds.get(session) === true ? cart([rate()]) : emptyCart(), {
        status: path.endsWith("/add-item") ? 201 : 200,
        headers: { "Cart-Token": session },
      });
    };
    return { request, holds, sessions: () => issued };
  };
  /** Every paid cart but the first opened once and retired, and the replacement just spent. */
  const oneUsablePaidCart = async (resources: ReturnType<typeof memoryWooShops>, shop: string) => {
    const at = new Date();
    await resources.startCartRuntime(shop, "earlier-worker");
    for (let slot = 1; slot < 8; slot += 1) {
      await resources.claimCart(shop, "earlier-worker", "paid", slot, `opened-${slot}`, at);
      await resources.registerCartIdentity(
        shop,
        "earlier-worker",
        "paid",
        slot,
        `opened-${slot}`,
        `retired-${slot}`,
      );
      await resources.finishCart(shop, "earlier-worker", "paid", slot, `opened-${slot}`, null);
    }
    await resources.claimCart(shop, "earlier-worker", "paid", 1, "replacement", at);
    await resources.registerCartIdentity(
      shop,
      "earlier-worker",
      "paid",
      1,
      "replacement",
      "retired-replacement",
    );
    await resources.finishCart(shop, "earlier-worker", "paid", 1, "replacement", null);
  };

  it("answers the next paid question after the registry failed to record a finished cart", async () => {
    const shop = aShopOfSessions();
    const registry = memoryWooShops();
    await oneUsablePaidCart(registry, "https://woo.nuanu.ai");
    let failures = 1;
    const resources = {
      ...registry,
      finishCart: async (...finished: Parameters<typeof registry.finishCart>) => {
        if (failures-- > 0) throw new Error("Connection terminated unexpectedly");
        return await registry.finishCart(...finished);
      },
    };
    const runtime = new WooShopRuntime(
      connectionTo("https://woo.nuanu.ai"),
      shop.request,
      resources,
    );
    expect(await runtime.paidShippingRates("28", JAKARTA)).toMatchObject({ ok: true });
    const next = await Promise.race([
      runtime.paidShippingRates("28", JAKARTA),
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 2_000)),
    ]);
    expect(next).toMatchObject({ ok: true });
    expect(shop.sessions()).toBe(1);
  });

  it("never prices two paid questions in one cart, even after another cart's opening failed", async () => {
    const opening = Promise.withResolvers<void>();
    const adding = Promise.withResolvers<void>();
    const added = Promise.withResolvers<void>();
    let openings = 0;
    let adds = 0;
    let mostAtOnce = 0;
    const shop = aShopOfSessions();
    const request: WooRequest = async (url, init) => {
      const path = new URL(url).pathname;
      const token = new Headers(init?.headers).get("cart-token");
      if (path === "/wp-json/wc/store/v1/cart" && token === null && ++openings === 1) {
        await opening.promise;
        return new Response("<html>Access denied</html>", { status: 403 });
      }
      if (!path.endsWith("/add-item")) return await shop.request(url, init);
      adds += 1;
      mostAtOnce = Math.max(mostAtOnce, adds);
      adding.resolve();
      await added.promise;
      const answered = await shop.request(url, init);
      adds -= 1;
      return answered;
    };
    const resources = memoryWooShops();
    await oneUsablePaidCart(resources, "https://woo.nuanu.ai");
    const runtime = new WooShopRuntime(connectionTo("https://woo.nuanu.ai"), request, resources);
    const first = runtime.paidShippingRates("28", JAKARTA);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = runtime.paidShippingRates("28", JAKARTA);
    await new Promise((resolve) => setTimeout(resolve, 20));
    opening.resolve();
    await adding.promise;
    const third = runtime.paidShippingRates("28", JAKARTA);
    await new Promise((resolve) => setTimeout(resolve, 50));
    added.resolve();
    await Promise.all([first, second, third]);
    expect(mostAtOnce).toBe(1);
  });

  it("asks a paid question in a cart that answers when another cart's opening was refused", async () => {
    const resources = memoryWooShops();
    const shop = aShopOfSessions((path, token) =>
      path === "/wp-json/wc/store/v1/cart" && token === null
        ? new Response("<html>Access denied</html>", { status: 403 })
        : null,
    );
    await resources.startCartRuntime("https://woo.nuanu.ai", "earlier-worker");
    await resources.claimCart(
      "https://woo.nuanu.ai",
      "earlier-worker",
      "paid",
      1,
      "c1",
      new Date(),
    );
    await resources.finishCart("https://woo.nuanu.ai", "earlier-worker", "paid", 1, "c1", {
      token: "session-kept",
      expiresAt: null,
    });
    const runtime = new WooShopRuntime(
      connectionTo("https://woo.nuanu.ai"),
      shop.request,
      resources,
    );
    expect(await runtime.paidShippingRates("28", JAKARTA)).toMatchObject({ ok: true });
  });

  it.each([
    ["did not answer", 502, "<html>Bad Gateway</html>"],
    ["met a firewall's page", 403, "<html>Access denied</html>"],
  ])(
    "asks no further cart, and asks again later, once the shop's cart %s",
    async (_case, status, page) => {
      let opened = 0;
      const shop = aShopOfSessions((path, token) => {
        if (path !== "/wp-json/wc/store/v1/cart" || token !== null) return null;
        opened += 1;
        return new Response(page, { status });
      });
      const runtime = new WooShopRuntime(
        connectionTo("https://woo.nuanu.ai"),
        shop.request,
        memoryWooShops(),
      );
      expect(await runtime.paidShippingRates("28", JAKARTA)).toMatchObject({
        ok: false,
        again: true,
      });
      expect(opened).toBe(1);
    },
  );

  it("has a paid question wait for the one usable paid cart rather than say none is free", async () => {
    const shop = aShopOfSessions();
    const resources = memoryWooShops();
    await oneUsablePaidCart(resources, "https://woo.nuanu.ai");
    const runtime = new WooShopRuntime(
      connectionTo("https://woo.nuanu.ai"),
      shop.request,
      resources,
    );
    const [destination, base] = await Promise.all([
      runtime.paidShippingRates("28", JAKARTA),
      runtime.paidShippingRates("28", { country: "ID", state: "BA", city: "Denpasar" }),
    ]);
    expect(destination).toMatchObject({ ok: true, rates: [{ cost: "5.00" }] });
    expect(base).toMatchObject({ ok: true, rates: [{ cost: "5.00" }] });
    expect(shop.sessions()).toBe(1);
    expect([...shop.holds.values()]).toStrictEqual([false]);
  });

  it("counts a session the shop issued against its cart even when the cart opened unusable", async () => {
    // A cache in front of the shop serving one visitor's cart to everybody.
    const shop = aShopOfSessions();
    let opened = 0;
    const request: WooRequest = async (url, init) => {
      const token = new Headers(init?.headers).get("cart-token");
      if (new URL(url).pathname === "/wp-json/wc/store/v1/cart" && token === null) {
        opened += 1;
        return Response.json(cart([rate()]), { headers: { "Cart-Token": `served-${opened}` } });
      }
      return await shop.request(url, init);
    };
    const runtime = new WooShopRuntime(
      connectionTo("https://woo.nuanu.ai"),
      request,
      memoryWooShops(),
    );
    for (let question = 0; question < 12; question += 1)
      expect(await runtime.shippingRates("28", JAKARTA)).toMatchObject({ ok: false });
    // Eight first openings and one replacement; the rest wait ten minutes.
    expect(opened).toBe(9);
  });

  it.each([
    [
      "WooCommerce's own rate limit",
      () =>
        Response.json(
          { code: "rate_limit_exceeded", message: "Too many requests. Please wait and try again." },
          { status: 429 },
        ),
    ],
    ["a proxy's rate limit", () => new Response("<html>Too Many Requests</html>", { status: 429 })],
    ["a firewall's page", () => new Response("<html>Access denied</html>", { status: 403 })],
    [
      "a firewall's own document",
      () => Response.json({ code: "request_blocked", message: "Blocked" }, { status: 403 }),
    ],
  ])("keeps a cart whose change was turned away before it ran: %s", async (_case, turnedAway) => {
    let turned = false;
    const shop = aShopOfSessions((path) => {
      if (!path.endsWith("/add-item") || turned) return null;
      turned = true;
      return turnedAway();
    });
    const runtime = new WooShopRuntime(
      connectionTo("https://woo.nuanu.ai"),
      shop.request,
      memoryWooShops(),
    );
    expect(await runtime.shippingRates("28", JAKARTA)).toMatchObject({ ok: false, again: true });
    expect(await runtime.shippingRates("28", JAKARTA)).toMatchObject({ ok: true });
    expect(shop.sessions()).toBe(1);
  });

  it("asks a paid question again in another cart when the shop refuses a cart's session", async () => {
    const resources = memoryWooShops();
    // WooCommerce answers an expired session's change with a new guest's token beside the refusal.
    let fresh = 0;
    const shop = aShopOfSessions((path, token) =>
      token === "rotated-away" && path !== "/wp-json/wc/store/v1/cart"
        ? Response.json(
            {
              code: "woocommerce_rest_missing_nonce",
              message: "Missing the Nonce header. This endpoint requires a valid nonce.",
            },
            { status: 401, headers: { "Cart-Token": `new-guest-${++fresh}` } },
          )
        : null,
    );
    const at = new Date();
    await resources.startCartRuntime("https://woo.nuanu.ai", "earlier-worker");
    for (const [slot, token] of [
      [0, "rotated-away"],
      [1, "session-1"],
    ] as const) {
      await resources.claimCart(
        "https://woo.nuanu.ai",
        "earlier-worker",
        "paid",
        slot,
        `c${slot}`,
        at,
      );
      await resources.finishCart(
        "https://woo.nuanu.ai",
        "earlier-worker",
        "paid",
        slot,
        `c${slot}`,
        {
          token,
          expiresAt: null,
        },
      );
    }
    const runtime = new WooShopRuntime(
      connectionTo("https://woo.nuanu.ai"),
      shop.request,
      resources,
    );
    expect(await runtime.paidShippingRates("28", JAKARTA)).toMatchObject({
      ok: true,
      rates: [{ cost: "5.00" }],
    });
    // The refused session is retired rather than kept for the next question.
    await resources.startCartRuntime("https://woo.nuanu.ai", "next-worker");
    expect(
      await resources.claimCart("https://woo.nuanu.ai", "next-worker", "paid", 0, "after", at),
    ).toMatchObject({ kind: "new" });
  });

  it("says a paid question is worth asking again when the shop refuses every cart's session, and never asks a refused one again", async () => {
    const changed: string[] = [];
    const shop = aShopOfSessions((path, token) => {
      if (token === null || path === "/wp-json/wc/store/v1/cart") return null;
      changed.push(token);
      return Response.json(
        { code: "woocommerce_rest_missing_nonce", message: "Missing the Nonce header." },
        { status: 401 },
      );
    });
    const runtime = new WooShopRuntime(
      connectionTo("https://woo.nuanu.ai"),
      shop.request,
      memoryWooShops(),
    );
    for (let question = 0; question < 2; question += 1)
      expect(await runtime.paidShippingRates("28", JAKARTA)).toMatchObject({
        ok: false,
        again: true,
      });
    expect(new Set(changed).size).toBe(changed.length);
    // A fresh session refused says the shop refuses them all, so each question opens one.
    expect(shop.sessions()).toBe(2);
  });

  it("says a paid question is worth asking again when a cart change met a page that is not the shop's", async () => {
    const shop = aShopOfSessions((path) =>
      path.endsWith("/add-item") ? new Response("<html>Not Found</html>", { status: 404 }) : null,
    );
    const runtime = new WooShopRuntime(
      connectionTo("https://woo.nuanu.ai"),
      shop.request,
      memoryWooShops(),
    );
    expect(await runtime.paidShippingRates("28", JAKARTA)).toMatchObject({
      ok: false,
      again: true,
    });
  });

  it("prices again once the cart registry answers after it failed at the first question", async () => {
    const shop = aShopOfSessions();
    const registry = memoryWooShops();
    let blips = 1;
    const resources = {
      ...registry,
      startCartRuntime: async (shopUrl: string, owner: string) => {
        if (blips-- > 0) throw new Error("Connection terminated unexpectedly");
        await registry.startCartRuntime(shopUrl, owner);
      },
    };
    const runtime = new WooShopRuntime(
      connectionTo("https://woo.nuanu.ai"),
      shop.request,
      resources,
    );
    await expect(runtime.shippingRates("28", JAKARTA)).rejects.toThrow("Connection terminated");
    expect(await runtime.shippingRates("28", JAKARTA)).toMatchObject({ ok: true });
    expect(await runtime.paidShippingRates("28", JAKARTA)).toMatchObject({ ok: true });
  });

  it("keeps concurrent cities in separate carts and cleans both before reuse", async () => {
    const carts = new Map<string, { held: boolean; city: string }>();
    const together = Promise.withResolvers<void>();
    let concurrent = false;
    let updates = 0;
    stand = await shopAnswering(async (asked) => {
      const token = asked.cartToken ?? `cart-${carts.size + 1}`;
      const state = carts.get(token) ?? { held: false, city: "" };
      carts.set(token, state);
      if (asked.url.endsWith("/add-item")) state.held = true;
      if (asked.url.endsWith("/remove-item")) state.held = false;
      if (asked.url.endsWith("/update-customer")) {
        state.city = JSON.parse(asked.body).shipping_address.city;
        if (concurrent) {
          updates += 1;
          if (updates === 2) together.resolve();
          await together.promise;
        }
      }
      return {
        status: asked.url.endsWith("/add-item") ? 201 : 200,
        body: state.held
          ? cart([rate({ price: state.city === "Berlin" ? "900" : "500" })])
          : emptyCart(),
        headers: { "Cart-Token": token },
      };
    });
    const runtime = new WooShopRuntime(connectionTo(stand.url), fetch);
    expect(await runtime.shippingRates("28", JAKARTA)).toMatchObject({ ok: true });
    concurrent = true;
    const unblock = setTimeout(() => together.resolve(), 1_000);
    try {
      const [jakarta, berlin] = await Promise.all([
        runtime.shippingRates("28", JAKARTA),
        runtime.shippingRates("28", { country: "DE", city: "Berlin" }),
      ]);
      expect(jakarta).toMatchObject({ ok: true, rates: [{ cost: "5.00" }] });
      expect(berlin).toMatchObject({ ok: true, rates: [{ cost: "9.00" }] });
      expect(carts.size).toBe(2);
      expect([...carts.values()].every((cart) => !cart.held)).toBe(true);
    } finally {
      clearTimeout(unblock);
      together.resolve();
      await runtime.drain();
    }
  });

  it("rejects a newly opened free cart that repeats a paid session kept only on disk after restart", async () => {
    const resources = memoryWooShops();
    const expiresAt = new Date(Date.now() + 172_800_000);
    let issued = 0;
    const tokenFor = (identity: string) =>
      `e30.${Buffer.from(JSON.stringify({ user_id: identity, iat: ++issued, exp: Math.floor(expiresAt.getTime() / 1000) })).toString("base64url")}.signature`;
    const paidToken = tokenFor("paid-session");
    const contents = new Map<string, boolean>();
    const mutations: string[] = [];
    let opened = 0;
    stand = await shopAnswering((asked) => {
      const identity =
        asked.cartToken === undefined
          ? ++opened === 1
            ? "paid-session"
            : "second-paid-session"
          : (JSON.parse(
              Buffer.from(asked.cartToken.split(".")[1] ?? "", "base64url").toString("utf8"),
            ).user_id as string);
      if (asked.method === "POST") mutations.push(identity);
      if (asked.url.endsWith("/add-item")) contents.set(identity, true);
      if (asked.url.endsWith("/remove-item")) contents.set(identity, false);
      return {
        status: asked.url.endsWith("/add-item") ? 201 : 200,
        body: contents.get(identity) ? cart([rate()]) : emptyCart(),
        headers: { "Cart-Token": tokenFor(identity) },
      };
    });
    await resources.startCartRuntime(stand.url, "previous-worker");
    await resources.claimCart(stand.url, "previous-worker", "paid", 0, "paid-empty", new Date());
    await resources.finishCart(stand.url, "previous-worker", "paid", 0, "paid-empty", {
      token: paidToken,
      expiresAt,
    });
    const runtime = new WooShopRuntime(connectionTo(stand.url), fetch, resources);
    try {
      expect(await runtime.shippingRates("28", JAKARTA)).toMatchObject({ ok: false });
      expect(mutations).toEqual([]);
      expect(await runtime.paidShippingRates("28", JAKARTA)).toMatchObject({ ok: true });
      expect(mutations).toContain("paid-session");
      // The paid question reuses the restored session; only the refused free cart was opened.
      expect(opened).toBe(1);
    } finally {
      await runtime.drain();
    }
  });

  it.each([
    "transport",
    "proxy add 504",
    "proxy add 202",
    "proxy remove 504",
    "proxy add HTML",
    "proxy remove HTML",
  ] as const)(
    "does not revive an uncertain mutation from an empty read while a completed failed cart recovers: %s",
    async (failure) => {
      const carts = new Map<string, { held: number }>();
      let retryCleanup = false;
      let originalUnknown = false;
      const request: WooRequest = async (url, init) => {
        const path = new URL(url).pathname;
        const token = new Headers(init?.headers).get("cart-token") ?? `cart-${carts.size + 1}`;
        const state = carts.get(token) ?? { held: 0 };
        carts.set(token, state);
        if (path.endsWith("/add-item")) {
          if (token === "cart-1" && !originalUnknown && !failure.startsWith("proxy remove")) {
            originalUnknown = true;
            if (failure === "transport")
              throw new Error("reply lost while the shop still has the mutation");
            if (failure === "proxy add 202") return Response.json(cart([rate()]), { status: 202 });
            return failure.endsWith("HTML")
              ? new Response("<html>Proxy response</html>", { status: 200 })
              : Response.json({}, { status: 504 });
          }
          // Reusing the first token would overlap the original add, whose response was lost.
          state.held =
            token === "cart-1" && originalUnknown
              ? failure.startsWith("proxy remove")
                ? 0
                : 2
              : 1;
        }
        if (path.endsWith("/remove-item")) {
          if (token === "cart-1" && !originalUnknown && failure.startsWith("proxy remove")) {
            originalUnknown = true;
            state.held = 0;
            return failure.endsWith("HTML")
              ? new Response("<html>Proxy response</html>", { status: 200 })
              : Response.json({}, { status: 504 });
          }
          if (!retryCleanup) return new Response(null, { status: 429 });
          state.held = 0;
        }
        return Response.json(
          state.held ? cart([rate()], { items: [{ ...LINE, quantity: state.held }] }) : emptyCart(),
          { headers: { "Cart-Token": token } },
        );
      };
      const runtime = new WooShopRuntime(connectionTo("https://woo.nuanu.ai"), request);
      for (let count = 0; count < 8; count += 1)
        expect(await runtime.shippingRates("28", JAKARTA)).toMatchObject({ ok: false });
      expect(carts.size).toBe(8);
      retryCleanup = true;
      expect(await runtime.shippingRates("28", JAKARTA)).toMatchObject({
        ok: true,
        rates: [{ cost: "5.00" }],
      });
      expect(carts.size).toBe(8);
      expect(carts.get("cart-1")?.held).toBe(0);
      expect([...carts.values()].map((cart) => cart.held)).toStrictEqual([0, 0, 1, 1, 1, 1, 1, 1]);
    },
  );

  it("replaces an expired known-dirty identity through the creation budget instead of retrying its cleanup forever", async () => {
    let time = 1_800_000_000_000;
    let sessions = 0;
    let cleanupAllowed = false;
    const contents = new Map<string, boolean>();
    stand = await shopAnswering((asked) => {
      let token = asked.cartToken;
      // The Store API takes a token it cannot validate for none: a read opens a
      // new guest's cart, and a write is refused for want of a nonce.
      const lapsed =
        token !== undefined &&
        JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")).exp *
          1000 <=
          time;
      if (lapsed && asked.method !== "GET") return wooRefusal("woocommerce_rest_missing_nonce");
      if (token === undefined || lapsed) {
        sessions += 1;
        token = `e30.${Buffer.from(JSON.stringify({ user_id: `guest-${sessions}`, exp: Math.floor(time / 1000) + 172_800 })).toString("base64url")}.signature`;
        contents.set(token, false);
      }
      if (asked.url.endsWith("/add-item")) contents.set(token, true);
      if (asked.url.endsWith("/remove-item")) {
        if (!cleanupAllowed) return { status: 429, raw: "" };
        contents.set(token, false);
      }
      return {
        status: asked.url.endsWith("/add-item") ? 201 : 200,
        body: contents.get(token) ? cart([rate()]) : emptyCart(),
        headers: { "Cart-Token": token },
      };
    });
    const clock = vi.spyOn(Date, "now").mockImplementation(() => time);
    try {
      const runtime = new WooShopRuntime(connectionTo(stand.url), fetch, memoryWooShops());
      for (let attempt = 0; attempt < 8; attempt += 1)
        expect(await runtime.shippingRates("28", JAKARTA)).toMatchObject({ ok: false });
      expect(sessions).toBe(8);
      time += 172_801_000;
      cleanupAllowed = true;
      expect(await runtime.shippingRates("28", JAKARTA)).toMatchObject({ ok: true });
      expect(sessions).toBe(9);
      expect(await runtime.shippingRates("28", JAKARTA)).toMatchObject({ ok: true });
      expect(sessions).toBe(9);
    } finally {
      clock.mockRestore();
    }
  });

  it("opens sessions for a shop whose sessions last minutes only as fast as the replacement budget allows", async () => {
    let time = 1_800_000_000_000;
    let sessions = 0;
    const holds = new Map<string, boolean>();
    const request: WooRequest = async (url, init) => {
      const path = new URL(url).pathname;
      let token = new Headers(init?.headers).get("cart-token");
      if (token === null) {
        sessions += 1;
        token = `e30.${Buffer.from(JSON.stringify({ user_id: `guest-${sessions}`, exp: Math.floor(time / 1000) + 360 })).toString("base64url")}.signature`;
      }
      if (path.endsWith("/add-item")) holds.set(token, true);
      if (path.endsWith("/remove-item")) holds.set(token, false);
      return Response.json(holds.get(token) === true ? cart([rate()]) : emptyCart(), {
        status: path.endsWith("/add-item") ? 201 : 200,
        headers: { "Cart-Token": token },
      });
    };
    const clock = vi.spyOn(Date, "now").mockImplementation(() => time);
    try {
      const runtime = new WooShopRuntime(
        connectionTo("https://woo.nuanu.ai"),
        request,
        memoryWooShops(),
      );
      for (let question = 0; question < 20; question += 1) {
        await runtime.shippingRates("28", JAKARTA);
        time += 120_000;
      }
      // Eight first openings, then one replacement every ten minutes of the forty.
      expect(sessions).toBe(11);
    } finally {
      clock.mockRestore();
    }
  });

  it("waits for an in-flight cart mutation after quote cancellation before cleaning or reusing its slot", async () => {
    const adding = Promise.withResolvers<void>();
    const finishAdd = Promise.withResolvers<void>();
    let held = false;
    let first = true;
    let finished = false;
    const request: WooRequest = async (url, init) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/add-item") && first) {
        first = false;
        adding.resolve();
        return await new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("request aborted")), {
            once: true,
          });
          void finishAdd.promise.then(() => {
            held = true;
            resolve(Response.json(cart([])));
          });
        });
      }
      if (path.endsWith("/add-item")) held = true;
      if (path.endsWith("/remove-item")) held = false;
      return Response.json(held ? cart([rate()]) : emptyCart(), {
        headers: { "Cart-Token": TOKEN },
      });
    };
    const runtime = new WooShopRuntime(connectionTo("https://woo.nuanu.ai"), request);
    const caller = new AbortController();
    const work = runtime.shippingRates("28", JAKARTA, caller.signal).finally(() => {
      finished = true;
    });
    await adding.promise;
    caller.abort();
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(finished).toBe(false);
    } finally {
      finishAdd.resolve();
      await work;
    }
    expect(held).toBe(false);
    expect(await runtime.shippingRates("28", { country: "DE", city: "Berlin" })).toMatchObject({
      ok: true,
    });
    expect(held).toBe(false);
  });

  it("renews an observed empty cart after its shop-declared token expiry", async () => {
    let time = 1_800_000_000_000;
    let sessions = 0;
    const contents = new Map<string, boolean>();
    stand = await shopAnswering((asked) => {
      let token = asked.cartToken;
      if (token === undefined) {
        sessions += 1;
        token = `e30.${Buffer.from(JSON.stringify({ user_id: `guest-${sessions}`, exp: Math.floor(time / 1000) + 172800 })).toString("base64url")}.signature`;
        contents.set(token, false);
      } else if (
        JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")).exp *
          1000 <=
        time
      ) {
        return { status: 401, body: { code: "invalid_cart_token" } };
      }
      if (asked.url.endsWith("/add-item")) contents.set(token, true);
      if (asked.url.endsWith("/remove-item")) contents.set(token, false);
      return {
        status: asked.url.endsWith("/add-item") ? 201 : 200,
        body: contents.get(token) ? cart([rate()]) : emptyCart(),
        headers: { "Cart-Token": token },
      };
    });
    const clock = vi.spyOn(Date, "now").mockImplementation(() => time);
    try {
      const runtime = new WooShopRuntime(connectionTo(stand.url), fetch);
      expect(await runtime.shippingRates("28", JAKARTA)).toMatchObject({ ok: true });
      time += 172_801_000;
      expect(await runtime.shippingRates("28", JAKARTA)).toMatchObject({ ok: true });
      expect(sessions).toBe(2);
      expect([...contents.values()]).toStrictEqual([false, false]);
      expect(await runtime.shippingRates("28", JAKARTA)).toMatchObject({ ok: true });
      expect(sessions).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });

  it("reuses one exclusive cart across complete locality replacements and leaves it empty after each question", async () => {
    let sessions = 0;
    let held = false;
    const localities: unknown[] = [];
    stand = await shopAnswering((asked) => {
      if (asked.method === "GET") {
        if (asked.cartToken === undefined) sessions += 1;
        return {
          status: 200,
          body: cart([], { items: held ? [LINE] : [], needs_shipping: held, shipping_rates: [] }),
          headers: { "Cart-Token": TOKEN },
        };
      }
      if (asked.url.endsWith("/add-item")) {
        held = true;
        return { status: 201, body: cart([]) };
      }
      if (asked.url.endsWith("/remove-item")) {
        held = false;
        return {
          status: 200,
          body: cart([], { items: [], needs_shipping: false, shipping_rates: [] }),
        };
      }
      localities.push(JSON.parse(asked.body).shipping_address);
      return { status: 200, body: cart([rate()]) };
    });
    const runtime = new WooShopRuntime(connectionTo(stand.url), fetch);
    expect(
      await runtime.shippingRates("28", {
        country: "ID",
        state: "JK",
        city: "Jakarta",
        postal_code: "10110",
      }),
    ).toMatchObject({ ok: true });
    expect(held).toBe(false);
    expect(await runtime.shippingRates("28", { country: "DE", city: "Berlin" })).toMatchObject({
      ok: true,
    });
    expect(held).toBe(false);
    expect(sessions).toBe(1);
    expect(localities).toStrictEqual([
      { country: "ID", state: "JK", city: "Jakarta", postcode: "10110" },
      { country: "DE", state: "", city: "Berlin", postcode: "" },
    ]);
    expect(stand.asked.filter((call) => call.url.endsWith("/remove-item"))).toHaveLength(2);
  });

  it("recovers free pricing with a new identity at most every ten minutes after uncertain mutations exhaust its lane", async () => {
    let time = 1_800_000_000_000;
    let sessions = 0;
    let broken = true;
    const held = new Set<string>();
    const retired = new Set<string>();
    stand = await shopAnswering((asked) => {
      const token = asked.cartToken ?? `identity-${++sessions}`;
      if (asked.url.endsWith("/add-item")) {
        held.add(token);
        if (broken) {
          retired.add(token);
          return { status: 503, raw: "<html>proxy lost the mutation response</html>" };
        }
        expect(retired.has(token)).toBe(false);
      }
      if (asked.url.endsWith("/remove-item")) held.delete(token);
      return {
        status: asked.url.endsWith("/add-item") ? 201 : 200,
        body: held.has(token)
          ? cart([rate()])
          : cart([], { items: [], needs_shipping: false, shipping_rates: [] }),
        headers: { "Cart-Token": token },
      };
    });
    const clock = vi.spyOn(Date, "now").mockImplementation(() => time);
    try {
      const runtime = new WooShopRuntime(connectionTo(stand.url), fetch, memoryWooShops());
      for (let attempt = 0; attempt < 9; attempt += 1)
        expect(await runtime.shippingRates("28", JAKARTA)).toMatchObject({ ok: false });
      expect(sessions).toBe(9);
      broken = false;
      expect(await runtime.shippingRates("28", JAKARTA)).toMatchObject({ ok: false });
      expect(sessions).toBe(9);
      time += 600_000;
      expect(await runtime.shippingRates("28", JAKARTA)).toMatchObject({ ok: true });
      expect(sessions).toBe(10);
      expect(held.size).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });

  it("asks a fresh cart with its token and no nonce, and sends every field of the place", async () => {
    // A field left out keeps the shop's base location, so a German address
    // without a state would be priced as if it were in the shop's own state.
    stand = await shopWithRates(() => ({ status: 200, body: cart([rate()]) }));

    const read = await ratesFor(stand.url, "28", JAKARTA);

    expect(read.ok && read.rates).toStrictEqual([
      { methodId: "flat_rate", instanceId: "3", title: "Standard", cost: "5.00", tax: "0.00" },
    ]);
    expect(stand.asked.map((asked) => `${asked.method} ${asked.url}`)).toStrictEqual([
      "GET /wp-json/wc/store/v1/cart",
      "POST /wp-json/wc/store/v1/cart/add-item",
      "POST /wp-json/wc/store/v1/cart/update-customer",
      "POST /wp-json/wc/store/v1/cart/remove-item",
      "GET /wp-json/wc/store/v1/cart",
    ]);
    expect(JSON.parse(stand.asked[1]?.body ?? "")).toStrictEqual({ id: 28, quantity: 1 });
    expect(JSON.parse(stand.asked[2]?.body ?? "")).toStrictEqual({
      shipping_address: { country: "ID", state: "", city: "Jakarta", postcode: "" },
    });
    expect(stand.asked.slice(1).every((asked) => asked.cartToken === TOKEN)).toBe(true);
    // The cart is the public half of WooCommerce: no key, no nonce.
    expect(stand.asked.every((asked) => asked.authorization === undefined)).toBe(true);
    expect(stand.asked.every((asked) => asked.nonce === undefined)).toBe(true);
  });

  it("keeps every rate in the shop's own order, and leaves pickup out", async () => {
    // A parcel nobody collects never leaves, and pickup is usually the cheapest
    // rate.
    stand = await shopWithRates(() => ({
      status: 200,
      body: cart([
        rate({ rate_id: "local_pickup:5", method_id: "local_pickup", instance_id: 5, price: "0" }),
        rate({
          rate_id: "pickup_location:0",
          method_id: "pickup_location",
          instance_id: 0,
          price: "0",
        }),
        rate({ name: "Express", instance_id: 4, price: "1200" }),
        rate(),
      ]),
    }));

    const read = await ratesFor(stand.url, "28", JAKARTA);

    expect(read.ok && read.rates).toStrictEqual([
      { methodId: "flat_rate", instanceId: "4", title: "Express", cost: "12.00", tax: "0.00" },
      { methodId: "flat_rate", instanceId: "3", title: "Standard", cost: "5.00", tax: "0.00" },
    ]);
  });

  it("tells a place the shop does not ship to from a shop that refused or did not answer", async () => {
    stand = await shopWithRates(() => ({ status: 200, body: cart([]) }));
    expect(await ratesFor(stand.url, "28", JAKARTA)).toMatchObject({ ok: true, rates: [] });
    await stand.close();

    // The shop's refusal names the place, so none of it is carried on.
    stand = await shopWithRates(() => ({
      status: 400,
      body: {
        code: "rest_invalid_param",
        message: "The provided state (BE) is not valid in Jakarta.",
      },
    }));
    const refused = await ratesFor(stand.url, "28", JAKARTA);
    expect(refused).toMatchObject({ ok: false, again: false });
    expect(JSON.stringify(refused)).not.toContain("Jakarta");
    expect(JSON.stringify(refused)).not.toContain("BE");
    await stand.close();

    stand = await shopWithRates(() => ({ status: 503, body: {} }));
    expect(await ratesFor(stand.url, "28", JAKARTA)).toMatchObject({ ok: false, again: true });
    await stand.close();

    // Without a token the cart cannot be asked anything.
    stand = await shopAnswering(() => ({ status: 200, body: cart([]) }));
    expect(await ratesFor(stand.url, "28", JAKARTA)).toMatchObject({ ok: false, again: false });
  });

  it("says the shop ruled a parcel or its place out only where its own readable answer did", async () => {
    // A cart that refused the product or the place is the seller's no; a cart
    // in front of which something else answered, or one holding what was not
    // asked, said nothing about this parcel.
    const refusing = (code: string) => ({
      status: 400,
      body: { code, message: "No.", data: { status: 400 } },
    });
    for (const [what, addItem, placed, saidNo] of [
      ["the product refused", refusing("woocommerce_rest_product_out_of_stock"), null, true],
      ["the place refused", null, refusing("rest_invalid_param"), true],
      [
        // What a shop's restriction plugin raises on the cart it would not
        // check out, whatever the line and its rate say.
        "a cart whose own errors refuse the line",
        null,
        {
          status: 200,
          body: cart([rate()], {
            errors: [
              {
                code: "woocommerce_rest_cart_item_error",
                message: "This product cannot be shipped to your country.",
              },
            ],
          }),
        },
        true,
      ],
      [
        "no shipping needed",
        null,
        { status: 200, body: cart([], { needs_shipping: false, shipping_rates: [] }) },
        true,
      ],
      [
        "rates in two currencies",
        null,
        {
          status: 200,
          body: cart([rate(), rate({ rate_id: "flat_rate:4", currency_code: "EUR" })]),
        },
        true,
      ],
      [
        "a rate at three decimals",
        null,
        { status: 200, body: cart([rate({ currency_minor_unit: 3, price: "5000" })]) },
        true,
      ],
      [
        // A code neither WooCommerce nor WordPress refuses a product or a place
        // with, as a plugin or a proxy in front of the cart can write.
        "a refusal under another code",
        null,
        refusing("rest_forbidden"),
        false,
      ],
      ["a page that is not JSON", null, { status: 200, raw: "not-json" }, false],
      [
        "two packages for one parcel",
        null,
        {
          status: 200,
          body: cart([rate()], { shipping_rates: [aPackage([rate()]), aPackage([rate()])] }),
        },
        false,
      ],
      ["a cart without its rates", null, { status: 200, body: { items: [] } }, false],
      [
        "a cart holding two",
        null,
        {
          status: 200,
          body: cart([rate()], {
            items: [{ ...LINE, quantity: 2 }],
            shipping_rates: [aPackage([rate()], [{ ...PACKED, quantity: 2 }])],
          }),
        },
        false,
      ],
      [
        "a rate that is not an amount",
        null,
        { status: 200, body: cart([rate({ price: "five" })]) },
        false,
      ],
    ] as const) {
      stand = await shopAnswering((asked) => {
        if (asked.method === "GET") {
          return { status: 200, body: emptyCart(), headers: { "Cart-Token": TOKEN } };
        }
        if (asked.url.endsWith("/remove-item")) return { status: 200, body: emptyCart() };
        if (asked.url.endsWith("/add-item")) return addItem ?? { status: 201, body: cart([]) };
        return placed ?? { status: 200, body: cart([rate()]) };
      });

      expect(await ratesFor(stand.url, "28", JAKARTA), what).toMatchObject({
        ok: false,
        again: false,
        saidNo,
      });
      await stand.close();
      stand = null;
    }

    // The shop refusing the cart's session, or a page in place of its answer
    // to a change, says nothing about the parcel, and another cart may answer,
    // so the question is worth asking again.
    for (const [what, refusal] of [
      [
        "a cart that wants a nonce",
        { status: 401, body: { code: "woocommerce_rest_missing_nonce" } },
      ],
      [
        "a cart that refuses its nonce",
        { status: 403, body: { code: "woocommerce_rest_invalid_nonce" } },
      ],
      ["a refusal that is not WooCommerce's", { status: 400, raw: "<html>Bad Request</html>" }],
    ] as const) {
      stand = await shopAnswering((asked) => {
        if (asked.method === "GET") {
          return { status: 200, body: emptyCart(), headers: { "Cart-Token": TOKEN } };
        }
        if (asked.url.endsWith("/remove-item")) return { status: 200, body: emptyCart() };
        if (asked.url.endsWith("/add-item")) return { status: 201, body: cart([]) };
        return refusal;
      });
      const read = await ratesFor(stand.url, "28", JAKARTA);
      expect(read, what).toMatchObject({ ok: false, again: true });
      expect(read, what).not.toHaveProperty("saidNo");
      await stand.close();
      stand = null;
    }

    // A card naming no product is settled before the shop is asked.
    expect(await ratesFor("http://127.0.0.1:1", "not-a-product", JAKARTA)).toMatchObject({
      ok: false,
      saidNo: true,
    });

    // Without a token the cart cannot be asked anything, which says nothing
    // about the parcel either.
    stand = await shopAnswering(() => ({ status: 200, body: cart([]) }));
    expect(await ratesFor(stand.url, "28", JAKARTA)).toMatchObject({ ok: false, saidNo: false });
  });

  it("names in the reason for every failed cart answer which question it was and the status it came with", async () => {
    // What the operator's log says of the shop's cart, and nothing of the
    // place that was asked about.
    const steps = [
      "/wp-json/wc/store/v1/cart",
      "/wp-json/wc/store/v1/cart/add-item",
      "/wp-json/wc/store/v1/cart/update-customer",
    ] as const;
    const failures: readonly (readonly [readonly string[], Failure])[] = [
      [steps, { status: 503, body: { message: "later" } }],
      [steps, { status: 429, body: { message: "later" } }],
      [steps, { status: 408, body: { message: "later" } }],
      [steps, { status: 403, body: { code: "woocommerce_rest_invalid_nonce" } }],
      [steps, { status: 200, kind: "broken" }],
      [steps, { status: 0, kind: "unanswered" }],
      // A cart opened without its token.
      [steps.slice(0, 1), { status: 200, body: cart([]) }],
      [steps.slice(2), { status: 200, raw: "not-json" }],
      [steps.slice(2), { status: 200, body: { items: [] } }],
    ];
    for (const [where, failure] of failures) {
      const reasons = new Set<string>();
      for (const step of where) {
        stand = await shopAnswering((asked) => {
          if (asked.url === step) return failure;
          if (asked.method === "GET") {
            return { status: 200, body: emptyCart(), headers: { "Cart-Token": TOKEN } };
          }
          if (asked.url.endsWith("/add-item")) return { status: 201, body: cart([]) };
          return { status: 200, body: cart([rate()]) };
        });

        const read = await shippingRatesInTheShop(
          stand.url,
          "28",
          JAKARTA,
          failing(`${stand.url}${step}`, failure, true),
        );

        const said = `${step} ${failure.kind ?? failure.status}`;
        expect(read.ok, said).toBe(false);
        if (!read.ok) {
          expect(read.why, said).toContain(step);
          if (failure.kind !== "unanswered") {
            expect(read.why, said).toContain(String(failure.status));
          }
          expect(read.why, said).not.toMatch(/jakarta/i);
          reasons.add(read.why);
        }
        await stand.close();
        stand = null;
      }
      expect(reasons.size, `${failure.kind ?? failure.status}`).toBe(where.length);
    }
  });

  it("reads no rate from a cart answer missing any field it is judged by", async () => {
    // Each of these is part of every Store API cart answer; one missing is an
    // answer this cannot read, not a cart with nothing in it.
    const without = (field: string, from: Record<string, unknown>) => {
      const { [field]: _left, ...rest } = from;
      return rest;
    };
    const whole = cart([rate()]);
    for (const [what, body] of [
      ...["items", "errors", "needs_shipping", "shipping_rates"].map(
        (field) => [field, without(field, whole)] as const,
      ),
      ["a package's items", { ...whole, shipping_rates: [without("items", aPackage([rate()]))] }],
      [
        "a package's rates",
        { ...whole, shipping_rates: [without("shipping_rates", aPackage([rate()]))] },
      ],
      ["a line's key", { ...whole, items: [without("key", LINE)] }],
    ] as const) {
      stand = await shopWithRates(() => ({ status: 200, body }));

      expect(await ratesFor(stand.url, "28", JAKARTA), what).toMatchObject({
        ok: false,
        again: false,
        saidNo: false,
      });
      await stand.close();
      stand = null;
    }
  });

  /**
   * A Store API cart as the tax probe's shops answered it, in minor units: the
   * line with the goods' tax, the rates with theirs, and the totals.
   */
  const taxedCart = (
    goods: { subtotal: string; tax: string },
    rates: unknown[],
    totals: {
      items: string;
      tax: string;
      price: string;
      lines: { name: string; rate: string }[];
      fees?: string;
      discount?: string;
    },
  ) =>
    cart(rates, {
      items: [{ ...LINE, totals: { line_subtotal: goods.subtotal, line_subtotal_tax: goods.tax } }],
      totals: {
        total_items: totals.items,
        total_tax: totals.tax,
        total_fees: totals.fees ?? "0",
        total_discount: totals.discount ?? "0",
        total_price: totals.price,
        currency_code: "USD",
        currency_minor_unit: 2,
        tax_lines: totals.lines,
      },
    });
  /** The Seattle shop's cart for the tote bag at 20.00, shipping taxable. */
  const SEATTLE_CART = taxedCart(
    { subtotal: "2000", tax: "211" },
    [rate({ rate_id: "flat_rate:12", instance_id: 12, price: "600", taxes: "63" })],
    {
      items: "2000",
      tax: "274",
      price: "2874",
      lines: [
        { name: "WA State", rate: "6.5%" },
        { name: "Seattle", rate: "4.05%" },
      ],
    },
  );
  const SEATTLE: ShipToLocality = {
    country: "US",
    state: "WA",
    city: "Seattle",
    postal_code: "98101",
  };

  it("reads a cart that calculates tax at its whole price, with the goods and the taxes inside it", async () => {
    stand = await shopWithRates(() => ({ status: 200, body: SEATTLE_CART }));

    const read = await ratesFor(stand.url, "28", SEATTLE);

    const standard = {
      methodId: "flat_rate",
      instanceId: "12",
      title: "Standard",
      cost: "6.00",
      tax: "0.63",
    };
    expect(read).toStrictEqual({
      ok: true,
      currency: "USD",
      rates: [standard],
      priced: {
        ok: true,
        total: "28.74",
        goodsBeforeTax: "20.00",
        goods: "22.11",
        taxes: ["Seattle 4.05%", "WA State 6.5%"],
        rate: standard,
      },
    });
  });

  it("chooses the cheapest rate in a taxed cart where the shop chose another, and prices the cart with it", async () => {
    // The Bali shop's Jakarta cart at 20.00 with shipping taxable, Standard
    // 5.00 with 0.55 of tax. Express at 12.00 is listed first and chosen,
    // with its 1.32 of tax and the total that makes.
    const express = rate({
      rate_id: "flat_rate:4",
      name: "Express",
      instance_id: 4,
      price: "1200",
      taxes: "132",
    });
    const standard = rate({ price: "500", taxes: "55" });
    const goods = { subtotal: "1802", tax: "198" };
    const lines = [{ name: "PPN", rate: "11%" }];
    stand = await shopAnswering((asked) => {
      if (asked.method === "GET") {
        return { status: 200, body: emptyCart(), headers: { "Cart-Token": TOKEN } };
      }
      if (asked.url.endsWith("/add-item")) return { status: 201, body: cart([]) };
      if (asked.url.endsWith("/remove-item")) return { status: 200, body: emptyCart() };
      if (asked.url.endsWith("/select-shipping-rate")) {
        return {
          status: 200,
          body: taxedCart(goods, [{ ...express, selected: false }, standard], {
            items: "1802",
            tax: "253",
            price: "2555",
            lines,
          }),
        };
      }
      return {
        status: 200,
        body: taxedCart(goods, [express, { ...standard, selected: false }], {
          items: "1802",
          tax: "330",
          price: "3332",
          lines,
        }),
      };
    });

    const read = await ratesFor(stand.url, "28", JAKARTA);

    expect(read).toMatchObject({
      ok: true,
      priced: { ok: true, total: "25.55", goods: "20.00", rate: { instanceId: "3", tax: "0.55" } },
    });
    const chose = stand.asked.find((asked) => asked.url.endsWith("/select-shipping-rate"));
    expect(chose?.cartToken).toBe(TOKEN);
    expect(JSON.parse(chose?.body ?? "{}")).toStrictEqual({
      package_id: 0,
      rate_id: "flat_rate:3",
    });
  });

  it("names no price from a cart that raises an error of its own once the cheapest rate is chosen", async () => {
    // As a shop's plugin does that will not send this parcel by that method.
    const express = rate({
      rate_id: "flat_rate:4",
      name: "Express",
      instance_id: 4,
      price: "1200",
      taxes: "132",
    });
    const standard = rate({ price: "500", taxes: "55" });
    const goods = { subtotal: "1802", tax: "198" };
    const lines = [{ name: "PPN", rate: "11%" }];
    stand = await shopAnswering((asked) => {
      if (asked.method === "GET") {
        return { status: 200, body: emptyCart(), headers: { "Cart-Token": TOKEN } };
      }
      if (asked.url.endsWith("/add-item")) return { status: 201, body: cart([]) };
      if (asked.url.endsWith("/remove-item")) return { status: 200, body: emptyCart() };
      if (asked.url.endsWith("/select-shipping-rate")) {
        return {
          status: 200,
          body: {
            ...taxedCart(goods, [{ ...express, selected: false }, standard], {
              items: "1802",
              tax: "253",
              price: "2555",
              lines,
            }),
            errors: [{ code: "woocommerce_rest_cart_item_error", message: "Not by this method." }],
          },
        };
      }
      return {
        status: 200,
        body: taxedCart(goods, [express, { ...standard, selected: false }], {
          items: "1802",
          tax: "330",
          price: "3332",
          lines,
        }),
      };
    });

    expect(await ratesFor(stand.url, "28", JAKARTA)).toMatchObject({
      ok: true,
      priced: { ok: false, saidNo: true },
    });
  });

  it("prices a cart that carries no tax at the goods and the cheapest rate, without choosing in it", async () => {
    // The Seattle shop's San Francisco cart at 20.00 with no tax there, its
    // order 27.50; a dearer rate listed first is the shop's choice.
    stand = await shopWithRates(() => ({
      status: 200,
      body: taxedCart(
        { subtotal: "2000", tax: "0" },
        [
          rate({ rate_id: "flat_rate:5", name: "Express", instance_id: 5, price: "1500" }),
          rate({ rate_id: "flat_rate:2", instance_id: 2, price: "750", selected: false }),
        ],
        { items: "2000", tax: "0", price: "3500", lines: [] },
      ),
    }));

    const read = await ratesFor(stand.url, "28", {
      country: "US",
      state: "CA",
      city: "San Francisco",
      postal_code: "94105",
    });

    expect(read).toMatchObject({
      ok: true,
      priced: { ok: true, total: "27.50", goods: "20.00", taxes: [], rate: { instanceId: "2" } },
    });
    expect(stand.asked.some((asked) => asked.url.endsWith("/select-shipping-rate"))).toBe(false);
  });

  it("names no price from a cart that adds a fee or takes a discount an order would not carry", async () => {
    for (const extra of [{ fees: "100" }, { discount: "200" }]) {
      stand = await shopWithRates(() => ({
        status: 200,
        body: taxedCart(
          { subtotal: "2000", tax: "211" },
          [rate({ rate_id: "flat_rate:12", instance_id: 12, price: "600", taxes: "63" })],
          { items: "2000", tax: "274", price: "2874", lines: [], ...extra },
        ),
      }));

      expect(await ratesFor(stand.url, "28", SEATTLE), JSON.stringify(extra)).toMatchObject({
        ok: true,
        priced: { ok: false, saidNo: true },
      });
      await stand.close();
      stand = null;
    }
  });

  it("takes a rate only from a cart that holds this product alone, once", async () => {
    // A shop's plugins can change a cart while it is asked: a minimum quantity,
    // a gift, a bundle. What the cart then charges to ship is the rate of what
    // it holds, not of the one parcel sold.
    const GIFT = { key: "line-31", id: 31, quantity: 1 };
    for (const [holding, body] of [
      [
        "two of the product",
        cart([rate()], {
          items: [{ ...LINE, quantity: 2 }],
          shipping_rates: [aPackage([rate()], [{ ...PACKED, quantity: 2 }])],
        }),
      ],
      ["nothing", cart([rate()], { items: [], shipping_rates: [aPackage([rate()], [])] })],
      ["another product", cart([rate()], { items: [{ ...LINE, id: 22 }] })],
      [
        "the product and a gift",
        cart([rate()], {
          items: [LINE, GIFT],
          shipping_rates: [
            aPackage([rate()], [PACKED, { key: GIFT.key, name: "Gift", quantity: 1 }]),
          ],
        }),
      ],
      [
        "a package shipping two",
        cart([rate()], { shipping_rates: [aPackage([rate()], [{ ...PACKED, quantity: 2 }])] }),
      ],
      [
        "a package shipping another line",
        cart([rate()], { shipping_rates: [aPackage([rate()], [{ ...PACKED, key: GIFT.key }])] }),
      ],
      ["a package shipping nothing", cart([rate()], { shipping_rates: [aPackage([rate()], [])] })],
      // Where the line and its package disagree, neither can be taken at its
      // word.
      ["a line of two packed as one", cart([rate()], { items: [{ ...LINE, quantity: 2 }] })],
      ["a gift outside the package", cart([rate()], { items: [LINE, GIFT] })],
      [
        "a package shipping the product and more",
        cart([rate()], {
          shipping_rates: [
            aPackage([rate()], [PACKED, { key: GIFT.key, name: "Gift", quantity: 1 }]),
          ],
        }),
      ],
    ] as const) {
      stand = await shopWithRates(() => ({ status: 200, body }));

      expect(await ratesFor(stand.url, "28", JAKARTA), holding).toMatchObject({
        ok: false,
        again: false,
      });
      await stand.close();
      stand = null;
    }
  });
});

describe("creating a parcel's order", () => {
  // What a live WooCommerce 11.1 answered, with the address read back as sent.
  // The address is Agentify's office: a real place and nobody's home.
  const ADDRESS = {
    name: "Nuanu Reception",
    line_one: "Jl. Raya Kediri, Beraban",
    line_two: "Nuanu Creative City",
    city: "Tabanan",
    state: "BA",
    postal_code: "82121",
    country: "ID",
    phone_number: "+62 000 0000 0000",
  };
  const sold = {
    orderId: "ord_9",
    test: false,
    productId: "28",
    email: "merchant@example.com",
    total: { amount: "23.00", currency: "USD" },
    goods: "20.00",
    rate: {
      methodId: "flat_rate",
      instanceId: "1",
      title: "Bali courier",
      cost: "3.00",
      tax: "0.00",
    },
    address: ADDRESS,
    paidInto: null,
    tax: "off" as const,
  };
  const shipping = {
    first_name: "Nuanu Reception",
    last_name: "",
    company: "",
    address_1: "Jl. Raya Kediri, Beraban",
    address_2: "Nuanu Creative City",
    city: "Tabanan",
    state: "BA",
    postcode: "82121",
    country: "ID",
    phone: "+62 000 0000 0000",
  };
  const madeParcel = (overrides: Record<string, unknown> = {}) => ({
    id: 30,
    number: "30",
    order_key: "wc_order_30",
    status: "processing",
    currency: "USD",
    total: "23.00",
    total_tax: "0.00",
    shipping_total: "3.00",
    payment_method: "agentify",
    transaction_id: "ord_9",
    billing: { email: "merchant@example.com" },
    shipping,
    meta_data: [{ id: 13, key: "agentify_order_id", value: "ord_9" }],
    line_items: [
      { product_id: 28, quantity: 1, subtotal: "20.00", total: "20.00", total_tax: "0.00" },
    ],
    shipping_lines: [
      {
        id: 6,
        method_title: "Bali courier",
        method_id: "flat_rate",
        instance_id: "1",
        total: "3.00",
        total_tax: "0.00",
      },
    ],
    ...overrides,
  });
  /** None of these words may appear in any answer here. */
  const ADDRESS_WORDS = [
    "Reception",
    "Kediri",
    "Beraban",
    "Creative City",
    "Tabanan",
    "82121",
    "0000 0000",
  ];

  it.each([false, true])(
    "sends a paid parcel at its rate and destination, test channel %s",
    async (test) => {
      stand = await shopAnswering(() => ({ status: 201, body: madeParcel() }));

      const made = await createParcel(connectionTo(stand.url), { ...sold, test });

      expect(made).toStrictEqual({ ok: true, id: "30", number: "30", total: "23.00" });
      const asked = stand.asked[0];
      expect(asked?.method).toBe("POST");
      expect(asked?.authorization).toMatch(/^Basic /);
      // Only the fields needed, the address among them so it can be checked.
      expect(
        new URL(asked?.url ?? "", stand.url).searchParams.get("_fields")?.split(","),
      ).toContain("shipping");
      const body = JSON.parse(asked?.body ?? "{}");
      expect(body).toMatchObject({
        set_paid: true,
        transaction_id: "ord_9",
        billing: { email: "merchant@example.com" },
        // The whole name goes into the first name: splitting it would be a guess.
        shipping: {
          first_name: "Nuanu Reception",
          address_1: "Jl. Raya Kediri, Beraban",
          address_2: "Nuanu Creative City",
          city: "Tabanan",
          state: "BA",
          postcode: "82121",
          country: "ID",
          phone: "+62 000 0000 0000",
        },
        line_items: [{ product_id: 28, quantity: 1, subtotal: "20.00", total: "20.00" }],
        shipping_lines: [
          { method_id: "flat_rate", instance_id: "1", method_title: "Bali courier", total: "3.00" },
        ],
      });
      expect(body.shipping.last_name).toBeUndefined();
      expect(body.meta_data).toContainEqual({
        key: "agentify_paid",
        value: test ? "23.00 USD in test USDC, not real money" : "23.00 USD",
      });
      expect(
        body.meta_data.filter((one: { key: string }) => one.key === "agentify_channel"),
      ).toStrictEqual(test ? [{ key: "agentify_channel", value: "test" }] : []);
    },
  );

  it("writes the commission of a parcel on what was paid, the goods and the shipping together", async () => {
    // The split received the whole payment, shipping included: 0.1% of 23.00
    // is 0.023, where the goods alone would make it 0.02.
    const lines = [
      { key: "agentify_order_id", value: "ord_9" },
      { key: "agentify_paid", value: "23.00 USD" },
      { key: "agentify_commission", value: "≈ 0.023 USD (0.1%)" },
      { key: "agentify_payout_contract", value: PAID_INTO.address },
    ];
    stand = await shopAnswering(() => ({ status: 201, body: madeParcel({ meta_data: lines }) }));

    const made = await createParcel(connectionTo(stand.url), { ...sold, paidInto: PAID_INTO });

    expect(made).toStrictEqual({ ok: true, id: "30", number: "30", total: "23.00" });
    expect(JSON.parse(stand.asked[0]?.body ?? "{}").meta_data).toStrictEqual(lines);
  });

  it("does not call an order placed whose answer does not carry the address it was sent", async () => {
    // Taking the order on erases Agentify's copy of the address, so the shop
    // must be seen holding it first. An answer holding another or none is
    // unknown: never placed, and never posted again.
    for (const changed of [
      { shipping: { ...shipping, address_1: "Jl. Raya Kediri" } },
      { shipping: { ...shipping, phone: "" } },
      { shipping: undefined },
    ]) {
      stand = await shopAnswering(() => ({ status: 201, body: madeParcel(changed) }));

      const made = await createParcel(connectionTo(stand.url), sold);

      expect(made, JSON.stringify(changed)).toMatchObject({ ok: false, again: true });
      for (const word of ADDRESS_WORDS) expect(JSON.stringify(made)).not.toContain(word);
      await stand.close();
      stand = null;
    }
  });

  it("does not call an order placed whose totals or shipping line are not the sale", async () => {
    for (const changed of [
      { total: "20.00" },
      { shipping_lines: [] },
      { shipping_lines: [{ ...madeParcel().shipping_lines[0], method_id: "free_shipping" }] },
      { shipping_lines: [{ ...madeParcel().shipping_lines[0], total: "5.00" }] },
      {
        line_items: [
          { product_id: 28, quantity: 1, subtotal: "23.00", total: "23.00", total_tax: "0.00" },
        ],
      },
      { meta_data: [] },
    ]) {
      stand = await shopAnswering(() => ({ status: 201, body: madeParcel(changed) }));

      const made = await createParcel(connectionTo(stand.url), sold);

      expect(made, JSON.stringify(changed)).toMatchObject({ ok: false, again: true });
      await stand.close();
      stand = null;
    }
  });

  /**
   * The tax probe's parcel orders for the tote bag at 20.00 with taxable
   * shipping, made with a line naming the product alone: from the Bali shop to
   * Denpasar by its courier, and from the Seattle shop to Seattle.
   */
  const TAXED_ORDERS = [
    {
      tax: "included",
      rate: {
        methodId: "flat_rate",
        instanceId: "1",
        title: "Bali courier",
        cost: "3.00",
        tax: "0.33",
      },
      answer: {
        total: "23.33",
        total_tax: "2.31",
        line: "18.02",
        lineTax: "1.98",
        shippingTax: "0.33",
      },
    },
    {
      tax: "excluded",
      rate: {
        methodId: "flat_rate",
        instanceId: "12",
        title: "Standard",
        cost: "6.00",
        tax: "0.63",
      },
      answer: {
        total: "28.74",
        total_tax: "2.74",
        line: "20.00",
        lineTax: "2.11",
        shippingTax: "0.63",
      },
    },
  ] as const;
  const taxedParcel = (
    rate: { methodId: string; instanceId: string; title: string; cost: string },
    answer: {
      total: string;
      total_tax: string;
      line: string;
      lineTax: string;
      shippingTax: string;
    },
  ) =>
    madeParcel({
      total: answer.total,
      total_tax: answer.total_tax,
      line_items: [
        {
          product_id: 28,
          quantity: 1,
          subtotal: answer.line,
          total: answer.line,
          total_tax: answer.lineTax,
        },
      ],
      shipping_lines: [
        {
          id: 6,
          method_title: rate.title,
          method_id: rate.methodId,
          instance_id: rate.instanceId,
          total: rate.cost,
          total_tax: answer.shippingTax,
        },
      ],
    });

  it("leaves a shop that calculates tax to price the goods, and takes the order on at the total paid", async () => {
    for (const { tax, rate, answer } of TAXED_ORDERS) {
      stand = await shopAnswering(() => ({ status: 201, body: taxedParcel(rate, answer) }));

      const made = await createParcel(connectionTo(stand.url), {
        ...sold,
        total: { amount: answer.total, currency: "USD" },
        rate,
        tax,
      });

      expect(made, tax).toStrictEqual({ ok: true, id: "30", number: "30", total: answer.total });
      const body = JSON.parse(stand.asked[0]?.body ?? "{}");
      // Totals sent on the line would be taxed on top in a shop whose prices
      // hold their tax, and are the shop's own price in the other.
      expect(body.line_items, tax).toStrictEqual([{ product_id: 28, quantity: 1 }]);
      expect(body.shipping_lines, tax).toStrictEqual([
        {
          method_id: rate.methodId,
          instance_id: rate.instanceId,
          method_title: rate.title,
          total: rate.cost,
        },
      ]);
      await stand.close();
      stand = null;
    }
  });

  it("does not take on a taxed parcel's order whose total is not what was paid", async () => {
    // The Bali shop's order with the goods' totals sent on its line: 25.53
    // against the cart's 23.33.
    const [{ rate }] = TAXED_ORDERS;
    stand = await shopAnswering(() => ({
      status: 201,
      body: taxedParcel(rate, {
        total: "25.53",
        total_tax: "2.53",
        line: "20.00",
        lineTax: "2.20",
        shippingTax: "0.33",
      }),
    }));

    const made = await createParcel(connectionTo(stand.url), {
      ...sold,
      total: { amount: "23.33", currency: "USD" },
      rate,
      tax: "included",
    });

    expect(made).toMatchObject({ ok: false, again: true, id: "30" });
  });

  it("takes on a taxed parcel's order within a cent of what was paid either way, and says what the shop recorded", async () => {
    // The review's German shop entering 10.0756 of net shipping: the cart
    // taxed that cost and quoted 31.99, the order taxed the 10.08 it was sent
    // and totalled 32.00; and the same a cent the other way.
    const paket = {
      methodId: "flat_rate",
      instanceId: "8",
      title: "Paket",
      cost: "10.08",
      tax: "1.91",
    } as const;
    for (const [paid, recorded] of [
      ["31.99", "32.00"],
      ["32.00", "31.99"],
    ] as const) {
      stand = await shopAnswering(() => ({
        status: 201,
        body: taxedParcel(paket, {
          total: recorded,
          total_tax: "5.11",
          line: "16.81",
          lineTax: "3.19",
          shippingTax: "1.92",
        }),
      }));

      const made = await createParcel(connectionTo(stand.url), {
        ...sold,
        total: { amount: paid, currency: "USD" },
        rate: paket,
        tax: "included",
      });

      expect(made, paid).toStrictEqual({ ok: true, id: "30", number: "30", total: recorded });
      await stand.close();
      stand = null;
    }
  });

  it("takes on a parcel's order a cent from what was paid from a shop calculating no tax too, and no more", async () => {
    stand = await shopAnswering(() => ({ status: 201, body: madeParcel({ total: "23.01" }) }));
    expect(await createParcel(connectionTo(stand.url), sold)).toMatchObject({
      ok: true,
      total: "23.01",
    });
    await stand.close();
    stand = await shopAnswering(() => ({ status: 201, body: madeParcel({ total: "23.02" }) }));
    expect(await createParcel(connectionTo(stand.url), sold)).toMatchObject({
      ok: false,
      again: true,
    });
  });

  it("does not take on the order of a parcel sold as untaxed when the order carries tax", async () => {
    for (const changed of [
      { total_tax: "0.01" },
      {
        line_items: [
          { product_id: 28, quantity: 1, subtotal: "20.00", total: "20.00", total_tax: "0.01" },
        ],
      },
    ]) {
      stand = await shopAnswering(() => ({ status: 201, body: madeParcel(changed) }));
      expect(await createParcel(connectionTo(stand.url), sold)).toMatchObject({
        ok: false,
        again: true,
      });
      await stand.close();
      stand = null;
    }
  });

  it("carries none of the address into a refusal, and says whether to ask again", async () => {
    stand = await shopAnswering(() => ({
      status: 400,
      body: {
        code: "rest_invalid_param",
        message: "Invalid shipping: Jl. Raya Kediri, Beraban, Tabanan",
      },
    }));
    const refused = await createParcel(connectionTo(stand.url), sold);
    expect(refused).toMatchObject({ ok: false, again: false });
    for (const word of ADDRESS_WORDS) expect(JSON.stringify(refused)).not.toContain(word);
    await stand.close();

    stand = await shopAnswering(() => ({ status: 503, body: {} }));
    expect(await createParcel(connectionTo(stand.url), sold)).toMatchObject({
      ok: false,
      again: true,
    });
  });
});

describe("reading whether a parcel has shipped", () => {
  // Completed is read as sent; tracking comes from WooCommerce's own
  // fulfilments, in the shape a live 11.1 answered.
  const order = (status: string, lines: unknown[] = [{ method_title: "Bali courier" }]) => ({
    id: 30,
    status,
    transaction_id: "ord_9",
    shipping_lines: lines,
  });
  const fulfilment = (overrides: Record<string, unknown> = {}, meta: unknown[] = []) => ({
    id: 1,
    entity_type: "WC_Order",
    entity_id: "30",
    status: "fulfilled",
    is_fulfilled: "1",
    meta_data: [
      { id: 1, key: "_items", value: [{ item_id: 5, qty: 1 }] },
      { id: 2, key: "_tracking_number", value: "PROBE123" },
      { id: 3, key: "_shipment_provider", value: "jne" },
      { id: 4, key: "_tracking_url", value: "https://example.com/track/PROBE123" },
      ...meta,
    ],
    ...overrides,
  });
  const NO_ROUTE = {
    status: 404,
    body: { code: "rest_no_route", message: "No route was found matching the URL." },
  };
  const shopShowing = (
    theOrder: { status: number; body: unknown },
    fulfilments: { status: number; body: unknown } = NO_ROUTE,
  ) =>
    shopAnswering((asked) =>
      asked.url.startsWith("/wp-json/wc/v3/orders/30/fulfillments") ? fulfilments : theOrder,
    );

  it("reads a completed order's tracking from the shop's own fulfilment, and not its address", async () => {
    stand = await shopShowing(
      { status: 200, body: order("completed") },
      { status: 200, body: [fulfilment()] },
    );

    const read = await shipmentOf(connectionTo(stand.url), "30");

    expect(read).toStrictEqual({
      kind: "shipped",
      shipment: {
        carrier: "jne",
        tracking_number: "PROBE123",
        tracking_url: "https://example.com/track/PROBE123",
      },
    });
    const fields = new URL(stand.asked[0]?.url ?? "", stand.url).searchParams.get("_fields");
    expect(fields?.split(",")).not.toContain("shipping");
    expect(fields?.split(",")).not.toContain("billing");
    expect(stand.asked.every((asked) => asked.authorization !== undefined)).toBe(true);
  });

  it("names the shop's shipping method as the carrier, with no number, where nothing else is said", async () => {
    // Fulfilments are off by default, so this is the ordinary case: the carrier
    // is the method paid for, with no number.
    for (const fulfilments of [
      NO_ROUTE,
      { status: 200, body: [] },
      { status: 200, body: [fulfilment({ status: "unfulfilled", is_fulfilled: "" })] },
    ]) {
      stand = await shopShowing({ status: 200, body: order("completed") }, fulfilments);

      expect(await shipmentOf(connectionTo(stand.url), "30")).toStrictEqual({
        kind: "shipped",
        shipment: { carrier: "Bali courier", tracking_number: null },
      });
      await stand.close();
      stand = null;
    }
  });

  it("leaves out a tracking address that is not one, and records nothing worded otherwise", async () => {
    // Never cleaned: a bad tracking address is dropped, and a carrier or number
    // that is not plain text means no shipment, so the order waits for the
    // merchant.
    stand = await shopShowing(
      { status: 200, body: order("completed") },
      {
        status: 200,
        body: [
          fulfilment({
            meta_data: [
              { key: "_tracking_number", value: "PROBE123" },
              { key: "_shipment_provider", value: "jne" },
              { key: "_tracking_url", value: "http://example.com/track/PROBE123" },
            ],
          }),
        ],
      },
    );
    expect(await shipmentOf(connectionTo(stand.url), "30")).toStrictEqual({
      kind: "shipped",
      shipment: { carrier: "jne", tracking_number: "PROBE123" },
    });
    await stand.close();

    for (const [carrier, number] of [
      ["<b>jne</b>", "PROBE123"],
      ["jne", "PROBE &amp; 123"],
    ]) {
      stand = await shopShowing(
        { status: 200, body: order("completed") },
        {
          status: 200,
          body: [
            fulfilment({
              meta_data: [
                { key: "_tracking_number", value: number },
                { key: "_shipment_provider", value: carrier },
              ],
            }),
          ],
        },
      );
      expect(await shipmentOf(connectionTo(stand.url), "30"), `${carrier} ${number}`).toMatchObject(
        {
          kind: "unknown",
        },
      );
      await stand.close();
    }
    stand = await shopShowing({
      status: 200,
      body: order("completed", [{ method_title: "Flat &amp; fast" }]),
    });
    expect(await shipmentOf(connectionTo(stand.url), "30")).toMatchObject({ kind: "unknown" });
  });

  it("does not choose among several fulfilments or several shipping lines", async () => {
    stand = await shopShowing(
      { status: 200, body: order("completed") },
      { status: 200, body: [fulfilment(), fulfilment({ id: 2 })] },
    );
    expect(await shipmentOf(connectionTo(stand.url), "30")).toMatchObject({ kind: "unknown" });
    await stand.close();

    stand = await shopShowing({
      status: 200,
      body: order("completed", [{ method_title: "Bali courier" }, { method_title: "Express" }]),
    });
    expect(await shipmentOf(connectionTo(stand.url), "30")).toMatchObject({ kind: "unknown" });
  });

  it("does not take another sale's order for this one", async () => {
    // The shop's order id can be reused by another or rebuilt shop, so only an
    // order carrying this sale's identifier says anything about it.
    stand = await shopShowing({
      status: 200,
      body: { ...order("completed"), transaction_id: "ord_somebody_else" },
    });

    expect(await shipmentOf(connectionTo(stand.url), "30")).toMatchObject({ kind: "unknown" });
    const fields = new URL(stand.asked[0]?.url ?? "", stand.url).searchParams.get("_fields");
    expect(fields?.split(",")).toContain("transaction_id");
  });

  it("waits for an order not completed, and lets go of one the shop ended", async () => {
    for (const status of ["processing", "on-hold", "pending"]) {
      stand = await shopShowing({ status: 200, body: order(status) });
      expect(await shipmentOf(connectionTo(stand.url), "30"), status).toStrictEqual({
        kind: "waiting",
      });
      await stand.close();
      stand = null;
    }
    for (const status of ["cancelled", "refunded", "failed", "trash"]) {
      stand = await shopShowing({ status: 200, body: order(status) });
      expect(await shipmentOf(connectionTo(stand.url), "30"), status).toStrictEqual({
        kind: "ended",
        status,
      });
      await stand.close();
      stand = null;
    }
    // The shop saying it has no such order is an ending; a 404 from something
    // in front of it is not.
    stand = await shopShowing({
      status: 404,
      body: { code: "woocommerce_rest_shop_order_invalid_id", message: "Invalid ID." },
    });
    expect(await shipmentOf(connectionTo(stand.url), "30")).toStrictEqual({
      kind: "ended",
      status: "deleted",
    });
    await stand.close();
    for (const unclear of [NO_ROUTE, { status: 503, body: {} }, { status: 200, body: {} }]) {
      stand = await shopShowing(unclear);
      expect(await shipmentOf(connectionTo(stand.url), "30")).toMatchObject({ kind: "unknown" });
      await stand.close();
      stand = null;
    }
  });
});
