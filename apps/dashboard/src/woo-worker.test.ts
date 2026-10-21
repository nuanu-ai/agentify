/**
 * The whole path with nothing in the middle stubbed: a real gateway on
 * in-memory adapters, a card converted from a shop's catalogue and published
 * normally, a purchase over HTTP with a payment, and a shop on loopback. The
 * shop stands in for a real one answering `POST wc/v3/orders` with `set_paid:
 * true` under 201.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  buyOverHttp,
  type Harness,
  harness,
  loggedWhile,
  type Served,
  serve,
} from "@agentify/gateway/testing";
import {
  type AgentOrderStatus,
  type Order,
  QuoteRequestSchema,
} from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gatewayFor } from "./gateway.js";
import { cardsFromTheShop, merchantItemIdFor, type StoreProduct } from "./woo-catalog.js";
import type { WooRequest } from "./woo-request.js";
import {
  createTheOrderInTheShop,
  createTheParcelInTheShop,
  type EligibleWooProduct,
  inspectProductInTheShop,
  type OrderMade,
  type ParcelMade,
  type ParcelSold,
  type ProductInspection,
  type RatesRead,
  type ShipmentRead,
  type ShopKeys,
  type SoldItem,
  shippingRatesInTheShop,
} from "./woo-shop.js";
import { memoryWooShops, type WooConnection, type WooShops } from "./woo-shops.js";
import {
  type Filling,
  filledAsPaid,
  fillFromTheShop,
  followShipments,
  quoteFromTheShop,
  startWooWorker,
  turnOnce,
} from "./woo-worker.js";

const showing = (product: EligibleWooProduct): ProductInspection => ({ ok: true, product });

/**
 * A payment checked against the merchant's wallet itself, before payments
 * went to splits: its shop order carries no commission line, which the cases
 * handing it are not about.
 */
const NO_SPLIT = null;

const RULED_OUT: ProductInspection = {
  ok: false,
  why: "This product cannot be imported: it is out of stock.",
  again: false,
  saidNo: true,
};
const MERCHANT_EMAIL = "merchant@example.com";

const aProduct = (overrides: Partial<StoreProduct> = {}): StoreProduct => ({
  id: 11,
  name: "Canvas tote bag",
  sku: "agentify-tote",
  type: "simple",
  description: "<p>A physical item that has to be shipped somewhere.</p>",
  short_description: "",
  is_purchasable: true,
  is_in_stock: true,
  status: "publish",
  virtual: true,
  downloadable: true,
  manage_stock: false,
  download_limit: -1,
  download_expiry: -1,
  downloads: [
    { id: "dl_guide", name: "Guide", file: "https://shop.example.com/protected/guide.txt" },
  ],
  qualification_problem: null,
  prices: { price: "2500", currency_code: "USD", currency_minor_unit: 2 },
  ...overrides,
});

const connection = (accountId = "acc_1"): WooConnection => ({
  accountId,
  shopUrl: "https://shop.example.com",
  consumerKey: "ck_abc",
  consumerSecret: "cs_def",
  permissions: "read_write",
  revision: "grant_1",
  connectedAt: new Date("2026-09-14T12:00:00.000Z"),
});

const anOrder = (overrides: Partial<Order> = {}): Order => ({
  id: "ord_1",
  merchant_item_id: merchantItemIdFor("https://shop.example.com", "11"),
  params: {},
  price: {
    amount: "25.00",
    currency: "USD",
    at: "2026-09-14T12:00:00.000Z",
    as_of: "2026-09-14T12:00:00.000Z",
  },
  price_id: "prc_1",
  test: true,
  ...overrides,
});

const aShopThatAccepts = () => {
  const placed: SoldItem[] = [];
  let next = 12;
  return {
    placed,
    place: async (_keys: ShopKeys, sold: SoldItem): Promise<OrderMade> => {
      placed.push(sold);
      next += 1;
      return {
        ok: true,
        id: String(next),
        number: String(next),
        orderKey: `wc_order_${next}`,
        downloadId: sold.download.id,
      };
    },
  };
};

/**
 * A shop's Store API cart, answering the place with a cart that holds
 * `quantity` of product 28 and charges 5.00 to ship it, as a shop does whose
 * plugin raised a minimum quantity, and carrying `errors` as a shop's
 * restriction plugin raises them.
 */
const aCartHoldingTheTote =
  (quantity: number, errors: readonly unknown[] = []): WooRequest =>
  async (url, init) => {
    const asked = new URL(url).pathname;
    if ((init?.method ?? "GET") === "GET") {
      return Response.json(
        { items: [], needs_shipping: false, shipping_rates: [] },
        { headers: { "Cart-Token": "cart-token-1" } },
      );
    }
    return Response.json(
      {
        items: [{ key: "line-28", id: 28, quantity }],
        errors,
        needs_shipping: true,
        shipping_rates: [
          {
            package_id: 0,
            items: [{ key: "line-28", name: "Canvas tote bag", quantity }],
            shipping_rates: [
              {
                rate_id: "flat_rate:3",
                name: "Standard",
                method_id: "flat_rate",
                instance_id: 3,
                price: "500",
                taxes: "0",
                currency_code: "USD",
                currency_minor_unit: 2,
              },
            ],
          },
        ],
      },
      { status: asked.endsWith("/add-item") ? 201 : 200 },
    );
  };

/** What a shop's plugin that will not ship the line to the place raises on the cart. */
const A_CART_ERROR = {
  code: "woocommerce_rest_cart_item_error",
  message: "This product cannot be shipped to your country.",
};

/** The shop's answers to a product check that cannot be read or trusted. */
const UNREADABLE: readonly (readonly [string, WooRequest])[] = [
  [
    "a revoked key",
    async () =>
      Response.json(
        { code: "woocommerce_rest_cannot_view", message: "Sorry, you cannot view this resource." },
        { status: 401 },
      ),
  ],
  ["a page that is not JSON", async () => new Response("not-json", { status: 200 })],
  ["an incomplete document", async () => Response.json({ id: 28, type: "simple" })],
];

const filling = (
  shops: WooShops,
  place: (keys: ShopKeys, sold: SoldItem) => Promise<OrderMade>,
) => ({
  shops,
  now: () => new Date("2026-09-14T12:00:00.000Z"),
  placeOrder: place,
  inspectProduct: async (_connection: WooConnection, merchantItemId: string) =>
    showing({
      kind: "download",
      productId: merchantItemId.split("_").at(-1) ?? "",
      downloadId: "dl_guide",
      fileName: "Guide",
      price: { amount: "25.00", currency: "USD" },
      fingerprint: "accepted-download-fingerprint",
    }),
  quotedProduct: async () => "accepted-download-fingerprint",
});

