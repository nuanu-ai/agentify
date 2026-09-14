/**
 * Talking to one merchant's shop: reading the catalogue anybody can read, and
 * creating the paid order that only the granted keys can create.
 *
 * The shop in these tests is a small server answering on loopback, and what is
 * asserted is what we sent it — a Store API read with no credential on it at
 * all, and a `wc/v3` order carrying `set_paid` and the key pair as HTTP Basic.
 * Those two facts are the whole of the integration, and each was measured
 * rather than assumed (`docs/research/27-woo-connect-probe.md`).
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { catalogueOf, createTheOrderInTheShop } from "./woo-shop.js";

interface Asked {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: string;
}

interface Stand {
  readonly url: string;
  readonly asked: Asked[];
  close(): Promise<void>;
}

const shopAnswering = async (
  answer: (asked: Asked) => { status: number; body: unknown },
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
        body: Buffer.concat(chunks).toString("utf8"),
      };
      asked.push(call);
      const said = answer(call);
      response.writeHead(said.status, { "content-type": "application/json" });
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
    const read = await catalogueOf(stand.url);

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

    const read = await catalogueOf(stand.url);
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

    const read = await catalogueOf(stand.url, 150);

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

    const read = await catalogueOf(stand.url, 200);

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

    const read = await catalogueOf(stand.url, 200);

    expect(read.ok).toBe(true);
    expect(read.ok === true && read.products).toHaveLength(200);
  });

  it("says what a shop that refused looked like rather than showing nothing", async () => {
    stand = await shopAnswering(() => ({
      status: 404,
      body: { code: "rest_no_route", message: "No route was found matching the URL" },
    }));
    const read = await catalogueOf(stand.url);
    expect(read.ok).toBe(false);
    expect(read.ok === false && read.why).toContain("No route was found");
  });

  it("does not pretend a document it cannot read is an empty catalogue", async () => {
    // An empty catalogue and a shop answering something else are different
    // news, and a merchant told the first would go looking for their products.
    stand = await shopAnswering(() => ({ status: 200, body: { products: "all of them" } }));
    const read = await catalogueOf(stand.url);
    expect(read.ok).toBe(false);
  });
});

describe("creating the order", () => {
  const order = {
    orderId: "ord_7",
    productId: "11",
    email: "merchant@example.com",
    price: { amount: "25.00", currency: "USD" },
  };

  it("sends a paid order, with the keys as Basic authentication", async () => {
    stand = await shopAnswering(() => ({
      status: 201,
      body: { id: 13, number: "13", status: "processing" },
    }));

    const made = await createTheOrderInTheShop(connectionTo(stand.url), order);

    expect(made).toEqual({ ok: true, id: "13", number: "13" });
    const asked = stand.asked[0];
    expect(asked?.method).toBe("POST");
    expect(asked?.url).toBe("/wp-json/wc/v3/orders");
    expect(asked?.authorization).toBe(`Basic ${Buffer.from("ck_abc:cs_def").toString("base64")}`);

    const sent = JSON.parse(asked?.body ?? "{}");
    // The shop has to be told the money is already in, or the order sits in
    // its pending list and the merchant never ships it.
    expect(sent.set_paid).toBe(true);
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
    stand = await shopAnswering(() => ({ status: 201, body: { id: 13, number: "WOO-0013" } }));
    const made = await createTheOrderInTheShop(connectionTo(stand.url), order);
    expect(made).toEqual({ ok: true, id: "13", number: "WOO-0013" });
  });

  it("carries the shop's own refusal back in the shop's own words", async () => {
    stand = await shopAnswering(() => ({
      status: 400,
      body: {
        code: "woocommerce_rest_invalid_product_id",
        message: "Product ID is invalid.",
      },
    }));
    const made = await createTheOrderInTheShop(connectionTo(stand.url), order);
    expect(made.ok).toBe(false);
    expect(made.ok === false && made.why).toContain("Product ID is invalid.");
    // A shop that says the product is wrong says the same thing every time,
    // so nothing is gained by asking again.
    expect(made.ok === false && made.again).toBe(false);
  });

  it("says a shop that would not answer is worth asking again", async () => {
    const made = await createTheOrderInTheShop(connectionTo("http://127.0.0.1:1"), order);
    expect(made.ok).toBe(false);
    expect(made.ok === false && made.again).toBe(true);
  });

  it("says a shop that is busy is worth asking again", async () => {
    // A shop behind a rate limiter answers 429, which is not a 5xx. Read as
    // final it closes the sale for good and hands the buyer a refusal, which
    // is a busy afternoon costing the merchant the sale.
    for (const status of [408, 429, 502]) {
      stand = await shopAnswering(() => ({ status, body: { message: "later" } }));
      const made = await createTheOrderInTheShop(connectionTo(stand.url), order);
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
    const made = await createTheOrderInTheShop(connectionTo(stand.url), order);
    expect(made.ok).toBe(false);
    expect(made.ok === false && made.again).toBe(false);
  });

  it("does not claim an order from an answer with no order in it", async () => {
    // A proxy in front of the shop answering 201 with its own page is the
    // shape that would otherwise become a delivery naming an order number of
    // "undefined".
    stand = await shopAnswering(() => ({ status: 201, body: { ok: true } }));
    const made = await createTheOrderInTheShop(connectionTo(stand.url), order);
    expect(made.ok).toBe(false);
  });
});
