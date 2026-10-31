/**
 * The whole path with nothing in the middle stubbed: a real gateway on
 * in-memory adapters, a card converted from a shop's catalogue and published
 * normally, a purchase over HTTP with a payment, and a shop on loopback. The
 * shop stands in for a real one answering `POST wc/v3/orders` with `set_paid:
 * true` under 201.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { QUOTE_RESPONSE_MS } from "@agentify/core/published";
import {
  buyOverHttp,
  type Harness,
  harness,
  loggedWhile,
  paymentNamingNoPayer,
  type Served,
  serve,
  workUntilStopped,
} from "@agentify/gateway/testing";
import {
  type AgentOrderStatus,
  type Order,
  QuoteRequestSchema,
  type QuoteResponse,
  QuoteResponseSchema,
  type ShipToLocality,
} from "@nuanu-ai/agentify-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayFor } from "./gateway.js";
import { shopPublisherFor, workShopJob } from "./shop-job-runner.js";
import { cardsView } from "./views.js";
import { cardsFromTheShop, merchantItemIdFor, type StoreProduct } from "./woo-catalog.js";
import type { QuotedSale } from "./woo-quoted-sale.js";
import type { WooRequest } from "./woo-request.js";
import * as wooTransport from "./woo-request.js";
import {
  connectedCatalogue,
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
  type ShopTax,
  type SoldItem,
  shippingRatesInTheShop,
} from "./woo-shop.js";
import { memoryWooShops, type WooConnection, type WooShops } from "./woo-shops.js";
import {
  filledAsPaid,
  fillFromTheShop as fillPaidOrder,
  followShipments,
  type Filling as ProductionFilling,
  quoteFromTheShop,
  startWooWorker,
  turnOnce,
  type WorkingParts,
} from "./woo-worker.js";

beforeEach(() => {
  let issued = 0;
  const original = wooTransport.wooRequest;
  vi.spyOn(wooTransport, "wooRequest").mockImplementation(async (url, init) => {
    if (new URL(url).pathname === "/wp-json/wc/store/v1/cart" && (init?.method ?? "GET") === "GET")
      return Response.json(
        { items: [], needs_shipping: false, shipping_rates: [] },
        {
          headers: {
            "Cart-Token": new Headers(init?.headers).get("cart-token") ?? `empty-cart-${++issued}`,
          },
        },
      );
    return original(url, init);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Fixture facts echoed by the gateway on an authenticated paid merchant order. */
type Filling = ProductionFilling & { readonly offered?: QuotedSale | null };
const referenceFor = (sale: QuotedSale): string =>
  Buffer.from(
    JSON.stringify([
      sale.fingerprint,
      sale.inTheShop.amount,
      sale.inTheShop.currency,
      sale.paid.amount,
      ...(sale.rate === null
        ? []
        : [sale.rate.version, sale.rate.rate, sale.rate.setAt.toISOString()]),
    ]),
  ).toString("base64url");
const fillFromTheShop = (
  order: Order,
  connection: WooConnection,
  email: string,
  filling: Filling,
  split: Parameters<typeof fillPaidOrder>[4],
) =>
  fillPaidOrder(
    filling.offered === undefined
      ? order
      : {
          ...order,
          quote_reference: filling.offered === null ? undefined : referenceFor(filling.offered),
        },
    connection,
    email,
    filling,
    split,
  );

const showing = (product: EligibleWooProduct): ProductInspection => ({ ok: true, product });

/** A price bound as a dollar shop's is: the shop held to what the buyer is to pay. */
const boundAt = (fingerprint: string, amount = "25.00"): QuotedSale => ({
  fingerprint,
  inTheShop: { amount, currency: "USD" },
  paid: { amount, currency: "USD" },
  rate: null,
});

