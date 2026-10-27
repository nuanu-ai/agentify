/**
 * The lists of orders, receipts and cards as the server draws them. The views
 * are pure functions of the gateway's documents, and the documents here are
 * built by the contract's own schemas, so nothing is stubbed.
 */

import { PAYOUT_SPLIT_NETWORKS, payoutSplitFor, payoutSplitNetworkOf } from "@agentify/gateway";
import type { OrderList, ReceiptList } from "@nuanu-ai/agentify-contracts";
import {
  MerchantCardListSchema,
  OrderListSchema,
  ReceiptListSchema,
} from "@nuanu-ai/agentify-contracts";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";
import { inViewersZone } from "../../src/moments.js";
import { readable } from "../../src/testing/html.js";
import { cardsView, ordersView, receiptsView } from "../../src/views.js";
import { CardsScreen } from "./cards.js";
import { OrdersScreen } from "./orders.js";
import { ReceiptsScreen } from "./receipts.js";

/** Every screen says who it is drawn for. */
const WHO = "owner@example.com";

/** Inside the gate, as the screens are, so a form that posts knows its address. */
const served = (screen: () => ReactElement): string => {
  const Stub = createRoutesStub([
    { id: "routes/gate", path: "/", children: [{ path: "page", Component: screen }] },
  ]);
  return renderToString(
    <Stub
      initialEntries={["/page"]}
      hydrationData={{ loaderData: { "routes/gate": { who: WHO } } }}
    />,
  );
};

const cards = MerchantCardListSchema.parse({
  selling: "open",
  cards: [
    {
      id: "itm_1",
      as_of: "2026-08-26T09:00:00Z",
      card: {
        merchant_item_id: "room-101",
        title: "A room for the night",
        description: "One night in room 101",
        price: { amount: "80.00", currency: "USD" },
        result: { access_code: { type: "string" } },
        fulfillment: "sync",
      },
      selling: "open",
      paused: false,
    },
  ],
});

const order = (id: string) => ({
  id,
  merchant_item_id: "room-101",
  params: {},
  price: {
    amount: "80.00",
    currency: "USD",
    at: "2026-08-26T10:20:00Z",
    as_of: "2026-08-26T10:15:00Z",
  },
  test: false,
  status: "delivered",
  payment_status: "paid",
});

const receipt = (id: string) => ({
  id,
  order_id: `ord_${id}`,
  item_id: "itm_1",
  price: {
    amount: "80.00",
    currency: "USD",
    at: "2026-08-26T10:20:00Z",
    as_of: "2026-08-26T10:15:00Z",
  },
  paid_at: "2026-08-26T10:20:03Z",
  outcome: "delivered",
  test: false,
});

const ordersPage = (orders: OrderList): string =>
  served(() => <OrdersScreen view={ordersView(cards, orders, orders)} />);

const receiptsPage = (receipts: ReceiptList): string =>
  served(() => <ReceiptsScreen view={receiptsView(cards, receipts)} />);

/**
 * The split a merchant's payments go to on the test channel, made by the
 * gateway's own rule from the code's table, so the rate is the one every
 * split is made with.
 */
const SPLIT = payoutSplitFor(
  payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, "eip155:84532"),
  "mch_0123456789abcdef0123456789abcdef",
  "0xde3F8C4422A7F8C94bce9Cc2Ec118665108148EF",
);

/** The terms of the Base Sepolia experiment's splits, 97% and 3%, as they were created on chain. */
const AT_THREE_PERCENT = {
  merchantAllocation: 970_000,
  commissionAllocation: 30_000,
  totalAllocation: 1_000_000,
};

/** An order at this price whose payment went into a split on these terms. */
const pricedAt = (amount: string, id = `ord_${amount}`) => ({
  ...order(id),
  price: { ...order(id).price, amount },
});

/** Each row's amount, as a person reads it in its column. */
const amountsIn = (html: string): string[] =>
  [...html.matchAll(/<div class="cell cell-amount">([\s\S]*?)<\/div>/g)].map((cell) =>
    readable(cell[1] ?? ""),
  );