describe("one paid order, in the merchant's own shop", () => {
  it("places it, and hands the buyer the number the shop gave it", async () => {
    const shops = memoryWooShops();
    const shop = aShopThatAccepts();

    const answer = await fillFromTheShop(
      anOrder(),
      connection(),
      MERCHANT_EMAIL,
      filling(shops, shop.place),
      NO_SPLIT,
    );

    expect(answer).toMatchObject({
      delivered: { file_name: "Guide", order_number: "13" },
    });
    expect(shop.placed).toEqual([
      {
        orderId: "ord_1",
        productId: "11",
        email: MERCHANT_EMAIL,
        price: { amount: "25.00", currency: "USD" },
        download: { id: "dl_guide", name: "Guide" },
        paidInto: NO_SPLIT,
      },
    ]);
  });

  it("refuses an order whose price is not the shop's price, and places nothing", async () => {
    // The download can be the bound one and the money still wrong: a sale
    // charged at a price the shop no longer asks is not put in somebody's shop
    // on their behalf.
    const shops = memoryWooShops();
    const shop = aShopThatAccepts();

    const answer = await fillFromTheShop(
      anOrder({ price: { ...anOrder().price, amount: "30.00" } }),
      connection(),
      MERCHANT_EMAIL,
      filling(shops, shop.place),
      NO_SPLIT,
    );

    expect(answer).toMatchObject({ refused: { code: "cannot_fulfill" } });
    expect(shop.placed).toHaveLength(0);
    expect((await shops.knownOrder("ord_1"))?.kind).toBe("precreate_refused");
  });

  it("does not tell the buyer the shop was silent when its answer to the product check broke off", async () => {
    // The shop answered and its answer could not be read: the order is still
    // refused, in words true of that.
    const shops = memoryWooShops();
    const shop = aShopThatAccepts();
    const cutOff = async () =>
      new Response(
        new ReadableStream({ start: (controller) => controller.error(new Error("cut off")) }),
        { status: 200 },
      );

    const answer = await fillFromTheShop(
      anOrder(),
      connection(),
      MERCHANT_EMAIL,
      {
        ...filling(shops, shop.place),
        inspectProduct: (asked, merchantItemId) =>
          inspectProductInTheShop(asked, merchantItemId, cutOff),
      },
      NO_SPLIT,
    );

    expect(answer).toMatchObject({ refused: { code: "cannot_fulfill" } });
    expect(JSON.stringify(answer)).not.toMatch(/did not answer/i);
    expect(shop.placed).toHaveLength(0);
    expect((await shops.knownOrder("ord_1"))?.kind).toBe("precreate_refused");
  });

  it("refuses an order the shop said nothing about, and says the shop did not answer", async () => {
    // The refusal's words reach the buyer's agent. A shop that timed out has
    // said nothing about the product, so the reason is that the shop did not
    // answer. The refusal is recorded like any other, so recovery can still
    // finish the sale.
    const shops = memoryWooShops();
    const shop = aShopThatAccepts();

    const answer = await fillFromTheShop(
      anOrder(),
      connection(),
      MERCHANT_EMAIL,
      {
        ...filling(shops, shop.place),
        inspectProduct: async () => ({
          ok: false,
          why: "The shop did not answer the protected product check.",
          again: true,
        }),
      },
      NO_SPLIT,
    );

    expect(answer).toMatchObject({
      refused: { code: "cannot_fulfill", message: expect.stringMatching(/did not answer/) },
    });
    expect(JSON.stringify(answer)).not.toMatch(/no longer/);
    expect(shop.placed).toHaveLength(0);
    expect((await shops.knownOrder("ord_1"))?.kind).toBe("precreate_refused");
  });

  it("refuses an order whose product check could not be read in none of the words that say the product changed or the shop was silent", async () => {
    // The shop answered, so it was not silent, and what it answered says
    // nothing about the product, so no reason that says the product changed
    // is true of it.
    const refusalWith = async (overrides: Partial<Filling>): Promise<string | undefined> => {
      const answer = await fillFromTheShop(
        anOrder(),
        connection(),
        MERCHANT_EMAIL,
        { ...filling(memoryWooShops(), aShopThatAccepts().place), ...overrides },
        NO_SPLIT,
      );
      return (answer as { refused?: { message?: string } } | null)?.refused?.message;
    };
    const download = {
      kind: "download" as const,
      productId: "11",
      downloadId: "dl_guide",
      fileName: "Guide",
      price: { amount: "25.00", currency: "USD" },
      fingerprint: "accepted-download-fingerprint",
    };
    const untrue = new Set(
      await Promise.all(
        [
          { inspectProduct: async () => RULED_OUT },
          {
            inspectProduct: async () =>
              showing({ kind: "parcel", productId: "11", price: download.price, fingerprint: "p" }),
          },
          {
            inspectProduct: async () =>
              showing({ ...download, price: { amount: "30.00", currency: "USD" } }),
          },
          { quotedProduct: async () => "an-earlier-download" },
          {
            inspectProduct: async (): Promise<ProductInspection> => ({
              ok: false,
              why: "The shop did not answer the protected product check.",
              again: true,
            }),
          },
        ].map(refusalWith),
      ),
    );
    expect(untrue.has(undefined)).toBe(false);

    for (const [what, answering] of UNREADABLE) {
      const shops = memoryWooShops();
      const shop = aShopThatAccepts();

      const answer = await fillFromTheShop(
        anOrder(),
        connection(),
        MERCHANT_EMAIL,
        {
          ...filling(shops, shop.place),
          inspectProduct: (asked, merchantItemId) =>
            inspectProductInTheShop(asked, merchantItemId, answering),
        },
        NO_SPLIT,
      );

      expect(answer, what).toMatchObject({ refused: { code: "cannot_fulfill" } });
      const message = (answer as { refused?: { message?: string } } | null)?.refused?.message;
      expect(untrue, what).not.toContain(message);
      expect(shop.placed, what).toHaveLength(0);
      expect((await shops.knownOrder("ord_1"))?.kind, what).toBe("precreate_refused");
    }
  });

  it("refuses an order the shop ruled out, and does not say the shop was silent", async () => {
    const shops = memoryWooShops();
    const shop = aShopThatAccepts();

    const answer = await fillFromTheShop(
      anOrder(),
      connection(),
      MERCHANT_EMAIL,
      {
        ...filling(shops, shop.place),
        inspectProduct: async () => RULED_OUT,
      },
      NO_SPLIT,
    );

    expect(answer).toMatchObject({ refused: { code: "cannot_fulfill" } });
    expect(JSON.stringify(answer)).not.toMatch(/did not answer/);
    // The shop's own no is told as the product having changed, not as an
    // answer nobody could read.
    expect(JSON.stringify(answer)).toMatch(/no longer/);
    expect(shop.placed).toHaveLength(0);
  });

  it("places one order for a sale handed over twice", async () => {
    // Delivery is at least once: a second hand-over must not become a second
    // parcel the merchant packs.
    const shops = memoryWooShops();
    const shop = aShopThatAccepts();
    const parts = filling(shops, shop.place);

    const first = await fillFromTheShop(anOrder(), connection(), MERCHANT_EMAIL, parts, NO_SPLIT);
    const again = await fillFromTheShop(anOrder(), connection(), MERCHANT_EMAIL, parts, NO_SPLIT);

    expect(shop.placed).toHaveLength(1);
    expect(again).toEqual(first);
  });

  it("does not deliver a Woo result that the durable ledger did not bind", async () => {
    const durable = memoryWooShops();
    const shop = aShopThatAccepts();
    const shops: WooShops = {
      ...durable,
      recordOrder: async () => false,
    };

    const answer = await fillFromTheShop(
      anOrder(),
      connection(),
      MERCHANT_EMAIL,
      filling(shops, shop.place),
      NO_SPLIT,
    );

    expect(answer).toBeNull();
    expect((await durable.knownOrder("ord_1"))?.kind).toBe("unknown");
    expect(shop.placed).toHaveLength(1);
  });

  it("refuses the sale when the shop says no, without quoting the shop to the buyer", async () => {
    // A WordPress refusal can carry a file path on a shop with debugging on,
    // and the reader here is a stranger's agent that could only forward it.
    const shops = memoryWooShops();
    const answer = await fillFromTheShop(
      anOrder(),
      connection(),
      MERCHANT_EMAIL,
      filling(shops, async () => ({
        ok: false,
        why: "The shop answered 400: Fatal error in /var/www/html/wp-content/plugins/x.php",
        again: false,
      })),
      NO_SPLIT,
    );

    expect(answer).not.toBeNull();
    const said = answer && "refused" in answer ? answer.refused.message : "";
    expect(said).toMatch(/\S/);
    expect(said).not.toContain("/var/www");
    expect(said).not.toContain("Fatal error");
  });

  it("keeps a post-call refusal unknown and never posts it again", async () => {
    const shops = memoryWooShops();
    let placements = 0;
    const refuse = async () => {
      placements += 1;
      return { ok: false as const, why: "gone", again: false };
    };
    await fillFromTheShop(
      anOrder(),
      connection(),
      MERCHANT_EMAIL,
      filling(shops, refuse),
      NO_SPLIT,
    );
    const again = await fillFromTheShop(
      anOrder(),
      connection(),
      MERCHANT_EMAIL,
      filling(shops, refuse),
      NO_SPLIT,
    );

    expect((await shops.knownOrder("ord_1"))?.kind).toBe("unknown");
    expect(again && "refused" in again).toBe(true);
    expect(placements).toBe(1);
  });

  it("answers nothing at all when the shop did not answer either", async () => {
    // A refusal would close the sale for good; answering nothing lets the
    // gateway hand the order over again.
    const shops = memoryWooShops();
    const answer = await fillFromTheShop(
      anOrder(),
      connection(),
      MERCHANT_EMAIL,
      filling(shops, async () => ({ ok: false, why: "no answer", again: true })),
      NO_SPLIT,
    );
    expect(answer).toBeNull();
  });

  it("will not place a second order for an attempt whose outcome nobody knows", async () => {
    // The process died with a request on its way to the shop. Whether the shop
    // holds an order is not knowable here, and ordering again is the one move
    // certainly wrong.
    const shops = memoryWooShops();
    const shop = aShopThatAccepts();
    const parts = filling(shops, shop.place);

    await fillFromTheShop(
      anOrder(),
      connection(),
      MERCHANT_EMAIL,
      filling(shops, async () => ({ ok: false, why: "the shop did not answer", again: true })),
      NO_SPLIT,
    );
    const again = await fillFromTheShop(anOrder(), connection(), MERCHANT_EMAIL, parts, NO_SPLIT);

    expect(shop.placed).toHaveLength(0);
    expect(again).not.toBeNull();
    // Not "there is no such order", but "an order may be there and nothing here
    // can tell".
    expect(again && "refused" in again && again.refused.message).toMatch(/ord_1/);
  });

  it("refuses a connection whose keys cannot write", async () => {
    // The second guard after a quote-time refusal: a stale paid envelope must
    // not make an order on read-only credentials.
    const shops = memoryWooShops();
    const shop = aShopThatAccepts();
    const answer = await fillFromTheShop(
      anOrder(),
      { ...connection(), permissions: "read" },
      MERCHANT_EMAIL,
      filling(shops, shop.place),
      NO_SPLIT,
    );
    expect(shop.placed).toHaveLength(0);
    expect(answer && "refused" in answer).toBe(true);
  });

  it("does not deliver a different download than the one accepted at quote time", async () => {
    const shops = memoryWooShops();
    const shop = aShopThatAccepts();
    const answer = await fillFromTheShop(
      anOrder({ price_id: "prc_1" }),
      connection(),
      MERCHANT_EMAIL,
      {
        ...filling(shops, shop.place),
        quotedProduct: async () => "quoted-download-fingerprint",
        inspectProduct: async () =>
          showing({
            kind: "download",
            productId: "11",
            downloadId: "dl_replaced",
            fileName: "Replacement",
            fingerprint: "replacement-download-fingerprint",
            price: { amount: "25.00", currency: "USD" },
          }),
      },
      NO_SPLIT,
    );

    expect(answer && "refused" in answer).toBe(true);
    expect(shop.placed).toHaveLength(0);
    expect((await shops.recoveryOrder("ord_1"))?.facts.productFingerprint).toBe(
      "quoted-download-fingerprint",
    );
  });

  it("does not reopen a definite pre-create refusal on worker redelivery", async () => {
    const shops = memoryWooShops();
    const shop = aShopThatAccepts();
    let supported = false;
    const parts = {
      ...filling(shops, shop.place),
      inspectProduct: async () =>
        supported
          ? showing({
              kind: "download",
              productId: "11",
              downloadId: "dl_guide",
              fileName: "Guide",
              fingerprint: "accepted-download-fingerprint",
              price: { amount: "25.00", currency: "USD" },
            })
          : RULED_OUT,
    };

    const refused = await fillFromTheShop(anOrder(), connection(), MERCHANT_EMAIL, parts, NO_SPLIT);
    supported = true;
    const redelivered = await fillFromTheShop(
      anOrder(),
      { ...connection(), consumerKey: "ck_reconnected" },
      MERCHANT_EMAIL,
      parts,
      NO_SPLIT,
    );

    expect(refused && "refused" in refused).toBe(true);
    expect(redelivered && "refused" in redelivered).toBe(true);
    expect(shop.placed).toHaveLength(0);
  });
});

