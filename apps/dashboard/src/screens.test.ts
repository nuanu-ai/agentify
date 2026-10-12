/**
 * Sentences the real gateway cannot reach yet: while every order is a test, a
 * list mixing test and real money cannot be produced over HTTP, and its failure
 * would be a merchant counting test purchases as takings. The screens are pure
 * functions of the gateway's documents, and the documents here are built by the
 * contract's own schemas, so nothing is stubbed.
 */

import { SURFACE_MARKER_ATTRIBUTE, SURFACE_WORDS } from "@agentify/core";
import type { OrderList, ReceiptList } from "@nuanu-ai/agentify-contracts";
import {
  MerchantCardListSchema,
  OrderListSchema,
  ReceiptListSchema,
} from "@nuanu-ai/agentify-contracts";
import { describe, expect, it } from "vitest";
import { page } from "./html.js";
import { cardsScreen, ordersScreen, receiptsScreen, type Viewer } from "./screens.js";
import { settingsScreen } from "./seller-name.js";
import { signInScreen } from "./sign-in.js";
import { readable } from "./testing/html.js";

/** Every screen says who it is drawn for. */
const SEEN_BY: Viewer = { base: "", mode: "sandbox", who: "owner@example.com", confirmed: true };

describe("what a page says about the stack it belongs to", () => {
  it("says nothing settles here on the laptop", () => {
    // The sandbox sign-in page must say that no payment settles here.
    const html = signInScreen("", "sandbox");

    expect(html).toContain(`${SURFACE_MARKER_ATTRIBUTE}="sandbox"`);
    expect(readable(html)).toContain(SURFACE_WORDS.sandbox);
  });

  it("says payments settle with test funds on the test site", () => {
    // The test-site page must carry its test-funds warning.
    const html = signInScreen("", "test");

    expect(html).toContain(`${SURFACE_MARKER_ATTRIBUTE}="test"`);
    expect(readable(html)).toContain(SURFACE_WORDS.test);
  });

  it("says nothing at all on the live one, and still names itself", () => {
    // The marker names the mode rather than merely existing: an absence cannot
    // tell a correct live page from one that failed to render.
    const html = signInScreen("", "live");

    expect(html).toContain(`${SURFACE_MARKER_ATTRIBUTE}="live"`);
    expect(readable(html)).not.toContain(SURFACE_WORDS.test);
    expect(readable(html)).not.toContain(SURFACE_WORDS.sandbox);
    // No banner element either: an empty styled one is a band across a live
    // page.
    expect(html).not.toContain('class="stack-note"');
  });

  it("carries the same marker on a signed-in page", () => {
    // Pages behind the sign-in must carry the stack label too.
    const html = page({
      base: "",
      who: "owner@example.com",
      confirmed: true,
      tab: "cards",
      title: "Cards",
      mode: "test",
      body: "<p>x</p>",
    });

    expect(html).toContain(`${SURFACE_MARKER_ATTRIBUTE}="test"`);
    expect(readable(html)).toContain(SURFACE_WORDS.test);
  });
});

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

describe("the receipts of sales that went out", () => {
  it("counts a parcel handed to a carrier beside goods handed over, and says which it is", () => {
    // A shipped parcel is counted with the delivered ones, under a label that
    // does not call a parcel with a carrier delivered.
    const receipts: ReceiptList = ReceiptListSchema.parse({
      receipts: [receipt("rcp_1", false), { ...receipt("rcp_2", false), outcome: "shipped" }],
    });

    const text = readable(receiptsScreen(SEEN_BY, cards, receipts));

    expect(text).toContain("Delivered or shipped 2 of 2 receipts");
    expect(text).toContain("shipped");
  });
});

describe("a list where some of the money was real and some was not", () => {
  it("counts the test purchases rather than calling the whole page a test", () => {
    const orders: OrderList = OrderListSchema.parse({
      orders: [order("ord_1", true), order("ord_2", false), order("ord_3", false)],
    });

    const text = readable(ordersScreen(SEEN_BY, cards, orders, false));

    expect(text).toContain("1 order here is a test purchase");
    expect(text).not.toContain("Every order here is a test purchase");
  });

  it("marks the test rows and leaves the real ones alone", () => {
    const receipts: ReceiptList = ReceiptListSchema.parse({
      receipts: [receipt("rcp_1", true), receipt("rcp_2", false)],
    });

    const html = receiptsScreen(SEEN_BY, cards, receipts);
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

    const onReceipts = readable(receiptsScreen(SEEN_BY, cards, receipts));
    const onOrders = readable(ordersScreen(SEEN_BY, cards, orders, false));

    expect(onReceipts).not.toContain("test purchase");
    expect(onOrders).not.toContain("test purchase");
    expect(receiptsScreen(SEEN_BY, cards, receipts)).not.toContain(">test<");
  });
});

describe("whether a live merchant is approved", () => {
  // A live merchant is told whether they have the operator's approval, and a
  // card off sale for want of it says so.
  const live = (approved: boolean): Viewer => ({
    ...SEEN_BY,
    mode: "live",
    sellerName: "Freeland",
    sellerSite: "https://freeland.example",
    payout: { wallet: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", pending: null },
    liveApproval: approved,
  });
  const offSale = MerchantCardListSchema.parse({
    ...cards,
    cards: cards.cards.map((entry) => ({ ...entry, selling: "paused" })),
  });

  it("says on Settings whether Agentify has approved the merchant for live sales", () => {
    const approved = readable(settingsScreen(live(true)));
    const waiting = readable(settingsScreen(live(false)));

    expect(approved).toMatch(/approved your merchant/);
    expect(waiting).toMatch(/not approved your merchant/);
    expect(approved).not.toMatch(/not approved your merchant/);
  });

  it("says nothing about the approval off the live channel, where nobody needs it", () => {
    for (const mode of ["sandbox", "test"] as const) {
      const unapproved = { ...live(false), mode };

      expect(readable(settingsScreen(unapproved)), mode).not.toMatch(/approv/i);
    }
  });

  it("says on an empty Cards page that publishing waits for the approval", () => {
    // Without the approval every live publish is refused, so an unapproved
    // merchant's Cards page is the empty one, where they look for why nothing
    // appears.
    const none = MerchantCardListSchema.parse({ ...cards, cards: [] });

    expect(readable(cardsScreen(live(false), none, "https://agentify.ad"))).toMatch(
      /not approved your merchant/,
    );
    expect(readable(cardsScreen(live(true), none, "https://agentify.ad"))).not.toMatch(/approv/);
  });

  it("says a card is off sale because the approval is still to come", () => {
    const waiting = readable(cardsScreen(live(false), offSale, "https://agentify.ad"));

    expect(waiting).toMatch(/not approved your merchant/);
    expect(waiting).not.toMatch(/cannot tell/);
  });
});