/** What each row opens to. */
const openedIn = (html: string): string[] =>
  [...html.matchAll(/<div class="more-body">([\s\S]*?)<\/div><\/details>/g)].map((opened) =>
    readable(opened[1] ?? ""),
  );

describe("the receipts of sales that went out", () => {
  it("puts each payment under its day in the viewer's calendar, the heading naming the zone its time is in", () => {
    const receipts: ReceiptList = ReceiptListSchema.parse({
      receipts: [{ ...receipt("rcp_1"), paid_at: "2026-08-26T20:15:03Z" }],
    });

    const html = inViewersZone("Asia/Makassar", () => receiptsPage(receipts));

    expect(html).toMatch(/<h3>27 August 2026 · UTC\+8<\/h3>/);
    expect(readable(html)).toContain("04:15:03");
    expect(readable(receiptsPage(receipts))).toContain("26 August 2026 · UTC");
  });

  it("lists a parcel handed to a carrier beside goods handed over, and says which it is", () => {
    // A parcel with a carrier has not been delivered, so its row does not say
    // so; both are counted among the receipts.
    const receipts: ReceiptList = ReceiptListSchema.parse({
      receipts: [receipt("rcp_1"), { ...receipt("rcp_2"), outcome: "shipped" }],
    });

    const text = readable(receiptsPage(receipts));

    expect(text).toContain("All receipts 2");
    expect(text).toContain("Delivered");
    expect(text).toContain("Shipped");
  });

  it("lists the latest payment first, whatever order the gateway gave them in", () => {
    const receipts: ReceiptList = ReceiptListSchema.parse({
      receipts: [
        { ...receipt("rcp_old"), paid_at: "2026-08-26T09:00:03Z" },
        { ...receipt("rcp_new"), paid_at: "2026-08-26T11:00:03Z" },
        { ...receipt("rcp_mid"), paid_at: "2026-08-26T10:00:03Z" },
      ],
    });

    const text = readable(receiptsPage(receipts));
    const at = (id: string) => text.indexOf(id);

    expect(at("rcp_new")).toBeLessThan(at("rcp_mid"));
    expect(at("rcp_mid")).toBeLessThan(at("rcp_old"));
  });

  it("keeps a receipt's ID and its order's out of the row's lines, whole in its opened part, each with its copy button", () => {
    const id = "rcp_d59f0110946cfebd26bbf9ae7de0134e";
    const order = "ord_d59f0110946cfebd26bbf9ae7de0134e";
    const receipts: ReceiptList = ReceiptListSchema.parse({
      receipts: [{ ...receipt(id), order_id: order }],
    });

    const html = receiptsPage(receipts);
    const lines = html.replace(/<details[^>]*class="row-more[\s\S]*?<\/details>/g, "");
    const [opened] = openedIn(html);

    expect(readable(lines)).not.toMatch(/rcp_|ord_/);
    expect(opened).toContain(`Receipt ${id}`);
    expect(opened).toContain(`Order ${order}`);
    expect(html).toContain(`aria-label="Copy the whole receipt ID ${id}"`);
    expect(html).toContain(`aria-label="Copy the whole order ID ${order}"`);
  });
});

describe("a row that opens to its details", () => {
  // Two purchases of one product in the same second share a title, a day and
  // a time; read out by those alone, the two presses could not be told apart.
  it.each([
    [
      "orders",
      () =>
        ordersPage(
          OrderListSchema.parse({
            orders: [order("ord_0a1b2c3d4e5f6a7b"), order("ord_9f8e7d6c5b4a3f2e")],
          }),
        ),
    ],
    [
      "receipts",
      () =>
        receiptsPage(
          ReceiptListSchema.parse({
            receipts: [receipt("rcp_0a1b2c3d4e5f6a7b"), receipt("rcp_9f8e7d6c5b4a3f2e")],
          }),
        ),
    ],
  ])("names apart two %s of one product made in the same second", (_list, page) => {
    const names = [...page().matchAll(/<summary aria-label="([^"]*)"/g)].map((found) => found[1]);

    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
  });
});

describe("the shares of a sale paid into the merchant's payout split", () => {
  // Computed by hand in whole millionths of a dollar, USDC's smallest unit,
  // each share rounded down as the split rounds it: 0.29 at 99.9% is 289710
  // millionths exactly, where floating point makes it 0.28970999999999997.
  const SHARES: readonly (readonly [price: string, merchant: string])[] = [
    ["80.00", "about 79.92 USD"],
    ["5", "about 4.995 USD"],
    ["0.29", "about 0.28971 USD"],
    ["0.09", "about 0.08991 USD"],
    ["0.01", "about 0.00999 USD"],
    ["0.000019", "about 0.000018 USD"],
    ["0.000001", "under 0.000001 USD"],
  ];

  it("says each order's shares as about so much, rounded down to a millionth as the split rounds them", () => {
    const orders: OrderList = OrderListSchema.parse({
      orders: SHARES.map(([price]) => pricedAt(price)),
    });
    const paidInto = Object.fromEntries(orders.orders.map((one) => [one.id, SPLIT]));

    const html = served(() => (
      <OrdersScreen view={ordersView(cards, orders, orders, undefined, {}, paidInto)} />
    ));

    // The row says the price the buyer paid; its opened part says the
    // merchant's share of it, after Agentify's part.
    expect(amountsIn(html)).toStrictEqual(SHARES.map(([price]) => `${price} USD`));
    expect(openedIn(html)).toStrictEqual(
      SHARES.map(([, merchant]) =>
        expect.stringContaining(`Your share ${merchant}, after Agentify's 0.1%`),
      ),
    );
  });

  it("says a receipt's shares the same way", () => {
    const receipts: ReceiptList = ReceiptListSchema.parse({
      // Paid a second apart, the first the latest.
      receipts: SHARES.map(([price], at) => ({
        ...receipt(`rcp_${at}`),
        price: { ...receipt(`rcp_${at}`).price, amount: price },
        paid_at: new Date(Date.parse("2026-08-26T10:20:03Z") - at * 1_000).toISOString(),
      })),
    });
    const paidInto = Object.fromEntries(receipts.receipts.map((one) => [one.order_id, SPLIT]));

    const html = served(() => (
      <ReceiptsScreen view={receiptsView(cards, receipts, null, paidInto)} />
    ));

    expect(amountsIn(html)).toStrictEqual(SHARES.map(([price]) => `${price} USD`));
    for (const [at, opened] of openedIn(html).entries()) {
      const [, merchant] = SHARES[at] ?? [];
      expect(opened).toContain(`Your share ${merchant}, after Agentify's 0.1%`);
    }
  });

  it("divides by the terms of the split the order was paid into, not by a rate of its own", () => {
    const orders: OrderList = OrderListSchema.parse({ orders: [pricedAt("80.00")] });

    const html = served(() => (
      <OrdersScreen
        view={ordersView(
          cards,
          orders,
          orders,
          undefined,
          {},
          {
            "ord_80.00": AT_THREE_PERCENT,
          },
        )}
      />
    ));

    expect(openedIn(html)[0]).toContain("Your share about 77.60 USD, after Agentify's 3%");
  });

  it("shows no shares for an order paid to a wallet itself, before payments went to splits", () => {
    // Such an order paid the whole price to the wallet, and "to Agentify" on
    // it would be a false statement about money.
    const orders: OrderList = OrderListSchema.parse({
      orders: [pricedAt("80.00", "ord_split"), pricedAt("80.00", "ord_wallet")],
    });

    const html = served(() => (
      <OrdersScreen view={ordersView(cards, orders, orders, undefined, {}, { ord_split: SPLIT })} />
    ));

    // Priced in the same moment, they are listed by their IDs, the greatest first.
    expect(openedIn(html)[1]).toContain("Your share");
    expect(openedIn(html)[0]).not.toContain("Your share");
    expect(openedIn(html)[0]).not.toContain("Agentify");
  });
});

describe("a paid order left unfulfilled", () => {
  it("reports the missing delivery and names no sum for the merchant to send", () => {
    const unfulfilled: OrderList = OrderListSchema.parse({
      orders: [{ ...pricedAt("80.00", "ord_unfulfilled"), status: "unfulfilled" }],
    });
    const text = readable(
      served(() => (
        <OrdersScreen
          view={ordersView(
            cards,
            unfulfilled,
            unfulfilled,
            undefined,
            {
              ord_unfulfilled: {
                unfulfilled: "deadline_passed",
                paidAt: null,
                deadline: null,
                soldThrough: "api",
                counts: false,
              },
            },
            { ord_unfulfilled: SPLIT },
          )}
        />
      )),
    );
    const callout = text.slice(text.indexOf("Needs you"), text.indexOf("All orders"));
    expect(callout).toContain("not delivered before the delivery deadline");
    // The order's own price is the one sum told; neither its share nor any
    // amount owed back is put to the merchant as a transfer to make.
    expect(callout.match(/\d+\.\d{2} USD/g)).toStrictEqual(["80.00 USD"]);
  });

  it("names no source for a payment confirmed after Agentify stopped waiting", () => {
    // The confirmation may be the facilitator's late answer, with no transfer
    // ever read from the chain, and the order does not record which.
    const unfulfilled: OrderList = OrderListSchema.parse({
      orders: [{ ...pricedAt("80.00", "ord_unfulfilled"), status: "unfulfilled" }],
    });
    const text = readable(
      served(() => (
        <OrdersScreen
          view={ordersView(
            cards,
            unfulfilled,
            unfulfilled,
            undefined,
            {
              ord_unfulfilled: {
                unfulfilled: "charge_confirmed_late",
                paidAt: null,
                deadline: null,
                soldThrough: "api",
                counts: false,
              },
            },
            { ord_unfulfilled: SPLIT },
          )}
        />
      )),
    );
    const callout = text.slice(text.indexOf("Needs you"), text.indexOf("All orders"));
    expect(callout).toContain("stopped waiting");
    expect(callout).not.toMatch(/network|chain|blockchain/i);
  });

  it("marks only the orders that count toward the stop on new purchases", () => {
    // An unfulfilled order the merchant does not answer for, such as one
    // Agentify never handed over, needs them too but does not hold their sales.
    const two: OrderList = OrderListSchema.parse({
      orders: [
        { ...pricedAt("80.00", "ord_counted"), status: "unfulfilled" },
        { ...pricedAt("12.00", "ord_not_counted"), status: "unfulfilled" },
      ],
    });
    const html = served(() => (
      <OrdersScreen
        view={ordersView(
          cards,
          two,
          two,
          undefined,
          {},
          {},
          undefined,
          {},
          {},
          new Set(["ord_counted"]),
        )}
      />
    ));

    expect([...html.matchAll(/data-stops="([^"]+)"/g)].map(([, id]) => id)).toStrictEqual([
      "ord_counted",
    ]);
  });

  it("does not guess why delivery was missing when no cause was read", () => {
    const unfulfilled: OrderList = OrderListSchema.parse({
      orders: [{ ...pricedAt("80.00", "ord_unfulfilled"), status: "unfulfilled" }],
    });
    const text = readable(ordersPage(unfulfilled));
    expect(text).toContain("Paid, and the product was not delivered.");
    expect(text).not.toContain("deadline");
  });
});

