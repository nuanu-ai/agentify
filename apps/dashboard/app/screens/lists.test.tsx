/**
 * Sentences the real gateway cannot reach yet: while every order is a test, a
 * list mixing test and real money cannot be produced over HTTP, and its failure
 * would be a merchant counting test purchases as takings. The views are pure
 * functions of the gateway's documents, and the documents here are built by the
 * contract's own schemas, so nothing is stubbed; each page is drawn as the
 * server sends it.
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
import { readable } from "../../src/testing/html.js";
import type { Viewer } from "../../src/viewer.js";
import { cardsView, ordersView, receiptsView } from "../../src/views.js";
import { CardsScreen } from "./cards.js";
import { OrdersScreen } from "./orders.js";
import { ReceiptsScreen } from "./receipts.js";

/** Every screen says who it is drawn for. */
const SEEN_BY: Viewer = { base: "", mode: "sandbox", who: "owner@example.com", confirmed: true };

/** Inside the gate, as the screens are, so a form that posts knows its address. */
const served = (screen: () => ReactElement): string => {
  const Stub = createRoutesStub([
    { id: "routes/gate", path: "/", children: [{ path: "page", Component: screen }] },
  ]);
  return renderToString(
    <Stub
      initialEntries={["/page"]}
      hydrationData={{ loaderData: { "routes/gate": { who: SEEN_BY.who } } }}
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

const order = (id: string, test: boolean) => ({
  id,
  merchant_item_id: "room-101",
  params: {},
  price: {
    amount: "80.00",
    currency: "USD",
    at: "2026-08-26T10:20:00Z",
    as_of: "2026-08-26T10:15:00Z",
  },
  test,
  status: "delivered",
});

const receipt = (id: string, test: boolean) => ({
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
  test,
});

const ordersPage = (orders: OrderList, viewer: Viewer = SEEN_BY): string =>
  served(() => <OrdersScreen view={ordersView(viewer.mode, cards, orders, orders)} />);

const receiptsPage = (receipts: ReceiptList, viewer: Viewer = SEEN_BY): string =>
  served(() => <ReceiptsScreen view={receiptsView(viewer, cards, receipts)} />);

/** On the live site, which draws no band over its pages to say what is a test. */
const ON_LIVE: Viewer = { ...SEEN_BY, mode: "live" };

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
  ...order(id, false),
  price: { ...order(id, false).price, amount },
});

/** Each row's amount, as a person reads it on a wide screen: a receipt's cell, or an order's. */
const amountsIn = (html: string): string[] =>
  [
    ...html.matchAll(
      /<td class="amount"[^>]*>([\s\S]*?)<\/td>|<div class="cell cell-amount">([\s\S]*?)<\/div><div class="cell cell-state">/g,
    ),
  ].map((cell) => readable(cell[1] ?? cell[2] ?? ""));

/** What each order's row opens to on a narrow screen. */
const openedIn = (html: string): string[] =>
  [...html.matchAll(/<div class="more-body">([\s\S]*?)<\/div><\/details>/g)].map((opened) =>
    readable(opened[1] ?? ""),
  );

