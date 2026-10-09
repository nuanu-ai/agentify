/**
 * What happens to a paid order on a card that came from a WooCommerce shop.
 *
 * The whole path is here and nothing in the middle of it is stubbed: a real
 * gateway on in-memory adapters, a card converted from a shop's own catalogue
 * and published through the ordinary publish door, a purchase made over HTTP
 * with a payment, and a shop answering on loopback. What the last test asserts
 * is the sentence the work exists for — after a paid order on a woo-imported
 * card, a paid order exists in the shop, and the buyer is handed its number.
 *
 * The shop here is a small server rather than a WooCommerce. What it stands in
 * for is measured: `docs/research/33-woo-connect-probe.md` records a real shop
 * answering `POST wc/v3/orders` with `set_paid: true` under 201, with the order
 * then agreeing with itself in four independent places.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buyOverHttp, type Harness, harness, type Served, serve } from "@agentify/gateway/testing";
import type { AgentOrderStatus, Order } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gatewayFor } from "./gateway.js";
import { cardsFromTheShop, merchantItemIdFor, type StoreProduct } from "./woo-catalog.js";
import {
  createTheOrderInTheShop,
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
} from "./woo-shop.js";
import { memoryWooShops, type WooConnection, type WooShops } from "./woo-shops.js";
import {
  type Filling,
  fillFromTheShop,
  followShipments,
  quoteFromTheShop,
  startWooWorker,
  turnOnce,
} from "./woo-worker.js";

/** The shop showing this product as the one download it sells. */
const showing = (product: EligibleWooProduct): ProductInspection => ({ ok: true, product });