describe("an order delivered and not paid", () => {
  // Nothing is owed by the merchant, so it is not counted among the orders
  // that need them; but whether to revoke what was delivered or to wait is
  // theirs to decide, as the documentation says, and the screen says so.
  const held: OrderList = OrderListSchema.parse({
    orders: [{ ...order("ord_held"), status: "delivered_unpaid", payment_status: "not_paid" }],
  });

  it("is not counted as needing the merchant, and says it waits on the buyer", () => {
    const html = ordersPage(held);
    const text = readable(html);

    expect(text).toContain("Waiting on the buyer 1");
    expect(text).toContain("Needs you 0");
    expect(html).not.toContain('aria-label="Orders that need you"');
    expect(html).toContain('href="/docs/orders#you-delivered-and-the-payment-did-not-execute"');
    // Paid again for the same order, never bought again, which would deliver
    // twice.
    expect(text).toContain("the buyer pays again for this same order");
  });

  it("leaves to the merchant whether to revoke what they delivered or to wait", () => {
    const text = readable(ordersPage(held));

    expect(text).toContain("Whether to revoke what you delivered or wait is up to you");
    expect(text).not.toMatch(/nothing for you to do/i);
  });

  it("is told apart from a refund due listed beside it", () => {
    const both: OrderList = OrderListSchema.parse({
      orders: [...held.orders, { ...order("ord_owed"), status: "unfulfilled" }],
    });

    const text = readable(ordersPage(both));
    const needs = text.slice(text.indexOf("Needs you 1"), text.indexOf("Waiting on the buyer 1"));
    const waits = text.slice(text.indexOf("Waiting on the buyer 1"), text.indexOf("All orders"));

    expect(needs).toContain("Unfulfilled");
    expect(needs).not.toContain("Held for payment");
    expect(waits).toContain("Held for payment");
    expect(waits).not.toContain("Unfulfilled");
  });
});

