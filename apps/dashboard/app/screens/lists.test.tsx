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
  served(() => <OrdersScreen view={ordersView(viewer, cards, orders, false)} />);

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

/** Each row's amount cell, as a person reads it. */
const amountsIn = (html: string): string[] =>
  [...html.matchAll(/<td class="amount"[^>]*>([\s\S]*?)<\/td>/g)].map((cell) =>
    readable(cell[1] ?? ""),
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
  it("counts the test purchases rather than calling the whole page a test", () => {
    const orders: OrderList = OrderListSchema.parse({
      orders: [order("ord_1", true), order("ord_2", false), order("ord_3", false)],
    });

    const text = readable(ordersPage(orders, ON_LIVE));

    expect(text).toContain("1 order here is a test purchase");
    expect(text).not.toContain("Every order here is a test purchase");
  });

  it("marks the test rows and leaves the real ones alone", () => {
    const receipts: ReceiptList = ReceiptListSchema.parse({
      receipts: [receipt("rcp_1", true), receipt("rcp_2", false)],
    });

    const html = receiptsPage(receipts, ON_LIVE);
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

    expect(readable(receiptsPage(receipts, ON_LIVE))).not.toContain("test purchase");
    expect(readable(ordersPage(orders, ON_LIVE))).not.toContain("test purchase");
    expect(receiptsPage(receipts, ON_LIVE)).not.toContain(">test<");
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
    const rows = html.slice(html.indexOf("<tbody>")).split("<tr");

    expect(readable(html)).not.toContain("test purchase");
    expect(readable(ordersPage(orders, onTest))).not.toContain("test purchase");
    expect(rows.filter((row) => row.includes(">test<"))).toHaveLength(2);
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

    const cells = amountsIn(
      served(() => <OrdersScreen view={ordersView(SEEN_BY, cards, orders, false, {}, paidInto)} />),
    );

    expect(cells).toStrictEqual(
      SHARES.map(
        ([price, merchant, commission]) =>
          `${price} USD ${merchant} to you ${commission} to Agentify`,
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

    const [cell] = amountsIn(
      served(() => (
        <OrdersScreen
          view={ordersView(SEEN_BY, cards, orders, false, {}, { "ord_80.00": AT_THREE_PERCENT })}
        />
      )),
    );

    expect(cell).toBe("80.00 USD ≈ 77.60 USD to you ≈ 2.40 USD to Agentify");
  });

  it("shows no shares for an order paid to a wallet itself, before payments went to splits", () => {
    // Such an order paid the whole price to the wallet, and "to Agentify" on
    // it would be a false statement about money.
    const orders: OrderList = OrderListSchema.parse({
      orders: [pricedAt("80.00", "ord_split"), pricedAt("80.00", "ord_wallet")],
    });

    const cells = amountsIn(
      served(() => (
        <OrdersScreen view={ordersView(SEEN_BY, cards, orders, false, {}, { ord_split: SPLIT })} />
      )),
    );

    expect(cells).toStrictEqual([
      "80.00 USD ≈ 79.92 USD to you ≈ 0.08 USD to Agentify",
      "80.00 USD",
    ]);
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
            false,
            { ord_owed: "deadline_passed" },
            {
              ord_owed: SPLIT,
            },
          )}
        />
      )),
    );
    const callout = text.slice(text.indexOf("Order ord_owed refund due"));

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
      served(() => <OrdersScreen view={ordersView(SEEN_BY, cards, owing, false)} />),
    );
    const callout = text.slice(text.indexOf("Order ord_owed refund due"));

    expect(callout).toMatch(/The payment was received and the product was not delivered/);
    expect(callout).toMatch(/the full price, 80\.00 USD/);
    expect(callout).not.toMatch(/commission/);
  });
});