describe("the whole way through, against a real gateway", () => {
  let open: Harness | null = null;
  let served: Served | null = null;
  let shopServer: Server | null = null;

  afterEach(async () => {
    await served?.close();
    await open?.stop();
    await new Promise<void>((resolve) => {
      if (shopServer === null) {
        resolve();
        return;
      }
      shopServer.close(() => resolve());
    });
    open = null;
    served = null;
    shopServer = null;
  });

  const aShopOnAPort = async (
    emptySuccessfulBody = false,
  ): Promise<{ url: string; orders: Record<string, unknown>[] }> => {
    const orders: Record<string, unknown>[] = [];
    shopServer = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const sent = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        orders.push(sent);
        response.writeHead(201, { "content-type": "application/json" });
        response.end(
          emptySuccessfulBody
            ? ""
            : JSON.stringify({
                id: 13,
                number: "13",
                order_key: "wc_order_13",
                status: "processing",
                currency: "USD",
                total: "25.00",
                total_tax: "0.00",
                payment_method: sent.payment_method,
                transaction_id: sent.transaction_id,
                billing: sent.billing,
                meta_data: sent.meta_data,
                line_items: [
                  {
                    product_id: 11,
                    quantity: 1,
                    subtotal: "25.00",
                    total: "25.00",
                    total_tax: "0.00",
                  },
                ],
              }),
        );
      });
    });
    shopServer.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => shopServer?.once("listening", resolve));
    const { port } = shopServer.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, orders };
  };

  it("sells an imported product and leaves a paid order in the shop", async () => {
    open = await harness();
    served = await serve(open);
    const shop = await aShopOnAPort();
    const gateway = gatewayFor(open.gateway, {
      merchantId: open.merchant.id,
      email: MERCHANT_EMAIL,
    });
    // What pressing Connect does before the merchant is sent to their shop.
    expect((await gateway.sellThrough("woocommerce")).ok).toBe(true);

    // Published through the same path as every other card, with no leniency of
    // its own.
    const { cards } = cardsFromTheShop([aProduct()], shop.url);
    const card = cards[0];
    expect(card).toBeDefined();
    const published = await gateway.publishCard(card?.card ?? ({} as never));
    expect(published.ok).toBe(true);
    const itemId = published.ok && published.document.ok ? published.document.id : "";
    expect(itemId).not.toBe("");

    const shops = memoryWooShops();
    const parts = {
      shops,
      now: () => new Date("2026-09-14T12:00:00.000Z"),
      placeOrder: (
        keys: Parameters<typeof createTheOrderInTheShop>[0],
        sold: Parameters<typeof createTheOrderInTheShop>[1],
      ) => createTheOrderInTheShop(keys, sold, fetch),
      inspectProduct: async () =>
        showing({
          kind: "download",
          productId: "11",
          downloadId: "dl_guide",
          fileName: "Guide",
          price: { amount: "25.00", currency: "USD" },
          fingerprint: "accepted-download-fingerprint",
        }),
      quotedProduct: async () => "accepted-download-fingerprint",
    };
    const connected: WooConnection = { ...connection(), shopUrl: shop.url };

    const bought = await buyOverHttp(open, served, itemId, {
      through: "woocommerce",
      onOrder: async (order) => {
        const answer = await fillFromTheShop(order, connected, MERCHANT_EMAIL, parts, NO_SPLIT);
        if (answer === null) {
          throw new Error("the shop was not asked");
        }
        return answer;
      },
      onQuote: async () => ({
        available: true,
        price: { amount: "25.00", currency: "USD" },
        as_of: "2026-09-14T12:00:00.000Z",
      }),
    });

    // The buyer holds the number of an order in a shop they have never heard
    // of.
    expect(bought.status).toBe(200);
    const started = bought.body as AgentOrderStatus;
    const read = await served.call("GET", `/x402/orders/${started.order_id}/status`);
    const status = read.body as AgentOrderStatus;
    expect(status.status).toBe("delivered");
    expect(status.delivered).toMatchObject({ file_name: "Guide", order_number: "13" });
    const durable = await shops.knownOrder(status.order_id);
    expect(JSON.stringify(durable)).not.toContain("download_url");
    expect(JSON.stringify(durable)).not.toContain(MERCHANT_EMAIL);

    // One paid order in the shop, carrying our identifier so the two systems
    // can be reconciled by hand.
    expect(shop.orders).toHaveLength(1);
    const placed = shop.orders[0] as {
      set_paid: boolean;
      transaction_id: string;
      line_items: { product_id: number; total: string }[];
    };
    expect(placed.set_paid).toBe(true);
    expect(placed.transaction_id).toBe(status.order_id);
    expect(placed.line_items[0]?.product_id).toBe(11);
    expect(placed.line_items[0]?.total).toBe("25.00");
  });

  it("names on the shop's order the payout contract the payment went to, though the merchant moved their wallet since", async () => {
    // The line records where this payment went; after a change of wallet the
    // contract in force is another one.
    open = await harness();
    served = await serve(open);
    const shop = await aShopOnAPort();
    const gateway = gatewayFor(open.gateway, {
      merchantId: open.merchant.id,
      email: MERCHANT_EMAIL,
    });
    expect((await gateway.sellThrough("woocommerce")).ok).toBe(true);
    const { cards } = cardsFromTheShop([aProduct()], shop.url);
    const published = await gateway.publishCard(cards[0]?.card ?? ({} as never));
    const itemId = published.ok && published.document.ok ? published.document.id : "";
    const paidInto = (await open.gateway.payoutSplitsOf(open.merchant.id)).inForce;
    const parts = {
      shops: memoryWooShops(),
      now: () => new Date("2026-09-14T12:00:00.000Z"),
      placeOrder: (
        keys: Parameters<typeof createTheOrderInTheShop>[0],
        sold: Parameters<typeof createTheOrderInTheShop>[1],
      ) => createTheOrderInTheShop(keys, sold, fetch),
      inspectProduct: async () =>
        showing({
          kind: "download",
          productId: "11",
          downloadId: "dl_guide",
          fileName: "Guide",
          price: { amount: "25.00", currency: "USD" },
          fingerprint: "accepted-download-fingerprint",
        }),
      quotedProduct: async () => "accepted-download-fingerprint",
    };
    const connected: WooConnection = { ...connection(), shopUrl: shop.url };

    await buyOverHttp(open, served, itemId, {
      through: "woocommerce",
      onOrder: async (order) => {
        // Paid, and the merchant saves another wallet before the shop is asked.
        expect(
          (await gateway.setPayoutWallet("0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359")).ok,
        ).toBe(true);
        const answer = await filledAsPaid(gateway, order, connected, MERCHANT_EMAIL, parts);
        if (answer === null) throw new Error("the shop was not asked");
        return answer;
      },
      onQuote: async () => ({
        available: true,
        price: { amount: "25.00", currency: "USD" },
        as_of: "2026-09-14T12:00:00.000Z",
      }),
    });

    const now = (await open.gateway.payoutSplitsOf(open.merchant.id)).inForce;
    expect(now?.address).not.toBe(paidInto?.address);
    const placed = shop.orders[0] as { meta_data: { key: string; value: unknown }[] };
    expect(placed.meta_data).toContainEqual({
      key: "agentify_payout_contract",
      value: paidInto?.address,
    });
    expect(JSON.stringify(placed.meta_data)).not.toContain(now?.address ?? "no split");
  });

  it("asks the shop for nothing where it cannot read where the payment went", async () => {
    // A shop order made without the line would claim no commission was taken.
    const shop = aShopThatAccepts();
    const unread = {
      paidInto: async () => ({ ok: false as const, status: 0, why: "nothing answered" }),
    };

    let answer: unknown;
    const written = await loggedWhile(async () => {
      answer = await filledAsPaid(
        unread,
        anOrder(),
        connection(),
        MERCHANT_EMAIL,
        filling(memoryWooShops(), shop.place),
      );
    });

    expect(answer).toBeNull();
    expect(shop.placed).toStrictEqual([]);
    // The merchant's log says which order waits, and why.
    expect(written).toMatch(/ord_1.*could not be read.*nothing answered/);
  });

  it("keeps a committed order unknown when its successful response body is lost", async () => {
    const shop = await aShopOnAPort(true);
    const shops = memoryWooShops();
    const connected: WooConnection = { ...connection(), shopUrl: shop.url };
    const parts = {
      shops,
      now: () => new Date("2026-09-14T12:00:00.000Z"),
      placeOrder: (
        keys: Parameters<typeof createTheOrderInTheShop>[0],
        sold: Parameters<typeof createTheOrderInTheShop>[1],
      ) => createTheOrderInTheShop(keys, sold, fetch),
      inspectProduct: async () =>
        showing({
          kind: "download",
          productId: "11",
          downloadId: "dl_guide",
          fileName: "Guide",
          price: { amount: "25.00", currency: "USD" },
          fingerprint: "accepted-download-fingerprint",
        }),
      quotedProduct: async () => "accepted-download-fingerprint",
    };

    const first = await fillFromTheShop(anOrder(), connected, MERCHANT_EMAIL, parts, NO_SPLIT);
    const durable = await shops.knownOrder("ord_1");
    const redelivery = await fillFromTheShop(anOrder(), connected, MERCHANT_EMAIL, parts, NO_SPLIT);

    expect(first).toBeNull();
    expect(durable?.kind).toBe("unknown");
    expect(shop.orders).toHaveLength(1);
    expect(redelivery && "refused" in redelivery).toBe(true);
  });

  it("draws the stream of the merchant the connected account names, and nobody else's", async () => {
    // The worker draws that merchant's stream only; another merchant's envelope
    // stays for that merchant's own worker.
    open = await harness();
    const other = await open.addMerchant();
    const anEvent = (id: string) => ({
      kind: "order_event" as const,
      id,
      sent_at: "2026-09-14T12:00:00.000Z",
      payload: {
        type: "order.unfulfilled" as const,
        order_id: "ord_7c1e05",
        at: "2026-09-14T12:00:00.000Z",
        price: { amount: "25.00", currency: "USD" },
        reason: "deadline_passed" as const,
      },
    });
    await open.queue.publish(open.merchant.id, anEvent("msg_ours"));
    await open.queue.publish(other.id, anEvent("msg_theirs"));
    const application = open.gateway;
    await application.sellThrough(open.merchant.id, "woocommerce");

    const turned = await turnOnce(connection(), {
      shops: memoryWooShops(),
      identity: {
        byId: async () => ({
          id: "p",
          email: MERCHANT_EMAIL,
          confirmed: true,
          merchant: { id: open?.merchant.id ?? "" },
        }),
      },
      clientFor: (acting) => gatewayFor(application, acting),
      now: () => new Date("2026-09-14T12:00:00.000Z"),
      waitSeconds: 1,
    });

    expect(turned).toBe(1);
    const left = await application.poll(other.id, 100);
    expect(left.envelopes.map((envelope) => envelope.id)).toStrictEqual(["msg_theirs"]);
  });

  it("counts an event it drew, so the loop comes straight back for what follows", async () => {
    // One envelope per poll, so an event is often all a turn draws; counted as
    // nothing, it would rest the loop with orders waiting behind it.
    const gateway = {
      pollWorker: async () => ({
        ok: true as const,
        document: {
          envelopes: [
            {
              kind: "order_event" as const,
              id: "msg_1f77a0",
              sent_at: "2026-09-14T12:00:00.000Z",
              payload: {
                type: "order.unfulfilled" as const,
                order_id: "ord_7c1e05",
                at: "2026-09-14T12:00:00.000Z",
                price: { amount: "25.00", currency: "USD" },
                reason: "deadline_passed" as const,
              },
            },
          ],
        },
      }),
    } as never;
    const turned = await turnOnce(connection(), {
      shops: memoryWooShops(),
      identity: {
        byId: async () => ({
          id: "p",
          email: MERCHANT_EMAIL,
          confirmed: true,
          merchant: { id: open?.merchant.id ?? "" },
        }),
      },
      clientFor: () => gateway,
      now: () => new Date("2026-09-14T12:00:00.000Z"),
      waitSeconds: 1,
    });
    expect(turned).toBe(1);
  });

  it("refuses a fresh quote before payment when the shop did not grant write access", async () => {
    let answer: unknown;
    const gateway = {
      pollWorker: async () => ({
        ok: true as const,
        document: {
          envelopes: [
            {
              id: "env_quote",
              kind: "quote_request" as const,
              sent_at: "2026-09-14T12:00:00.000Z",
              payload: {
                merchant_item_id: merchantItemIdFor("https://shop.example.com", "11"),
                price_id: "prc_1",
                purpose: "purchase" as const,
                expires_at: "2026-09-14T12:01:00.000Z",
              },
            },
          ],
        },
      }),
      answerQuote: async (_id: string, said: unknown) => {
        answer = said;
        return { ok: true as const, document: { used: true } };
      },
      answerOrder: async () => {
        throw new Error("no paid order may be drawn for a refused quote");
      },
    } as never;

    await turnOnce(
      { ...connection(), permissions: "read" },
      {
        shops: memoryWooShops(),
        identity: {
          byId: async () => ({
            id: "p",
            email: MERCHANT_EMAIL,
            confirmed: true,
            merchant: { id: "mer_1" },
          }),
        },
        clientFor: () => gateway,
        now: () => new Date("2026-09-14T12:00:00.000Z"),
        inspectProduct: async () => {
          throw new Error("a connection that cannot write must be refused before the shop is read");
        },
      },
    );

    expect(answer).toMatchObject({ available: false });
  });
});