describe("the state of each card", () => {
  const entry = cards.cards[0];
  if (entry === undefined) throw new Error("the example catalogue has no card");
  const listOf = (selling: "open" | "paused", ...more: Partial<typeof entry>[]) =>
    MerchantCardListSchema.parse({
      selling,
      cards: more.map((one, at) => ({ ...entry, id: `itm_${at}`, ...one })),
    });
  const wordsOf = (list: ReturnType<typeof listOf>, offSale: readonly string[] = []) =>
    cardsView(list, "https://agentify.ad", false, {
      through: "api",
      offSale,
    }).listing.rows.map((row) => row.state.text);

  it("tells a card on sale from one the merchant paused and one held by the account", () => {
    const list = listOf(
      "open",
      { selling: "open", paused: false },
      { selling: "paused", paused: true },
      { selling: "paused", paused: false },
    );

    expect(wordsOf(list)).toStrictEqual(["On sale", "Paused by you", "Off sale"]);
  });

  it.each([
    ["the shop published, while the code sells", "api", /your code/i],
    ["the code published, while the shop sells", "woocommerce", /WooCommerce/],
  ] as const)(
    "says beside a card %s which integration the merchant chose, with the way to the switch and no switch of its own",
    (_which, through, says) => {
      // The banner names no reason for it: only this card's row can say which
      // of the merchant's cards came from the integration not in use.
      const list = listOf("open", { selling: "paused", paused: false });
      const html = served(() => (
        <CardsScreen
          view={cardsView(list, "https://agentify.ad", false, { through, offSale: ["itm_0"] })}
          base=""
        />
      ));
      const row = /<li class="list-row[^"]*">([\s\S]*?)<\/li>/.exec(html)?.[1] ?? "";
      const note = readable(/<div class="cell cell-note">([\s\S]*?)<\/div>/.exec(row)?.[1] ?? "");

      expect(note).toMatch(says);
      // The state beside it already says the card is off sale.
      expect(note).not.toMatch(/off sale/i);
      // The choice between the two is the merchant's, not a sale anybody makes:
      // a shop never approved sells nothing, and neither does code never run.
      expect(readable(row)).not.toMatch(/\bsells\b/);
      expect(row).toContain('href="/woocommerce"');
      expect(row).not.toContain("<form");
    },
  );

  it("does not call a card paused by the merchant while the other integration holds it", () => {
    // Resuming it would not put it on sale, so "Paused by you" would send the
    // merchant to a switch that changes nothing.
    const list = listOf("open", { selling: "paused", paused: true });

    expect(wordsOf(list, ["itm_0"])).toStrictEqual(["Off sale"]);
  });
});