/** A cart read for its rates alone, which a shop calculating no tax is sold from. */
const NOT_PRICED = {
  ok: false as const,
  why: "The shop's cart answered without its totals.",
  again: false as const,
  saidNo: false,
};

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
const noCatalogueMutation = (): never => {
  throw new Error("No catalogue mutation belongs to this case");
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
  currency: null,
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
  quote_reference: referenceFor(boundAt("accepted-download-fingerprint")),
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
        total: sold.price.amount,
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
      tax: { mode: "off" as const },
    }),
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
        test: true,
        productId: "11",
        email: MERCHANT_EMAIL,
        price: { amount: "25.00", currency: "USD" },
        download: { id: "dl_guide", name: "Guide" },
        paidInto: NO_SPLIT,
        tax: { mode: "off" },
      },
    ]);
  });

  it("places a download from a shop whose prices hold their tax as the shop prices it, and delivers it", async () => {
    // The tax probe's Bali shop answering for its download at 1.00: a line
    // carrying totals is taxed on top (order 54), a line naming only the
    // product is priced from it with the tax inside (order 55).
    const inBali: WooRequest = async (_url, init) => {
      const sent = JSON.parse(String(init?.body)) as {
        transaction_id: string;
        billing: unknown;
        meta_data: unknown;
        line_items: { total?: string }[];
      };
      const shopPriced = sent.line_items[0]?.total === undefined;
      return Response.json(
        {
          id: shopPriced ? 55 : 54,
          number: shopPriced ? "55" : "54",
          order_key: "wc_order_55",
          status: "completed",
          currency: "USD",
          total: shopPriced ? "1.00" : "1.11",
          total_tax: shopPriced ? "0.10" : "0.11",
          payment_method: "agentify",
          transaction_id: sent.transaction_id,
          billing: sent.billing,
          meta_data: sent.meta_data,
          line_items: [
            {
              product_id: 20,
              quantity: 1,
              subtotal: shopPriced ? "0.90" : "1.00",
              total: shopPriced ? "0.90" : "1.00",
              total_tax: shopPriced ? "0.10" : "0.11",
            },
          ],
        },
        { status: 201 },
      );
    };
    const item = merchantItemIdFor("https://shop.example.com", "20");

    const answer = await fillFromTheShop(
      anOrder({ merchant_item_id: item, price: { ...anOrder().price, amount: "1.00" } }),
      connection(),
      MERCHANT_EMAIL,
      {
        ...filling(memoryWooShops(), (keys, sold) => createTheOrderInTheShop(keys, sold, inBali)),
        offered: boundAt("accepted-download-fingerprint", "1.00"),
        inspectProduct: async () =>
          showing({
            kind: "download",
            productId: "20",
            downloadId: "dl_guide",
            fileName: "Guide",
            price: { amount: "1.00", currency: "USD" },
            fingerprint: "accepted-download-fingerprint",
            tax: { mode: "included" },
          }),
      },
      NO_SPLIT,
    );

    expect(answer).toMatchObject({ delivered: { order_number: "55" } });
  });

  it("keeps the total the shop's order recorded a cent from what was paid", async () => {
    const shops = memoryWooShops();
    const shop = aShopThatAccepts();

    await fillFromTheShop(
      anOrder(),
      connection(),
      MERCHANT_EMAIL,
      filling(shops, async (keys, sold) => ({ ...(await shop.place(keys, sold)), total: "25.01" })),
      NO_SPLIT,
    );

    expect(await shops.shopTotals("acc_1", ["ord_1"])).toStrictEqual({
      ord_1: { total: "25.01", converted: null },
    });
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

  it.each([
    [
      "did not answer",
      async (): Promise<ProductInspection> => ({
        ok: false,
        why: "The shop did not answer the protected product check.",
        again: true,
      }),
    ],
    [
      "broke off its answer",
      (asked: WooConnection, merchantItemId: string) =>
        inspectProductInTheShop(
          asked,
          merchantItemId,
          async () =>
            new Response(
              new ReadableStream({ start: (controller) => controller.error(new Error("cut off")) }),
              { status: 200 },
            ),
        ),
    ],
  ])(
    "answers nothing for a paid download whose shop %s, so the order comes again",
    async (_case, inspectProduct) => {
      // A shop down for a while says nothing about the product, and the order
      // is handed over again for hours, so it waits for the shop.
      const shops = memoryWooShops();
      const shop = aShopThatAccepts();

      const answer = await fillFromTheShop(
        anOrder(),
        connection(),
        MERCHANT_EMAIL,
        { ...filling(shops, shop.place), inspectProduct },
        NO_SPLIT,
      );

      expect(answer).toBeNull();
      expect(shop.placed).toHaveLength(0);
      // Only the silence is kept, which no later hand-over reads as a refusal.
      expect(await shops.knownOrder("ord_1")).toStrictEqual({ kind: "shop_silent" });
    },
  );

  it("saves a silent shop's sale for its merchant to recover, and still delivers it when a later hand-over reaches the shop", async () => {
    const shops = memoryWooShops();
    const shop = aShopThatAccepts();
    const silent = {
      ...filling(shops, shop.place),
      inspectProduct: async (): Promise<ProductInspection> => ({
        ok: false,
        why: "The shop did not answer the protected product check.",
        again: true,
      }),
    };

    expect(
      await fillFromTheShop(anOrder(), connection(), MERCHANT_EMAIL, silent, NO_SPLIT),
    ).toBeNull();
    expect(await shops.recoveryOrder("ord_1")).toMatchObject({
      accountId: "acc_1",
      phase: "shop_silent",
      facts: { productFingerprint: "accepted-download-fingerprint", amount: "25.00" },
      placed: null,
    });

    const answered = await fillFromTheShop(
      anOrder(),
      connection(),
      MERCHANT_EMAIL,
      filling(shops, shop.place),
      NO_SPLIT,
    );
    expect(answered).toMatchObject({ delivered: { file_name: "Guide" } });
    expect(shop.placed).toHaveLength(1);
  });

  it("refuses an order whose product check could not be read in none of the words that say the product changed or the shop was silent", async () => {
    // The shop answered, so it was not silent, and what it answered says
    // nothing about the product, so no reason that says the product changed
    // is true of it.
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
      expect(message, what).toMatch(/answer.*product check.*could not be read or trusted/i);
      expect(message, what).toMatch(/no WooCommerce order was created/i);
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
        offered: boundAt("quoted-download-fingerprint"),
        inspectProduct: async () =>
          showing({
            kind: "download",
            productId: "11",
            downloadId: "dl_replaced",
            fileName: "Replacement",
            fingerprint: "replacement-download-fingerprint",
            tax: { mode: "off" as const },
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
              tax: { mode: "off" as const },
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

/** What a production gateway is configured with, the facilitator's credentials made up. */
const LIVE = {
  PAYMENT_NETWORK: "eip155:8453",
  FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
  CDP_API_KEY_ID: "key-id",
  CDP_API_KEY_SECRET: "key-secret",
} as const;

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

  it.each([
    ["the sandbox", {}],
    ["the live channel", LIVE],
  ] as const)(
    "on %s, sells an imported product and leaves a paid order in the shop",
    async (_, channel) => {
      open = await harness(channel);
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
            tax: { mode: "off" as const },
          }),
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
          quote_reference: referenceFor(boundAt("accepted-download-fingerprint")),
          price: { amount: "25.00", currency: "USD" },
          as_of: "2026-09-14T12:00:00.000Z",
        }),
      });

      // The buyer holds the number of an order in a shop they have never heard
      // of.
      expect(bought.status).toBe(200);
      const started = bought.body as AgentOrderStatus;
      const read = await served.call("GET", new URL(started.status_url).pathname);
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
      // The shop's order, which every employee and plugin of the shop reads,
      // carries the identifier and not the buyer's key that opens the goods.
      const key = (await open.store.orderById(status.order_id))?.buyerKey ?? "";
      expect(key).not.toBe("");
      expect(JSON.stringify(shop.orders)).not.toContain(key);
      expect(placed.line_items[0]?.product_id).toBe(11);
      expect(placed.line_items[0]?.total).toBe("25.00");
    },
  );

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
          tax: { mode: "off" as const },
        }),
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
        quote_reference: referenceFor(boundAt("accepted-download-fingerprint")),
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
    // The log says which order waits, by the order's identifier, and why.
    expect(written).toMatch(/could not be read.*nothing answered/);
    expect(written).toContain("order ord_1");
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
          tax: { mode: "off" as const },
        }),
    };

    const first = await fillFromTheShop(anOrder(), connected, MERCHANT_EMAIL, parts, NO_SPLIT);
    const durable = await shops.knownOrder("ord_1");
    const redelivery = await fillFromTheShop(anOrder(), connected, MERCHANT_EMAIL, parts, NO_SPLIT);

    expect(first).toBeNull();
    expect(durable?.kind).toBe("unknown");
    expect(shop.orders).toHaveLength(1);
    expect(redelivery).toMatchObject({
      refused: { code: "cannot_fulfill", message: expect.stringContaining("ord_1") },
    });
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
      publisherFor: noCatalogueMutation,
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
      publisherFor: noCatalogueMutation,
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
        publisherFor: noCatalogueMutation,
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
    tax: { mode: "off" as const },
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
  ): Promise<QuoteResponse | null> => {
    // Stays null when the worker says nothing.
    let answer: QuoteResponse | null = null;
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
        if (priceId !== question.price_id) throw new Error(`answered under ${priceId}`);
        answer = QuoteResponseSchema.parse(said);
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
      publisherFor: noCatalogueMutation,
      clientFor: () => gateway,
      now: () => new Date(NOW),
      inspectProduct,
    });
    return answer;
  };

  it.each(["off", "included"] as const)(
    "returns the product and money facts in its opaque reference with tax %s",
    async (mode) => {
      const shops = memoryWooShops();
      const answer = await answering(shops, inTheShop, async () =>
        showing({ ...inTheShop, tax: { mode } }),
      );
      expect(answer).toMatchObject({
        available: true,
        price: { amount: "25.00", currency: "USD" },
        as_of: NOW,
      });
      if (answer?.available !== true || answer.quote_reference === undefined)
        throw new Error("No quoted sale reference");
      expect(
        JSON.parse(Buffer.from(answer.quote_reference, "base64url").toString("utf8")),
      ).toStrictEqual(["accepted-download-fingerprint", "25.00", "USD", "25.00"]);
    },
  );

  it("names no price when the shop does not show the product as one download", async () => {
    const shops = memoryWooShops();

    expect(await answering(shops, null)).toStrictEqual({ available: false, as_of: NOW });
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
        answerQuote: async (
          _priceId: string,
          answer: { available: boolean; quote_reference?: string },
        ) => {
          const next = turns[0];
          if (next?.kind === "order")
            turns[0] = {
              ...next,
              payload: { ...next.payload, quote_reference: answer.quote_reference },
            };
          return { ok: true as const, document: { used: true } };
        },
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
        publisherFor: noCatalogueMutation,
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
    }
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
      tax: { mode: "off" as const },
    },
  };
  const rate = (title: string, cost: string, instanceId = "3") => ({
    methodId: "flat_rate",
    instanceId,
    title,
    cost,
    tax: "0.00",
  });

  const answering = async (
    shops: WooShops,
    rates: (place: unknown) => Promise<RatesRead>,
    asked: Record<string, unknown> = question,
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
      publisherFor: noCatalogueMutation,
      clientFor: () => gateway,
      now: () => new Date(NOW),
      inspectProduct: async () => theTote,
      shippingRates: async (_connection, productId, where) =>
        productId === "28"
          ? rates(where)
          : { ok: false, why: "another product", again: false, saidNo: true },
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
        currency: "USD",
        rates: [
          rate("Express", "12.00", "4"),
          rate("Standard", "5.00"),
          rate("Courier", "5.00", "9"),
        ],
        priced: NOT_PRICED,
      };
    });

    expect(answer).toStrictEqual({
      available: true,
      quote_reference: expect.stringMatching(/^[A-Za-z0-9_-]{1,512}$/),
      price: { amount: "25.00", currency: "USD" },
      as_of: NOW,
    });
    expect(asked).toStrictEqual(place);
  });

  it("adds the rate to the goods in cents, not in floating point", async () => {
    const shops = memoryWooShops();

    const answer = await answering(shops, async () => ({
      ok: true,
      currency: "USD",
      rates: [rate("Standard", "0.10")],
      priced: NOT_PRICED,
    }));

    expect(answer).toMatchObject({ available: true, price: { amount: "20.10" } });
  });

  it("names no price where the shop has no rate for the place, or the shop refused it", async () => {
    // "Not available" is all the agent is told; the reason goes to the
    // merchant's log. A shop that could not answer at all is a different case
    // (below).
    for (const read of [
      { ok: true as const, currency: "USD", rates: [], priced: NOT_PRICED },
      { ok: false as const, why: "The shop refused the place.", again: false, saidNo: true },
    ]) {
      const shops = memoryWooShops();

      expect(await answering(shops, async () => read), JSON.stringify(read)).toStrictEqual({
        available: false,
        as_of: NOW,
      });
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
      publisherFor: noCatalogueMutation,
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
          tax: { mode: "off" as const },
        }),
      shippingRates: async () => ({
        ok: true,
        currency: "USD",
        rates: [rate("Standard", "5.00")],
        priced: NOT_PRICED,
      }),
    });

    expect(answer).toStrictEqual({ available: false, as_of: NOW });
  });

  it("names no price where a shop calculating no tax shows a rate carrying tax", async () => {
    const shops = memoryWooShops();

    const answer = await answering(shops, async () => ({
      ok: true,
      currency: "USD",
      rates: [{ ...rate("Standard", "5.00"), tax: "0.55" }],
      priced: NOT_PRICED,
    }));

    expect(answer).toStrictEqual({ available: false, as_of: NOW });
  });

  it("names no price for a parcel's question that carries no place", async () => {
    const { ship_to: _left, ...noPlace } = question;
    let asked = false;

    const answer = await answering(
      memoryWooShops(),
      async () => {
        asked = true;
        return { ok: true, currency: "USD", rates: [rate("Standard", "5.00")], priced: NOT_PRICED };
      },
      noPlace,
    );

    expect(answer).toStrictEqual({ available: false, as_of: NOW });
    expect(asked).toBe(false);
  });

  it("says nothing when the shop is slower than the price check allows", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const answer = answering(
      memoryWooShops(),
      () => new Promise<RatesRead>(() => undefined),
      question,
    );
    await vi.advanceTimersByTimeAsync(QUOTE_RESPONSE_MS);
    expect(await answer).toBeNull();
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
      quote_reference: expect.stringMatching(/^[A-Za-z0-9_-]{1,512}$/),
      price: { amount: "25.00" },
    });
    // Not the seller's "not available": the cart said nothing about this parcel.
    expect(await answering(shops, fromTheCart(2))).toBeNull();
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
      quote_reference: referenceFor(boundAt("accepted-parcel-fingerprint")),
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
      tax: { mode: "off" as const },
    },
  };
  const rate = (title: string, cost: string, instanceId: string) => ({
    methodId: "flat_rate",
    instanceId,
    title,
    cost,
    tax: "0.00",
  });
  const TODAY: RatesRead = {
    ok: true,
    currency: "USD",
    rates: [rate("Express", "12.00", "4"), rate("Standard", "5.00", "3")],
    priced: NOT_PRICED,
  };

  const aParcelShop = () => {
    const placed: ParcelSold[] = [];
    return {
      placed,
      place: async (_keys: ShopKeys, sold: ParcelSold): Promise<ParcelMade> => {
        placed.push(sold);
        return {
          ok: true,
          id: String(29 + placed.length),
          number: String(29 + placed.length),
          total: sold.total.amount,
        };
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
    // Sold on the test channel, so the shop's order is marked as paid in test USDC.
    expect(shop.placed[0]).toMatchObject({
      orderId: "ord_1",
      test: true,
      productId: "28",
      email: MERCHANT_EMAIL,
      total: { amount: "25.00", currency: "USD" },
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
      parcelParts(memoryWooShops(), shop.place, {
        offered: boundAt("accepted-parcel-fingerprint", "32.00"),
      }),
      NO_SPLIT,
    );

    expect(answer).toStrictEqual({ accepted: {} });
    expect(shop.placed[0]?.rate).toStrictEqual(rate("Express", "12.00", "4"));
  });

  it("refuses an order from a shop calculating no tax whose cart taxes the rate, and posts nothing", async () => {
    // The order's tax must be nothing in such a shop, so a rate carrying tax
    // is no price it can be filled at.
    const shops = memoryWooShops();
    const shop = aParcelShop();

    const answer = await fillFromTheShop(
      parcelOrder(),
      connection(),
      MERCHANT_EMAIL,
      parcelParts(shops, shop.place, {
        shippingRates: async () => ({
          ok: true,
          currency: "USD",
          rates: [{ ...rate("Standard", "5.00", "3"), tax: "0.55" }],
          priced: NOT_PRICED,
        }),
      }),
      NO_SPLIT,
    );

    expect(answer).toMatchObject({ refused: { code: "cannot_fulfill" } });
    expect(shop.placed).toHaveLength(0);
  });

  it("keeps the total a parcel's order recorded in the shop a cent from what was paid", async () => {
    const shops = memoryWooShops();

    await fillFromTheShop(
      parcelOrder(),
      connection(),
      MERCHANT_EMAIL,
      parcelParts(shops, async () => ({ ok: true, id: "30", number: "30", total: "25.01" })),
      NO_SPLIT,
    );

    expect(await shops.shopTotals("acc_1", ["ord_1"])).toStrictEqual({
      ord_1: { total: "25.01", converted: null },
    });
  });

  it("refuses an order whose shipping no longer costs what was paid, and posts nothing", async () => {
    const shops = memoryWooShops();
    const shop = aParcelShop();

    const answer = await fillFromTheShop(
      parcelOrder(),
      connection(),
      MERCHANT_EMAIL,
      parcelParts(shops, shop.place, {
        shippingRates: async () => ({
          ok: true,
          currency: "USD",
          rates: [rate("Standard", "6.00", "3")],
          priced: NOT_PRICED,
        }),
      }),
      NO_SPLIT,
    );

    expect(answer).toMatchObject({ refused: { code: "cannot_fulfill" } });
    expect(shop.placed).toHaveLength(0);
    expect(await shops.knownOrder("ord_1")).toStrictEqual({ kind: "precreate_refused" });
  });

  it("refuses an order whose product changed since its price, and posts nothing", async () => {
    for (const changed of [
      { offered: boundAt("an-earlier-parcel") },
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
            tax: { mode: "off" as const },
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

    for (const [overrides, reason] of [
      [{ inspectProduct: async () => RULED_OUT }, /product.*no longer.*parcel/i],
      [{ offered: boundAt("an-earlier-parcel") }, /product changed.*quoted/i],
      [
        {
          inspectProduct: async (): Promise<ProductInspection> =>
            showing({
              kind: "download",
              productId: "28",
              downloadId: "dl",
              fileName: "Tote.pdf",
              price: { amount: "20.00", currency: "USD" },
              fingerprint: "accepted-parcel-fingerprint",
              tax: { mode: "off" },
            }),
        },
        /product.*no longer.*parcel/i,
      ],
      [
        {
          shippingRates: async (): Promise<RatesRead> => ({
            ok: true,
            currency: "USD",
            rates: [rate("Standard", "6.00", "3")],
            priced: NOT_PRICED,
          }),
        },
        /shipping.*no longer costs.*paid/i,
      ],
    ] satisfies readonly (readonly [Partial<Filling>, RegExp])[]) {
      expect(await refusalWith(overrides)).toMatch(reason);
    }

    // Where the answer could not be read, none of those is true.
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
      expect(message, what).toMatch(
        what === "a cart holding two"
          ? /cart.*shipping.*could not be read or trusted/i
          : /answer.*product check.*could not be read or trusted/i,
      );
      expect(message, what).toMatch(/no WooCommerce order was created/i);
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
      expect(message, what).toMatch(/cart.*offered no shipping.*place.*sale/i);
      expect(message, what).toMatch(/no WooCommerce order was created/i);
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
        {
          shippingRates: async () => ({
            ok: true as const,
            currency: "USD",
            rates: [],
            priced: NOT_PRICED,
          }),
        },
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

describe("a parcel from a shop that calculates tax", () => {
  // The tax probe's shops and the carts they answered for the tote bag at
  // 20.00 with taxable shipping, in the shape the cart read gives them.
  const DENPASAR = { country: "ID", state: "BA", city: "Denpasar", postal_code: "80361" };
  const BERLIN = { country: "DE", state: "DE-BE", city: "Berlin", postal_code: "10115" };
  const JAKARTA = { country: "ID", state: "JK", city: "Jakarta", postal_code: "10110" };
  const SAN_FRANCISCO = { country: "US", state: "CA", city: "San Francisco", postal_code: "94105" };
  const PARIS = { country: "FR", city: "Paris", postal_code: "75001" };
  const SEATTLE = { country: "US", state: "WA", city: "Seattle", postal_code: "98101" };
  const rate = (instanceId: string, title: string, cost: string, tax: string) => ({
    methodId: "flat_rate",
    instanceId,
    title,
    cost,
    tax,
  });
  const cartPricing = (
    total: string,
    [goodsBeforeTax, goods]: readonly [string, string],
    taxes: string[],
    cheapest: ReturnType<typeof rate>,
  ): RatesRead => ({
    ok: true,
    currency: "USD",
    rates: [cheapest],
    priced: { ok: true, total, goodsBeforeTax, goods, taxes, rate: cheapest },
  });
  const CARTS: Readonly<Record<string, RatesRead>> = {
    Denpasar: cartPricing(
      "23.33",
      ["18.02", "20.00"],
      ["PPN 11%"],
      rate("1", "Bali courier", "3.00", "0.33"),
    ),
    Jakarta: cartPricing(
      "25.55",
      ["18.02", "20.00"],
      ["PPN 11%"],
      rate("3", "Standard", "5.00", "0.55"),
    ),
    "San Francisco": cartPricing(
      "25.52",
      ["18.02", "18.02"],
      [],
      rate("2", "Standard", "7.50", "0.00"),
    ),
    Berlin: cartPricing(
      "25.83",
      ["16.81", "20.00"],
      ["MwSt. 19%"],
      rate("8", "Paket", "4.90", "0.93"),
    ),
    // The German shop keeping one gross price for every buyer: its Paris cart
    // keeps the goods at 20.00 under the French rate, and its order to the
    // same address came to 32.05.
    Paris: cartPricing(
      "31.88",
      ["16.67", "20.00"],
      ["TVA 20%"],
      rate("11", "Standard", "9.90", "1.98"),
    ),
    Seattle: cartPricing(
      "28.74",
      ["20.00", "22.11"],
      ["Seattle 4.05%", "WA State 6.5%"],
      rate("12", "Standard", "6.00", "0.63"),
    ),
  };
  const theTote = (
    tax: ShopTax,
    fingerprint = "accepted-parcel-fingerprint",
  ): ProductInspection => ({
    ok: true,
    product: {
      kind: "parcel",
      productId: "28",
      price: { amount: "20.00", currency: "USD" },
      tax,
      fingerprint,
    },
  });
  const IN_BALI = theTote({ mode: "included", base: DENPASAR });
  const IN_BERLIN = theTote({ mode: "included", base: BERLIN });
  const IN_SEATTLE = theTote({ mode: "excluded" });
  const NOW = "2026-09-14T12:00:00.000Z";
  const item = merchantItemIdFor("https://shop.example.com", "28");

  /** The carts asked, by city, and the parts that answer them. */
  const parts = (inspected: ProductInspection, shops = memoryWooShops()) => {
    const asked: string[] = [];
    return {
      asked,
      shops,
      filling: {
        shops,
        now: () => new Date(NOW),
        inspectProduct: async () => inspected,
        shippingRates: async (
          _connection: WooConnection,
          _productId: string,
          where: ShipToLocality,
        ) => {
          asked.push(where.city);
          return (
            CARTS[where.city] ?? {
              ok: true as const,
              currency: "USD",
              rates: [],
              priced: NOT_PRICED,
            }
          );
        },
      } satisfies Filling,
    };
  };
  const quoted = (filling: Filling, place: ShipToLocality) =>
    quoteFromTheShop(
      connection(),
      {
        merchant_item_id: item,
        price_id: "prc_parcel",
        purpose: "purchase",
        expires_at: "2026-09-14T12:01:00.000Z",
        ship_to: place,
      },
      new Date(NOW),
      filling,
    ).then((result) => result?.answer ?? null);

  it("prices a parcel from a shop entering prices before tax at its cart's whole price for the place", async () => {
    const shop = parts(IN_SEATTLE);

    expect(await quoted(shop.filling, SEATTLE)).toStrictEqual({
      available: true,
      quote_reference: expect.stringMatching(/^[A-Za-z0-9_-]{1,512}$/),
      price: { amount: "28.74", currency: "USD" },
      as_of: NOW,
    });
    expect(shop.asked).toStrictEqual(["Seattle"]);
  });

  it("prices an inclusive shop's parcel at its cart's whole price where the place is taxed as the shop's own address", async () => {
    const shop = parts(IN_BALI);

    expect(await quoted(shop.filling, JAKARTA)).toStrictEqual({
      available: true,
      quote_reference: expect.stringMatching(/^[A-Za-z0-9_-]{1,512}$/),
      price: { amount: "25.55", currency: "USD" },
      as_of: NOW,
    });
    expect([...shop.asked].sort()).toStrictEqual(["Denpasar", "Jakarta"]);
  });

  it("names no price before payment where an inclusive shop taxes the place otherwise than its own address", async () => {
    // No tax for San Francisco, and the French rate for Paris where the shop
    // keeps one gross price, whose order would not charge what its cart does.
    for (const [inspected, place] of [
      [IN_BALI, SAN_FRANCISCO],
      [IN_BERLIN, PARIS],
    ] as const) {
      const shop = parts(inspected);

      expect(await quoted(shop.filling, place), place.city).toStrictEqual({
        available: false,
        as_of: NOW,
      });
    }
  });

  it("names no price where an inclusive shop's cart taxes the goods otherwise than at its own address, whatever its tax lines say", async () => {
    // The German shop keeping one gross price, with its tax totals shown as a
    // single line, so that its carts carry none: the Paris cart charged 31.88
    // and the order made for it 32.05; its own address sells without them.
    const single = (cart: RatesRead): RatesRead =>
      cart.ok && cart.priced.ok ? { ...cart, priced: { ...cart.priced, taxes: [] } } : cart;
    const shop = parts(IN_BERLIN);
    const filling: Filling = {
      ...shop.filling,
      shippingRates: async (_connection, _productId, where) =>
        single(CARTS[where.city] ?? { ok: true, currency: "USD", rates: [], priced: NOT_PRICED }),
    };

    expect(await quoted(filling, PARIS)).toStrictEqual({ available: false, as_of: NOW });
    expect(
      await quoted(filling, { country: "DE", city: "Berlin", postal_code: "10115" }),
    ).toMatchObject({
      available: true,
    });
  });

  it("prices an inclusive shop's parcel whose cart rounds the goods' two halves a cent over the price, and no further", async () => {
    // The review's Berlin shop at 20%, a product at 1.11 sold at the shop's
    // own address: the cart holds the goods at 0.93 before tax and 0.19 of
    // tax, 1.12 between them, and totals 6.99 with 4.90 of shipping and its
    // 0.98, which is right for 1.11.
    const at = (goods: string, total: string): RatesRead =>
      cartPricing(total, ["0.93", goods], ["R1 20%"], rate("8", "Paket", "4.90", "0.98"));
    const atBerlin = { country: "DE", city: "Berlin", postal_code: "10115" };
    for (const [goods, total, answer] of [
      ["1.12", "6.99", { available: true, price: { amount: "6.99", currency: "USD" } }],
      ["1.13", "7.00", { available: false }],
    ] as const) {
      const shop = parts({
        ok: true,
        product: {
          kind: "parcel",
          productId: "28",
          price: { amount: "1.11", currency: "USD" },
          tax: { mode: "included", base: BERLIN },
          fingerprint: "accepted-parcel-fingerprint",
        },
      });
      const filling: Filling = { ...shop.filling, shippingRates: async () => at(goods, total) };

      expect(await quoted(filling, atBerlin), goods).toMatchObject(answer);
    }
  });

  it("names no price where the place's cart holds the goods at another price than the product's", async () => {
    // As a shop's plugin that changes prices in the cart alone makes it: the
    // order made through the admin interface would charge the product's own
    // price. The carts are the probe's with the goods at 18.00 before tax.
    for (const [inspected, place, cart] of [
      [
        IN_SEATTLE,
        SEATTLE,
        cartPricing(
          "26.52",
          ["18.00", "19.89"],
          ["Seattle 4.05%", "WA State 6.5%"],
          rate("12", "Standard", "6.00", "0.63"),
        ),
      ],
      [
        IN_BALI,
        JAKARTA,
        cartPricing(
          "23.53",
          ["16.20", "17.98"],
          ["PPN 11%"],
          rate("3", "Standard", "5.00", "0.55"),
        ),
      ],
    ] as const) {
      const shop = parts(inspected);
      const filling: Filling = {
        ...shop.filling,
        shippingRates: async (_connection, _productId, where) =>
          where.city === place.city ? cart : (CARTS[where.city] ?? cart),
      };

      expect(await quoted(filling, place), place.city).toStrictEqual({
        available: false,
        as_of: NOW,
      });
    }
  });

  it("gives no price where the inclusive shop's cart for its own address cannot be read", async () => {
    // An answer that could not be read said nothing, and the silence refuses
    // the sale on a WooCommerce card.
    const shop = parts(IN_BALI);
    const filling: Filling = {
      ...shop.filling,
      shippingRates: async (_connection, _productId, where) =>
        where.city === "Denpasar"
          ? { ok: true, currency: "USD", rates: [], priced: NOT_PRICED }
          : (CARTS[where.city] ?? { ok: true, currency: "USD", rates: [], priced: NOT_PRICED }),
    };

    expect(await quoted(filling, JAKARTA)).toBeNull();
  });

  const ADDRESS_IN = (place: ShipToLocality) => ({
    name: "Probe Buyer",
    line_one: "1 Probe Street",
    city: place.city,
    ...(place.state === undefined ? {} : { state: place.state }),
    ...(place.postal_code === undefined ? {} : { postal_code: place.postal_code }),
    country: place.country,
    phone_number: "+10000000000",
  });
  const paidFor = (place: ShipToLocality, amount: string): Order =>
    anOrder({
      merchant_item_id: item,
      price: { amount, currency: "USD", at: NOW, as_of: NOW },
      price_id: "prc_parcel",
      ship_to: ADDRESS_IN(place),
    });
  const aParcelShop = () => {
    const placed: ParcelSold[] = [];
    return {
      placed,
      place: async (_keys: ShopKeys, sold: ParcelSold): Promise<ParcelMade> => {
        placed.push(sold);
        return { ok: true, id: "336", number: "336", total: sold.total.amount };
      },
    };
  };
  const filled = (filling: Filling, order: Order, shop: ReturnType<typeof aParcelShop>) =>
    fillFromTheShop(
      order,
      connection(),
      MERCHANT_EMAIL,
      {
        ...filling,
        placeParcel: shop.place,
        offered: boundAt("accepted-parcel-fingerprint", order.price.amount),
      },
      NO_SPLIT,
    );

  it("places a taxed parcel at the rate its cart priced while the cart still charges what was paid", async () => {
    for (const [inspected, place, paid, mode] of [
      [IN_SEATTLE, SEATTLE, "28.74", "excluded"],
      [IN_BALI, JAKARTA, "25.55", "included"],
    ] as const) {
      const shop = aParcelShop();

      const answer = await filled(parts(inspected).filling, paidFor(place, paid), shop);

      expect(answer, place.city).toStrictEqual({ accepted: {} });
      const cart = CARTS[place.city];
      expect(shop.placed, place.city).toMatchObject([
        {
          total: { amount: paid, currency: "USD" },
          rate: cart?.ok && cart.priced.ok ? cart.priced.rate : null,
          tax: mode,
        },
      ]);
    }
  });

  it("refuses a taxed parcel whose cart no longer charges what was paid, and posts nothing", async () => {
    // Paid at the Seattle cart's 28.74; its cart now says 28.11, as it did
    // with the shipping untaxed.
    const shop = aParcelShop();
    const shops = memoryWooShops();
    const filling: Filling = {
      ...parts(IN_SEATTLE, shops).filling,
      shippingRates: async () =>
        cartPricing(
          "28.11",
          ["20.00", "22.11"],
          ["Seattle 4.05%", "WA State 6.5%"],
          rate("13", "Standard", "6.00", "0.00"),
        ),
    };

    const answer = await filled(filling, paidFor(SEATTLE, "28.74"), shop);

    expect(answer).toMatchObject({ refused: { code: "cannot_fulfill" } });
    expect(shop.placed).toHaveLength(0);
    expect(await shops.knownOrder("ord_1")).toStrictEqual({ kind: "precreate_refused" });
  });

  it("refuses an inclusive shop's parcel to a place not taxed as its own address, and posts nothing", async () => {
    // Paid at the Paris cart's 31.88: the order to that address came to 32.05.
    const shop = aParcelShop();

    const answer = await filled(parts(IN_BERLIN).filling, paidFor(PARIS, "31.88"), shop);

    expect(answer).toMatchObject({ refused: { code: "cannot_fulfill" } });
    expect(shop.placed).toHaveLength(0);
  });

  /**
   * A shop answering the product check in process from its settings, the way
   * `wc/v3` answers each setting and each settings group.
   */
  const aShopSetTo =
    (settings: Readonly<Record<string, string>>): WooRequest =>
    async (url) => {
      const path = new URL(url).pathname;
      if (path === "/protected/guide.txt") return new Response(null, { status: 403 });
      if (path.endsWith("/settings/tax") || path.endsWith("/settings/general")) {
        return Response.json(Object.entries(settings).map(([id, value]) => ({ id, value })));
      }
      if (path.includes("/settings/")) {
        const id = path.split("/").at(-1) ?? "";
        return Response.json({ id, value: settings[id] ?? "" });
      }
      const parcel = path.endsWith("/28");
      return Response.json({
        id: parcel ? 28 : 11,
        type: "simple",
        status: "publish",
        purchasable: true,
        stock_status: "instock",
        manage_stock: false,
        sold_individually: false,
        virtual: !parcel,
        downloadable: !parcel,
        download_limit: -1,
        download_expiry: -1,
        price: parcel ? "20.00" : "25.00",
        downloads: parcel
          ? []
          : [
              {
                id: "dl_guide",
                name: "Guide",
                file: "https://shop.example.com/protected/guide.txt",
              },
            ],
      });
    };
  const BALI_SETTINGS = {
    woocommerce_currency: "USD",
    woocommerce_calc_taxes: "yes",
    woocommerce_price_num_decimals: "2",
    woocommerce_file_download_method: "force",
    woocommerce_downloads_require_login: "no",
    woocommerce_downloads_grant_access_after_payment: "yes",
    woocommerce_downloads_redirect_fallback_allowed: "no",
    woocommerce_ship_to_countries: "",
    woocommerce_ship_to_destination: "shipping",
    woocommerce_prices_include_tax: "yes",
    woocommerce_tax_display_shop: "incl",
    woocommerce_tax_based_on: "shipping",
    woocommerce_tax_round_at_subtotal: "no",
    woocommerce_default_country: "ID:BA",
    woocommerce_store_city: "Denpasar",
    woocommerce_store_postcode: "80361",
  } as const;
  const BALI_AT_SUBTOTAL = { ...BALI_SETTINGS, woocommerce_tax_round_at_subtotal: "yes" };

  it("names no price for a download from a shop rounding tax per line, and prices it rounding at the subtotal", async () => {
    // The Berlin shop with a 10% rate and a 5% compound one: its download at
    // 1.00 was paid 1.00 and recorded at 1.01 rounding per line, and at 1.00
    // rounding at the subtotal.
    const inBerlin = {
      ...BALI_SETTINGS,
      woocommerce_default_country: "DE:DE-BE",
      woocommerce_store_city: "Berlin",
      woocommerce_store_postcode: "10115",
    };
    for (const [round, answer] of [
      ["no", { available: false }],
      ["yes", { available: true, price: { amount: "25.00", currency: "USD" } }],
    ] as const) {
      const filling: Filling = {
        ...parts(IN_BERLIN).filling,
        inspectProduct: (keys, itemId) =>
          inspectProductInTheShop(
            keys,
            itemId,
            aShopSetTo({ ...inBerlin, woocommerce_tax_round_at_subtotal: round }),
          ),
      };
      const answered =
        (
          await quoteFromTheShop(
            connection(),
            {
              merchant_item_id: merchantItemIdFor("https://shop.example.com", "11"),
              price_id: `prc_download_${round}`,
              purpose: "purchase",
              expires_at: "2026-09-14T12:01:00.000Z",
            },
            new Date(NOW),
            filling,
          )
        )?.answer ?? null;

      expect(answered, round).toMatchObject(answer);
    }
  });

  it("names no price before payment from an inclusive shop rounding tax per line, and prices it rounding at the subtotal", async () => {
    // The review's Berlin shop with a 10% rate and a 5% compound one on 3.00
    // of taxable shipping, sold at its own address. The compound rate's tax
    // on the shipping is 5% of 3.30, 0.165: the cart rounded it up to a total
    // of 23.47 and the order, rounding per line, down to 23.46. Rounding at
    // the subtotal, both said 23.47.
    const compound = cartPricing(
      "23.47",
      ["17.32", "20.00"],
      ["R1 10%", "R2 5%"],
      rate("8", "Paket", "3.00", "0.47"),
    );
    const inBerlin = {
      ...BALI_SETTINGS,
      woocommerce_default_country: "DE:DE-BE",
      woocommerce_store_city: "Berlin",
      woocommerce_store_postcode: "10115",
    };
    for (const [round, answer] of [
      ["no", { available: false }],
      ["yes", { available: true, price: { amount: "23.47", currency: "USD" } }],
    ] as const) {
      const filling: Filling = {
        ...parts(IN_BERLIN).filling,
        inspectProduct: (keys, itemId) =>
          inspectProductInTheShop(
            keys,
            itemId,
            aShopSetTo({ ...inBerlin, woocommerce_tax_round_at_subtotal: round }),
          ),
        shippingRates: async () => compound,
      };

      expect(
        await quoted(filling, { country: "DE", city: "Berlin", postal_code: "10115" }),
        round,
      ).toMatchObject(answer);
    }
  });

  it("refuses before any order is made when a tax setting changed between the quote and the payment", async () => {
    for (const [what, product, before, after, place] of [
      [
        "the shop's own address",
        "28",
        BALI_AT_SUBTOTAL,
        { ...BALI_AT_SUBTOTAL, woocommerce_store_postcode: "80111" },
        JAKARTA,
      ],
      [
        "tax turned on under a download",
        "11",
        { ...BALI_AT_SUBTOTAL, woocommerce_calc_taxes: "no" },
        BALI_AT_SUBTOTAL,
        null,
      ],
      ["a download's rounding", "11", BALI_AT_SUBTOTAL, BALI_SETTINGS, null],
    ] as const) {
      let settings: Readonly<Record<string, string>> = before;
      const shops = memoryWooShops();
      const shop = aParcelShop();
      const downloads = aShopThatAccepts();
      const merchantItemId = merchantItemIdFor("https://shop.example.com", product);
      const filling: Filling = {
        ...parts(IN_BALI, shops).filling,
        inspectProduct: (keys, itemId) =>
          inspectProductInTheShop(keys, itemId, aShopSetTo(settings)),
        placeParcel: shop.place,
        placeOrder: downloads.place,
      };
      const question = {
        merchant_item_id: merchantItemId,
        price_id: "prc_changed",
        purpose: "purchase" as const,
        expires_at: "2026-09-14T12:01:00.000Z",
        ...(place === null ? {} : { ship_to: place }),
      };

      const answer =
        (await quoteFromTheShop(connection(), question, new Date(NOW), filling))?.answer ?? null;
      expect(answer, what).toMatchObject({ available: true });
      settings = after;
      const price = answer?.available === true ? answer.price.amount : "";
      const order = anOrder({
        merchant_item_id: merchantItemId,
        price: { amount: price, currency: "USD", at: NOW, as_of: NOW },
        price_id: "prc_changed",
        ...(place === null ? {} : { ship_to: ADDRESS_IN(place) }),
      });
      const refused = await fillFromTheShop(order, connection(), MERCHANT_EMAIL, filling, NO_SPLIT);

      expect(refused, what).toMatchObject({ refused: { code: "cannot_fulfill" } });
      expect(shop.placed, what).toHaveLength(0);
      expect(downloads.placed, what).toHaveLength(0);
    }
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
      { id: "30", number: "30", permission: null, total: "25.00" },
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
          tax: { mode: "off" as const },
        },
      }),
      shippingRates: async () => ({
        ok: true,
        currency: "USD",
        rates: [
          {
            methodId: "flat_rate",
            instanceId: "1",
            title: "Bali courier",
            cost: "3.00",
            tax: "0.00",
          },
        ],
        priced: NOT_PRICED,
      }),
      placeParcel: async (_keys, sold) => {
        placed.push(sold);
        return { ok: true, id: "30", number: "30", total: sold.total.amount };
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
          const answer =
            (
              await quoteFromTheShop(
                connected,
                QuoteRequestSchema.parse(question),
                new Date(harnessed.now()),
                parts,
              )
            )?.answer ?? null;
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
    const { order_id: orderId, status_url: statusUrl } = bought.body as AgentOrderStatus;
    const paidFor = await gateway.getOrder(orderId);
    expect(paidFor.ok && paidFor.document.price.amount).toBe("23.00");
    expect(paidFor.ok && paidFor.document.ship_to).toMatchObject({ erased_at: expect.any(String) });
    expect(placed).toHaveLength(1);
    expect(placed[0]?.address).toStrictEqual(ADDRESS);
    const waiting = await served.call("GET", new URL(statusUrl).pathname);
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

    const read = await served.call("GET", new URL(statusUrl).pathname);
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
          tax: { mode: "off" as const },
        },
      }),
      shippingRates: async () => ({
        ok: true,
        currency: "USD",
        rates: [
          {
            methodId: "flat_rate",
            instanceId: "1",
            title: "Bali courier",
            cost: "3.00",
            tax: "0.00",
          },
        ],
        priced: NOT_PRICED,
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
          const answer =
            (
              await quoteFromTheShop(
                connected,
                QuoteRequestSchema.parse(question),
                new Date(harnessed.now()),
                parts,
              )
            )?.answer ?? null;
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
      publisherFor: noCatalogueMutation,
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
      publisherFor: noCatalogueMutation,
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
    await shops.recordOrder(
      "ord_1",
      { id: "30", number: "30", permission: null, total: "25.00" },
      new Date(),
    );
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
      publisherFor: noCatalogueMutation,
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
    offered: quotedFingerprint === null ? null : boundAt(quotedFingerprint),
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
      publisherFor: noCatalogueMutation,
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

  it("names an order whose answer the gateway did not take by its identifier", async () => {
    const shop = aShopThatAccepts();
    const gateway = {
      pollWorker: async () => ({
        ok: true as const,
        document: {
          envelopes: [
            {
              id: "env_order",
              kind: "order" as const,
              sent_at: new Date().toISOString(),
              payload: anOrder(),
            },
          ],
        },
      }),
      paidInto: async () => ({ ok: true as const, document: NO_SPLIT }),
      answerOrder: async () => ({ ok: false as const, status: 409, why: "the order is over" }),
    } as never;
    const parts = {
      ...filling(memoryWooShops(), shop.place),
      identity: {
        byId: async () => ({
          id: "acc_1",
          email: MERCHANT_EMAIL,
          confirmed: true,
          merchant: { id: "mer_1" },
        }),
      },
      publisherFor: noCatalogueMutation,
      clientFor: () => gateway,
    };

    const written = await loggedWhile(() => turnOnce(connection(), parts));

    expect(written).toContain("the order is over");
    expect(written).toMatch(/answer.*order/i);
    expect(written).toContain("ord_1");
  });

  it("names an order whose delivery could not be bound without the buyer's download secrets", async () => {
    // The shop's order key and the buyer's uid open that buyer's download.
    const shops = memoryWooShops();
    const unbound: WooShops = {
      ...shops,
      recordOrder: async () => false,
      knownOrder: async () => null,
    };
    const place = async (_keys: ShopKeys, sold: SoldItem): Promise<OrderMade> => ({
      ok: true,
      id: "57",
      number: "57",
      orderKey: "wc_order_fixture",
      downloadId: sold.download.id,
      total: sold.price.amount,
    });
    const paid = { paidInto: async () => ({ ok: true as const, document: NO_SPLIT }) };

    let answer: unknown;
    const written = await loggedWhile(async () => {
      answer = await filledAsPaid(
        paid as never,
        anOrder(),
        connection(),
        MERCHANT_EMAIL,
        filling(unbound, place),
      );
    });

    expect(answer).toBeNull();
    expect(written).toContain("not durably bound");
    expect(written).toContain(`order ${anOrder().id}`);
    expect(written).not.toContain("wc_order_");
    expect(written).not.toContain("download_file");
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
  it("delivers a paid download with one handover while every paid cart waits for a replacement", async () => {
    const application = await harness();
    const shops = memoryWooShops();
    const connected = connection();
    const { cards } = cardsFromTheShop([aProduct()], connected.shopUrl);
    await application.gateway.sellThrough(application.merchant.id, "woocommerce");
    const gateway = gatewayFor(application.gateway, {
      merchantId: application.merchant.id,
      email: MERCHANT_EMAIL,
    });
    const published = await gateway.publishCard(cards[0]?.card ?? ({} as never));
    if (!published.ok || !published.document.ok)
      throw new Error("The download card was not published.");
    const pricing = workUntilStopped(application, {
      through: "woocommerce",
      onQuote: () => ({
        available: true,
        price: { amount: "25.00", currency: "USD" },
        as_of: new Date(application.now()).toISOString(),
        quote_reference: referenceFor(boundAt("accepted-download-fingerprint")),
      }),
    });
    const offer = await application.gateway.beginPurchase(published.document.id, {});
    await pricing.stop();
    if (offer.step !== "pay") throw new Error(`The download was not priced: ${offer.step}`);
    const payment = paymentNamingNoPayer(application);
    await application.gateway.payPurchase(
      offer.order.priceOffer.stamp,
      payment.payment,
      payment.fingerprint,
      undefined,
      { itemId: published.document.id, params: {} },
    );
    const orderId = offer.order.order.id;
    const at = new Date(application.now());
    // Every paid cart was opened and then retired, and a replacement was just
    // spent, so none of them can open again for ten minutes.
    await shops.startCartRuntime(connected.shopUrl, "interrupted-worker");
    for (let slot = 0; slot < 8; slot += 1) {
      await shops.claimCart(
        connected.shopUrl,
        "interrupted-worker",
        "paid",
        slot,
        `initial-${slot}`,
        at,
      );
      await shops.registerCartIdentity(
        connected.shopUrl,
        "interrupted-worker",
        "paid",
        slot,
        `initial-${slot}`,
        `retired-session-${slot}`,
      );
      await shops.finishCart(
        connected.shopUrl,
        "interrupted-worker",
        "paid",
        slot,
        `initial-${slot}`,
        null,
      );
    }
    await shops.claimCart(connected.shopUrl, "interrupted-worker", "paid", 1, "failed-repair", at);
    await shops.finishCart(
      connected.shopUrl,
      "interrupted-worker",
      "paid",
      1,
      "failed-repair",
      null,
    );
    await shops.connect(connected);
    const shop = aShopThatAccepts();
    const worker = startWooWorker({
      ...filling(shops, shop.place),
      now: () => new Date(application.now()),
      identity: {
        byId: async () => ({
          id: "acc_1",
          email: MERCHANT_EMAIL,
          confirmed: true,
          merchant: { id: application.merchant.id },
        }),
      },
      publisherFor: noCatalogueMutation,
      clientFor: (acting: { merchantId: string; email: string }) =>
        gatewayFor(application.gateway, acting),
      betweenTurnsMs: 2,
      waitSeconds: 0,
    });
    try {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if ((await application.store.orderById(orderId))?.order.state === "delivered") break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const filled = await application.store.orderById(orderId);
      expect(filled?.order.state).toBe("delivered");
      expect(filled?.order.dispatch.attempts).toBe(1);
      expect(await shops.knownOrder(orderId)).toMatchObject({ kind: "placed", id: "13" });
    } finally {
      await worker.stop();
      await application.stop();
    }
  });

  it("takes on a paid inclusive-tax parcel while free quote carts remain in cleanup", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const release = Promise.withResolvers<void>();
    const sessions = new Map<string, boolean>();
    const freeTokens = new Set<string>();
    let removing = 0;
    let issued = 0;
    const request = vi.spyOn(wooTransport, "wooRequest").mockImplementation(async (url, init) => {
      const path = new URL(url).pathname;
      const token = new Headers(init?.headers).get("cart-token") ?? `cart-${++issued}`;
      if (!sessions.has(token)) sessions.set(token, false);
      if (path.endsWith("/add-item")) {
        sessions.set(token, true);
        if (pendingPaid) freeTokens.add(token);
      }
      if (path.endsWith("/remove-item")) {
        if (freeTokens.has(token)) {
          removing += 1;
          await release.promise;
        }
        sessions.set(token, false);
      }
      const held = sessions.get(token);
      const response = {
        items: held
          ? [
              {
                key: `line-${token}`,
                id: 28,
                quantity: 1,
                totals: { line_subtotal: "1802", line_subtotal_tax: "198" },
              },
            ]
          : [],
        errors: [],
        needs_shipping: held,
        shipping_rates: held
          ? [
              {
                package_id: 0,
                items: [{ key: `line-${token}`, quantity: 1 }],
                shipping_rates: [
                  {
                    rate_id: "flat_rate:3",
                    selected: true,
                    method_id: "flat_rate",
                    instance_id: 3,
                    name: "Standard",
                    price: "500",
                    taxes: "55",
                    currency_code: "USD",
                    currency_minor_unit: 2,
                  },
                ],
              },
            ]
          : [],
        totals: {
          total_items: "1802",
          total_tax: "253",
          total_fees: "0",
          total_discount: "0",
          total_price: "2555",
          currency_code: "USD",
          currency_minor_unit: 2,
          tax_lines: [{ name: "PPN", rate: "11" }],
        },
      };
      return Response.json(response, {
        status: path.endsWith("/add-item") ? 201 : 200,
        headers: { "Cart-Token": token },
      });
    });
    const shops = memoryWooShops();
    const connected = connection();
    await shops.connect(connected);
    const locality = { country: "ID", state: "BA", city: "Denpasar", postal_code: "80361" };
    const item = merchantItemIdFor(connected.shopUrl, "28");
    const questions = Array.from({ length: 4 }, (_, index) => ({
      kind: "quote_request" as const,
      id: `free-${index}`,
      sent_at: new Date().toISOString(),
      payload: {
        merchant_item_id: item,
        price_id: `free-${index}`,
        purpose: "purchase" as const,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        ship_to: locality,
      },
    }));
    const paid = anOrder({
      id: "paid-during-free-cleanup",
      merchant_item_id: item,
      price: {
        amount: "25.55",
        currency: "USD",
        at: new Date().toISOString(),
        as_of: new Date().toISOString(),
      },
      quote_reference: referenceFor(boundAt("inclusive-parcel", "25.55")),
      ship_to: {
        ...locality,
        name: "Nuanu Reception",
        line_one: "Jl. Raya Kediri, Beraban",
        phone_number: "+62 000 0000 0000",
      },
    });
    let pendingPaid = true;
    const accepted = Promise.withResolvers<void>();
    const client = {
      pollWorker: async () => {
        const free = questions.shift();
        if (free) return { ok: true, document: { envelopes: [free] } };
        if (pendingPaid) {
          pendingPaid = false;
          return {
            ok: true,
            document: {
              envelopes: [
                {
                  kind: "order",
                  id: "paid-envelope",
                  sent_at: new Date().toISOString(),
                  payload: paid,
                },
              ],
            },
          };
        }
        return { ok: true, document: { envelopes: [] } };
      },
      paidInto: async () => ({ ok: true, document: NO_SPLIT }),
      answerOrder: async (_id: string, answer: unknown) => {
        expect(answer).toEqual({ accepted: {} });
        accepted.resolve();
        return { ok: true };
      },
    };
    const worker = startWooWorker({
      shops,
      now: () => new Date(),
      betweenTurnsMs: 2,
      waitSeconds: 0,
      identity: {
        byId: async () => ({
          id: "acc_1",
          email: MERCHANT_EMAIL,
          confirmed: true,
          merchant: { id: "mer_1" },
        }),
      },
      publisherFor: noCatalogueMutation,
      clientFor: () => client as never,
      inspectProduct: async () => ({
        ok: true,
        product: {
          kind: "parcel",
          productId: "28",
          price: { amount: "20.00", currency: "USD" },
          fingerprint: "inclusive-parcel",
          tax: { mode: "included", base: locality },
        },
      }),
      placeParcel: async (_keys, sold) => ({
        ok: true,
        id: "901",
        number: "901",
        total: sold.total.amount,
      }),
    });
    try {
      let finished = false;
      accepted.promise.then(() => {
        finished = true;
      });
      await vi.advanceTimersByTimeAsync(QUOTE_RESPONSE_MS);
      expect(finished).toBe(true);
      expect(removing).toBe(8);
      expect(await shops.knownOrder(paid.id)).toEqual({
        kind: "placed_parcel",
        id: "901",
        number: "901",
      });
    } finally {
      release.resolve();
      const stopping = worker.stop();
      await vi.runAllTimersAsync();
      await stopping;
      request.mockRestore();
    }
  });

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
      publisherFor: noCatalogueMutation,
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
    total: "25.00",
  });

  it("waits for a timed-out quote's cart cleanup before shutdown completes", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const removing = Promise.withResolvers<void>();
    const finishRemoval = Promise.withResolvers<void>();
    const emptied = Promise.withResolvers<void>();
    let removed = false;
    let held = false;
    let openedCarts = 0;
    const cart = () => ({
      items: held ? [{ key: "line-28", id: 28, quantity: 1 }] : [],
      errors: [],
      needs_shipping: held,
      shipping_rates: held
        ? [
            {
              items: [{ key: "line-28", quantity: 1 }],
              shipping_rates: [
                {
                  method_id: "flat_rate",
                  instance_id: 3,
                  name: "Standard",
                  price: "500",
                  taxes: "0",
                  currency_code: "USD",
                  currency_minor_unit: 2,
                },
              ],
            },
          ]
        : [],
    });
    const request = vi.spyOn(wooTransport, "wooRequest").mockImplementation(async (url, init) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/add-item")) held = true;
      if (path.endsWith("/remove-item")) {
        removing.resolve();
        await finishRemoval.promise;
        held = false;
        removed = true;
      }
      if (path.endsWith("/cart") && removed) emptied.resolve();
      return Response.json(cart(), {
        headers: {
          "Cart-Token":
            new Headers(init?.headers).get("cart-token") ?? `owned-cart-${++openedCarts}`,
        },
      });
    });
    const shops = memoryWooShops();
    await shops.connect(connection());
    let pending = true;
    const gateway = {
      pollWorker: async () => {
        const envelopes = pending
          ? [
              {
                kind: "quote_request",
                id: "env-price",
                sent_at: new Date().toISOString(),
                payload: {
                  merchant_item_id: merchantItemIdFor(connection().shopUrl, "28"),
                  price_id: "prc-cart",
                  purpose: "purchase",
                  expires_at: new Date(Date.now() + 60_000).toISOString(),
                  ship_to: { country: "ID", city: "Jakarta" },
                },
              },
            ]
          : [];
        pending = false;
        return { ok: true, document: { envelopes } };
      },
    };
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
      publisherFor: noCatalogueMutation,
      clientFor: () => gateway as never,
      betweenTurnsMs: 5,
      waitSeconds: 0,
      inspectProduct: async () =>
        showing({
          kind: "parcel",
          productId: "28",
          price: { amount: "20.00", currency: "USD" },
          fingerprint: "accepted-parcel-fingerprint",
          tax: { mode: "off" },
        }),
    });
    let stopping: Promise<void> | undefined;
    try {
      await removing.promise;
      await vi.advanceTimersByTimeAsync(QUOTE_RESPONSE_MS);
      let stopped = false;
      stopping = worker.stop().then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(20);
      expect(stopped).toBe(false);
      expect(held).toBe(true);
    } finally {
      finishRemoval.resolve();
      await emptied.promise;
      await (stopping ?? worker.stop());
      request.mockRestore();
    }
    expect(held).toBe(false);
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

describe("a shop whose guest carts are short", () => {
  const SHOP = "https://shop.example.com";
  const PLACE = { country: "ID", state: "BA", city: "Tabanan", postal_code: "82121" };
  const TOTE = merchantItemIdFor(SHOP, "28");

  /**
   * WooCommerce's guest cart for product 28 at a 5.00 flat rate, one session
   * per token it issues. `refuse` answers instead of the shop where it returns
   * a response.
   */
  const aGuestCart = (refuse: (path: string, token: string | null) => Response | null) => {
    const holds = new Map<string, boolean>();
    let issued = 0;
    const request = vi.spyOn(wooTransport, "wooRequest").mockImplementation(async (url, init) => {
      const path = new URL(url).pathname;
      const token = new Headers(init?.headers).get("cart-token");
      const refused = refuse(path, token);
      if (refused !== null) return refused;
      const session = token ?? `guest-${++issued}`;
      if (path.endsWith("/add-item")) holds.set(session, true);
      if (path.endsWith("/remove-item")) holds.set(session, false);
      const held = holds.get(session) === true;
      return Response.json(
        {
          items: held ? [{ key: "line-28", id: 28, quantity: 1 }] : [],
          errors: [],
          needs_shipping: held,
          shipping_rates: held
            ? [
                {
                  package_id: 0,
                  items: [{ key: "line-28", quantity: 1 }],
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
              ]
            : [],
        },
        { status: path.endsWith("/add-item") ? 201 : 200, headers: { "Cart-Token": session } },
      );
    });
    return { request, sessions: () => issued, holds };
  };

  const download = (id: string) => ({
    kind: "order" as const,
    id: `env-${id}`,
    sent_at: new Date().toISOString(),
    payload: anOrder({ id }),
  });
  const parcel = (id: string) => ({
    kind: "order" as const,
    id: `env-${id}`,
    sent_at: new Date().toISOString(),
    payload: anOrder({
      id,
      merchant_item_id: TOTE,
      price_id: `prc-${id}`,
      quote_reference: referenceFor(boundAt("accepted-parcel-fingerprint")),
      ship_to: {
        ...PLACE,
        name: "Nuanu Reception",
        line_one: "Jl. Raya Kediri, Beraban",
        phone_number: "+62 000 0000 0000",
      },
    }),
  });
  const priceOfTheGuide = {
    kind: "quote_request" as const,
    id: "env-guide-price",
    sent_at: new Date().toISOString(),
    payload: {
      merchant_item_id: anOrder().merchant_item_id,
      price_id: "prc-guide",
      purpose: "purchase" as const,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    },
  };

  /**
   * A merchant's stream as the gateway keeps it: an order nobody answered is
   * handed over again a moment later, up to thirty times.
   */
  const working = (shops: WooShops, envelopes: { kind: string; payload: unknown }[]) => {
    const waiting = [...envelopes];
    const answered = new Map<string, unknown>();
    const handedOver = new Map<string, number>();
    const client = {
      pollWorker: async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        const next = waiting.shift();
        if (next?.kind === "order") {
          const id = (next.payload as Order).id;
          handedOver.set(id, (handedOver.get(id) ?? 0) + 1);
          if (!answered.has(id) && (handedOver.get(id) ?? 0) < 30) waiting.push(next);
        }
        return { ok: true as const, document: { envelopes: next ? [next] : [] } };
      },
      paidInto: async () => ({ ok: true as const, document: NO_SPLIT }),
      answerOrder: async (id: string, answer: unknown) => {
        answered.set(id, answer);
        return { ok: true as const };
      },
      answerQuote: async (id: string, answer: unknown) => {
        answered.set(id, answer);
        return { ok: true as const };
      },
    };
    const worker = startWooWorker({
      ...filling(shops, aShopThatAccepts().place),
      now: () => new Date(),
      identity: {
        byId: async () => ({
          id: "acc_1",
          email: MERCHANT_EMAIL,
          confirmed: true,
          merchant: { id: "mer_1" },
        }),
      },
      publisherFor: noCatalogueMutation,
      clientFor: () => client as never,
      betweenTurnsMs: 2,
      waitSeconds: 0,
      inspectProduct: async (_connection, merchantItemId) =>
        merchantItemId === TOTE
          ? showing({
              kind: "parcel",
              productId: "28",
              price: { amount: "20.00", currency: "USD" },
              fingerprint: "accepted-parcel-fingerprint",
              tax: { mode: "off" },
            })
          : showing({
              kind: "download",
              productId: "11",
              downloadId: "dl_guide",
              fileName: "Guide",
              price: { amount: "25.00", currency: "USD" },
              fingerprint: "accepted-download-fingerprint",
              tax: { mode: "off" },
            }),
      placeParcel: async (_keys, sold) => ({
        ok: true,
        id: `wc-${sold.orderId}`,
        number: `wc-${sold.orderId}`,
        total: sold.total.amount,
      }),
    });
    return {
      worker,
      answered,
      offer: (envelope: { kind: string; payload: unknown }) => waiting.push(envelope),
      drained: () => waiting.length === 0,
      handedOver: (id: string) => handedOver.get(id) ?? 0,
    };
  };
  /** Counts its waits rather than reading the clock, which some cases set. */
  const within = async (condition: () => boolean, ms = 1_000) => {
    for (let waited = 0; !condition() && waited < ms; waited += 2)
      await new Promise((resolve) => setTimeout(resolve, 2));
    return condition();
  };
  const priceOfTheTote = (priceId: string) => ({
    kind: "quote_request" as const,
    id: `env-${priceId}`,
    sent_at: new Date().toISOString(),
    payload: {
      merchant_item_id: TOTE,
      price_id: priceId,
      purpose: "purchase" as const,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      ship_to: PLACE,
    },
  });

  it("keeps delivering downloads and answering prices from a shop that will not open a cart for a visitor", async () => {
    // A plugin that turns the REST API off for guests answers the cart this way.
    aGuestCart((path) =>
      path.startsWith("/wp-json/wc/store/v1/cart")
        ? Response.json(
            {
              code: "rest_cannot_access",
              message: "Only authenticated users can access the REST API.",
            },
            { status: 401 },
          )
        : null,
    );
    const shops = memoryWooShops();
    await shops.connect(connection());
    const run = working(shops, [download("ord-guide"), priceOfTheGuide]);
    try {
      expect(
        await within(() => run.answered.has("ord-guide") && run.answered.has("prc-guide")),
      ).toBe(true);
      expect(run.answered.get("ord-guide")).toMatchObject({ delivered: { file_name: "Guide" } });
      expect(run.answered.get("prc-guide")).toMatchObject({ available: true });
    } finally {
      await run.worker.stop();
    }
  });

  it("takes on a paid parcel as soon as the shop's cart answers again after a burst of errors", async () => {
    let failing = 9;
    const cart = aGuestCart((path, token) => {
      if (path !== "/wp-json/wc/store/v1/cart" || token !== null || failing === 0) return null;
      failing -= 1;
      return new Response("<html>Service Unavailable</html>", { status: 503 });
    });
    const shops = memoryWooShops();
    await shops.connect(connection());
    const run = working(shops, [parcel("ord-tote")]);
    try {
      expect(await within(() => run.answered.has("ord-tote"))).toBe(true);
      expect(run.answered.get("ord-tote")).toEqual({ accepted: {} });
      expect(failing).toBe(0);
      expect([...cart.holds.values()].every((held) => !held)).toBe(true);
    } finally {
      await run.worker.stop();
    }
  });

  it("prices parcels again ten minutes after another worker took the shop's carts over", async () => {
    aGuestCart(() => null);
    const shops = memoryWooShops();
    await shops.connect(connection());
    let time = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => time);
    const run = working(shops, [priceOfTheTote("prc-before")]);
    try {
      expect(await within(() => run.answered.has("prc-before"))).toBe(true);
      expect(run.answered.get("prc-before")).toMatchObject({
        available: true,
        price: { amount: "25.00" },
      });
      await shops.startCartRuntime(SHOP, "another-worker");
      run.offer(priceOfTheTote("prc-taken-over"));
      expect(await within(run.drained)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(run.answered.has("prc-taken-over")).toBe(false);
      // Within ten minutes the other worker keeps them, asked or not.
      run.offer(priceOfTheTote("prc-within"));
      expect(await within(run.drained)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(run.answered.has("prc-within")).toBe(false);
      expect(
        await shops.claimCart(SHOP, "another-worker", "quote", 7, "still-mine", new Date(time)),
      ).not.toEqual({ kind: "stale" });
      time += 600_001;
      // A turn under way when the clock moved still holds the old runtime.
      await new Promise((resolve) => setTimeout(resolve, 20));
      run.offer(priceOfTheTote("prc-after"));
      expect(await within(() => run.answered.has("prc-after"))).toBe(true);
      expect(run.answered.get("prc-after")).toMatchObject({ available: true });
    } finally {
      await run.worker.stop();
      clock.mockRestore();
    }
  });

  it("takes on a paid parcel when its next hand-over comes after the ten-minute replacement, having answered nothing until then", async () => {
    aGuestCart(() => null);
    const shops = memoryWooShops();
    await shops.connect(connection());
    let time = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => time);
    // Every paid cart was opened and retired, and a replacement was just spent.
    const at = new Date(time);
    await shops.startCartRuntime(SHOP, "earlier-worker");
    for (let slot = 0; slot < 8; slot += 1) {
      await shops.claimCart(SHOP, "earlier-worker", "paid", slot, `opened-${slot}`, at);
      await shops.registerCartIdentity(
        SHOP,
        "earlier-worker",
        "paid",
        slot,
        `opened-${slot}`,
        `retired-${slot}`,
      );
      await shops.finishCart(SHOP, "earlier-worker", "paid", slot, `opened-${slot}`, null);
    }
    await shops.claimCart(SHOP, "earlier-worker", "paid", 0, "replacement", at);
    await shops.registerCartIdentity(
      SHOP,
      "earlier-worker",
      "paid",
      0,
      "replacement",
      "retired-again",
    );
    await shops.finishCart(SHOP, "earlier-worker", "paid", 0, "replacement", null);
    const run = working(shops, [parcel("ord-tote")]);
    try {
      expect(await within(() => run.handedOver("ord-tote") >= 3)).toBe(true);
      expect(run.answered.has("ord-tote")).toBe(false);
      // The gateway hands it over again for three hours; ten minutes is the next replacement.
      time += 600_001;
      expect(await within(() => run.answered.has("ord-tote"))).toBe(true);
      expect(run.answered.get("ord-tote")).toEqual({ accepted: {} });
    } finally {
      await run.worker.stop();
      clock.mockRestore();
    }
  });

  it("takes on a paid parcel at once after a restart that interrupted the carts it was using", async () => {
    aGuestCart(() => null);
    const shops = memoryWooShops();
    await shops.connect(connection());
    const now = new Date();
    await shops.startCartRuntime(SHOP, "interrupted-worker");
    for (const [lane, slot] of [
      ["paid", 0],
      ["paid", 1],
      ["quote", 0],
    ] as const) {
      await shops.claimCart(SHOP, "interrupted-worker", lane, slot, `${lane}-${slot}`, now);
      await shops.registerCartIdentity(
        SHOP,
        "interrupted-worker",
        lane,
        slot,
        `${lane}-${slot}`,
        `interrupted-${lane}-${slot}`,
      );
    }
    // A replacement opened just before the restart, so none is due for ten minutes.
    await shops.finishCart(SHOP, "interrupted-worker", "quote", 0, "quote-0", null);
    await shops.claimCart(SHOP, "interrupted-worker", "quote", 0, "replacement", now);
    const run = working(shops, [parcel("ord-tote"), download("ord-guide")]);
    try {
      expect(
        await within(() => run.answered.has("ord-tote") && run.answered.has("ord-guide")),
      ).toBe(true);
      expect(run.answered.get("ord-tote")).toEqual({ accepted: {} });
    } finally {
      await run.worker.stop();
    }
  });
});

describe("a paid order that carries no quoted price", () => {
  // An order paid before the connector's price travelled with the buyer has no
  // reference, and none of the shop's answers since can tell what it was.
  const PARCEL_ADDRESS = {
    name: "Nuanu Reception",
    line_one: "Jl. Raya Kediri, Beraban",
    city: "Tabanan",
    state: "BA",
    postal_code: "82121",
    country: "ID",
    phone_number: "+62 000 0000 0000",
  };

  it.each([
    ["a download", anOrder({ quote_reference: undefined })],
    ["a download whose reference cannot be read", anOrder({ quote_reference: "bm90LWEtcHJpY2U" })],
    [
      "a parcel",
      anOrder({
        merchant_item_id: merchantItemIdFor("https://shop.example.com", "28"),
        quote_reference: undefined,
        ship_to: PARCEL_ADDRESS,
      }),
    ],
  ])("is refused as %s in words that say so, before any cart is asked", async (_kind, order) => {
    const shops = memoryWooShops();
    const shop = aShopThatAccepts();
    let cartsAsked = 0;
    const answer = await fillFromTheShop(
      order,
      connection(),
      MERCHANT_EMAIL,
      {
        ...filling(shops, shop.place),
        shippingRates: async () => {
          cartsAsked += 1;
          return { ok: false, why: "not asked", again: true };
        },
      },
      NO_SPLIT,
    );
    expect(answer).toMatchObject({ refused: { code: "cannot_fulfill" } });
    const message = answer !== null && "refused" in answer ? answer.refused.message : "";
    // Nothing is known of what changed, so the refusal says nothing changed.
    expect(message).not.toMatch(/changed/i);
    expect(cartsAsked).toBe(0);
    expect(shop.placed).toEqual([]);
    expect(await shops.knownOrder(order.id)).toMatchObject({ kind: "precreate_refused" });
  });
});

describe("a direct shop refusal during an unpaid purchase", () => {
  let h: Harness;
  let server: Server;
  let origin: string;
  let response: { status: number; body?: Record<string, unknown> };
  let rawStatus: number;
  let currency: string;
  let connected: WooConnection;
  let shops: WooShops;
  let itemId: string;
  let owner: { id: string; email: string; confirmed: boolean; merchant: { id: string } };
  const document = () => ({
    id: 11,
    name: "Agentify guide.txt",
    description: "A downloadable guide.",
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
    price: "25.00",
    tax_status: "taxable",
    downloads: [{ id: "dl_guide", name: "Guide", file: origin + "/protected/guide.txt" }],
  });
  const settings: Readonly<Record<string, string>> = {
    woocommerce_currency: "USD",
    woocommerce_price_num_decimals: "2",
    woocommerce_calc_taxes: "no",
    woocommerce_ship_to_countries: "",
    woocommerce_ship_to_destination: "shipping",
    woocommerce_file_download_method: "force",
    woocommerce_downloads_require_login: "no",
    woocommerce_downloads_grant_access_after_payment: "yes",
    woocommerce_downloads_redirect_fallback_allowed: "no",
  };
  beforeEach(async () => {
    response = { status: 200 };
    rawStatus = 403;
    currency = "USD";
    server = createServer((request, reply) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      const setting = path.split("/").at(-1) ?? "";
      const raw = path === "/protected/guide.txt";
      const status = raw ? rawStatus : path.includes("/settings/") ? 200 : response.status;
      reply.writeHead(status, { "content-type": "application/json", "X-WP-Total": "1" });
      const product = response.body ?? document();
      reply.end(
        JSON.stringify(
          raw
            ? {}
            : path.includes("/settings/")
              ? {
                  id: setting,
                  value: setting === "woocommerce_currency" ? currency : settings[setting],
                }
              : path.endsWith("/products")
                ? [product]
                : product,
        ),
      );
    });
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
    h = await harness({ QUOTE_RESPONSE_MS: "300" });
    shops = memoryWooShops();
    connected = { ...connection(), shopUrl: origin, currency: { code: "USD", decimals: 2 } };
    await shops.connect(connected);
    owner = {
      id: connected.accountId,
      email: MERCHANT_EMAIL,
      confirmed: true,
      merchant: { id: h.merchant.id },
    };
    await h.gateway.sellThrough(h.merchant.id, "woocommerce");
    const { cards } = cardsFromTheShop([aProduct()], origin);
    const published = await h.gateway.publishCard(h.merchant.id, cards[0]?.card, "woocommerce");
    if (!published.ok) throw new Error("The shop card was not published");
    itemId = published.id;
    await h.gateway.poll(h.merchant.id, 0, { through: "woocommerce" });
  });
  afterEach(async () => {
    await h?.stop();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });
  const work = (overrides: Partial<WorkingParts> = {}) =>
    turnOnce(connected, {
      shops,
      identity: { byId: async () => owner },
      clientFor: (acting) => gatewayFor(h.gateway, acting),
      publisherFor: (acting) => shopPublisherFor(h.gateway, acting, shops),
      now: () => new Date(h.now()),
      waitSeconds: 1,
      inspectProduct: (keys, item) => inspectProductInTheShop(keys, item, fetch),
      ...overrides,
    });
  const sync = async () => {
    await shops.jobs.request({
      kind: "publish",
      merchantId: h.merchant.id,
      accountId: owner.id,
      connectionRevision: connected.revision,
      shopUrl: origin,
      currency: { code: "USD", decimals: 2 },
      rate: null,
    });
    const job = await shops.jobs.claim();
    if (!job) throw new Error("No publication accepted");
    await workShopJob(job, {
      shops,
      identity: { byId: async () => owner },
      clientFor: (acting) => gatewayFor(h.gateway, acting),
      publisherFor: (acting) => shopPublisherFor(h.gateway, acting, shops),
      catalogue: (keys) => connectedCatalogue(keys, fetch),
      surfaceMode: "sandbox",
      guestCart: async () => null,
    });
  };
  it.each(["purchase", "sync"] as const)(
    "%s explains whether the shop stopped selling a product or changed its conditions",
    async (path) => {
      for (const [change, message] of [
        [{ status: "draft" }, "Off sale: your shop stopped selling it"],
        [{ type: "variable" }, "Off sale: it changed in your shop, and Agentify can't sell it now"],
      ] as const) {
        response = { status: 200, body: { ...document(), ...change } };
        if (path === "purchase") {
          const purchase = h.gateway.beginPurchase(itemId, {});
          await work();
          expect(await purchase).toMatchObject({ step: "not_selling" });
        } else await sync();
        const answer = await gatewayFor(
          h.gateway,
          { merchantId: h.merchant.id, email: owner.email },
          undefined,
          shops.cardPauses,
        ).cards();
        if (!answer.ok) throw new Error("The Products page could not read its cards.");
        expect(
          cardsView(answer.document, origin).listing.rows.find((row) => row.id === itemId)?.state
            .text,
        ).toBe(message);
        if (path === "purchase") {
          response = { status: 200 };
          await sync();
        }
      }
    },
  );
  it("withdraws a directly deleted product and a later real sync restores the same card", async () => {
    response = { status: 404, body: { code: "woocommerce_rest_product_invalid_id" } };
    const purchase = h.gateway.beginPurchase(itemId, {});
    await work();
    expect(await purchase).toMatchObject({ step: "not_selling" });
    expect(await h.store.cardById(itemId)).toMatchObject({
      paused: true,
    });
    expect((await h.gateway.catalog()).items.map((one) => one.id)).not.toContain(itemId);
    response = { status: 200 };
    await sync();
    expect(await h.store.cardById(itemId)).toMatchObject({
      paused: false,
    });
    expect((await h.gateway.catalog()).items.map((one) => one.id)).toContain(itemId);
  });
  it.each([
    ["unpublished", { status: "draft" }, 200, 403, "stopped_selling"],
    ["not offered", { purchasable: false }, 200, 403, "stopped_selling"],
    ["unsupported variation", { type: "variable" }, 200, 403, "changed"],
    ["stock tracking", { manage_stock: true }, 200, 403, "changed"],
    ["limited download", { download_limit: 1 }, 200, 403, "changed"],
    ["public file", {}, 200, 200, "changed"],
    ["public range", {}, 200, 206, "changed"],
    [
      "temporarily out of stock",
      { stock_status: "outofstock", purchasable: false },
      200,
      403,
      false,
    ],
    ["generic product 404", { code: "rest_no_route" }, 404, 403, false],
    ["revoked access", { code: "woocommerce_rest_cannot_view" }, 401, 403, false],
    ["wrong product identity", { id: 99 }, 200, 403, false],
    ["malformed price", { price: "unreadable" }, 200, 403, false],
    ["missing raw file", {}, 200, 404, false],
    ["raw redirect", {}, 200, 302, false],
    ["raw accepted", {}, 200, 202, false],
    ["raw empty", {}, 200, 204, false],
  ] as const)(
    "persists only the direct product verdict: %s",
    async (_name, change, status, raw, withdraw) => {
      response = { status, body: { ...document(), ...change } };
      rawStatus = raw;
      const purchase = h.gateway.beginPurchase(itemId, {});
      await work();
      const outcome = await purchase;
      expect(outcome.step).toBe(
        withdraw || _name === "temporarily out of stock" ? "not_selling" : "seller_busy",
      );
      expect(await h.store.cardById(itemId)).toMatchObject({
        paused: !!withdraw,
      });
      expect((await h.gateway.catalog()).items.some((one) => one.id === itemId)).toBe(!withdraw);
      expect((await shops.cardPauses.list(h.merchant.id))[itemId]?.reason ?? null).toBe(
        withdraw || null,
      );
    },
  );
  it("does not pause a product merely because no conversion rate is set", async () => {
    currency = "EUR";
    const purchase = h.gateway.beginPurchase(itemId, {});
    await work();
    expect(await purchase).toMatchObject({ step: "not_selling" });
    expect(await h.store.cardById(itemId)).toMatchObject({
      paused: false,
    });
  });
  it.each(["renewed", "other origin", "another merchant", "API selected"] as const)(
    "a held old inspection cannot pause after %s",
    async (changed) => {
      response = { status: 404, body: { code: "woocommerce_rest_product_invalid_id" } };
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const purchase = h.gateway.beginPurchase(itemId, {});
      const turned = work({
        inspectProduct: async (keys, item) => {
          const read = await inspectProductInTheShop(keys, item, fetch);
          started.resolve();
          await release.promise;
          return read;
        },
      });
      await started.promise;
      if (changed === "renewed") await shops.connect({ ...connected, revision: "grant-2" });
      if (changed === "other origin")
        await shops.connect({ ...connected, shopUrl: "https://other.example" });
      if (changed === "another merchant")
        owner = { ...owner, merchant: { id: (await h.addMerchant()).id } };
      if (changed === "API selected") await h.gateway.sellThrough(h.merchant.id, "api");
      release.resolve();
      await turned;
      expect(await purchase).toMatchObject({ step: "not_selling" });
      expect(await h.store.cardById(itemId)).toMatchObject({
        paused: false,
      });
    },
  );
  it("a timed-out inspection never pauses later when its real shop answer arrives", async () => {
    response = { status: 404, body: { code: "woocommerce_rest_product_invalid_id" } };
    const release = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const purchase = h.gateway.beginPurchase(itemId, {});
    const turning = work({
      inspectProduct: async (keys, item) => {
        await release.promise;
        const read = await inspectProductInTheShop(keys, item, fetch);
        finished.resolve();
        return read;
      },
    });
    await vi.advanceTimersByTimeAsync(QUOTE_RESPONSE_MS);
    await turning;
    expect(await purchase).toMatchObject({ step: "seller_busy" });
    vi.useRealTimers();
    release.resolve();
    await finished.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await h.store.cardById(itemId)).toMatchObject({
      paused: false,
    });
  });
  it("still tells the buyer unavailable when the owned pause cannot be confirmed", async () => {
    response = { status: 404, body: { code: "woocommerce_rest_product_invalid_id" } };
    const purchase = h.gateway.beginPurchase(itemId, {});
    const lines = await loggedWhile(() =>
      work({
        publisherFor: (acting) => ({
          ...shopPublisherFor(h.gateway, acting, shops),
          pause: async () => {
            throw new Error("cs_private should never be logged");
          },
        }),
      }),
    );
    expect(await purchase).toMatchObject({ step: "not_selling" });
    expect(await h.store.cardById(itemId)).toMatchObject({
      paused: false,
    });
    expect(JSON.stringify(lines)).not.toContain("cs_private");
  });
  it("keeps a timed-out rate read inside the original price deadline without claiming unavailable", async () => {
    currency = "EUR";
    const inspected = await inspectProductInTheShop(
      connected,
      merchantItemIdFor(origin, "11"),
      fetch,
    );
    const releaseInspection = Promise.withResolvers<void>();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const entered = Promise.withResolvers<void>();
    const purchase = h.gateway.beginPurchase(itemId, {});
    let finished = false;
    const turning = work({
      inspectProduct: async () => {
        await releaseInspection.promise;
        return inspected;
      },
      shops: {
        ...shops,
        currentRate: () => {
          entered.resolve();
          return new Promise(() => {});
        },
      },
    }).then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(8_000);
    releaseInspection.resolve();
    await entered.promise;
    await vi.advanceTimersByTimeAsync(QUOTE_RESPONSE_MS - 8_000);
    expect(finished).toBe(true);
    await turning;
    expect(await purchase).toMatchObject({ step: "seller_busy" });
    expect(await h.store.cardById(itemId)).toMatchObject({
      paused: false,
    });
  });

  const address = {
    name: "Nuanu Reception",
    line_one: "Jl. Raya Kediri, Beraban",
    city: "Tabanan",
    state: "BA",
    postal_code: "82121",
    country: "ID",
    phone_number: "+62 000 0000 0000",
  };
  const parcel = async () => {
    const { cards } = cardsFromTheShop(
      [
        aProduct({
          id: 28,
          virtual: false,
          downloadable: false,
          downloads: [],
        }),
      ],
      origin,
    );
    const made = await h.gateway.publishCard(h.merchant.id, cards[0]?.card, "woocommerce");
    if (!made.ok) throw new Error("Parcel was not published");
    response = {
      status: 200,
      body: { ...document(), id: 28, virtual: false, downloadable: false, downloads: [] },
    };
    return made.id;
  };
  it("withdraws a directly deleted parcel even while its concurrent cart never answers", async () => {
    const id = await parcel();
    response = { status: 404, body: { code: "woocommerce_rest_product_invalid_id" } };
    const purchase = h.gateway.beginPurchase(id, {}, address);
    await work({ shippingRates: () => new Promise(() => {}) });
    expect(await purchase).toMatchObject({ step: "not_selling" });
    expect(await h.store.cardById(id)).toMatchObject({
      paused: true,
    });
  });
  it.each(["restriction", "no rate", "another currency"] as const)(
    "a buyer-specific cart %s never pauses an eligible parcel",
    async (refusal) => {
      const id = await parcel();
      const cart = aCartHoldingTheTote(1, refusal === "restriction" ? [A_CART_ERROR] : []);
      const request: WooRequest = async (url, init) => {
        const reply = await cart(url, init);
        const body = await reply.json();
        if (refusal === "no rate") for (const pack of body.shipping_rates) pack.shipping_rates = [];
        if (refusal === "another currency")
          for (const pack of body.shipping_rates)
            for (const rate of pack.shipping_rates) rate.currency_code = "EUR";
        return Response.json(body, { status: reply.status, headers: reply.headers });
      };
      const purchase = h.gateway.beginPurchase(id, {}, address);
      await work({
        shippingRates: (keys, product, where) =>
          shippingRatesInTheShop(keys.shopUrl, product, where, request),
      });
      expect(await purchase).toMatchObject({ step: "not_selling" });
      expect(await h.store.cardById(id)).toMatchObject({
        paused: false,
      });
    },
  );

  it("seller ownership wins a delayed withdrawal and a subsequent sync keeps that pause", async () => {
    response = { status: 404, body: { code: "woocommerce_rest_product_invalid_id" } };
    const atCards = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const purchase = h.gateway.beginPurchase(itemId, {});
    const turning = work({
      publisherFor: (acting) => {
        const publisher = shopPublisherFor(h.gateway, acting, shops);
        return {
          ...publisher,
          cards: async () => {
            const cards = await publisher.cards();
            atCards.resolve();
            await release.promise;
            return cards;
          },
        };
      },
    });
    await atCards.promise;
    expect(await purchase).toMatchObject({ step: "not_selling" });
    await h.gateway.setCardPaused(h.merchant.id, itemId, true, {
      kind: "signed_in",
      email: MERCHANT_EMAIL,
    });
    release.resolve();
    await turning;
    expect(await h.store.cardById(itemId)).toMatchObject({
      paused: true,
    });
    response = { status: 200 };
    await sync();
    expect(await h.store.cardById(itemId)).toMatchObject({
      paused: true,
    });
    expect((await h.gateway.catalog()).items.map((one) => one.id)).not.toContain(itemId);
  });
  it("a withdrawal changes neither another merchant's same product nor an SDK card", async () => {
    const other = await h.addMerchant();
    await h.gateway.sellThrough(other.id, "woocommerce");
    const stored = await h.store.cardById(itemId);
    if (!stored) throw new Error("Missing published card");
    const otherCard = await h.gateway.publishCard(other.id, stored.card, "woocommerce");
    await h.gateway.sellThrough(h.merchant.id, "api");
    const sdk = await h.gateway.publishCard(h.merchant.id, {
      ...stored.card,
      merchant_item_id: "sdk-control",
    });
    await h.gateway.sellThrough(h.merchant.id, "woocommerce");
    await h.gateway.poll(h.merchant.id, 0, { through: "woocommerce" });
    if (!otherCard.ok || !sdk.ok) throw new Error("Control cards were not published");
    response = { status: 404, body: { code: "woocommerce_rest_product_invalid_id" } };
    const purchase = h.gateway.beginPurchase(itemId, {});
    await work();
    expect(await purchase).toMatchObject({ step: "not_selling" });
    expect(await h.store.cardById(itemId)).toMatchObject({
      paused: true,
    });
    for (const id of [otherCard.id, sdk.id])
      expect(await h.store.cardById(id)).toMatchObject({
        paused: false,
      });
  });
});
