/**
 * Sentences the real gateway cannot reach yet: while every order is a test, a
 * list mixing test and real money cannot be produced over HTTP, and its failure
 * would be a merchant counting test purchases as takings. The views are pure
 * functions of the gateway's documents, and the documents here are built by the
 * contract's own schemas, so nothing is stubbed; each page is drawn as the
 * server sends it.
 */

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
import type { Viewer } from "../../src/screens.js";
import { readable } from "../../src/testing/html.js";
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
  served(() => <OrdersScreen view={ordersView(SEEN_BY, cards, orders, false)} />);

const receiptsPage = (receipts: ReceiptList): string =>
  served(() => <ReceiptsScreen view={receiptsView(SEEN_BY, cards, receipts)} />);

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

    const text = readable(ordersPage(orders));

    expect(text).toContain("1 order here is a test purchase");
    expect(text).not.toContain("Every order here is a test purchase");
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