describe("how a card is delivered", () => {
  const entry = cards.cards[0];
  if (entry === undefined) throw new Error("the example catalogue has no card");
  /** The delivery cell's words for a card of these fields. */
  const deliveryOf = (card: Partial<typeof entry.card>) => {
    const list = MerchantCardListSchema.parse({
      selling: "open",
      cards: [{ ...entry, card: { ...entry.card, ...card } }],
    });
    const html = served(() => (
      <CardsScreen view={cardsView(list, "https://agentify.ad")} base="" />
    ));
    return readable(/<div class="cell cell-fact">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "");
  };
  const later = (seconds: number) =>
    deliveryOf({ fulfillment: "async", fulfill_deadline_seconds: seconds });

  it("says the window the goods are owed within beside the word for how they come", () => {
    // The window is a promise the merchant answers for: an order still without
    // goods at its end owes the buyer their money back.
    expect(later(14_400)).toBe("Later, within 4 hours");
    expect(later(3_600)).toBe("Later, within 1 hour");
    expect(later(900)).toBe("Later, within 15 minutes");
    expect(later(5_400)).toBe("Later, within 90 minutes");
    expect(later(61)).toBe("Later, within 61 seconds");
    expect(later(172_800)).toBe("Later, within 2 days");
  });

  it("says a parcel's time to reach a carrier, which is not the time it arrives", () => {
    const parcel = deliveryOf({
      fulfillment: "ship",
      ship_within_seconds: 604_800,
      price_check: "handler",
      result: undefined,
    });

    expect(parcel).toContain("By parcel, to a carrier within 7 days");
  });

  it("says a card that names no window of its own is held to Agentify's, not to none", () => {
    // An order that runs past the default window is unfulfilled as one past a
    // window of the card's own would, so "Later" alone would read as no
    // deadline at all.
    const html = served(() => (
      <CardsScreen
        view={cardsView(
          MerchantCardListSchema.parse({
            selling: "open",
            cards: [{ ...entry, card: { ...entry.card, fulfillment: "async" } }],
          }),
          "https://agentify.ad",
        )}
        base=""
      />
    ));
    const fact = /<div class="cell cell-fact">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";

    expect(readable(fact)).toMatch(/^Later, \S/);
    expect(fact).toContain('href="/docs/cards#goods-that-leave-later-than-the-answer"');
  });

  it("names no window for a card delivered at once", () => {
    expect(deliveryOf({})).toBe("Immediate");
  });
});

