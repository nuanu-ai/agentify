/**
 * Talking to one merchant's shop: reading the catalogue anybody can read, and
 * creating the paid order that only the granted keys can create.
 *
 * The shop in these tests is a small server answering on loopback, and what is
 * asserted is what we sent it — a Store API read with no credential on it at
 * all, and a `wc/v3` order carrying `set_paid` and the key pair as HTTP Basic.
 * Those two facts are the whole of the integration, and each was measured
 * rather than assumed (`docs/research/33-woo-connect-probe.md`).
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
  shipmentInTheShop(keys, wooOrderId, fetch);
const createParcel = (
  keys: Parameters<typeof createTheParcelInTheShop>[0],
  sold: Parameters<typeof createTheParcelInTheShop>[1],
) => createTheParcelInTheShop(keys, sold, fetch);

import type { ShipToLocality } from "@nuanu-ai/agentify-contracts";
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
  /** The Store API's cart headers, which a client with no browser sends or not. */
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
    body: unknown;
    headers?: Readonly<Record<string, string>>;
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
      response.end(JSON.stringify(said.body));
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
    // The Store API is public by design, and sending a key to it would be
    // sending a merchant's secret where it buys nothing.
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
    // The refusal is the same either way; the difference is how many round
    // trips somebody else's shop makes for it. Read whole and refused at the
    // end, a five-thousand-product shop is fifty requests for one "no".
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
    // The case that matters most and the one a shop is most likely to be: a
    // catalogue that is not an exact multiple of the page size. Read with the
    // short page checked first, every shop between the ceiling and the next
    // hundred came over whole and nobody was told the number had been passed.
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
    // The other side of the same line: two hundred products against a ceiling
    // of two hundred is a catalogue that fits, and refusing it would be a shop
    // turned away for being exactly the size we said we take.
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
    // An empty catalogue and a shop answering something else are different
    // news, and a merchant told the first would go looking for their products.
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
    // The shop has to be told the money is already in, or the order sits in
    // its pending list and the merchant never ships it.
    expect(sent.set_paid).toBe(true);
    // The customer-facing name and both stored identifiers use the same
    // namespace, so the merchant never has to translate our name in Woo.
    expect(sent.payment_method).toBe("agentify");
    expect(sent.payment_method_title).toBe("Agentify");
    expect(sent.meta_data).toEqual([{ key: "agentify_order_id", value: "ord_7" }]);
    expect(sent.line_items).toEqual([
      { product_id: 11, quantity: 1, subtotal: "25.00", total: "25.00" },
    ]);
    // Our own identifier on the shop's order, so a merchant holding one can
    // find the other. It is the only thread between the two systems.
    expect(sent.transaction_id).toBe("ord_7");
    expect(sent.billing.email).toBe("merchant@example.com");
  });

  it("reads the number the shop gave the order rather than its row id", async () => {
    // A shop with a plugin that renumbers orders answers with a `number` that
    // is not the id, and the number is what the merchant sees on their screen.
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
    // A shop that says the product is wrong says the same thing every time,
    // so nothing is gained by asking again.
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
    // A shop behind a rate limiter answers 429, which is not a 5xx. Read as
    // final it closes the sale for good and hands the buyer a refusal, which
    // is a busy afternoon costing the merchant the sale.
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
    // A proxy in front of the shop answering 201 with its own page is the
    // shape that would otherwise become a delivery naming an order number of
    // "undefined".
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
    // Woo leaves this dormant default on ordinary products even when the shop
    // has tax calculation disabled and hides the field from its editor.
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

  /** A physical simple product as `wc/v3` writes one: no file and nothing virtual. */
  const parcelDocument = (overrides: Record<string, unknown> = {}) =>
    productDocument({
      id: 28,
      virtual: false,
      downloadable: false,
      downloads: [],
      price: "20.00",
      ...overrides,
    });

  /** The settings a parcel is sold under, with shipping to the shipping address. */
  const parcelSettingFor = (url: string): string => {
    if (url.includes("woocommerce_ship_to_countries")) return "";
    if (url.includes("woocommerce_ship_to_destination")) return "shipping";
    return settingFor(url);
  };

  it("accepts a physical simple product as a parcel, judged by the shop's shipping settings", async () => {
    // The download settings are the ones a download is sold under. A shop
    // whose download settings would refuse every file, and one that will not
    // even show them, still sells a parcel, and no file is asked for.
    stand = await shopAnswering((asked) => {
      if (asked.url.includes("woocommerce_file_download_method")) {
        return { status: 401, body: { code: "woocommerce_rest_cannot_view" } };
      }
      if (asked.url.includes("woocommerce_downloads_require_login")) {
        return { status: 200, body: { value: "yes" } };
      }
      if (asked.url.includes("/settings/")) {
        return { status: 200, body: { value: parcelSettingFor(asked.url) } };
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
    // A shop with shipping switched off has no rate to give, and one that
    // forces the billing address keeps no shipping address of its own: the
    // address the agent sent would vanish from the merchant's order screen.
    for (const [setting, value, named] of [
      ["woocommerce_ship_to_countries", "disabled", "Shipping location"],
      ["woocommerce_ship_to_destination", "billing_only", "billing address"],
    ] as const) {
      stand = await shopAnswering((asked) => {
        if (asked.url.includes(setting)) return { status: 200, body: { value } };
        if (asked.url.includes("/settings/")) {
          return { status: 200, body: { value: parcelSettingFor(asked.url) } };
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

  it("refuses a parcel whose shipping settings the shop will not show", async () => {
    stand = await shopAnswering((asked) => {
      if (asked.url.includes("woocommerce_ship_to_destination")) {
        return { status: 401, body: { code: "woocommerce_rest_cannot_view" } };
      }
      if (asked.url.includes("/settings/")) {
        return { status: 200, body: { value: parcelSettingFor(asked.url) } };
      }
      return { status: 200, body: parcelDocument() };
    });

    const read = await inspectProduct(connectionTo(stand.url), merchantItemIdFor(stand.url, "28"));

    expect(read).toMatchObject({ ok: false, again: false });
  });

  it("says a shop that would not answer the product check is worth asking again", async () => {
    // The order this check stands in front of is still live while the shop is
    // down or busy, and a refusal read off a timeout would close it for good
    // with a reason that is not true.
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

  it("accepts only the one protected native download the agent can receive", async () => {
    stand = await shopAnswering((asked) => {
      if (asked.url === "/protected/guide.txt") return { status: 403, body: {} };
      if (asked.url.includes("/settings/")) {
        return { status: 200, body: { value: settingFor(asked.url) } };
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
    // The key goes with every question to the shop's API and with nothing
    // else: the raw file is asked for as a stranger would ask for it.
    const api = stand.asked.filter((asked) => asked.url.startsWith("/wp-json/"));
    expect(api.length).toBeGreaterThan(0);
    expect(api.every((asked) => asked.authorization !== undefined)).toBe(true);
    expect(
      stand.asked.find((asked) => asked.url === "/protected/guide.txt")?.authorization,
    ).toBeUndefined();
  });

  it("does not call a download public when the shop was too busy to say", async () => {
    // The raw file is asked for without keys, and a refusal is what proves it
    // protected. A shop answering 503 there has proved nothing either way.
    stand = await shopAnswering((asked) => {
      if (asked.url === "/protected/guide.txt") return { status: 503, body: {} };
      if (asked.url.includes("/settings/")) {
        return { status: 200, body: { value: settingFor(asked.url) } };
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
          return { status: 200, body: { value: settingFor(asked.url) } };
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
        return { status: 200, body: { value: settingFor(asked.url) } };
      }
      return { status: 200, body: productDocument() };
    });
    const publicFile = await inspectProduct(
      connectionTo(stand.url),
      merchantItemIdFor(stand.url, "11"),
    );
    expect(publicFile).toMatchObject({ ok: false, why: expect.stringContaining("public") });
  });

  it("refuses a shop that calculates taxes and names the setting to repair", async () => {
    stand = await shopAnswering((asked) => {
      if (asked.url === "/protected/guide.txt") return { status: 403, body: {} };
      if (asked.url.includes("woocommerce_calc_taxes")) {
        return { status: 200, body: { value: "yes" } };
      }
      if (asked.url.includes("/settings/")) {
        return { status: 200, body: { value: settingFor(asked.url) } };
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
    // WooCommerce writes an order's totals at the shop's Number of decimals:
    // "25" and a tax of "0" at zero, "25.000" at three. An order created at
    // "25.00" in such a shop would be answered in a form it cannot be matched
    // with, after the paid order already exists there.
    for (const decimals of ["0", "3"]) {
      stand = await shopAnswering((asked) => {
        if (asked.url === "/protected/guide.txt") return { status: 403, body: {} };
        if (asked.url.includes("woocommerce_price_num_decimals")) {
          return { status: 200, body: { value: decimals } };
        }
        if (asked.url.includes("/settings/")) {
          return { status: 200, body: { value: settingFor(asked.url) } };
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
        return { status: 200, body: { value: settingFor(asked.url) } };
      }
      return { status: 200, body: productDocument() };
    });

    const read = await inspectProduct(connectionTo(stand.url), merchantItemIdFor(stand.url, "11"));

    expect(read).toMatchObject({
      ok: false,
      why: expect.stringContaining("tax calculation"),
    });
  });

  it("names a product that has no downloadable file instead of listing every rule", async () => {
    stand = await shopAnswering((asked) => {
      if (asked.url.includes("/settings/")) {
        return { status: 200, body: { value: settingFor(asked.url) } };
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
          return { status: 200, body: { value: settingFor(asked.url) } };
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
        return { status: 200, body: { value: settingFor(asked.url) } };
      }
      return { status: 200, body: productDocument() };
    });
    const missing = await inspectProduct(
      connectionTo(stand.url),
      merchantItemIdFor(stand.url, "11"),
    );
    expect(missing.ok).toBe(false);
  });

  /**
   * The shop on loopback, storing the product's price the way the merchant
   * typed it, and answering an order the way `wc/v3` does: with every total
   * written at the shop's two decimals, whatever string it was sent.
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
        return { status: 200, body: { value: settingFor(asked.url) } };
      }
      return { status: 200, body: productDocument({ price: typed() }) };
    });

  it("carries the price at a dollar's two decimals, however the merchant typed it", async () => {
    // WooCommerce keeps a price as it was typed and hands it back that way:
    // "25" stays "25" and "19.9" stays "19.9" in wc/v3, while the Store API
    // and every order total carry the same money at two decimals. The card,
    // the quote and the order all have to speak the second form.
    for (const [typed, amount] of [
      ["25", "25.00"],
      ["19.9", "19.90"],
      ["25.00", "25.00"],
      ["0.01", "0.01"],
      ["25.000", "25.00"],
      ["025", "25.00"],
      // WooCommerce stores a price typed without its leading zero as typed,
      // and the Store API prices it as 99 and 50 cents.
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
    // An accepted quote is held to this digest when its order is filled. A
    // merchant who retypes "25.00" as "25" has not changed what the product
    // costs, and the sales quoted before they pressed Update must still go
    // through; a merchant who changes it to 25.01 has.
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
    // Every accepted quote stores this digest, and so does the ledger entry of
    // every paid order, and recovery compares a fresh reading with the stored
    // one. A product whose shop price already had two decimals has to hash to
    // what it hashed to when those rows were written, so the value is pinned:
    // it is the digest this very product had before prices were normalised.
    // The shop answers in-process at a fixed address because the address is
    // part of what is hashed.
    const origin = "https://shop.example.com";
    const inProcess = async (url: string | URL): Promise<Response> => {
      const path = new URL(url).pathname;
      if (path === "/protected/guide.txt") return new Response(null, { status: 403 });
      if (path.includes("/settings/")) return Response.json({ value: settingFor(path) });
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
    // The Store API rounds "25.001" to 2500 cents. Selling at 25.00 would be
    // selling at a price the merchant did not set, and so would 25.01, so the
    // product stays in the shop with a sentence that names the price.
    stand = await shopStoringPrice(() => "25.001");

    const read = await inspectProduct(connectionTo(stand.url), merchantItemIdFor(stand.url, "11"));

    expect(read).toMatchObject({ ok: false, why: expect.stringContaining("25.001") });
    // The price is what the merchant changes, not the shop's decimals setting.
    expect(read.ok === false && read.why).not.toContain("Number of decimals");
  });

  it("refuses a price that is not a decimal amount at all", async () => {
    // "5." is here although WooCommerce stores it as "5": it cannot arrive, so
    // there is no form of it this has to accept.
    for (const typed of ["", "-5", "1e3", "5.", "."]) {
      stand = await shopStoringPrice(() => typed);

      const read = await inspectProduct(
        connectionTo(stand.url),
        merchantItemIdFor(stand.url, "11"),
      );

      expect(read, typed).toMatchObject({
        ok: false,
        why: expect.stringContaining("not a decimal amount"),
      });
      await stand.close();
      stand = null;
    }
  });

  it("sells a price typed without cents at the amount WooCommerce's own order carries", async () => {
    // The price this check reads is the price the order is created at, and
    // WooCommerce's answer to that order is compared with it character for
    // character. A check that handed on "25" would create the order, read
    // "25.00" back, and leave a paid order in the shop that nothing here can
    // say was made.
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
    });

    expect(made).toMatchObject({ ok: true, id: "13", orderKey: "wc_order_13" });
  });
});

describe("the shop's own shipping rate for a parcel's place", () => {
  // The exchange is the one the probe ran against a live WooCommerce
  // (`docs/research/41-woo-parcel-probe.md`): a fresh cart, its token in
  // place of a browser's nonce, the product added, the place set, and the
  // rates read off the answer. The shapes below are what that shop answered.
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
  const cart = (rates: unknown[], overrides: Record<string, unknown> = {}) => ({
    items: [{ id: 28, quantity: 1 }],
    needs_shipping: true,
    shipping_rates: [{ package_id: 0, name: "Shipment 1", shipping_rates: rates }],
    ...overrides,
  });
  /** A cart that hands out a token and answers the place with these rates. */
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
    // A field left out of the place is not cleared: the cart keeps the shop's
    // own base location, and a German address without a state was checked as
    // a German address in California. Every field goes, empty where the
    // address has none.
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
    // The cart is the public half of WooCommerce: no key, and no nonce.
    expect(stand.asked.every((asked) => asked.authorization === undefined)).toBe(true);
    expect(stand.asked.every((asked) => asked.nonce === undefined)).toBe(true);
  });

  it("keeps every rate in the shop's own order, and leaves pickup out", async () => {
    // Pickup is not shipping: a parcel nobody collects is a parcel that never
    // leaves, and it is usually the cheapest rate on offer.
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

    // The shop's own refusal names the place it refused, so none of it is
    // carried into what this says.
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

    // A cart with no token cannot be asked anything without a browser's nonce.
    stand = await shopAnswering(() => ({ status: 200, body: cart([]) }));
    expect(await ratesFor(stand.url, "28", JAKARTA)).toMatchObject({ ok: false, again: false });
  });

  it("refuses rates it could not sell at, rather than choosing among them", async () => {
    // Another currency, another scale, a tax the shop added, or two packages
    // for one product: each is a shop whose rate is not the price of shipping
    // this parcel in dollars, and a choice made among them would be a guess.
    for (const body of [
      cart([rate({ currency_code: "EUR" })]),
      cart([rate({ currency_minor_unit: 0, price: "5" })]),
      cart([rate({ taxes: "50" })]),
      cart([rate({ price: "five" })]),
      cart([rate()], {
        shipping_rates: [
          { package_id: 0, shipping_rates: [rate()] },
          { package_id: 1, shipping_rates: [rate()] },
        ],
      }),
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
});

describe("creating a parcel's order", () => {
  // What a live WooCommerce 11.1 answered to an order like this one, with the
  // address read back as it was sent (`docs/research/41-woo-parcel-probe.md`).
  // The address is Agentify's own office, the one the discovery listing's
  // example ships to: a real place and nobody's home.
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
  /** Every word of the address, none of which any answer here may carry. */
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
    // The answer is read with the fields this needs, the address among them so
    // that it can be checked, and nothing else the shop would echo.
    expect(new URL(asked?.url ?? "", stand.url).searchParams.get("_fields")?.split(",")).toContain(
      "shipping",
    );
    const body = JSON.parse(asked?.body ?? "{}");
    expect(body).toMatchObject({
      set_paid: true,
      transaction_id: "ord_9",
      billing: { email: "merchant@example.com" },
      // One name goes whole into the first name: splitting it would be a guess.
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

  it("does not call an order placed whose answer does not carry the address it was sent", async () => {
    // Taking the order on erases Agentify's copy of the address (ADR-0032), so
    // the shop has to be seen holding it first. An answer that holds another,
    // or none, is an order that may exist without it: unknown, never placed,
    // and never posted again.
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
  // WooCommerce has no "shipped". Completed is the merchant's word that the
  // order needs nothing more, and it is the one this reads; tracking, where
  // there is any, is read from WooCommerce's own fulfilments, in the shape a
  // live 11.1 answered (`docs/research/41-woo-parcel-probe.md`).
  const order = (status: string, lines: unknown[] = [{ method_title: "Bali courier" }]) => ({
    id: 30,
    status,
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
    // Fulfilments are switched off in WooCommerce by default, so this is the
    // ordinary case: the method the parcel was paid to go by is what the
    // agent is told carries it, and that it has no number we know.
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
    // A tracking address an agent cannot take as an address is left out, never
    // cleaned up; a carrier or a number that is not plain text is not a
    // shipment to record, and the order waits for the merchant to correct it.
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
    // The shop saying it has no such order is an ending; a 404 from anything
    // else in front of it is not the shop saying so.
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