describe("a price question off the merchant's stream", () => {
  // Everything is the deployed code except the shop's answer, a recording
  // gateway, and the in-memory store held to the same contract as the Postgres
  // one.
  const question = {
    merchant_item_id: merchantItemIdFor("https://shop.example.com", "11"),
    price_id: "prc_1",
    purpose: "purchase" as const,
    expires_at: "2026-09-14T12:01:00.000Z",
  };
  const NOW = "2026-09-14T12:00:00.000Z";
  const inTheShop = {
    kind: "download" as const,
    productId: "11",
    downloadId: "dl_guide",
    fileName: "Guide",
    price: { amount: "25.00", currency: "USD" },
    fingerprint: "accepted-download-fingerprint",
  };

  const shopShowing =
    (product: typeof inTheShop | null) =>
    async (asked: WooConnection, merchantItemId: string): Promise<ProductInspection> =>
      asked.accountId === "acc_1" &&
      merchantItemId === question.merchant_item_id &&
      product !== null
        ? showing(product)
        : RULED_OUT;

  const answering = async (
    shops: WooShops,
    product: typeof inTheShop | null,
    inspectProduct = shopShowing(product),
  ): Promise<unknown> => {
    // Stays null when the worker says nothing.
    let answer: unknown = null;
    const gateway = {
      pollWorker: async () => ({
        ok: true as const,
        document: {
          envelopes: [
            { id: "env_quote", kind: "quote_request" as const, sent_at: NOW, payload: question },
          ],
        },
      }),
      answerQuote: async (priceId: string, said: unknown) => {
        // The gateway files a price answer only under the price it named.
        answer = priceId === question.price_id ? said : `answered under ${priceId}`;
        return { ok: true as const, document: { used: true } };
      },
      answerOrder: async () => {
        throw new Error("no order was drawn, so none is answered");
      },
    } as never;
    await turnOnce(connection(), {
      shops,
      identity: {
        byId: async () => ({
          id: "p",
          email: MERCHANT_EMAIL,
          confirmed: true,
          merchant: { id: "mer_1" },
        }),
      },
      clientFor: () => gateway,
      now: () => new Date(NOW),
      inspectProduct,
    });
    return answer;
  };

  it("answers with the shop's own price and binds the price to the product it read", async () => {
    // An order paying this price is filled only against the download the agent
    // was offered.
    const shops = memoryWooShops();

    expect(await answering(shops, inTheShop)).toStrictEqual({
      available: true,
      price: { amount: "25.00", currency: "USD" },
      as_of: NOW,
    });
    expect(await shops.quotedProduct("acc_1", "prc_1", question.merchant_item_id)).toBe(
      "accepted-download-fingerprint",
    );
  });

  it("names no price when the shop does not show the product as one download", async () => {
    const shops = memoryWooShops();

    expect(await answering(shops, null)).toStrictEqual({ available: false, as_of: NOW });
    expect(await shops.quotedProduct("acc_1", "prc_1", question.merchant_item_id)).toBeNull();
  });

  for (const { title, atTheOrder, delivered } of [
    {
      title: "fills the order that pays a price against the download the price was bound to",
      atTheOrder: inTheShop,
      delivered: true,
    },
    {
      title: "refuses the order that pays a price when the download changed after it was quoted",
      atTheOrder: { ...inTheShop, fingerprint: "a-different-download" },
      delivered: false,
    },
  ]) {
    it(title, async () => {
      // One store, two turns: what the fill holds the order to is what the
      // quote wrote.
      const shops = memoryWooShops();
      const shop = aShopThatAccepts();
      const turns = [
        { id: "env_quote", kind: "quote_request" as const, sent_at: NOW, payload: question },
        {
          id: "env_order",
          kind: "order" as const,
          sent_at: NOW,
          payload: anOrder({ price_id: "prc_1" }),
        },
      ];
      let answered: unknown;
      const gateway = {
        pollWorker: async () => ({
          ok: true as const,
          document: { envelopes: [turns.shift()].filter((envelope) => envelope !== undefined) },
        }),
        answerQuote: async () => ({ ok: true as const, document: { used: true } }),
        paidInto: async () => ({ ok: true as const, document: NO_SPLIT }),
        answerOrder: async (_orderId: string, answer: unknown) => {
          answered = answer;
          return {
            ok: true as const,
            document: { ok: true as const, result: "delivered" as const },
          };
        },
      } as never;
      let product: typeof inTheShop = inTheShop;
      const parts = {
        shops,
        identity: {
          byId: async () => ({
            id: "p",
            email: MERCHANT_EMAIL,
            confirmed: true,
            merchant: { id: "mer_1" },
          }),
        },
        clientFor: () => gateway,
        now: () => new Date(NOW),
        placeOrder: shop.place,
        inspectProduct: async (asked: WooConnection, merchantItemId: string) =>
          shopShowing(product)(asked, merchantItemId),
      };

      await turnOnce(connection(), parts);
      product = atTheOrder;
      await turnOnce(connection(), parts);

      if (delivered) {
        expect(answered).toMatchObject({ delivered: { file_name: "Guide" } });
        expect(shop.placed).toHaveLength(1);
      } else {
        expect(answered).toMatchObject({ refused: { code: "cannot_fulfill" } });
        expect(shop.placed).toHaveLength(0);
      }
    });
  }

  it("says nothing when the shop's answer about the product could not be read", async () => {
    // A revoked key or a page in front of the shop said nothing about the
    // product, so the agent is told the price check went unanswered, not that
    // the seller said it is not available.
    for (const [what, answer] of [
      [
        "a revoked key",
        () =>
          Response.json(
            {
              code: "woocommerce_rest_cannot_view",
              message: "Sorry, you cannot view this resource.",
            },
            { status: 401 },
          ),
      ],
      ["a page that is not JSON", () => new Response("not-json", { status: 200 })],
    ] as const) {
      const shops = memoryWooShops();

      const said = await answering(shops, inTheShop, (asked, merchantItemId) =>
        inspectProductInTheShop(asked, merchantItemId, async () => answer()),
      );

      expect(said, what).toBeNull();
      expect(await shops.quotedProduct("acc_1", "prc_1", question.merchant_item_id)).toBeNull();
    }
  });

  it("names no price when that price was already bound to another product", async () => {
    // The order comes back held to the first answer, so a price for a changed
    // download is a price no order could be filled against.
    const shops = memoryWooShops();
    await shops.recordQuote(
      "acc_1",
      "prc_1",
      question.merchant_item_id,
      "an-earlier-download",
      new Date(question.expires_at),
      new Date(NOW),
    );

    expect(await answering(shops, inTheShop)).toStrictEqual({ available: false, as_of: NOW });
    expect(await shops.quotedProduct("acc_1", "prc_1", question.merchant_item_id)).toBe(
      "an-earlier-download",
    );
  });
});

