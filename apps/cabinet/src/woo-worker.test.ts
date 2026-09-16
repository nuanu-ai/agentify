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
 * for is measured: `docs/research/27-woo-connect-probe.md` records a real shop
 * answering `POST wc/v3/orders` with `set_paid: true` under 201, with the order
 * then agreeing with itself in four independent places.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  buyOverHttp,
  type Harness,
  harness,
  type Served,
  serve,
  theMerchantKey,
} from "@agentify/commerce-gateway/testing";
import type { AgentOrderStatus, Order } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { gatewayFor } from "./gateway.js";
import { cardsFromTheShop, type StoreProduct } from "./woo-catalog.js";
import type { OrderMade, ShopKeys, SoldItem } from "./woo-shop.js";
import { memoryWooShops, type WooConnection, type WooShops } from "./woo-shops.js";
import { fillFromTheShop, startWooWorker, turnOnce } from "./woo-worker.js";

const KEY = theMerchantKey("test");
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
  prices: { price: "2500", currency_code: "USD", currency_minor_unit: 2 },
  ...overrides,
});

const connection = (accountId = "acc_1"): WooConnection => ({
  accountId,
  shopUrl: "https://shop.example.com",
  consumerKey: "ck_abc",
  consumerSecret: "cs_def",
  permissions: "read_write",
  connectedAt: new Date("2026-09-14T12:00:00.000Z"),
});

const anOrder = (overrides: Partial<Order> = {}): Order => ({
  id: "ord_1",
  merchant_item_id: "11",
  params: {},
  price: {
    amount: "25.00",
    currency: "USD",
    at: "2026-09-14T12:00:00.000Z",
    as_of: "2026-09-14T12:00:00.000Z",
  },
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
      return { ok: true, id: String(next), number: String(next) };
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

    expect(answer).toEqual({ delivered: { order_number: "13" } });
    expect(shop.placed).toEqual([
      {
        orderId: "ord_1",
        productId: "11",
        email: MERCHANT_EMAIL,
        price: { amount: "25.00", currency: "USD" },
      },
    ]);
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

  it("gives the sale back when the shop refused before anything was placed", async () => {
    // A refusal that decided nothing about the shop's own records must not
    // leave a claim behind: the same product back in stock tomorrow is a sale
    // this merchant should be able to make.
    const shops = memoryWooShops();
    await fillFromTheShop(
      anOrder(),
      connection(),
      MERCHANT_EMAIL,
      filling(shops, async () => ({ ok: false, why: "gone", again: false })),
    );
    expect(await shops.claimOrder("acc_1", "ord_1", new Date())).toEqual({ kind: "ours" });
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
    // A shop that granted read-only lets a merchant connect and import, and
    // every sale then fails at the moment of delivery. Said here rather than
    // discovered from the shop's refusal.
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
  const aShopOnAPort = async (): Promise<{ url: string; orders: Record<string, unknown>[] }> => {
    const orders: Record<string, unknown>[] = [];
    shopServer = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const sent = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        orders.push(sent);
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: 13, number: "13", status: "processing" }));
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
    const gateway = gatewayFor(served.url, KEY);

    // The catalogue, converted and published through the door every other card
    // goes through. No leniency of its own: a card refused here is a card the
    // merchant is shown the refusal for.
    const { cards } = cardsFromTheShop([aProduct()]);
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
    });

    // The buyer's side: the sale went through and they hold the number of an
    // order in a shop they have never heard of.
    expect(bought.status).toBe(200);
    const status = bought.body as AgentOrderStatus;
    expect(status.status).toBe("delivered");
    expect(status.delivered).toEqual({ order_number: "13" });

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

  it("draws the order off the merchant's own stream and answers it", async () => {
    // The same thing again, this time with the cabinet doing the drawing —
    // which is the part a deployment runs and the part that has to speak the
    // contract's own poll and answer routes.
    open = await harness();
    served = await serve(open);
    const shop = await aShopOnAPort();
    const gateway = gatewayFor(served.url, KEY);

    const { cards } = cardsFromTheShop([aProduct()]);
    const published = await gateway.publishCard(cards[0]?.card ?? ({} as never));
    const itemId = published.ok && published.document.ok ? published.document.id : "";

    const shops = memoryWooShops();
    const connected: WooConnection = { ...connection(), shopUrl: shop.url };

    // The purchase and the cabinet's own turn run together: a synchronous card
    // is answered while the agent is still waiting on the purchase.
    const buying = buyOverHttp(open, served, itemId, {});
    let turned = 0;
    while (turned === 0) {
      turned = await turnOnce(connected, {
        shops,
        identity: {
          byId: async () => ({
            id: "p",
            email: MERCHANT_EMAIL,
            confirmed: true,
            merchant: { id: open?.merchant.id ?? "", key: KEY },
          }),
        },
        clientFor: () => gateway,
        now: () => new Date("2026-09-14T12:00:00.000Z"),
        waitSeconds: 1,
      });
    }
    const bought = await buying;

    expect(turned).toBe(1);
    expect((bought.body as AgentOrderStatus).delivered).toEqual({ order_number: "13" });
    expect(shop.orders).toHaveLength(1);
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
    // that merchant's orders drawn by nobody until the cabinet was restarted —
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
          merchant: { id: "mer_1", key: KEY },
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
          merchant: { id: "mer_1", key: KEY },
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