describe("the receipts of sales that went out", () => {
  it("counts a parcel handed to a carrier beside goods handed over, and says which it is", () => {
    // A shipped parcel is counted with the delivered ones, under a label that
    // does not call a parcel with a carrier delivered.
    const receipts: ReceiptList = ReceiptListSchema.parse({
      receipts: [receipt("rcp_1", false), { ...receipt("rcp_2", false), outcome: "shipped" }],
    });

    const text = readable(receiptsPage(receipts));

    expect(text).toContain("Delivered or shipped 2 of 2 receipts");
    expect(text).toContain("shipped");
  });

  it("lists the latest payment first, whatever order the gateway gave them in", () => {
    const receipts: ReceiptList = ReceiptListSchema.parse({
      receipts: [
        { ...receipt("rcp_old", false), paid_at: "2026-08-26T09:00:03Z" },
        { ...receipt("rcp_new", false), paid_at: "2026-08-26T11:00:03Z" },
        { ...receipt("rcp_mid", false), paid_at: "2026-08-26T10:00:03Z" },
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
      receipts: [{ ...receipt(id, false), order_id: order }],
    });

    const html = receiptsPage(receipts);
    const lines = html.replace(/<details class="cell-more[\s\S]*?<\/details>/g, "");
    const [opened] = openedIn(html);

    expect(readable(lines)).not.toMatch(/rcp_|ord_/);
    expect(opened).toContain(`Receipt ${id}`);
    expect(opened).toContain(`Order ${order}`);
    expect(html).toContain(`aria-label="Copy the whole receipt ID ${id}"`);
    expect(html).toContain(`aria-label="Copy the whole order ID ${order}"`);
  });
});

describe("a list where some of the money was real and some was not", () => {
  it("counts the test purchases rather than calling the whole page a test", () => {
    const orders: OrderList = OrderListSchema.parse({
      orders: [order("ord_1", true), order("ord_2", false), order("ord_3", false)],
    });

    const text = readable(ordersPage(orders, ON_LIVE));

    expect(text).toContain("1 order here is a test purchase");
    expect(text).not.toContain("Every order here is a test purchase");
  });

  it("marks each test order's sum, in every row the order is drawn in, and no real one", () => {
    const orders: OrderList = OrderListSchema.parse({
      orders: [
        { ...order("ord_1", true), status: "refund_due" },
        order("ord_2", false),
        order("ord_3", false),
      ],
    });

    const html = ordersPage(orders);
    const rows = html.split("<li").slice(1);

    // The refund's own row and its line in the list beside the two real sales.
    expect(rows.filter((row) => row.includes(">test<"))).toHaveLength(2);
    expect(rows.filter((row) => row.includes("ord_2") && row.includes(">test<"))).toHaveLength(0);
  });

  it("marks the test rows and leaves the real ones alone", () => {
    const receipts: ReceiptList = ReceiptListSchema.parse({
      receipts: [receipt("rcp_1", true), receipt("rcp_2", false)],
    });

    const html = receiptsPage(receipts, ON_LIVE);
    const rows = html.split('<li class="list-row').slice(1);

    expect(readable(html)).toContain("1 receipt here is a test purchase");
    // One row carries the mark and the other does not; a page that marked both
    // or neither would be useless on exactly the day this matters. The mark is
    // found by its word, not its class, because the page uses that class for
    // another pill too.
    expect(rows.filter((row) => row.includes(">test<"))).toHaveLength(1);
  });

  it("says nothing about test money when none of it was a test", () => {
    const receipts: ReceiptList = ReceiptListSchema.parse({
      receipts: [receipt("rcp_1", false)],
    });
    const orders: OrderList = OrderListSchema.parse({ orders: [order("ord_1", false)] });

    expect(readable(receiptsPage(receipts, ON_LIVE))).not.toContain("test purchase");
    expect(readable(ordersPage(orders, ON_LIVE))).not.toContain("test purchase");
    expect(receiptsPage(receipts, ON_LIVE)).not.toContain(">test<");
    expect(ordersPage(orders, ON_LIVE)).not.toContain(">test<");
  });

  it("says once on the live site, which draws no band, that every row is a test", () => {
    const receipts: ReceiptList = ReceiptListSchema.parse({
      receipts: [receipt("rcp_1", true), receipt("rcp_2", true)],
    });
    const orders: OrderList = OrderListSchema.parse({ orders: [order("ord_1", true)] });

    expect(readable(receiptsPage(receipts, ON_LIVE))).toContain(
      "Every receipt here is a test purchase: no real money moved.",
    );
    expect(readable(ordersPage(orders, ON_LIVE))).toContain(
      "Every order here is a test purchase: no real money moved.",
    );
  });

  it("leaves it to the band on a channel that draws one, and still marks every sum", () => {
    // The test site's band says on every page that its payments are tests, so
    // the list does not say it a second time; the mark on each sum stays.
    const onTest: Viewer = { ...SEEN_BY, mode: "test" };
    const receipts: ReceiptList = ReceiptListSchema.parse({
      receipts: [receipt("rcp_1", true), receipt("rcp_2", true)],
    });
    const orders: OrderList = OrderListSchema.parse({ orders: [order("ord_1", true)] });

    const html = receiptsPage(receipts, onTest);
    const rows = html.split('<li class="list-row').slice(1);

    expect(readable(html)).not.toContain("test purchase");
    expect(readable(ordersPage(orders, onTest))).not.toContain("test purchase");
    expect(rows.filter((row) => row.includes(">test<"))).toHaveLength(2);
  });
});

describe("the shares of a sale paid into the merchant's payout split", () => {
  // Computed by hand in whole millionths of a dollar, USDC's smallest unit,
  // each share rounded down as the split rounds it: 0.29 at 99.9% is 289710
  // millionths exactly, where floating point makes it 0.28970999999999997.
  const SHARES: readonly (readonly [price: string, merchant: string, commission: string])[] = [
    ["80.00", "≈ 79.92 USD", "≈ 0.08 USD"],
    ["5", "≈ 4.995 USD", "≈ 0.005 USD"],
    ["0.29", "≈ 0.28971 USD", "≈ 0.00029 USD"],
    ["0.09", "≈ 0.08991 USD", "≈ 0.00009 USD"],
    ["0.01", "≈ 0.00999 USD", "≈ 0.00001 USD"],
    ["0.000019", "≈ 0.000018 USD", "under 0.000001 USD"],
    ["0.000001", "under 0.000001 USD", "under 0.000001 USD"],
  ];

  it("says each order's shares as about so much, rounded down to a millionth as the split rounds them", () => {
    const orders: OrderList = OrderListSchema.parse({
      orders: SHARES.map(([price]) => pricedAt(price)),
    });
    const paidInto = Object.fromEntries(orders.orders.map((one) => [one.id, SPLIT]));

    const html = served(() => (
      <OrdersScreen
        view={ordersView(SEEN_BY.mode, cards, orders, orders, undefined, {}, paidInto)}
      />
    ));

    // A wide row says the merchant's share under the price; the row a phone
    // opens says both, beside the whole ID and the moment.
    expect(amountsIn(html)).toStrictEqual(
      SHARES.map(([price, merchant]) => `${price} USD ${merchant} to you`),
    );
    expect(openedIn(html)).toStrictEqual(
      SHARES.map(
        ([price, merchant, commission]) =>
          `ord_${price} ${merchant} to you ${commission} to Agentify Price set 2026-08-26 10:20:00 UTC`,
      ),
    );
  });

  it("says a receipt's shares the same way", () => {
    const receipts: ReceiptList = ReceiptListSchema.parse({
      receipts: SHARES.map(([price], at) => ({
        ...receipt(`rcp_${at}`, false),
        price: { ...receipt(`rcp_${at}`, false).price, amount: price },
      })),
    });
    const paidInto = Object.fromEntries(receipts.receipts.map((one) => [one.order_id, SPLIT]));

    const html = served(() => (
      <ReceiptsScreen view={receiptsView(SEEN_BY, cards, receipts, null, paidInto)} />
    ));

    // A row says the merchant's share under the price; the row's opened part
    // says both.
    expect(amountsIn(html)).toStrictEqual(
      SHARES.map(([price, merchant]) => `${price} USD ${merchant} to you`),
    );
    for (const [at, opened] of openedIn(html).entries()) {
      const [, merchant, commission] = SHARES[at] ?? [];
      expect(opened).toContain(`${merchant} to you ${commission} to Agentify`);
    }
  });

  it("divides by the terms of the split the order was paid into, not by a rate of its own", () => {
    const orders: OrderList = OrderListSchema.parse({ orders: [pricedAt("80.00")] });

    const html = served(() => (
      <OrdersScreen
        view={ordersView(
          SEEN_BY.mode,
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

    expect(amountsIn(html)).toStrictEqual(["80.00 USD ≈ 77.60 USD to you"]);
    expect(openedIn(html)[0]).toContain("≈ 2.40 USD to Agentify");
  });

  it("shows no shares for an order paid to a wallet itself, before payments went to splits", () => {
    // Such an order paid the whole price to the wallet, and "to Agentify" on
    // it would be a false statement about money.
    const orders: OrderList = OrderListSchema.parse({
      orders: [pricedAt("80.00", "ord_split"), pricedAt("80.00", "ord_wallet")],
    });

    const html = served(() => (
      <OrdersScreen
        view={ordersView(SEEN_BY.mode, cards, orders, orders, undefined, {}, { ord_split: SPLIT })}
      />
    ));

    expect(amountsIn(html)).toStrictEqual(["80.00 USD ≈ 79.92 USD to you", "80.00 USD"]);
    expect(openedIn(html)[1]).not.toContain("Agentify");
  });
});

describe("a refund owed", () => {
  it("names the full price as owed back, although the merchant's share was less", () => {
    // The commission is not given back by the split, and the buyer is owed
    // what they paid.
    const owing: OrderList = OrderListSchema.parse({
      orders: [{ ...pricedAt("80.00", "ord_owed"), status: "refund_due" }],
    });

    const text = readable(
      served(() => (
        <OrdersScreen
          view={ordersView(
            SEEN_BY.mode,
            cards,
            owing,
            owing,
            undefined,
            { ord_owed: "deadline_passed" },
            {
              ord_owed: SPLIT,
            },
          )}
        />
      )),
    );
    const callout = text.slice(text.indexOf("Needs you"), text.indexOf("All orders"));

    expect(callout).toMatch(/the full price, 80\.00 USD/);
    expect(callout).toMatch(/the commission stays with Agentify/);
    expect(callout).not.toContain("79.92");
  });

  it("says nothing of a commission on a refund owed for a payment to the wallet itself", () => {
    // Paid before payments went to splits: no commission was taken. Where the
    // cause could not be read, the sentence says only what holds for every
    // debt.
    const owing: OrderList = OrderListSchema.parse({
      orders: [{ ...pricedAt("80.00", "ord_owed"), status: "refund_due" }],
    });

    const text = readable(
      served(() => <OrdersScreen view={ordersView(SEEN_BY.mode, cards, owing, owing)} />),
    );
    const callout = text.slice(text.indexOf("Needs you"), text.indexOf("All orders"));

    expect(callout).toMatch(/Paid, and the product was not delivered/);
    expect(callout).toMatch(/the full price, 80\.00 USD/);
    expect(callout).not.toMatch(/commission/);
  });
});

describe("an order delivered and not paid", () => {
  // Nothing is owed by the merchant, so it is not counted among the orders
  // that need them; but whether to revoke what was delivered or to wait is
  // theirs to decide, as the documentation says, and the screen says so.
  const held: OrderList = OrderListSchema.parse({
    orders: [{ ...order("ord_held", false), status: "delivered_unpaid" }],
  });

  it("is not counted as needing the merchant, and says it waits on the buyer", () => {
    const text = readable(ordersPage(held));

    expect(text).toContain("Waiting on the buyer 1 Nothing owed by you");
    expect(text).not.toMatch(/needs? you/i);
    expect(text).toContain("the payment failed, so the goods are held");
    // Paid again for the same order, never bought again, which would deliver
    // twice.
    expect(text).toContain("The buyer can pay again for this same order");
  });

  it("leaves to the merchant whether to revoke what they delivered or to wait", () => {
    const text = readable(ordersPage(held));

    expect(text).toContain("whether to revoke what you delivered or wait is yours to decide");
    expect(text).not.toMatch(/nothing for you to do/i);
  });

  it("is told apart from a refund due listed beside it", () => {
    const both: OrderList = OrderListSchema.parse({
      orders: [...held.orders, { ...order("ord_owed", false), status: "refund_due" }],
    });

    const text = readable(ordersPage(both));
    const at = (words: string) => text.indexOf(words);

    expect(text).toContain("Needs you 1");
    expect(text).toContain("Waiting on the buyer 1");
    expect(at("Needs you")).toBeLessThan(at("ord_owed"));
    expect(at("ord_owed")).toBeLessThan(at("Waiting on the buyer"));
    expect(at("Waiting on the buyer")).toBeLessThan(at("ord_held"));
  });
});

describe("the state of each card", () => {
  const entry = cards.cards[0];
  if (entry === undefined) throw new Error("the example catalogue has no card");
  const listOf = (selling: "open" | "paused" | "departed", ...more: Partial<typeof entry>[]) =>
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

  it("says beside a card the shop published that it is off sale while the code sells", () => {
    // The banner names no reason for it: only this card's row can say which
    // of the merchant's cards came from the shop.
    const list = listOf("open", { selling: "paused", paused: false });
    const html = served(() => (
      <CardsScreen
        view={cardsView(list, "https://agentify.ad", false, {
          through: "api",
          offSale: ["itm_0"],
        })}
        base=""
      />
    ));
    const row = /<li class="list-row[^"]*">([\s\S]*?)<\/li>/.exec(html)?.[1] ?? "";

    expect(readable(row)).toMatch(/off sale while you sell through your own code/i);
    expect(row).not.toContain("<form");
  });

  it("gives a shop's card of a merchant who has left no reason of its own: they sell through nothing", () => {
    const list = listOf("departed", { selling: "departed", paused: false });
    const html = served(() => (
      <CardsScreen
        view={cardsView(list, "https://agentify.ad", false, {
          through: "api",
          offSale: ["itm_0"],
        })}
        base=""
      />
    ));
    const row = /<li class="list-row[^"]*">([\s\S]*?)<\/li>/.exec(html)?.[1] ?? "";

    expect(readable(row)).toContain("Off sale");
    expect(readable(row)).not.toMatch(/own code/i);
    expect(row).not.toContain("<form");
  });

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
    // An order that runs past the default window owes a refund as one past a
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

    expect(readable(fact)).toBe("Later, within Agentify's default window");
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

  it("does not repeat under every title the moment a fixed price holds from", () => {
    // On a real catalogue every fixed-price row would carry the same line.
    const html = served(() => (
      <CardsScreen view={cardsView(cards, "https://agentify.ad")} base="" />
    ));
    const main =
      /<div class="cell cell-main">([\s\S]*?)<div class="cell cell-amount"/.exec(html)?.[1] ?? "";

    expect(readable(main)).toContain("A room for the night");
    expect(readable(main)).not.toMatch(/since/i);
  });

  it("opens the price, at a press or a key, to the moment it holds from, on every width", () => {
    // A title on a span is reached by a resting pointer alone; a disclosure
    // the browser opens itself is reached by a key and a tap as well, without
    // the page's script.
    const html = served(() => (
      <CardsScreen view={cardsView(cards, "https://agentify.ad")} base="" />
    ));
    const price =
      /<div class="cell cell-amount"><details[^>]*><summary[^>]*>([^<]*)<\/summary>([\s\S]*?)<\/details>/.exec(
        html,
      );

    expect(price?.[1]).toBe("80.00 USD");
    expect(readable(price?.[2] ?? "")).toBe("On the card since 2026-08-26 09:00:00 UTC");
    expect(html).not.toContain('class="cell-more');
  });

  it("leaves a price asked at purchase as it is, with nothing to open", () => {
    const entry = cards.cards[0];
    if (entry === undefined) throw new Error("the example catalogue has no card");
    const asked = MerchantCardListSchema.parse({
      selling: "open",
      cards: [{ ...entry, card: { ...entry.card, price_check: "handler" } }],
    });
    const html = served(() => (
      <CardsScreen view={cardsView(asked, "https://agentify.ad")} base="" />
    ));
    const price = /<div class="cell cell-amount">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";

    expect(price).not.toContain("<details");
    expect(readable(price)).toBe("80.00 USD");
  });
});

describe("a search over the cards", () => {
  const entry = cards.cards[0];
  if (entry === undefined) throw new Error("the example catalogue has no card");
  const many = (count: number) =>
    MerchantCardListSchema.parse({
      selling: "open",
      cards: Array.from({ length: count }, (_, at) => ({
        ...entry,
        id: `itm_${at}`,
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

    expect(text).toContain("No card matches “suite”. Clear the search");
    expect(text).not.toContain("haven't published any cards");
    expect(page(many(0), "q=suite")).toContain("You haven't published any cards yet.");
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

    expect(drawn("q=1")).toContain("Only the card with the product code “1”.");
    expect(drawn("q=1&show=off-sale")).toContain("No card off sale has the product code “1”.");
    expect(drawn("q=room")).not.toContain("product code “");
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
  const none = (selling: "open" | "departed") =>
    readable(
      served(() => (
        <CardsScreen
          view={cardsView(
            MerchantCardListSchema.parse({ selling, cards: [] }),
            "https://agentify.ad",
            true,
          )}
          base=""
        />
      )),
    );

  it("offers the ways to a first card to a merchant who sells", () => {
    expect(none("open")).toContain("Publish a card through the SDK");
    expect(none("open")).toContain("Connect a WooCommerce shop");
  });

  it("offers no way to sell to a merchant who has left", () => {
    // Nothing on this page puts a merchant who left back on sale, so a way to
    // publish would lead to a refusal.
    const text = none("departed");

    expect(text).not.toContain("Publish a card through the SDK");
    expect(text).not.toContain("Connect a WooCommerce shop");
    expect(text).toContain("You have no cards.");
  });
});
