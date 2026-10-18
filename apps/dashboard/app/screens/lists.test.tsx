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

const ordersPage = (orders: OrderList): string =>
  served(() => <OrdersScreen view={ordersView(SEEN_BY, cards, orders, orders)} />);

const receiptsPage = (receipts: ReceiptList): string =>
  served(() => <ReceiptsScreen view={receiptsView(SEEN_BY, cards, receipts)} />);

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
});

describe("a list where some of the money was real and some was not", () => {
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

    const html = receiptsPage(receipts);
    const rows = html.slice(html.indexOf("<tbody>")).split("<tr");

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

    expect(readable(receiptsPage(receipts))).not.toContain("test purchase");
    expect(readable(ordersPage(orders))).not.toContain("test purchase");
    expect(receiptsPage(receipts)).not.toContain(">test<");
    expect(ordersPage(orders)).not.toContain(">test<");
  });
});

describe("whether a live merchant is approved, on the cards", () => {
  // A card off sale for want of the operator's approval says so.
  const live = (approved: boolean): Viewer => ({
    ...SEEN_BY,
    mode: "live",
    sellerName: "Freeland",
    payout: { wallet: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" },
    liveApproval: approved,
  });
  const offSale = MerchantCardListSchema.parse({
    ...cards,
    cards: cards.cards.map((entry) => ({ ...entry, selling: "paused" })),
  });
  const cardsPage = (viewer: Viewer, list: typeof cards): string =>
    served(() => (
      <CardsScreen view={cardsView(viewer, list, "https://agentify.ad")} base={viewer.base} />
    ));

  it("says on an empty Cards page that publishing waits for the approval", () => {
    // Without the approval every live publish is refused, so an unapproved
    // merchant's Cards page is the empty one, where they look for why nothing
    // appears.
    const none = MerchantCardListSchema.parse({ ...cards, cards: [] });

    expect(readable(cardsPage(live(false), none))).toMatch(/not approved your merchant/);
    expect(readable(cardsPage(live(true), none))).not.toMatch(/approv/);
  });

  it("says a card is off sale because the approval is still to come", () => {
    const waiting = readable(cardsPage(live(false), offSale));

    expect(waiting).toMatch(/not approved your merchant/);
    expect(waiting).not.toMatch(/cannot tell/);
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
      <OrdersScreen view={ordersView(SEEN_BY, cards, orders, orders, undefined, {}, paidInto)} />
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

    const cells = amountsIn(
      served(() => (
        <ReceiptsScreen view={receiptsView(SEEN_BY, cards, receipts, null, paidInto)} />
      )),
    );

    expect(cells).toStrictEqual(
      SHARES.map(
        ([price, merchant, commission]) =>
          `${price} USD ${merchant} to you ${commission} to Agentify`,
      ),
    );
  });

  it("divides by the terms of the split the order was paid into, not by a rate of its own", () => {
    const orders: OrderList = OrderListSchema.parse({ orders: [pricedAt("80.00")] });

    const html = served(() => (
      <OrdersScreen
        view={ordersView(
          SEEN_BY,
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
        view={ordersView(SEEN_BY, cards, orders, orders, undefined, {}, { ord_split: SPLIT })}
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
            SEEN_BY,
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
      served(() => <OrdersScreen view={ordersView(SEEN_BY, cards, owing, owing)} />),
    );
    const callout = text.slice(text.indexOf("Needs you"), text.indexOf("All orders"));

    expect(callout).toMatch(/Paid, and the product was not delivered/);
    expect(callout).toMatch(/the full price, 80\.00 USD/);
    expect(callout).not.toMatch(/commission/);
  });
});

describe("an order delivered and not paid", () => {
  // The buyer can pay again and nothing is the merchant's to do, so it is not
  // counted among the orders that need them; what can still happen to it is
  // said all the same.
  const held: OrderList = OrderListSchema.parse({
    orders: [{ ...order("ord_held", false), status: "delivered_unpaid" }],
  });

  it("is not counted as needing the merchant, and says it waits on the buyer", () => {
    const text = readable(ordersPage(held));

    expect(text).toContain("Waiting on the buyer 1 Nothing for you to do");
    expect(text).not.toMatch(/needs? you/i);
    expect(text).toContain("the payment failed, so the goods are held");
    // Paid again for the same order, never bought again, which would deliver
    // twice.
    expect(text).toContain("The buyer can pay again for this same order");
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
    cardsView(SEEN_BY, list, "https://agentify.ad", false, {
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

  it("does not call a card paused by the merchant while the other integration holds it", () => {
    // Resuming it would not put it on sale, so "Paused by you" would send the
    // merchant to a switch that changes nothing.
    const list = listOf("open", { selling: "paused", paused: true });

    expect(wordsOf(list, ["itm_0"])).toStrictEqual(["Off sale"]);
  });
});

describe("a card's row on a phone", () => {
  it("keeps what the narrow row leaves out in the row's opened part", () => {
    // The moment the price holds from is drawn under the title on a wide box
    // only; on a phone it is one press away, never gone.
    const html = served(() => (
      <CardsScreen view={cardsView(SEEN_BY, cards, "https://agentify.ad")} base="" />
    ));
    const opened = /<details class="cell-more">([\s\S]*?)<\/details>/.exec(html)?.[1] ?? "";

    expect(readable(opened)).toContain("Price on the card since 2026-08-26 09:00:00 UTC");
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
            SEEN_BY,
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