describe("a parcel's price question", () => {
  // Goods plus the shop's rate to the buyer's place, asked of the cart for the
  // locality and nothing about who.
  const place = { country: "ID", state: "JK", city: "Jakarta", postal_code: "10110" };
  const question = {
    merchant_item_id: merchantItemIdFor("https://shop.example.com", "28"),
    price_id: "prc_parcel",
    purpose: "purchase" as const,
    expires_at: "2026-09-14T12:01:00.000Z",
    ship_to: place,
  };
  const NOW = "2026-09-14T12:00:00.000Z";
  const theTote: ProductInspection = {
    ok: true,
    product: {
      kind: "parcel",
      productId: "28",
      price: { amount: "20.00", currency: "USD" },
      fingerprint: "accepted-parcel-fingerprint",
    },
  };
  const rate = (title: string, cost: string, instanceId = "3") => ({
    methodId: "flat_rate",
    instanceId,
    title,
    cost,
  });

  const answering = async (
    shops: WooShops,
    rates: (place: unknown) => Promise<RatesRead>,
    asked: Record<string, unknown> = question,
    quoteWithinMs?: number,
  ): Promise<unknown> => {
    // Stays null when the worker says nothing.
    let answer: unknown = null;
    const gateway = {
      pollWorker: async () => ({
        ok: true as const,
        document: {
          envelopes: [
            { id: "env_quote", kind: "quote_request" as const, sent_at: NOW, payload: asked },
          ],
        },
      }),
      answerQuote: async (_priceId: string, said: unknown) => {
        answer = said;
        return { ok: true as const, document: { used: true } };
      },
      answerOrder: async () => {
        throw new Error("no order was drawn, so none is answered");
      },
    } as never;
    await turnOnce(connection(), {
      shops,
      identity: {
        byId: async () => ({
          id: "p",
          email: MERCHANT_EMAIL,
          confirmed: true,
          merchant: { id: "mer_1" },
        }),
      },
      clientFor: () => gateway,
      now: () => new Date(NOW),
      inspectProduct: async () => theTote,
      shippingRates: async (_connection, productId, where) =>
        productId === "28"
          ? rates(where)
          : { ok: false, why: "another product", again: false, saidNo: true },
      ...(quoteWithinMs === undefined ? {} : { quoteWithinMs }),
    });
    return answer;
  };

  it("answers the goods and the cheapest rate together, and binds the price to the product", async () => {
    const shops = memoryWooShops();
    let asked: unknown;

    const answer = await answering(shops, async (where) => {
      asked = where;
      return {
        ok: true,
        rates: [
          rate("Express", "12.00", "4"),
          rate("Standard", "5.00"),
          rate("Courier", "5.00", "9"),
        ],
      };
    });

    expect(answer).toStrictEqual({
      available: true,
      price: { amount: "25.00", currency: "USD" },
      as_of: NOW,
    });
    expect(asked).toStrictEqual(place);
    expect(await shops.quotedProduct("acc_1", "prc_parcel", question.merchant_item_id)).toBe(
      "accepted-parcel-fingerprint",
    );
  });

  it("adds the rate to the goods in cents, not in floating point", async () => {
    const shops = memoryWooShops();

    const answer = await answering(shops, async () => ({
      ok: true,
      rates: [rate("Standard", "0.10")],
    }));

    expect(answer).toMatchObject({ available: true, price: { amount: "20.10" } });
  });

  it("names no price where the shop has no rate for the place, or the shop refused it", async () => {
    // "Not available" is all the agent is told; the reason goes to the
    // merchant's log. A shop that could not answer at all is a different case
    // (below).
    for (const read of [
      { ok: true as const, rates: [] },
      { ok: false as const, why: "The shop refused the place.", again: false, saidNo: true },
    ]) {
      const shops = memoryWooShops();

      expect(await answering(shops, async () => read), JSON.stringify(read)).toStrictEqual({
        available: false,
        as_of: NOW,
      });
      expect(
        await shops.quotedProduct("acc_1", "prc_parcel", question.merchant_item_id),
      ).toBeNull();
    }
  });

  it("names no price where the product in the shop is no longer a parcel", async () => {
    // A price of the goods alone would be paid for a parcel the shop now sells
    // as something else.
    const shops = memoryWooShops();
    let answer: unknown;
    const gateway = {
      pollWorker: async () => ({
        ok: true as const,
        document: {
          envelopes: [
            { id: "env_quote", kind: "quote_request" as const, sent_at: NOW, payload: question },
          ],
        },
      }),
      answerQuote: async (_priceId: string, said: unknown) => {
        answer = said;
        return { ok: true as const, document: { used: true } };
      },
    } as never;

    await turnOnce(connection(), {
      shops,
      identity: {
        byId: async () => ({
          id: "p",
          email: MERCHANT_EMAIL,
          confirmed: true,
          merchant: { id: "mer_1" },
        }),
      },
      clientFor: () => gateway,
      now: () => new Date(NOW),
      inspectProduct: async () =>
        showing({
          kind: "download",
          productId: "28",
          downloadId: "dl_guide",
          fileName: "Guide",
          price: { amount: "20.00", currency: "USD" },
          fingerprint: "a-download-now",
        }),
      shippingRates: async () => ({ ok: true, rates: [rate("Standard", "5.00")] }),
    });

    expect(answer).toStrictEqual({ available: false, as_of: NOW });
    expect(await shops.quotedProduct("acc_1", "prc_parcel", question.merchant_item_id)).toBeNull();
  });

  it("names no price for a parcel's question that carries no place", async () => {
    const { ship_to: _left, ...noPlace } = question;
    let asked = false;

    const answer = await answering(
      memoryWooShops(),
      async () => {
        asked = true;
        return { ok: true, rates: [rate("Standard", "5.00")] };
      },
      noPlace,
    );

    expect(answer).toStrictEqual({ available: false, as_of: NOW });
    expect(asked).toBe(false);
  });

  it("says nothing when the shop is slower than the price check allows", async () => {
    // After five seconds the gateway reads the shop as silent. Saying "not
    // available" would send the agent elsewhere; saying nothing tells it the
    // price check went unanswered, which is true. On a WooCommerce card silence
    // refuses the sale rather than selling at the listed price.
    const started = Date.now();

    const answer = await answering(
      memoryWooShops(),
      () => new Promise<RatesRead>(() => undefined),
      question,
      50,
    );

    expect(answer).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("offers no price from a cart that does not hold the one parcel the question is about", async () => {
    const shops = memoryWooShops();
    const fromTheCart = (quantity: number) => (where: unknown) =>
      shippingRatesInTheShop(
        "https://shop.example.com",
        "28",
        where as typeof place,
        aCartHoldingTheTote(quantity),
      );

    expect(await answering(memoryWooShops(), fromTheCart(1))).toMatchObject({
      available: true,
      price: { amount: "25.00" },
    });
    // Not the seller's "not available": the cart said nothing about this parcel.
    expect(await answering(shops, fromTheCart(2))).toBeNull();
    expect(await shops.quotedProduct("acc_1", "prc_parcel", question.merchant_item_id)).toBeNull();
  });

  it("names no price where the shop's own cart refuses the line", async () => {
    // The order is later made through the shop's admin interface, which skips
    // the checks that raised these errors, so the cart's refusal is the last
    // word the shop gets.
    const shops = memoryWooShops();

    const answer = await answering(shops, (where) =>
      shippingRatesInTheShop(
        "https://shop.example.com",
        "28",
        where as typeof place,
        aCartHoldingTheTote(1, [A_CART_ERROR]),
      ),
    );

    expect(answer).toStrictEqual({ available: false, as_of: NOW });
    expect(await shops.quotedProduct("acc_1", "prc_parcel", question.merchant_item_id)).toBeNull();
  });

  it("says nothing when the shop's cart could not answer just now", async () => {
    const answer = await answering(memoryWooShops(), async () => ({
      ok: false,
      why: "The shop's cart was too busy to answer.",
      again: true,
    }));

    expect(answer).toBeNull();
  });
});

describe("a parcel's paid order", () => {
  // The office the discovery listing's example ships to: a real place and
  // nobody's home.
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
  const ADDRESS_WORDS = ["Reception", "Kediri", "Beraban", "Creative City", "Tabanan", "82121"];
  const parcelOrder = (overrides: Partial<Order> = {}): Order =>
    anOrder({
      merchant_item_id: merchantItemIdFor("https://shop.example.com", "28"),
      price: {
        amount: "25.00",
        currency: "USD",
        at: "2026-09-14T12:00:00.000Z",
        as_of: "2026-09-14T12:00:00.000Z",
      },
      price_id: "prc_parcel",
      ship_to: ADDRESS,
      ...overrides,
    });
  const THE_TOTE: ProductInspection = {
    ok: true,
    product: {
      kind: "parcel",
      productId: "28",
      price: { amount: "20.00", currency: "USD" },
      fingerprint: "accepted-parcel-fingerprint",
    },
  };
  const rate = (title: string, cost: string, instanceId: string) => ({
    methodId: "flat_rate",
    instanceId,
    title,
    cost,
  });
  const TODAY: RatesRead = {
    ok: true,
    rates: [rate("Express", "12.00", "4"), rate("Standard", "5.00", "3")],
  };

  const aParcelShop = () => {
    const placed: ParcelSold[] = [];
    return {
      placed,
      place: async (_keys: ShopKeys, sold: ParcelSold): Promise<ParcelMade> => {
        placed.push(sold);
        return { ok: true, id: String(29 + placed.length), number: String(29 + placed.length) };
      },
    };
  };

  const parcelParts = (
    shops: WooShops,
    place: (keys: ShopKeys, sold: ParcelSold) => Promise<ParcelMade>,
    overrides: Partial<Filling> = {},
  ): Filling => ({
    shops,
    now: () => new Date("2026-09-14T12:00:00.000Z"),
    placeParcel: place,
    inspectProduct: async () => THE_TOTE,
    shippingRates: async () => TODAY,
    quotedProduct: async () => "accepted-parcel-fingerprint",
    ...overrides,
  });

  it("places it with the address and the rate it was paid at, and takes it on", async () => {
    const shops = memoryWooShops();
    const shop = aParcelShop();
    let asked: unknown;

    const answer = await fillFromTheShop(
      parcelOrder(),
      connection(),
      MERCHANT_EMAIL,
      parcelParts(shops, shop.place, {
        shippingRates: async (_connection, _productId, where) => {
          asked = where;
          return TODAY;
        },
      }),
      NO_SPLIT,
    );

    expect(answer).toStrictEqual({ accepted: {} });
    // Rates to the place, not the person.
    expect(asked).toStrictEqual({
      country: "ID",
      state: "BA",
      city: "Tabanan",
      postal_code: "82121",
    });
    expect(shop.placed).toHaveLength(1);
    expect(shop.placed[0]).toMatchObject({
      orderId: "ord_1",
      productId: "28",
      email: MERCHANT_EMAIL,
      paid: { amount: "25.00", currency: "USD" },
      goods: "20.00",
      rate: rate("Standard", "5.00", "3"),
      address: ADDRESS,
    });
    expect(await shops.knownOrder("ord_1")).toStrictEqual({
      kind: "placed_parcel",
      id: "30",
      number: "30",
    });
    // Kept as a parcel's sale, which recovery will not try again, with the
    // shop's order and nothing of where it goes.
    const kept = await shops.recoveryOrder("ord_1");
    expect(kept?.facts.kind).toBe("parcel");
    for (const word of ADDRESS_WORDS) expect(JSON.stringify(kept)).not.toContain(word);
  });

  it("chooses the rate the price was paid at, not the cheapest of today", async () => {
    // A cheaper rate added since the quote must not make the paid price look
    // wrong: the rate costing what was paid above the goods is the one sold.
    const shop = aParcelShop();

    const answer = await fillFromTheShop(
      parcelOrder({
        price: {
          amount: "32.00",
          currency: "USD",
          at: "2026-09-14T12:00:00.000Z",
          as_of: "2026-09-14T12:00:00.000Z",
        },
      }),
      connection(),
      MERCHANT_EMAIL,
      parcelParts(memoryWooShops(), shop.place),
      NO_SPLIT,
    );

    expect(answer).toStrictEqual({ accepted: {} });
    expect(shop.placed[0]?.rate).toStrictEqual(rate("Express", "12.00", "4"));
  });

  it("refuses an order whose shipping no longer costs what was paid, and posts nothing", async () => {
    const shops = memoryWooShops();
    const shop = aParcelShop();

    const answer = await fillFromTheShop(
      parcelOrder(),
      connection(),
      MERCHANT_EMAIL,
      parcelParts(shops, shop.place, {
        shippingRates: async () => ({ ok: true, rates: [rate("Standard", "6.00", "3")] }),
      }),
      NO_SPLIT,
    );

    expect(answer).toMatchObject({ refused: { code: "cannot_fulfill" } });
    expect(shop.placed).toHaveLength(0);
    expect(await shops.knownOrder("ord_1")).toStrictEqual({ kind: "precreate_refused" });
  });

  it("refuses an order whose product changed since its price, and posts nothing", async () => {
    for (const changed of [
      { quotedProduct: async () => "an-earlier-parcel" },
      { inspectProduct: async () => RULED_OUT },
      {
        inspectProduct: async (): Promise<ProductInspection> => ({
          ok: true,
          product: {
            kind: "download",
            productId: "28",
            downloadId: "dl",
            fileName: "Tote.pdf",
            price: { amount: "20.00", currency: "USD" },
            fingerprint: "accepted-parcel-fingerprint",
          },
        }),
      },
    ]) {
      const shops = memoryWooShops();
      const shop = aParcelShop();

      const answer = await fillFromTheShop(
        parcelOrder(),
        connection(),
        MERCHANT_EMAIL,
        parcelParts(shops, shop.place, changed),
        NO_SPLIT,
      );

      expect(answer).toMatchObject({ refused: { code: "cannot_fulfill" } });
      expect(shop.placed).toHaveLength(0);
    }
  });

  it("refuses an order whose cart at fulfilment holds other than the one parcel paid for, and posts nothing", async () => {
    // The rate is asked again when the order is filled, so a cart a plugin
    // changed then is caught then, before anything reaches the shop.
    const shops = memoryWooShops();
    const shop = aParcelShop();

    const answer = await fillFromTheShop(
      parcelOrder(),
      connection(),
      MERCHANT_EMAIL,
      parcelParts(shops, shop.place, {
        shippingRates: (keys, productId, where) =>
          shippingRatesInTheShop(keys.shopUrl, productId, where, aCartHoldingTheTote(2)),
      }),
      NO_SPLIT,
    );

    expect(answer).toMatchObject({ refused: { code: "cannot_fulfill" } });
    expect(shop.placed).toHaveLength(0);
    expect(await shops.knownOrder("ord_1")).toStrictEqual({ kind: "precreate_refused" });
  });

  it("refuses a paid parcel in words that say only what the shop's answer showed", async () => {
    const refusalWith = async (overrides: Partial<Filling>): Promise<string | undefined> => {
      const shops = memoryWooShops();
      const shop = aParcelShop();
      const answer = await fillFromTheShop(
        parcelOrder(),
        connection(),
        MERCHANT_EMAIL,
        parcelParts(shops, shop.place, overrides),
        NO_SPLIT,
      );
      // Every case here is refused before the shop is asked for an order.
      expect(shop.placed).toHaveLength(0);
      expect(await shops.knownOrder("ord_1")).toStrictEqual({ kind: "precreate_refused" });
      return (answer as { refused?: { message?: string } } | null)?.refused?.message;
    };
    const fromTheCart = (request: WooRequest): Partial<Filling> => ({
      shippingRates: (keys, productId, where) =>
        shippingRatesInTheShop(keys.shopUrl, productId, where, request),
    });
    // A cart that took its token and refuses the product, as one sold out
    // since the price was asked does.
    const soldOut: WooRequest = async (_url, init) =>
      (init?.method ?? "GET") === "GET"
        ? Response.json(
            { items: [], errors: [], needs_shipping: false, shipping_rates: [] },
            { headers: { "Cart-Token": "cart-token-1" } },
          )
        : Response.json(
            {
              code: "woocommerce_rest_product_out_of_stock",
              message: "You cannot add that amount to the cart.",
              data: { status: 400 },
            },
            { status: 400 },
          );

    // What is said where the product or its shipping did change.
    const changed = new Set<string | undefined>();
    for (const overrides of [
      { inspectProduct: async () => RULED_OUT },
      { quotedProduct: async () => "an-earlier-parcel" },
      {
        inspectProduct: async (): Promise<ProductInspection> =>
          showing({
            kind: "download",
            productId: "28",
            downloadId: "dl",
            fileName: "Tote.pdf",
            price: { amount: "20.00", currency: "USD" },
            fingerprint: "accepted-parcel-fingerprint",
          }),
      },
      {
        shippingRates: async () => ({
          ok: true as const,
          rates: [rate("Standard", "6.00", "3")],
        }),
      },
    ] satisfies Partial<Filling>[]) {
      changed.add(await refusalWith(overrides));
    }
    expect(changed.has(undefined)).toBe(false);

    // Where the answer could not be read, none of those is true.
    const unread = new Set<string | undefined>();
    for (const [what, overrides] of [
      ...UNREADABLE.map(
        ([what, answering]) =>
          [
            what,
            {
              inspectProduct: (asked: WooConnection, merchantItemId: string) =>
                inspectProductInTheShop(asked, merchantItemId, answering),
            },
          ] as const,
      ),
      ["a cart holding two", fromTheCart(aCartHoldingTheTote(2))] as const,
    ]) {
      const message = await refusalWith(overrides);
      expect(message, what).toBeDefined();
      expect(changed, what).not.toContain(message);
      unread.add(message);
    }

    // Where the shop's cart refused the parcel, that is what is said: not
    // that its shipping changed, and not that its answer could not be read.
    for (const [what, overrides] of [
      ["sold out since the price", fromTheCart(soldOut)],
      ["a cart whose errors refuse the line", fromTheCart(aCartHoldingTheTote(1, [A_CART_ERROR]))],
      [
        "the place refused",
        {
          shippingRates: async (): Promise<RatesRead> => ({
            ok: false,
            why: "The shop's cart refused the question (HTTP 400).",
            again: false,
            saidNo: true,
          }),
        },
      ],
    ] as const) {
      const message = await refusalWith(overrides);
      expect(message, what).toBeDefined();
      expect(changed, what).not.toContain(message);
      expect(unread, what).not.toContain(message);
    }
  });

  it("refuses an order whose cart at fulfilment refuses the line, and posts nothing", async () => {
    const shops = memoryWooShops();
    const shop = aParcelShop();

    const answer = await fillFromTheShop(
      parcelOrder(),
      connection(),
      MERCHANT_EMAIL,
      parcelParts(shops, shop.place, {
        shippingRates: (keys, productId, where) =>
          shippingRatesInTheShop(
            keys.shopUrl,
            productId,
            where,
            aCartHoldingTheTote(1, [A_CART_ERROR]),
          ),
      }),
      NO_SPLIT,
    );

    expect(answer).toMatchObject({ refused: { code: "cannot_fulfill" } });
    expect(shop.placed).toHaveLength(0);
    expect(await shops.knownOrder("ord_1")).toStrictEqual({ kind: "precreate_refused" });
  });

  it("answers nothing and writes nothing while the shop does not answer", async () => {
    // A parcel has days to ship, so a shop down for a minute is asked again
    // rather than refused.
    for (const silent of [
      {
        inspectProduct: async (): Promise<ProductInspection> => ({
          ok: false,
          why: "The shop did not answer the protected product check.",
          again: true,
        }),
      },
      {
        shippingRates: async (): Promise<RatesRead> => ({
          ok: false,
          why: "The shop's cart did not answer.",
          again: true,
        }),
      },
    ]) {
      const shops = memoryWooShops();
      const shop = aParcelShop();

      const answer = await fillFromTheShop(
        parcelOrder(),
        connection(),
        MERCHANT_EMAIL,
        parcelParts(shops, shop.place, silent),
        NO_SPLIT,
      );

      expect(answer).toBeNull();
      expect(shop.placed).toHaveLength(0);
      expect(await shops.knownOrder("ord_1")).toBeNull();
    }
  });

  it("takes a parcel handed over twice on again, with one order in the shop", async () => {
    const shops = memoryWooShops();
    const shop = aParcelShop();
    const parts = parcelParts(shops, shop.place);

    await fillFromTheShop(parcelOrder(), connection(), MERCHANT_EMAIL, parts, NO_SPLIT);
    const again = await fillFromTheShop(
      parcelOrder(),
      connection(),
      MERCHANT_EMAIL,
      parts,
      NO_SPLIT,
    );

    expect(again).toStrictEqual({ accepted: {} });
    expect(shop.placed).toHaveLength(1);
  });

  it("refuses a paid parcel order that carries no address to ship to", async () => {
    const shop = aParcelShop();

    const answer = await fillFromTheShop(
      parcelOrder({ ship_to: { erased_at: "2026-09-14T12:00:00.000Z" } }),
      connection(),
      MERCHANT_EMAIL,
      parcelParts(memoryWooShops(), shop.place),
      NO_SPLIT,
    );

    expect(answer).toMatchObject({ refused: { code: "cannot_fulfill" } });
    expect(shop.placed).toHaveLength(0);
  });

  it("writes none of the address into the merchant's log, whatever happens", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...said: unknown[]) => {
      logged.push(
        said
          .map((one) => (one instanceof Error ? one.stack : (JSON.stringify(one) ?? String(one))))
          .join(" "),
      );
    });
    try {
      for (const overrides of [
        { shippingRates: async () => ({ ok: true as const, rates: [] }) },
        {
          placeParcel: async () => ({
            ok: false as const,
            why: "The shop did not answer.",
            again: true,
          }),
        },
        {
          placeParcel: async () => ({ ok: false as const, why: "The shop refused.", again: false }),
        },
        {
          placeParcel: async () => {
            throw new Error("the socket closed");
          },
        },
        { inspectProduct: async () => RULED_OUT },
      ]) {
        await fillFromTheShop(
          parcelOrder(),
          connection(),
          MERCHANT_EMAIL,
          parcelParts(memoryWooShops(), aParcelShop().place, overrides),
          NO_SPLIT,
        ).catch(() => null);
      }
    } finally {
      spy.mockRestore();
    }

    expect(logged.length).toBeGreaterThan(0);
    for (const word of ADDRESS_WORDS) expect(logged.join("\n")).not.toContain(word);
  });

  it("names a shop that cannot take its order by origin, which no typed newline survives", async () => {
    const written = await loggedWhile(() =>
      fillFromTheShop(
        parcelOrder(),
        { ...connection(), shopUrl: "https://shop.exam\nple.com", permissions: "read" },
        MERCHANT_EMAIL,
        parcelParts(memoryWooShops(), aParcelShop().place),
        NO_SPLIT,
      ),
    );

    expect(written).toContain("the shop at https://shop.example.com granted");
    expect(written).not.toContain("exam\nple");
  });
});

