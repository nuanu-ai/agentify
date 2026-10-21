/**
 * The shop is a small server on loopback, and what is asserted is what we sent
 * it: a Store API read with no credential at all, and a `wc/v3` order carrying
 * `set_paid` and the key pair as HTTP Basic.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
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
import type { ShipToLocality } from "@nuanu-ai/agentify-contracts";
import type { WooRequest } from "./woo-request.js";
import {
  catalogueOf,
  createTheOrderInTheShop,
  createTheParcelInTheShop,
  inspectProductInTheShop,
  readTheOrderInTheShop,
  shipmentInTheShop,
  shippingRatesInTheShop,
} from "./woo-shop.js";

interface Asked {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly cartToken: string | undefined;
  readonly nonce: string | undefined;
  readonly body: string;
}

interface Stand {
  readonly url: string;
  readonly asked: Asked[];
  close(): Promise<void>;
}

const shopAnswering = async (
  answer: (asked: Asked) => {
    status: number;
    body?: unknown;
    headers?: Readonly<Record<string, string>>;
    /** Sent as it is in place of the body, for an answer that is not JSON. */
    raw?: string;
  },
): Promise<Stand> => {
  const asked: Asked[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const call: Asked = {
        method: request.method ?? "GET",
        url: request.url ?? "/",
        authorization: request.headers.authorization,
        cartToken: request.headers["cart-token"] as string | undefined,
        nonce: request.headers.nonce as string | undefined,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      asked.push(call);
      const said = answer(call);
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
    productId: "11",
    email: "merchant@example.com",
    price: { amount: "25.00", currency: "USD" },
    download: { id: "dl_guide", name: "Guide" },
    // Checked against the wallet itself, before payments went to splits.
    paidInto: null,
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
    expect(sent.meta_data).toEqual([{ key: "agentify_order_id", value: "ord_7" }]);
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

  it("writes the commission at the rate of the split the payment went to", async () => {
    stand = await shopAnswering(() => ({ status: 201, body: madeOrder() }));

    await createOrder(connectionTo(stand.url), { ...order, paidInto: AT_THREE_PERCENT });

    expect(JSON.parse(stand.asked[0]?.body ?? "{}").meta_data).toContainEqual({
      key: "agentify_commission",
      value: "≈ 0.75 USD (3%)",
    });
  });

  it("still refuses an answer whose correlation changed when the commission lines come back with it", async () => {
    const lines = [
      { key: "agentify_commission", value: "≈ 0.025 USD (0.1%)" },
      { key: "agentify_payout_contract", value: PAID_INTO.address },
    ];
    for (const meta of [
      lines,
      [{ key: "agentify_order_id", value: "ord_other" }, ...lines],
      [
        { key: "agentify_order_id", value: "ord_7" },
        { key: "agentify_order_id", value: "ord_7" },
        ...lines,
      ],
    ]) {
      stand = await shopAnswering(() => ({ status: 201, body: madeOrder({ meta_data: meta }) }));
      const made = await createOrder(connectionTo(stand.url), { ...order, paidInto: PAID_INTO });
      expect(made.ok, JSON.stringify(meta)).toBe(false);
      await stand.close();
      stand = null;
    }
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
    stand = await shopAnswering(() => ({
      status: 400,
      body: {
        code: "woocommerce_rest_invalid_product_id",
        message: `reflected ${secret}`,
      },
    }));
    const made = await createOrder(connectionTo(stand.url), order);
    expect(made.ok).toBe(false);
    expect(made.ok === false && made.why).not.toContain(secret);
    // A shop that says the product is wrong says it every time.
    expect(made.ok === false && made.again).toBe(false);
  });

  it("refuses a successful order response whose Agentify correlation changed", async () => {
    for (const changed of [
      { payment_method: "other" },
      { transaction_id: "ord_other" },
      { billing: { email: "somebody@example.com" } },
      { meta_data: [{ key: "agentify_order_id", value: "ord_other" }] },
      {
        meta_data: [
          { key: "agentify_order_id", value: "ord_7" },
          { key: "agentify_order_id", value: "ord_7" },
        ],
      },
    ]) {
      stand = await shopAnswering(() => ({ status: 201, body: madeOrder(changed) }));
      const made = await createOrder(connectionTo(stand.url), order);
      expect(made.ok).toBe(false);
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
    for (const status of [408, 429, 502]) {
      stand = await shopAnswering(() => ({ status, body: { message: "later" } }));
      const made = await createOrder(connectionTo(stand.url), order);
      expect(made.ok === false && made.again).toBe(true);
      await stand.close();
      stand = null;
    }
  });

  it("treats a shop that refused our keys as final", async () => {
    stand = await shopAnswering(() => ({
      status: 401,
      body: { code: "woocommerce_rest_cannot_view", message: "Sorry, you cannot list resources." },
    }));
    const made = await createOrder(connectionTo(stand.url), order);
    expect(made.ok).toBe(false);
    expect(made.ok === false && made.again).toBe(false);
  });

  it("does not claim an order from an answer with no order in it", async () => {
    // A proxy answering 201 with its own page would otherwise become a delivery
    // naming order number "undefined".
    stand = await shopAnswering(() => ({ status: 201, body: { ok: true } }));
    const made = await createOrder(connectionTo(stand.url), order);
    expect(made.ok).toBe(false);
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

  it("treats a shop that refused the product check as having answered", async () => {
    stand = await shopAnswering(() => ({
      status: 401,
      body: {
        code: "woocommerce_rest_cannot_view",
        message: "Sorry, you cannot view this resource.",
      },
    }));

    const read = await inspectProduct(connectionTo(stand.url), merchantItemIdFor(stand.url, "11"));

    expect(read).toMatchObject({ ok: false, again: false });
  });

  it("tells a revoked key, a firewall, a missing settings route and a key kept from the settings apart in the reason it gives", async () => {
    // The reason is all whoever reads the log has to go on: one reconnects, one
    // asks their host, one repairs the shop.
    const reasons = new Set<string>();
    for (const [where, status, code] of [
      ["/products/", 401, "woocommerce_rest_cannot_view"],
      ["/products/", 403, "forbidden"],
      ["woocommerce_ship_to_destination", 404, "rest_no_route"],
      // A key that may read the product and not the shop's settings.
      ["woocommerce_ship_to_destination", 401, "woocommerce_rest_cannot_view"],
    ] as const) {
      stand = await shopAnswering((asked) => {
        if (asked.url.includes(where)) return { status, body: { code } };
        if (asked.url.includes("/settings/")) {
          return { status: 200, body: settingAt(asked.url, parcelSettingFor(asked.url)) };
        }
        return { status: 200, body: parcelDocument() };
      });

      const read = await inspectProduct(
        connectionTo(stand.url),
        merchantItemIdFor(stand.url, "28"),
      );

      expect(read, `${status}`).toMatchObject({ ok: false, again: false, saidNo: false });
      if (!read.ok) reasons.add(read.why);
      await stand.close();
      stand = null;
    }
    expect(reasons.size).toBe(4);
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
      const reasons = new Set<string>();
      // Every answer from the raw file is a verdict except a refusal.
      const asked = checks.filter(([where]) => where !== file || failure.status !== 401);
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
          if (failure.kind === "broken" && where !== file) expect(read.again, said).toBe(true);
          reasons.add(read.why);
        }
        await stand.close();
        stand = null;
      }
      expect(reasons.size, `${failure.kind ?? failure.status}`).toBe(asked.length);
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

  it("does not call a download public when the shop was too busy to say", async () => {
    // A refusal of the keyless request proves the file protected; a 503 proves
    // nothing either way.
    stand = await shopAnswering((asked) => {
      if (asked.url === "/protected/guide.txt") return { status: 503, body: {} };
      if (asked.url.includes("/settings/")) {
        return { status: 200, body: settingAt(asked.url, settingFor(asked.url)) };
      }
      return { status: 200, body: productDocument() };
    });

    const read = await inspectProduct(connectionTo(stand.url), merchantItemIdFor(stand.url, "11"));

    expect(read).toMatchObject({ ok: false, again: true });
  });

  it("refuses public raw bytes and finite or stock-managed products", async () => {
    for (const overrides of [
      { manage_stock: true },
      { sold_individually: true },
      { download_limit: 1 },
      { download_expiry: 1 },
    ]) {
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
      expect(read.ok).toBe(false);
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

  it("refuses a shop that calculates taxes and names the setting to repair", async () => {
    stand = await shopAnswering((asked) => {
      if (asked.url === "/protected/guide.txt") return { status: 403, body: {} };
      if (asked.url.includes("woocommerce_calc_taxes")) {
        return { status: 200, body: settingAt(asked.url, "yes") };
      }
      if (asked.url.includes("/settings/")) {
        return { status: 200, body: settingAt(asked.url, settingFor(asked.url)) };
      }
      return { status: 200, body: productDocument() };
    });

    const read = await inspectProduct(connectionTo(stand.url), merchantItemIdFor(stand.url, "11"));

    expect(read).toMatchObject({
      ok: false,
      why: expect.stringContaining("tax calculation"),
    });
  });

  it("refuses a shop that writes prices at another number of decimals and names the setting", async () => {
    // WooCommerce writes order totals at the shop's number of decimals ("25" at
    // zero, "25.000" at three), so an order created at "25.00" there could not
    // be matched after the paid order exists.
    for (const decimals of ["0", "3"]) {
      stand = await shopAnswering((asked) => {
        if (asked.url === "/protected/guide.txt") return { status: 403, body: {} };
        if (asked.url.includes("woocommerce_price_num_decimals")) {
          return { status: 200, body: settingAt(asked.url, decimals) };
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

      expect(read, decimals).toMatchObject({
        ok: false,
        why: expect.stringContaining("Number of decimals"),
      });
      await stand.close();
      stand = null;
    }
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
    for (const product of [
      productDocument({ downloads: [{ id: "", name: "Guide", file: `${stand?.url}/x` }] }),
      productDocument({ downloads: [{ id: "dl", name: "", file: `${stand?.url}/x` }] }),
    ]) {
      stand = await shopAnswering((asked) => {
        if (asked.url.includes("/settings/")) {
          return { status: 200, body: settingAt(asked.url, settingFor(asked.url)) };
        }
        return { status: 200, body: product };
      });
      const read = await inspectProduct(
        connectionTo(stand.url),
        merchantItemIdFor(stand.url, "11"),
      );
      expect(read.ok).toBe(false);
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
    expect(missing.ok).toBe(false);
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

  it("keeps the fingerprint already recorded for a product priced with its cents", async () => {
    // Accepted quotes and paid-order ledger rows store this digest, and
    // recovery compares a fresh reading with it, so a price that already had
    // two decimals must hash to the stored value; it is pinned. The shop
    // answers at a fixed address because the address is part of what is hashed.
    const origin = "https://shop.example.com";
    const inProcess = async (url: string | URL): Promise<Response> => {
      const path = new URL(url).pathname;
      if (path === "/protected/guide.txt") return new Response(null, { status: 403 });
      if (path.includes("/settings/")) return Response.json(settingAt(path, settingFor(path)));
      return Response.json(
        productDocument({
          price: "0.01",
          downloads: [
            { id: "dl_guide", name: "Agentify guide.txt", file: `${origin}/protected/guide.txt` },
          ],
        }),
      );
    };

    const read = await inspectProductInTheShop(
      connectionTo(origin),
      merchantItemIdFor(origin, "11"),
      inProcess,
    );

    expect(read.ok && read.product.fingerprint).toBe(
      "e99a840cd2bd3f94384df3aa19fa18abf96de58435552c19b64703f59ab598dc",
    );
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
      productId: read.product.productId,
      email: "merchant@example.com",
      price: read.product.price,
      download: { id: read.product.downloadId, name: read.product.fileName },
      paidInto: null,
    });

    expect(made).toMatchObject({ ok: true, id: "13", orderKey: "wc_order_13" });
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
  const shopWithRates = (answered: () => { status: number; body: unknown }) =>
    shopAnswering((asked) => {
      if (asked.method === "GET" && asked.url === "/wp-json/wc/store/v1/cart") {
        return { status: 200, body: cart([]), headers: { "Cart-Token": TOKEN } };
      }
      if (asked.url === "/wp-json/wc/store/v1/cart/add-item") {
        return { status: 201, body: cart([]) };
      }
      return answered();
    });
  const JAKARTA: ShipToLocality = { country: "ID", city: "Jakarta" };

  it("asks a fresh cart with its token and no nonce, and sends every field of the place", async () => {
    // A field left out keeps the shop's base location, so a German address
    // without a state would be priced as if it were in the shop's own state.
    stand = await shopWithRates(() => ({ status: 200, body: cart([rate()]) }));

    const read = await ratesFor(stand.url, "28", JAKARTA);

    expect(read).toStrictEqual({
      ok: true,
      rates: [{ methodId: "flat_rate", instanceId: "3", title: "Standard", cost: "5.00" }],
    });
    expect(stand.asked.map((asked) => `${asked.method} ${asked.url}`)).toStrictEqual([
      "GET /wp-json/wc/store/v1/cart",
      "POST /wp-json/wc/store/v1/cart/add-item",
      "POST /wp-json/wc/store/v1/cart/update-customer",
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

    expect(read).toStrictEqual({
      ok: true,
      rates: [
        { methodId: "flat_rate", instanceId: "4", title: "Express", cost: "12.00" },
        { methodId: "flat_rate", instanceId: "3", title: "Standard", cost: "5.00" },
      ],
    });
  });

  it("tells a place the shop does not ship to from a shop that refused or did not answer", async () => {
    stand = await shopWithRates(() => ({ status: 200, body: cart([]) }));
    expect(await ratesFor(stand.url, "28", JAKARTA)).toStrictEqual({ ok: true, rates: [] });
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
        "a rate in another currency",
        null,
        { status: 200, body: cart([rate({ currency_code: "EUR" })]) },
        true,
      ],
      [
        "a cart that wants a nonce",
        null,
        { status: 401, body: { code: "woocommerce_rest_missing_nonce" } },
        false,
      ],
      [
        "a cart that refuses its nonce",
        null,
        { status: 403, body: { code: "woocommerce_rest_invalid_nonce" } },
        false,
      ],
      [
        // A code neither WooCommerce nor WordPress refuses a product or a place
        // with, as a plugin or a proxy in front of the cart can write.
        "a refusal under another code",
        null,
        refusing("rest_forbidden"),
        false,
      ],
      [
        "a refusal that is not WooCommerce's",
        null,
        { status: 400, raw: "<html>Bad Request</html>" },
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
          return { status: 200, body: cart([]), headers: { "Cart-Token": TOKEN } };
        }
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
            return { status: 200, body: cart([]), headers: { "Cart-Token": TOKEN } };
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

  it("refuses rates it could not sell at, rather than choosing among them", async () => {
    // Another currency or scale, an added tax, or two packages: none is the
    // price of shipping this parcel in dollars, and choosing among them would
    // be a guess.
    for (const body of [
      cart([rate({ currency_code: "EUR" })]),
      cart([rate({ currency_minor_unit: 0, price: "5" })]),
      cart([rate({ taxes: "50" })]),
      cart([rate({ price: "five" })]),
      cart([rate()], { shipping_rates: [aPackage([rate()]), aPackage([rate()])] }),
      cart([rate()], { needs_shipping: false }),
    ]) {
      stand = await shopWithRates(() => ({ status: 200, body }));

      expect(await ratesFor(stand.url, "28", JAKARTA), JSON.stringify(body)).toMatchObject({
        ok: false,
        again: false,
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
    productId: "28",
    email: "merchant@example.com",
    paid: { amount: "23.00", currency: "USD" },
    goods: "20.00",
    rate: { methodId: "flat_rate", instanceId: "1", title: "Bali courier", cost: "3.00" },
    address: ADDRESS,
    paidInto: null,
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

  it("sends a paid order shipping to the buyer, with the rate the price was paid at", async () => {
    stand = await shopAnswering(() => ({ status: 201, body: madeParcel() }));

    const made = await createParcel(connectionTo(stand.url), sold);

    expect(made).toStrictEqual({ ok: true, id: "30", number: "30" });
    const asked = stand.asked[0];
    expect(asked?.method).toBe("POST");
    expect(asked?.authorization).toMatch(/^Basic /);
    // Only the fields needed, the address among them so it can be checked.
    expect(new URL(asked?.url ?? "", stand.url).searchParams.get("_fields")?.split(",")).toContain(
      "shipping",
    );
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
  });

  it("writes the commission of a parcel on what was paid, the goods and the shipping together", async () => {
    // The split received the whole payment, shipping included: 0.1% of 23.00
    // is 0.023, where the goods alone would make it 0.02.
    const lines = [
      { key: "agentify_order_id", value: "ord_9" },
      { key: "agentify_commission", value: "≈ 0.023 USD (0.1%)" },
      { key: "agentify_payout_contract", value: PAID_INTO.address },
    ];
    stand = await shopAnswering(() => ({ status: 201, body: madeParcel({ meta_data: lines }) }));

    const made = await createParcel(connectionTo(stand.url), { ...sold, paidInto: PAID_INTO });

    expect(made).toStrictEqual({ ok: true, id: "30", number: "30" });
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