/** The shop answering, and ruling the product out. */
const RULED_OUT: ProductInspection = {
  ok: false,
  why: "This product cannot be imported: it is out of stock.",
  again: false,
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

/** A shop that always accepts, remembering what it was sent. */
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
      },
    ]);
  });

  it("refuses an order whose price is not the shop's price, and places nothing", async () => {
    // The download can be the one the price was bound to and the money still
    // be wrong: a sale charged at a price the shop does not ask any more is
    // not one to put in somebody's shop on their behalf.
    const shops = memoryWooShops();
    const shop = aShopThatAccepts();

    const answer = await fillFromTheShop(
      anOrder({ price: { ...anOrder().price, amount: "30.00" } }),
      connection(),
      MERCHANT_EMAIL,
      filling(shops, shop.place),
    );

    expect(answer).toMatchObject({ refused: { code: "cannot_fulfill" } });
    expect(shop.placed).toHaveLength(0);
    expect((await shops.knownOrder("ord_1"))?.kind).toBe("precreate_refused");
  });

  it("refuses an order the shop said nothing about, and says the shop did not answer", async () => {
    // The refusal is what makes the buyer's refund due, and its words reach the
    // buyer's agent. A shop that timed out has said nothing about the product,
    // so the reason is that the shop did not answer and not that the product
    // stopped being sold. The refusal is recorded like any other, so the
    // existing recovery can still finish the sale later.
    const shops = memoryWooShops();
    const shop = aShopThatAccepts();

    const answer = await fillFromTheShop(anOrder(), connection(), MERCHANT_EMAIL, {
      ...filling(shops, shop.place),
      inspectProduct: async () => ({
        ok: false,
        why: "The shop did not answer the protected product check.",
        again: true,
      }),
    });

    expect(answer).toMatchObject({
      refused: { code: "cannot_fulfill", message: expect.stringMatching(/did not answer/) },
    });
    expect(JSON.stringify(answer)).not.toMatch(/no longer/);
    expect(shop.placed).toHaveLength(0);
    expect((await shops.knownOrder("ord_1"))?.kind).toBe("precreate_refused");
  });

  it("refuses an order the shop ruled out, and does not say the shop was silent", async () => {
    const shops = memoryWooShops();
    const shop = aShopThatAccepts();

    const answer = await fillFromTheShop(anOrder(), connection(), MERCHANT_EMAIL, {
      ...filling(shops, shop.place),
      inspectProduct: async () => RULED_OUT,
    });

    expect(answer).toMatchObject({ refused: { code: "cannot_fulfill" } });
    expect(JSON.stringify(answer)).not.toMatch(/did not answer/);
    expect(shop.placed).toHaveLength(0);
  });

  it("places one order for a sale handed over twice", async () => {
    // Delivery is at least once and this is the whole reason the ledger
    // exists: a second hand-over must not become a second thing the merchant
    // picks, packs and posts.
    const shops = memoryWooShops();
    const shop = aShopThatAccepts();
    const parts = filling(shops, shop.place);

    const first = await fillFromTheShop(anOrder(), connection(), MERCHANT_EMAIL, parts);
    const again = await fillFromTheShop(anOrder(), connection(), MERCHANT_EMAIL, parts);

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
    );

    expect(answer).toBeNull();
    expect((await durable.knownOrder("ord_1"))?.kind).toBe("unknown");
    expect(shop.placed).toHaveLength(1);
  });

  it("refuses the sale when the shop says no, without quoting the shop to the buyer", async () => {
    // A WordPress refusal carries whatever the plugin that raised it chose to
    // say, and on a shop with debugging on that is a file path. The reader here
    // is a stranger's agent, which can do nothing with a merchant's internals
    // but forward them.
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
    await fillFromTheShop(anOrder(), connection(), MERCHANT_EMAIL, filling(shops, refuse));
    const again = await fillFromTheShop(
      anOrder(),
      connection(),
      MERCHANT_EMAIL,
      filling(shops, refuse),
    );

    expect((await shops.knownOrder("ord_1"))?.kind).toBe("unknown");
    expect(again && "refused" in again).toBe(true);
    expect(placements).toBe(1);
  });

  it("answers nothing at all when the shop did not answer either", async () => {
    // Not a refusal: a refusal closes the sale for good. Nothing is answered,
    // so the gateway hands the order over again, which is the one path back to
    // a sale that can still go through.
    const shops = memoryWooShops();
    const answer = await fillFromTheShop(
      anOrder(),
      connection(),
      MERCHANT_EMAIL,
      filling(shops, async () => ({ ok: false, why: "no answer", again: true })),
    );
    expect(answer).toBeNull();
  });

  it("will not place a second order for an attempt whose outcome nobody knows", async () => {
    // The process died with a request already on its way to the shop. Whether
    // that shop holds an order for this sale is not knowable from here, and
    // ordering again is the one move that is certainly wrong.
    const shops = memoryWooShops();
    const shop = aShopThatAccepts();
    const parts = filling(shops, shop.place);

    await fillFromTheShop(
      anOrder(),
      connection(),
      MERCHANT_EMAIL,
      filling(shops, async () => ({ ok: false, why: "the shop did not answer", again: true })),
    );
    const again = await fillFromTheShop(anOrder(), connection(), MERCHANT_EMAIL, parts);

    expect(shop.placed).toHaveLength(0);
    expect(again).not.toBeNull();
    // And it says which of the two it is: not "there is no such order", but
    // "an order may be there and nothing here can tell".
    expect(again && "refused" in again && again.refused.message).toMatch(/ord_1/);
  });

  it("refuses a connection whose keys cannot write", async () => {
    // The order path is the second guard after a quote-time refusal: a stale
    // paid envelope still must not make a Woo order on read-only credentials.
    const shops = memoryWooShops();
    const shop = aShopThatAccepts();
    const answer = await fillFromTheShop(
      anOrder(),
      { ...connection(), permissions: "read" },
      MERCHANT_EMAIL,
      filling(shops, shop.place),
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

    const refused = await fillFromTheShop(anOrder(), connection(), MERCHANT_EMAIL, parts);
    supported = true;
    const redelivered = await fillFromTheShop(
      anOrder(),
      { ...connection(), consumerKey: "ck_reconnected" },
      MERCHANT_EMAIL,
      parts,
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

  /** A WooCommerce answering `wc/v3` on loopback, remembering what it was sent. */
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

    // The catalogue, converted and published through the door every other card
    // goes through. No leniency of its own: a card refused here is a card the
    // merchant is shown the refusal for.
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
      onOrder: async (order) => {
        const answer = await fillFromTheShop(order, connected, MERCHANT_EMAIL, parts);
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

    // The buyer's side: the sale went through and they hold the number of an
    // order in a shop they have never heard of.
    expect(bought.status).toBe(200);
    const started = bought.body as AgentOrderStatus;
    const read = await served.call("GET", `/x402/orders/${started.order_id}/status`);
    const status = read.body as AgentOrderStatus;
    expect(status.status).toBe("delivered");
    expect(status.delivered).toMatchObject({ file_name: "Guide", order_number: "13" });
    const durable = await shops.knownOrder(status.order_id);
    expect(JSON.stringify(durable)).not.toContain("download_url");
    expect(JSON.stringify(durable)).not.toContain(MERCHANT_EMAIL);

    // The merchant's side: one order in the shop, paid, carrying our own
    // identifier so that the two systems can be reconciled by hand.
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

    const first = await fillFromTheShop(anOrder(), connected, MERCHANT_EMAIL, parts);
    const durable = await shops.knownOrder("ord_1");
    const redelivery = await fillFromTheShop(anOrder(), connected, MERCHANT_EMAIL, parts);

    expect(first).toBeNull();
    expect(durable?.kind).toBe("unknown");
    expect(shop.orders).toHaveLength(1);
    expect(redelivery && "refused" in redelivery).toBe(true);
  });

  it("draws the stream of the merchant the connected account names, and nobody else's", async () => {
    // The worker acts for the account that connected the shop, calling the
    // gateway's application inside the process (ADR-0030). What it draws is
    // that merchant's stream; an envelope waiting for another merchant stays
    // where it is, for that merchant's own worker.
    open = await harness();
    const other = await open.addMerchant();
    const anEvent = (id: string) => ({
      kind: "order_event" as const,
      id,
      sent_at: "2026-09-14T12:00:00.000Z",
      payload: {
        type: "order.refund_due" as const,
        order_id: "ord_7c1e05",
        at: "2026-09-14T12:00:00.000Z",
        price: { amount: "25.00", currency: "USD" },
        reason: "deadline_passed" as const,
      },
    });
    await open.queue.publish(open.merchant.id, anEvent("msg_ours"));
    await open.queue.publish(other.id, anEvent("msg_theirs"));
    const application = open.gateway;

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
    // The gateway hands out one envelope a poll, so an event is often all a
    // turn draws. Counted as nothing, it would send the loop to rest between
    // turns as though the stream were quiet, with orders waiting behind it.
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
                type: "order.refund_due" as const,
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
  // What the dashboard answers for the shop it stands in for when an agent
  // asks for a price. Everything here is the code a deployment runs except the
  // read of the product, which is the shop's answer handed in; the gateway,
  // which records what it was told; and the store, which is the in-memory one
  // held to the same contract as the Postgres one a deployment writes to.
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

  /** The shop's answer for the item and account it was asked about, and nothing for any other. */
  const shopShowing =
    (product: typeof inTheShop | null) =>
    async (asked: WooConnection, merchantItemId: string): Promise<ProductInspection> =>
      asked.accountId === "acc_1" &&
      merchantItemId === question.merchant_item_id &&
      product !== null
        ? showing(product)
        : RULED_OUT;

  const answering = async (shops: WooShops, product: typeof inTheShop | null): Promise<unknown> => {
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
      answerQuote: async (priceId: string, said: unknown) => {
        // Answered under the price the question named, which is the only
        // thing the gateway files a price answer against.
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
      inspectProduct: shopShowing(product),
    });
    return answer;
  };

  it("answers with the shop's own price and binds the price to the product it read", async () => {
    // The binding is what the order is held to later: an order paying this
    // price is filled only against the download the agent was offered.
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
      // One store, two turns: the price question and then the order paying
      // it, with nothing handed in for the binding. What the fill holds the
      // order to is what the quote wrote.
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

  it("names no price when that price was already bound to another product", async () => {
    // The shop changed the download between two answers for one price. The
    // order comes back held to the first, so a price for the second is a price
    // no order could be filled against.
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
  // The price of a parcel is the goods and the shop's own rate to the buyer's
  // place together (ADR-0033): the product read the way every price question
  // reads it, and the rate asked of the shop's cart for the place the
  // question carries, which is the locality and nothing about who.
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
    let answer: unknown;
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
        productId === "28" ? rates(where) : { ok: false, why: "another product", again: false },
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
    // Not available is all an agent can be told today; the reason goes to the
    // merchant's log. The shop that does not ship there and the shop that
    // refused the place read the same to the agent.
    for (const read of [
      { ok: true as const, rates: [] },
      { ok: false as const, why: "The shop refused the place.", again: false },
      { ok: false as const, why: "The shop did not answer.", again: true },
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
    // The card ships, and a price of the goods alone would be paid for a
    // parcel the shop now sells as something else.
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

  it("names no price when the shop is slower than the price check allows", async () => {
    // The gateway waits five seconds for a price. A shop that answers after
    // that answers nobody, and the worker has other questions waiting.
    const started = Date.now();

    const answer = await answering(
      memoryWooShops(),
      () => new Promise<RatesRead>(() => undefined),
      question,
      50,
    );

    expect(answer).toStrictEqual({ available: false, as_of: NOW });
    expect(Date.now() - started).toBeLessThan(2_000);
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

  /** A shop that takes every parcel's order, remembering what it was sent. */
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
    );

    expect(answer).toStrictEqual({ accepted: {} });
    // The shop is asked for rates to the place, not the person.
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
    // The ledger keeps the sale as a parcel's, which recovery will not try to
    // make again, with the shop's order and nothing of where it goes.
    const kept = await shops.recoveryOrder("ord_1");
    expect(kept?.facts.kind).toBe("parcel");
    for (const word of ADDRESS_WORDS) expect(JSON.stringify(kept)).not.toContain(word);
  });

  it("chooses the rate the price was paid at, not the cheapest of today", async () => {
    // The agent was quoted the cheapest rate, and a cheaper one the shop added
    // since must not make the paid price look wrong: the rate costing what was
    // paid above the goods is the rate that was sold.
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
      );

      expect(answer).toMatchObject({ refused: { code: "cannot_fulfill" } });
      expect(shop.placed).toHaveLength(0);
    }
  });

  it("answers nothing and writes nothing while the shop does not answer", async () => {
    // A parcel has days to ship, so a shop that is down for a minute is asked
    // again on the next hand-over rather than refused for good.
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

    await fillFromTheShop(parcelOrder(), connection(), MERCHANT_EMAIL, parts);
    const again = await fillFromTheShop(parcelOrder(), connection(), MERCHANT_EMAIL, parts);

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
        ).catch(() => null);
      }
    } finally {
      spy.mockRestore();
    }

    expect(logged.length).toBeGreaterThan(0);
    for (const word of ADDRESS_WORDS) expect(logged.join("\n")).not.toContain(word);
  });
});

describe("following a parcel to the carrier", () => {
  const SHIPPED = {
    kind: "shipped" as const,
    shipment: { carrier: "Bali courier", tracking_number: null },
  };

  /** A ledger holding one parcel the shop has, on a connected shop. */
  const withAParcel = async (): Promise<WooShops> => {
    const shops = memoryWooShops();
    await shops.connect(connection());
    const facts = {
      kind: "parcel" as const,
      shopOrigin: "https://shop.example.com",
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

  /** The gateway's deliver call, answering what it is told to and remembering what it was sent. */
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

  const following = (shops: WooShops, gateway: unknown, read: () => Promise<ShipmentRead>) =>
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
      now: () => new Date("2026-09-15T12:00:00.000Z"),
      readShipment: async (_keys, wooOrderId) => {
        if (wooOrderId !== "30") throw new Error(`asked about ${wooOrderId}`);
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
      expect(await shops.parcelsToFollow("acc_1")).toStrictEqual([
        { orderId: "ord_1", wooOrderId: "30" },
      ]);
    }
  });

  it("lets go of an order the shop ended, and does not say it shipped", async () => {
    // A cancelled order never shipped. Nothing is told to the gateway, and the
    // order becomes a refund owed when its time to ship runs out.
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

    for (const code of ["order_already_closed", "shipment_already_recorded"]) {
      const refused = await withAParcel();
      const gateway = aGateway(() => ({ ok: false, status: 409, why: "refused", code }));

      await following(refused, gateway.client, async () => SHIPPED);
      await following(refused, gateway.client, async () => SHIPPED);

      expect(gateway.delivered, code).toHaveLength(1);
      expect(await refused.parcelsToFollow("acc_1")).toStrictEqual([]);
    }
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
        onQuote: (question) =>
          quoteFromTheShop(connected, question, new Date(harnessed.now()), parts),
        onOrder: async (order) =>
          (await fillFromTheShop(order, connected, MERCHANT_EMAIL, parts)) ??
          Promise.reject(new Error("the shop was not asked")),
      },
      { priced: { params: {}, ship_to: ADDRESS }, paid: { params: {}, ship_to: ADDRESS } },
    );

    // The agent paid the goods and the shop's rate together, the shop holds a
    // paid order shipping there, and Agentify holds the address no longer.
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
});

describe("the worker that keeps every connected shop served", () => {
  /**
   * A gateway that answers a poll with nothing and counts who asked.
   *
   * The subject here is the loop rather than what one turn does with an order,
   * so the stream is empty on purpose: what is being checked is that somebody
   * is still drawing it.
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
    // The loop for one account is started once and kept in a map keyed by the
    // account. A loop that ended by itself while its entry stayed would leave
    // that merchant's orders drawn by nobody until the dashboard was restarted —
    // and a merchant who disconnects and reconnects is an ordinary afternoon.
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
   * A WooCommerce on loopback answering the protected product check and the
   * order call, with its Number of decimals as the test leaves it and every
   * call it was asked remembered. Its order answer writes every total at that
   * number of decimals, whatever string it was sent, which is what `wc/v3`
   * does. The product's price is stored as a whole-dollar merchant typed it.
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
   * Filling against that shop with the real product check and the real order
   * call; the quote's fingerprint is the one the check gave when it was taken.
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
    // A merchant who sold in whole dollars switched to two decimals to import,
    // an agent was quoted, and the merchant switched back. Posted, the order
    // would exist in the shop, paid, and WooCommerce's answer of "25" could
    // never be matched with "25.00": the sale would end as an order nobody
    // here can say was made. Refused before the post, it is a refund.
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
    );

    expect(answer).toMatchObject({ delivered: { file_name: "Guide", order_number: "13" } });
    expect(shop.asked.filter((one) => one.method === "POST")).toHaveLength(1);
  });
});