describe("following a parcel to the carrier", () => {
  const SHIPPED = {
    kind: "shipped" as const,
    shipment: { carrier: "Bali courier", tracking_number: null },
  };

  const withAParcel = async (soldFrom = "https://shop.example.com"): Promise<WooShops> => {
    const shops = memoryWooShops();
    await shops.connect(connection());
    const facts = {
      kind: "parcel" as const,
      shopOrigin: soldFrom,
      connectionRevision: "grant_1",
      merchantItemId: merchantItemIdFor("https://shop.example.com", "28"),
      priceId: "prc_parcel",
      productId: "28",
      productFingerprint: "accepted-parcel-fingerprint",
      amount: "25.00",
      currency: "USD",
    };
    await shops.claimOrder("acc_1", "ord_1", facts, new Date("2026-09-14T12:00:00.000Z"));
    await shops.recordOrder(
      "ord_1",
      { id: "30", number: "30", permission: null },
      new Date("2026-09-14T12:00:00.000Z"),
    );
    return shops;
  };

  const aGateway = (answer: () => unknown = () => ({ ok: true, document: { ok: true } })) => {
    const delivered: { orderId: string; shipment: unknown }[] = [];
    return {
      delivered,
      client: {
        deliverOrder: async (orderId: string, shipment: unknown) => {
          delivered.push({ orderId, shipment });
          return answer();
        },
      } as never,
    };
  };

  const following = (
    shops: WooShops,
    gateway: unknown,
    read: () => Promise<ShipmentRead>,
    now = "2026-09-15T12:00:00.000Z",
  ) =>
    followShipments({
      shops,
      identity: {
        byId: async () => ({
          id: "p",
          email: MERCHANT_EMAIL,
          confirmed: true,
          merchant: { id: "mer_1" },
        }),
      },
      clientFor: () => gateway as never,
      now: () => new Date(now),
      readShipment: async (_keys, wooOrderId, orderId) => {
        if (wooOrderId !== "30" || orderId !== "ord_1") {
          throw new Error(`asked about ${wooOrderId} for ${orderId}`);
        }
        return await read();
      },
    });

  it("records the shipment once the shop completes the order, and follows it no further", async () => {
    const shops = await withAParcel();
    const gateway = aGateway();

    await following(shops, gateway.client, async () => SHIPPED);
    await following(shops, gateway.client, async () => SHIPPED);

    expect(gateway.delivered).toStrictEqual([{ orderId: "ord_1", shipment: SHIPPED.shipment }]);
    expect(await shops.parcelsToFollow("acc_1")).toStrictEqual([]);
  });

  it("keeps following an order the shop has not completed, or could not say about", async () => {
    for (const read of [
      { kind: "waiting" as const },
      { kind: "unknown" as const, why: "The shop did not answer." },
    ]) {
      const shops = await withAParcel();
      const gateway = aGateway();

      await following(shops, gateway.client, async () => read);

      expect(gateway.delivered).toStrictEqual([]);
      expect(await shops.parcelsToFollow("acc_1")).toHaveLength(1);
    }
  });

  it("lets go of an order the shop ended, and does not say it shipped", async () => {
    // A cancelled order never shipped: nothing goes to the gateway, and it
    // becomes an unfulfilled order when its time to ship runs out.
    const shops = await withAParcel();
    const gateway = aGateway();

    await following(shops, gateway.client, async () => ({ kind: "ended", status: "cancelled" }));

    expect(gateway.delivered).toStrictEqual([]);
    expect(await shops.parcelsToFollow("acc_1")).toStrictEqual([]);
  });

  it("asks again after a gateway that did not answer, and stops after one that refused", async () => {
    const silent = await withAParcel();
    await following(
      silent,
      aGateway(() => ({ ok: false, status: 0, why: "no answer" })).client,
      async () => SHIPPED,
    );
    expect(await silent.parcelsToFollow("acc_1")).toHaveLength(1);

    // Settling the payment is a moment the gateway asks to be called again
    // after.
    const settling = await withAParcel();
    await following(
      settling,
      aGateway(() => ({ ok: false, status: 409, why: "settling", code: "settle_in_flight" }))
        .client,
      async () => SHIPPED,
    );
    expect(await settling.parcelsToFollow("acc_1")).toHaveLength(1);

    for (const code of ["order_already_closed", "shipment_already_recorded"]) {
      const refused = await withAParcel();
      const gateway = aGateway(() => ({ ok: false, status: 409, why: "refused", code }));

      await following(refused, gateway.client, async () => SHIPPED);
      await following(refused, gateway.client, async () => SHIPPED);

      expect(gateway.delivered, code).toHaveLength(1);
      expect(await refused.parcelsToFollow("acc_1")).toStrictEqual([]);
    }
  });

  it("does not read a parcel sold from a shop the account no longer connects", async () => {
    // The order number belongs to the shop it was placed in; read in the shop
    // connected now, it would be somebody else's order.
    const shops = await withAParcel("https://old-shop.example.com");
    const gateway = aGateway();
    let read = 0;

    await following(shops, gateway.client, async () => {
      read += 1;
      return SHIPPED;
    });

    expect(read).toBe(0);
    expect(gateway.delivered).toStrictEqual([]);
  });

  it("still reads a parcel past its seven days, whose late shipment closes the unfulfilled order", async () => {
    // A late shipment still reaches the agent and records shipment until the merchant
    // closes Agentify fulfillment, so the shop is read well past the seven days.
    const shops = await withAParcel();
    const gateway = aGateway();

    await following(shops, gateway.client, async () => SHIPPED, "2026-10-13T12:00:00.000Z");

    expect(gateway.delivered).toStrictEqual([{ orderId: "ord_1", shipment: SHIPPED.shipment }]);
  });

  it("lets go of a parcel not completed within thirty days of being placed", async () => {
    // Thirty days is the longest any card may give to ship; after that the
    // order is an unfulfilled order and the shop is not read again.
    const shops = await withAParcel();
    const gateway = aGateway();
    let read = 0;

    await following(
      shops,
      gateway.client,
      async () => {
        read += 1;
        return { kind: "waiting" };
      },
      "2026-10-14T12:00:01.000Z",
    );

    expect(read).toBe(0);
    expect(gateway.delivered).toStrictEqual([]);
    expect(await shops.parcelsToFollow("acc_1")).toStrictEqual([]);
  });

  it("follows nothing of a download, whose order is already delivered", async () => {
    const shops = memoryWooShops();
    await shops.connect(connection());
    await shops.claimOrder(
      "acc_1",
      "ord_2",
      {
        shopOrigin: "https://shop.example.com",
        connectionRevision: "grant_1",
        merchantItemId: merchantItemIdFor("https://shop.example.com", "11"),
        priceId: "prc_1",
        productId: "11",
        productFingerprint: "accepted-download-fingerprint",
        amount: "25.00",
        currency: "USD",
      },
      new Date("2026-09-14T12:00:00.000Z"),
    );
    await shops.recordOrder(
      "ord_2",
      {
        id: "13",
        number: "13",
        permission: {
          shopOrigin: "https://shop.example.com",
          productId: "11",
          orderKey: "wc_order_13",
          downloadId: "dl_guide",
          fileName: "Guide",
          emailUid: "uid",
          orderNumber: "13",
        },
      },
      new Date("2026-09-14T12:00:00.000Z"),
    );

    expect(await shops.parcelsToFollow("acc_1")).toStrictEqual([]);
  });
});