describe("a card's row on a phone", () => {
  it("says on the row's own line that a price is asked at purchase", () => {
    // The price shown may not be the one paid, so a phone does not hide that
    // behind a press.
    const entry = cards.cards[0];
    if (entry === undefined) throw new Error("the example catalogue has no card");
    const asked = MerchantCardListSchema.parse({
      selling: "open",
      cards: [{ ...entry, card: { ...entry.card, price_check: "handler" } }],
    });
    const html = served(() => (
      <CardsScreen view={cardsView(asked, "https://agentify.ad")} base="" />
    ));
    const fact = /<div class="cell cell-fact">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";

    expect(readable(fact)).toContain("price asked at purchase");
  });

  it("shows the price as a figure with nothing to open, fixed or asked at purchase", () => {
    const entry = cards.cards[0];
    if (entry === undefined) throw new Error("the example catalogue has no card");
    const both = MerchantCardListSchema.parse({
      selling: "open",
      cards: [entry, { ...entry, id: "itm_2", card: { ...entry.card, price_check: "handler" } }],
    });
    const html = served(() => (
      <CardsScreen view={cardsView(both, "https://agentify.ad")} base="" />
    ));
    const prices = [...html.matchAll(/<div class="cell cell-amount">([\s\S]*?)<\/div>/g)].map(
      ([, price = ""]) => price,
    );

    expect(prices.map(readable)).toStrictEqual(["80.00 USD", "80.00 USD"]);
    expect(prices.join("")).not.toContain("<details");
  });
});