describe("a parcel the whole way through, against a real gateway", () => {
  let open: Harness | null = null;
  let served: Served | null = null;

  afterEach(async () => {
    await served?.close();
    await open?.stop();
    open = null;
    served = null;
  });

  // The office the discovery listing's example ships to: a real place and
  // nobody's home.
  const ADDRESS = {
    name: "Nuanu Reception",
    line_one: "Jl. Raya Kediri, Beraban",
    city: "Tabanan",
    state: "BA",
    postal_code: "82121",
    country: "ID",
    phone_number: "+62 000 0000 0000",
  };

  it("is priced with shipping, placed in the shop, taken on, and read as shipped", async () => {
    open = await harness();
    served = await serve(open);
    const harnessed = open;
    const acting = { merchantId: harnessed.merchant.id, email: MERCHANT_EMAIL };
    const gateway = gatewayFor(harnessed.gateway, acting);
    await harnessed.gateway.sellThrough(harnessed.merchant.id, "woocommerce");
    await harnessed.gateway.setSellerName(harnessed.merchant.id, {
      seller_site: "https://shop.example.com",
    });

    const { cards } = cardsFromTheShop(
      [
        aProduct({
          id: 28,
          virtual: false,
          downloadable: false,
          downloads: [],
          prices: { price: "2000", currency_code: "USD", currency_minor_unit: 2 },
        }),
      ],
      "https://shop.example.com",
    );
    const published = await gateway.publishCard(cards[0]?.card ?? ({} as never));
    const itemId = published.ok && published.document.ok ? published.document.id : "";
    expect(itemId).not.toBe("");

    const shops = memoryWooShops();
    const connected = connection();
    await shops.connect(connected);
    const placed: ParcelSold[] = [];
    const parts: Filling = {
      shops,
      now: () => new Date(harnessed.now()),
      inspectProduct: async () => ({
        ok: true,
        product: {
          kind: "parcel",
          productId: "28",
          price: { amount: "20.00", currency: "USD" },
          fingerprint: "accepted-parcel-fingerprint",
        },
      }),
      shippingRates: async () => ({
        ok: true,
        rates: [{ methodId: "flat_rate", instanceId: "1", title: "Bali courier", cost: "3.00" }],
      }),
      placeParcel: async (_keys, sold) => {
        placed.push(sold);
        return { ok: true, id: "30", number: "30" };
      },
    };

    const bought = await buyOverHttp(
      harnessed,
      served,
      itemId,
      {
        through: "woocommerce",
        // The harness hands the question over as the envelope carried it.
        onQuote: async (question) => {
          const answer = await quoteFromTheShop(
            connected,
            QuoteRequestSchema.parse(question),
            new Date(harnessed.now()),
            parts,
          );
          if (answer === null) throw new Error("the shop answered and the worker said nothing");
          return answer;
        },
        onOrder: async (order) =>
          (await fillFromTheShop(order, connected, MERCHANT_EMAIL, parts, NO_SPLIT)) ??
          Promise.reject(new Error("the shop was not asked")),
      },
      { priced: { params: {}, ship_to: ADDRESS }, paid: { params: {}, ship_to: ADDRESS } },
    );

    // The agent paid goods and rate together, the shop holds a paid order
    // shipping there, and Agentify no longer holds the address.
    expect(bought.status).toBe(200);
    const orderId = (bought.body as AgentOrderStatus).order_id;
    const paidFor = await gateway.getOrder(orderId);
    expect(paidFor.ok && paidFor.document.price.amount).toBe("23.00");
    expect(paidFor.ok && paidFor.document.ship_to).toMatchObject({ erased_at: expect.any(String) });
    expect(placed).toHaveLength(1);
    expect(placed[0]?.address).toStrictEqual(ADDRESS);
    const waiting = await served.call("GET", `/x402/orders/${orderId}/status`);
    expect((waiting.body as AgentOrderStatus).status).toBe("in_progress");

    // The merchant marks it Completed in their shop.
    await followShipments({
      shops,
      identity: {
        byId: async () => ({
          id: "p",
          email: MERCHANT_EMAIL,
          confirmed: true,
          merchant: { id: harnessed.merchant.id },
        }),
      },
      clientFor: (who) => gatewayFor(harnessed.gateway, who),
      now: () => new Date(harnessed.now()),
      readShipment: async () => ({
        kind: "shipped",
        shipment: { carrier: "Bali courier", tracking_number: null },
      }),
    });

    const read = await served.call("GET", `/x402/orders/${orderId}/status`);
    const status = read.body as Record<string, unknown>;
    expect(status.status).toBe("shipped");
    expect(status.shipment).toMatchObject({ carrier: "Bali courier", tracking_number: null });
    expect(status.delivered).toBeNull();
  });

  it("names on the shop's parcel order the payout contract the payment went to, though the merchant moved their wallet since", async () => {
    // The line records where this payment went, goods and shipping together,
    // read from the order's own payment; after a change of wallet the
    // contract in force is another one.
    open = await harness();
    served = await serve(open);
    const harnessed = open;
    const gateway = gatewayFor(harnessed.gateway, {
      merchantId: harnessed.merchant.id,
      email: MERCHANT_EMAIL,
    });
    await harnessed.gateway.sellThrough(harnessed.merchant.id, "woocommerce");
    await harnessed.gateway.setSellerName(harnessed.merchant.id, {
      seller_site: "https://shop.example.com",
    });
    const { cards } = cardsFromTheShop(
      [
        aProduct({
          id: 28,
          virtual: false,
          downloadable: false,
          downloads: [],
          prices: { price: "2000", currency_code: "USD", currency_minor_unit: 2 },
        }),
      ],
      "https://shop.example.com",
    );
    const published = await gateway.publishCard(cards[0]?.card ?? ({} as never));
    const itemId = published.ok && published.document.ok ? published.document.id : "";
    const paidInto = (await harnessed.gateway.payoutSplitsOf(harnessed.merchant.id)).inForce;
    const sent: { meta_data: { key: string; value: unknown }[] }[] = [];
    // A shop that takes the order and answers with it, as WooCommerce does.
    const theShop: WooRequest = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      sent.push(body);
      return new Response(
        JSON.stringify({
          id: 30,
          number: "30",
          order_key: "wc_order_30",
          status: "processing",
          currency: body.currency,
          total: "23.00",
          total_tax: "0.00",
          payment_method: body.payment_method,
          transaction_id: body.transaction_id,
          billing: body.billing,
          shipping: body.shipping,
          meta_data: body.meta_data,
          line_items: body.line_items.map((line: object) => ({ ...line, total_tax: "0.00" })),
          shipping_lines: body.shipping_lines,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    };
    const shops = memoryWooShops();
    const connected = connection();
    await shops.connect(connected);
    const parts: Filling = {
      shops,
      now: () => new Date(harnessed.now()),
      inspectProduct: async () => ({
        ok: true,
        product: {
          kind: "parcel",
          productId: "28",
          price: { amount: "20.00", currency: "USD" },
          fingerprint: "accepted-parcel-fingerprint",
        },
      }),
      shippingRates: async () => ({
        ok: true,
        rates: [{ methodId: "flat_rate", instanceId: "1", title: "Bali courier", cost: "3.00" }],
      }),
      placeParcel: (keys, sold) => createTheParcelInTheShop(keys, sold, theShop),
    };

    await buyOverHttp(
      harnessed,
      served,
      itemId,
      {
        through: "woocommerce",
        onQuote: async (question) => {
          const answer = await quoteFromTheShop(
            connected,
            QuoteRequestSchema.parse(question),
            new Date(harnessed.now()),
            parts,
          );
          if (answer === null) throw new Error("the shop answered and the worker said nothing");
          return answer;
        },
        onOrder: async (order) => {
          // Paid, and the merchant saves another wallet before the shop is asked.
          expect(
            (await gateway.setPayoutWallet("0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359")).ok,
          ).toBe(true);
          return (
            (await filledAsPaid(gateway, order, connected, MERCHANT_EMAIL, parts)) ??
            Promise.reject(new Error("the shop was not asked"))
          );
        },
      },
      { priced: { params: {}, ship_to: ADDRESS }, paid: { params: {}, ship_to: ADDRESS } },
    );

    const now = (await harnessed.gateway.payoutSplitsOf(harnessed.merchant.id)).inForce;
    expect(now?.address).not.toBe(paidInto?.address);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.meta_data).toContainEqual({
      key: "agentify_payout_contract",
      value: paidInto?.address,
    });
    expect(JSON.stringify(sent[0]?.meta_data)).not.toContain(now?.address ?? "no split");
  });
});

describe("the worker that keeps every connected shop served", () => {
  /**
   * The stream is empty on purpose: what is checked is that somebody keeps
   * drawing it.
   */
  const countingGateway = () => {
    let polls = 0;
    return {
      polls: () => polls,
      client: {
        pollWorker: async () => {
          polls += 1;
          return {
            ok: true as const,
            document: { contract_version: "1", envelopes: [] },
          };
        },
      },
    };
  };

  const untilPolled = async (
    polls: () => number,
    atLeast: number,
    within = 2_000,
  ): Promise<number> => {
    const until = Date.now() + within;
    while (polls() < atLeast && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return polls();
  };

  it("keeps serving a shop that was disconnected and connected again", async () => {
    // A loop that ended by itself while its entry stayed would leave a merchant
    // who disconnected and reconnected served by nobody until restart.
    const shops = memoryWooShops();
    const gateway = countingGateway();
    const worker = startWooWorker({
      shops,
      now: () => new Date(),
      identity: {
        byId: async () => ({
          id: "acc_1",
          email: MERCHANT_EMAIL,
          confirmed: true,
          merchant: { id: "mer_1" },
        }),
      },
      clientFor: () => gateway.client as never,
      waitSeconds: 0,
      betweenTurnsMs: 5,
    });

    try {
      await shops.connect(connection());
      const first = await untilPolled(gateway.polls, 1);
      expect(first).toBeGreaterThanOrEqual(1);

      await shops.forget("acc_1");
      // Long enough for the loop to notice there is nothing to draw.
      await new Promise((resolve) => setTimeout(resolve, 60));
      const whileGone = gateway.polls();

      await shops.connect(connection());
      const afterwards = await untilPolled(gateway.polls, whileGone + 1);
      expect(afterwards).toBeGreaterThan(whileGone);
    } finally {
      await worker.stop();
    }
  });

  it("stops drawing when there is nothing connected", async () => {
    const shops = memoryWooShops();
    const gateway = countingGateway();
    const worker = startWooWorker({
      shops,
      now: () => new Date(),
      identity: {
        byId: async () => ({
          id: "acc_1",
          email: MERCHANT_EMAIL,
          confirmed: true,
          merchant: { id: "mer_1" },
        }),
      },
      clientFor: () => gateway.client as never,
      waitSeconds: 0,
      betweenTurnsMs: 5,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await worker.stop();
    expect(gateway.polls()).toBe(0);
  });

  it("stops at once when it is stopped while parcels are being read", async () => {
    // Shutdown waits for this and the next pass is minutes away; a stop that
    // waited for it would be killed instead.
    const shops = memoryWooShops();
    await shops.connect(connection());
    await shops.claimOrder(
      "acc_1",
      "ord_1",
      {
        kind: "parcel",
        shopOrigin: "https://shop.example.com",
        connectionRevision: "grant_1",
        merchantItemId: merchantItemIdFor("https://shop.example.com", "28"),
        priceId: "prc_parcel",
        productId: "28",
        productFingerprint: "accepted-parcel-fingerprint",
        amount: "25.00",
        currency: "USD",
      },
      new Date(),
    );
    await shops.recordOrder("ord_1", { id: "30", number: "30", permission: null }, new Date());
    let reading = false;
    const worker = startWooWorker({
      shops,
      now: () => new Date(),
      identity: {
        byId: async () => ({
          id: "acc_1",
          email: MERCHANT_EMAIL,
          confirmed: true,
          merchant: { id: "mer_1" },
        }),
      },
      clientFor: () => countingGateway().client as never,
      waitSeconds: 0,
      betweenTurnsMs: 5,
      shipmentsEveryMs: 60_000,
      readShipment: async () => {
        reading = true;
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { kind: "waiting" };
      },
    });
    const until = Date.now() + 2_000;
    while (!reading && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(reading).toBe(true);

    const started = Date.now();
    await worker.stop();

    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("a shop whose Number of decimals changed after the quote", () => {
  let shopServer: Server | null = null;

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (shopServer === null) {
        resolve();
        return;
      }
      shopServer.close(() => resolve());
    });
    shopServer = null;
  });

  /**
   * Order answers write every total at the shop's number of decimals, as
   * `wc/v3` does; the price is stored as a whole-dollar merchant typed it.
   */
  const aShopWritingDecimals = async (
    decimals: () => string,
  ): Promise<{ url: string; asked: { method: string; path: string }[] }> => {
    const asked: { method: string; path: string }[] = [];
    const settings: Readonly<Record<string, string>> = {
      woocommerce_currency: "USD",
      woocommerce_calc_taxes: "no",
      woocommerce_file_download_method: "force",
      woocommerce_downloads_require_login: "no",
      woocommerce_downloads_grant_access_after_payment: "yes",
      woocommerce_downloads_redirect_fallback_allowed: "no",
    };
    shopServer = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const method = request.method ?? "GET";
        const path = request.url ?? "/";
        asked.push({ method, path });
        const answer = (status: number, body: unknown): void => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(body));
        };
        if (path === "/protected/guide.txt") return answer(403, {});
        const setting = /\/settings\/\w+\/(\w+)$/.exec(path)?.[1];
        if (setting !== undefined) {
          return answer(200, {
            id: setting,
            value: setting === "woocommerce_price_num_decimals" ? decimals() : settings[setting],
          });
        }
        if (method === "POST" && path === "/wp-json/wc/v3/orders") {
          const sent = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const written = (amount: string): string => Number(amount).toFixed(Number(decimals()));
          return answer(201, {
            id: 13,
            number: "13",
            order_key: "wc_order_13",
            status: "processing",
            currency: sent.currency,
            total: written(sent.line_items[0].total),
            total_tax: written("0"),
            payment_method: sent.payment_method,
            transaction_id: sent.transaction_id,
            billing: sent.billing,
            meta_data: sent.meta_data,
            line_items: [
              {
                product_id: sent.line_items[0].product_id,
                quantity: 1,
                subtotal: written(sent.line_items[0].subtotal),
                total: written(sent.line_items[0].total),
                total_tax: written("0"),
              },
            ],
          });
        }
        return answer(200, {
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
          price: "25",
          downloads: [
            {
              id: "dl_guide",
              name: "Guide",
              file: `http://${request.headers.host}/protected/guide.txt`,
            },
          ],
        });
      });
    });
    shopServer.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => shopServer?.once("listening", resolve));
    const { port } = shopServer.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, asked };
  };

  /**
   * The real product check and order call; the quote's fingerprint is the one
   * the check gave when the quote was taken.
   */
  const fillingAgainst = (shops: WooShops, quotedFingerprint: string | null) => ({
    shops,
    now: () => new Date("2026-09-14T12:00:00.000Z"),
    placeOrder: (keys: ShopKeys, sold: SoldItem) => createTheOrderInTheShop(keys, sold, fetch),
    inspectProduct: (connected: WooConnection, merchantItemId: string) =>
      inspectProductInTheShop(connected, merchantItemId, fetch),
    quotedProduct: async () => quotedFingerprint,
  });

  it("refuses the sale before any order is posted to the shop", async () => {
    // The merchant switched decimals after a quote: posted, the order would
    // exist in the shop, paid, with totals that can never be matched. Refused
    // before the post, it is a refund.
    for (const changedTo of ["0", "3"]) {
      let decimals = "2";
      const shop = await aShopWritingDecimals(() => decimals);
      const connected: WooConnection = { ...connection(), shopUrl: shop.url };
      const item = merchantItemIdFor(shop.url, "11");
      const quoted = await inspectProductInTheShop(connected, item, fetch);
      expect(quoted.ok, changedTo).toBe(true);
      decimals = changedTo;
      const shops = memoryWooShops();

      const answer = await fillFromTheShop(
        anOrder({ merchant_item_id: item }),
        connected,
        MERCHANT_EMAIL,
        fillingAgainst(shops, quoted.ok ? quoted.product.fingerprint : null),
        NO_SPLIT,
      );

      expect(answer !== null && "refused" in answer, changedTo).toBe(true);
      expect(
        shop.asked.filter((one) => one.method === "POST"),
        changedTo,
      ).toEqual([]);
      expect((await shops.knownOrder("ord_1"))?.kind, changedTo).toBe("precreate_refused");
      await new Promise<void>((resolve) => shopServer?.close(() => resolve()));
      shopServer = null;
    }
  });

  it("places the order in a shop that still writes two decimals", async () => {
    const shop = await aShopWritingDecimals(() => "2");
    const connected: WooConnection = { ...connection(), shopUrl: shop.url };
    const item = merchantItemIdFor(shop.url, "11");
    const quoted = await inspectProductInTheShop(connected, item, fetch);

    const answer = await fillFromTheShop(
      anOrder({ merchant_item_id: item }),
      connected,
      MERCHANT_EMAIL,
      fillingAgainst(memoryWooShops(), quoted.ok ? quoted.product.fingerprint : null),
      NO_SPLIT,
    );

    expect(answer).toMatchObject({ delivered: { file_name: "Guide", order_number: "13" } });
    expect(shop.asked.filter((one) => one.method === "POST")).toHaveLength(1);
  });
});