describe("a search over the cards", () => {
  const entry = cards.cards[0];
  if (entry === undefined) throw new Error("the example catalogue has no card");
  const many = (count: number) =>
    MerchantCardListSchema.parse({
      selling: "open",
      // Published a minute apart, the first one first.
      cards: Array.from({ length: count }, (_, at) => ({
        ...entry,
        id: `itm_${at}`,
        as_of: new Date(Date.parse("2026-10-01T09:00:00Z") + at * 60_000).toISOString(),
        card: { ...entry.card, merchant_item_id: `room-${at}`, title: `Room ${at}` },
      })),
    });
  const page = (list: ReturnType<typeof many>, address: string) =>
    readable(
      served(() => (
        <CardsScreen
          view={cardsView(
            list,
            "https://agentify.ad",
            false,
            undefined,
            new URLSearchParams(address),
          )}
          base=""
        />
      )),
    );

  it("says what was searched for where no card matches, which is not an empty catalogue", () => {
    const text = page(many(3), "q=suite");

    expect(text).toContain("No product matches “suite”. Clear the search");
    expect(text).not.toContain("haven't published any products");
    expect(page(many(0), "q=suite")).toContain("You haven't published any products yet.");
  });

  it("finds only the card whose product code is the whole search, as a link to one card names it", () => {
    // A link to the card with product code 1 must not list 11 and 21 beside it.
    const coded = MerchantCardListSchema.parse({
      selling: "open",
      cards: ["1", "11", "21", "Lamp-1", "LAMP-10"].map((code, at) => ({
        ...entry,
        id: `itm_${at}`,
        card: { ...entry.card, merchant_item_id: code, title: `Item ${code}` },
      })),
    });
    const found = (q: string) =>
      cardsView(
        coded,
        "https://agentify.ad",
        false,
        undefined,
        new URLSearchParams({ q }),
      ).listing.rows.map((row) => row.itemId);

    expect(found("1")).toStrictEqual(["1"]);
    expect(found(" lamp-1 ")).toStrictEqual(["Lamp-1"]);
    // Any other search still finds a part of a title or a code.
    expect(found("2")).toStrictEqual(["21"]);
    expect(found("item")).toStrictEqual(["1", "11", "21", "Lamp-1", "LAMP-10"]);
  });

  it("says a search was read as a whole product code, in what it found and in what it did not", () => {
    // Card 11 holds "1" and is off sale, so "no card off sale matches 1"
    // would be false; the sentences say the search was read as a code.
    const coded = MerchantCardListSchema.parse({
      selling: "open",
      cards: [
        { ...entry, id: "itm_1", card: { ...entry.card, merchant_item_id: "1" } },
        {
          ...entry,
          id: "itm_11",
          selling: "paused",
          paused: true,
          card: { ...entry.card, merchant_item_id: "11" },
        },
      ],
    });
    const drawn = (address: string) =>
      readable(
        served(() => (
          <CardsScreen
            view={cardsView(
              coded,
              "https://agentify.ad",
              false,
              undefined,
              new URLSearchParams(address),
            )}
            base=""
          />
        )),
      );

    expect(drawn("q=1")).toContain("Only the product with the product code “1”.");
    expect(drawn("q=1&show=off-sale")).toContain("No product off sale has the product code “1”.");
    expect(drawn("q=room")).not.toContain("product code “");
  });

  it("finds a card whose title holds a number and its unit, typed with a space or pasted from the page", () => {
    const sized = MerchantCardListSchema.parse({
      selling: "open",
      cards: [
        { ...entry, card: { ...entry.card, title: "eSIM Indonesia 5 GB, 30 days" } },
        {
          ...entry,
          id: "itm_2",
          card: { ...entry.card, merchant_item_id: "esim-10", title: "eSIM Indonesia 10 GB" },
        },
      ],
    });
    const found = (q: string) =>
      cardsView(
        sized,
        "https://agentify.ad",
        false,
        undefined,
        new URLSearchParams({ q }),
      ).listing.rows.map((row) => row.itemId);

    expect(found("5 gb, 30 days")).toStrictEqual(["room-101"]);
    // The page keeps a number with its unit by a no-break space, which a copy carries.
    expect(found("5 GB, 30 days")).toStrictEqual(["room-101"]);
  });

  it("finds a card by its product code as well as its title", () => {
    const text = page(many(12), "q=room-11");

    expect(text).toContain("Room 11");
    expect(text).not.toContain("Room 10");
  });

  it("draws fifty cards of a longer catalogue and says how many there are", () => {
    const text = page(many(214), "");

    expect(text).toContain("Showing 1–50 of 214");
    expect(text).toContain("Room 49");
    expect(text).not.toContain("Room 50 ");
  });
});

describe("an empty catalogue", () => {
  const none = () =>
    served(() => (
      <CardsScreen
        view={cardsView(
          MerchantCardListSchema.parse({ selling: "open", cards: [] }),
          "https://agentify.ad",
          true,
        )}
        base=""
      />
    ));

  it("offers the ways to a first product to a merchant who sells: the SDK's guide and the shop's connection", () => {
    expect(none()).toContain('href="/docs/quickstart"');
    expect(none()).toContain('href="/woocommerce"');
  });
});