describe("what the worker writes in the merchant's log when something fails", () => {
  // A failure from the shop's client or the database can carry the shop's key
  // and secret or a buyer's address, and a newline in it would start a line of
  // its own; the log goes places the database does not.
  const SECRET = "cs_a-secret-from-the-shop";
  const FORGED = "\n[dashboard] forged";
  const carrying = (): Error => new Error(`${SECRET}${FORGED}`);
  const expectNothingCarried = (written: string): void => {
    expect(written).not.toContain(SECRET);
    expect(written).not.toContain("forged");
  };

  const working = (shops: WooShops) =>
    startWooWorker({
      shops,
      now: () => new Date(),
      identity: {
        byId: async () => ({
          id: "acc_1",
          email: MERCHANT_EMAIL,
          confirmed: true,
          merchant: { id: "mer_1" },
        }),
      },
      clientFor: () => ({}) as never,
      waitSeconds: 0,
      betweenTurnsMs: 5,
      shipmentsEveryMs: 60_000,
    });

  /** Runs the worker until the log says everything `expected`, or two seconds pass. */
  const loggedUntil = (shops: WooShops, ...expected: string[]): Promise<string> =>
    loggedWhile(async () => {
      const worker = working(shops);
      try {
        await vi.waitFor(
          () => {
            const said = vi.mocked(console.error).mock.calls.flat().join(" ");
            for (const line of expected) expect(said).toContain(line);
          },
          { timeout: 2_000, interval: 5 },
        );
      } finally {
        await worker.stop();
      }
    });

  it("names the account whose turn failed", async () => {
    const shops = memoryWooShops();
    await shops.connect(connection());
    const failing: WooShops = {
      ...shops,
      connectionOf: async () => {
        throw carrying();
      },
    };

    const written = await loggedUntil(failing, "a WooCommerce turn failed for acc_1");

    expectNothingCarried(written);
  });

  it("says the connections could not be read, and nothing the failure carried", async () => {
    const failing: WooShops = {
      ...memoryWooShops(),
      connections: async () => {
        throw carrying();
      },
    };

    const written = await loggedUntil(
      failing,
      "could not read its connections",
      "the parcels could not be followed this time",
    );

    expectNothingCarried(written);
  });

  it("names the account whose parcels could not be followed", async () => {
    const shops = memoryWooShops();
    await shops.connect(connection());
    const failing: WooShops = {
      ...shops,
      parcelsToFollow: async () => {
        throw carrying();
      },
    };

    const written = await loggedWhile(() =>
      followShipments({
        shops: failing,
        identity: { byId: async () => null },
        clientFor: () => ({}) as never,
        now: () => new Date(),
      }),
    );

    expect(written).toContain("the parcels of acc_1 could not be followed this time");
    expectNothingCarried(written);
  });

  it("names a shop by its origin, so a newline typed into its address starts no line", async () => {
    // The address is kept as the merchant typed it, and a URL parser drops a
    // newline inside it without a word.
    const typed = "https://shop.exam\nple.com";
    expect(new URL(typed).origin).toBe("https://shop.example.com");

    const written = await loggedWhile(() =>
      fillFromTheShop(
        anOrder(),
        { ...connection(), shopUrl: typed, permissions: "read" },
        MERCHANT_EMAIL,
        filling(memoryWooShops(), aShopThatAccepts().place),
        NO_SPLIT,
      ),
    );

    expect(written).toContain("the shop at https://shop.example.com granted");
    expect(written).not.toContain("exam\nple");
  });

  it("names the shop an interrupted order was placed in by its origin", async () => {
    const written = await loggedWhile(() =>
      fillFromTheShop(
        anOrder(),
        { ...connection(), shopUrl: "https://shop.exam\nple.com" },
        MERCHANT_EMAIL,
        filling(memoryWooShops(), async () => ({ ok: false as const, why: "gone", again: false })),
        NO_SPLIT,
      ),
    );

    expect(written).toContain("was already being placed in the shop at https://shop.example.com");
    expect(written).not.toContain("exam\nple");
  });
});

describe("bounded work within one connected shop", () => {
  const begin = async (ids: string[], place: (sold: SoldItem) => Promise<OrderMade>) => {
    const shops = memoryWooShops();
    await shops.connect(connection());
    const stream = ids.map((id, index) =>
      id === "quote"
        ? {
            kind: "quote_request" as const,
            id: `env-${index}`,
            sent_at: new Date().toISOString(),
            payload: {
              merchant_item_id: anOrder().merchant_item_id,
              price_id: "live-price",
              purpose: "purchase" as const,
              expires_at: new Date(Date.now() + 60_000).toISOString(),
            },
          }
        : {
            kind: "order" as const,
            id: `env-${index}`,
            sent_at: new Date().toISOString(),
            payload: anOrder({ id }),
          },
    );
    const answers: string[] = [];
    let polls = 0;
    const gateway = {
      pollWorker: async () => {
        polls += 1;
        const next = stream.shift();
        return {
          ok: true as const,
          document: { contract_version: "1", envelopes: next ? [next] : [] },
        };
      },
      paidInto: async () => ({ ok: true as const, document: NO_SPLIT }),
      answerOrder: async (id: string) => {
        answers.push(id);
        return { ok: true as const };
      },
      answerQuote: async () => {
        answers.push("quote");
        return { ok: true as const };
      },
    };
    const worker = startWooWorker({
      ...filling(shops, async (_keys, sold) => place(sold)),
      identity: {
        byId: async () => ({
          id: "acc_1",
          email: MERCHANT_EMAIL,
          confirmed: true,
          merchant: { id: "mer_1" },
        }),
      },
      clientFor: () => gateway as never,
      betweenTurnsMs: 5,
      waitSeconds: 0,
    });
    return { worker, shops, answers, polls: () => polls };
  };
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 1_000;
    while (!condition() && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 2));
    expect(condition()).toBe(true);
  };
  const placed = (id: string): OrderMade => ({
    ok: true,
    id,
    number: id,
    orderKey: `wc_${id}`,
    downloadId: "dl_guide",
  });

  it("answers the next purchase and price while one shop creation is held open", async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const started: string[] = [];
    const run = await begin(["slow", "fast", "quote"], async (sold) => {
      started.push(sold.orderId);
      if (sold.orderId === "slow") await promise;
      return placed(sold.orderId);
    });
    try {
      await until(() => run.answers.includes("fast") && run.answers.includes("quote"));
      expect(started).toEqual(["slow", "fast"]);
      expect(run.answers).not.toContain("slow");
    } finally {
      resolve();
      await run.worker.stop();
    }
  });

  it("holds the fifth order in the gateway until one of four creations finishes", async () => {
    const gates = Array.from({ length: 5 }, () => Promise.withResolvers<void>());
    const started: string[] = [];
    const run = await begin(["0", "1", "2", "3", "4"], async (sold) => {
      started.push(sold.orderId);
      await gates[Number(sold.orderId)]?.promise;
      return placed(sold.orderId);
    });
    try {
      await until(() => started.length >= 4);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(started).toEqual(["0", "1", "2", "3"]);
      expect(run.polls()).toBe(4);
      gates[0]?.resolve();
      await until(() => started.includes("4"));
    } finally {
      gates.forEach((gate) => {
        gate.resolve();
      });
      await run.worker.stop();
    }
  });

  it("does not refuse or create an in-flight redelivery a second time", async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const started: string[] = [];
    const run = await begin(["same", "same", "quote"], async (sold) => {
      started.push(sold.orderId);
      await promise;
      return placed(sold.orderId);
    });
    try {
      await until(() => run.answers.includes("quote"));
      expect(started).toEqual(["same"]);
      expect(run.answers).not.toContain("same");
      resolve();
      await until(() => run.answers.includes("same"));
      expect(run.answers.filter((id) => id === "same")).toHaveLength(1);
    } finally {
      resolve();
      await run.worker.stop();
    }
  });

  it("retains disconnected work through reconnect and shutdown until it finishes", async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const started: string[] = [];
    const run = await begin(["old"], async (sold) => {
      started.push(sold.orderId);
      await promise;
      return placed(sold.orderId);
    });
    try {
      await until(() => started.length === 1);
      await run.shops.forget("acc_1");
      await new Promise((resolve) => setTimeout(resolve, 40));
      const before = run.polls();
      await run.shops.connect({ ...connection(), revision: "grant_2" });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(run.polls()).toBe(before);
      let stopped = false;
      const stopping = run.worker.stop().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(stopped).toBe(false);
      resolve();
      await stopping;
      expect(run.answers).toEqual(["old"]);
    } finally {
      resolve();
      await run.worker.stop();
    }
  });

  it("resumes polling after a disconnected owner's held work finishes", async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    let started = false;
    const run = await begin(["old"], async (sold) => {
      started = true;
      await promise;
      return placed(sold.orderId);
    });
    try {
      await until(() => started);
      await run.shops.forget("acc_1");
      await new Promise((resolve) => setTimeout(resolve, 40));
      await run.shops.connect({ ...connection(), revision: "grant_2" });
      const before = run.polls();
      resolve();
      await until(() => run.polls() > before && run.answers.includes("old"));
    } finally {
      resolve();
      await run.worker.stop();
    }
  });
});
