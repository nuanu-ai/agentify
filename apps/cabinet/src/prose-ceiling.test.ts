/**
 * How many words of prose each screen is allowed to carry.
 *
 * This file exists because the rule slipped past people twice. A pass in
 * September 2026 cut the cabinet's text by an audit that kept every sentence
 * carrying a fact, and Dmitry read the result and said it was still far too
 * much and still did not read like an e-commerce admin — naming the settings
 * page's three paragraphs about a seller name, its three about a payout
 * address, and the paragraph under the orders table. The charter's rule is
 * that a rule moves into a machine after it has slipped past people; it has
 * now slipped twice on this surface, so it is a test.
 *
 * What is counted, so that a number here can be argued with:
 *
 * - Every `<p>` on the page, which is where a screen's prose lives. A word
 *   inside a heading, a label, a button, a table cell or a list item is not
 *   counted: those are the screen's structure and its data, and a product list
 *   grows with the catalogue rather than with anybody's writing.
 * - Minus the text of any link inside those paragraphs. A link is a control.
 *   Every footnote here ends with one, and counting "How an order can end"
 *   against the sentence that earns it would price a door as prose.
 *   Minus `p.secret`, which is a key and not a sentence.
 * - Minus the page's chrome: the header with the tabs, the footer, the banner
 *   naming the stack, and the row with the signed-in address. Those are the
 *   same on every screen and are not what any of them is about.
 * - The notice boxes are not counted either. They are `div`s, they are drawn
 *   one per order that needs the merchant, and like rows they scale with what
 *   happened rather than with what anybody wrote. They are held to the same
 *   discipline by review and by the tests that read them.
 *
 * The footnote — `p.note` — is counted apart from the rest, because the two
 * have different jobs and different limits. The body of a screen is a heading,
 * a line of counts and the controls; the footnote is the one sentence that
 * says what the table cannot show. A screen is allowed one.
 *
 * The numbers are the standard Dmitry set, with about fifteen per cent on top:
 * the point is to catch a paragraph coming back, not to referee a comma.
 */

import type {
  MerchantCardList,
  MerchantKey,
  MerchantKeyList,
  OrderList,
  ReceiptList,
} from "@nuanu-ai/agentify-contracts";
import {
  MerchantCardListSchema,
  OrderListSchema,
  ReceiptListSchema,
} from "@nuanu-ai/agentify-contracts";
import { describe, expect, it } from "vitest";
import { keysScreen, newKeyScreen } from "./keys.js";
import { cardsScreen, ordersScreen, receiptsScreen, type Viewer } from "./screens.js";
import { chooseNameScreen, settingsScreen } from "./seller-name.js";
import { KEY_REFUSED_BY_GATEWAY, problemPageAt } from "./server.js";
import {
  linkRequestedScreen,
  mailUnavailableScreen,
  merchantSetupScreen,
  openLinkScreen,
  refusedLinkScreen,
  signInScreen,
} from "./sign-in.js";
import { readable } from "./testing/html.js";
import { wooImportScreen, wooReturnScreen, wooScreen } from "./woo-screens.js";

/** The parts of a page that are the same on every screen and belong to none. */
const withoutChrome = (html: string): string =>
  html
    .replaceAll(/<header[\s\S]*?<\/header>/gi, " ")
    .replaceAll(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replaceAll(/<div class="stack-note"[\s\S]*?<\/div>\s*<\/div>/gi, " ")
    .replaceAll(/<div class="account">[\s\S]*?<\/div>\s*<\/div>/gi, " ");

const paragraphs = (html: string): readonly string[] =>
  withoutChrome(html).match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) ?? [];

const isFootnote = (paragraph: string): boolean => /<p class="note"/i.test(paragraph);
const isSecret = (paragraph: string): boolean => /<p class="secret"/i.test(paragraph);

/** The words of one paragraph, with the controls in it taken out. */
const wordsIn = (paragraph: string): readonly string[] =>
  readable(paragraph.replaceAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi, " "))
    .split(/\s+/)
    .filter((word) => word !== "");

/** Everything a screen says that is not its footnote. */
const bodyWords = (html: string): number =>
  paragraphs(html)
    .filter((one) => !isFootnote(one) && !isSecret(one))
    .flatMap((one) => wordsIn(one)).length;

/** The one sentence a screen is allowed under its table. */
const footnoteWords = (html: string): number =>
  paragraphs(html)
    .filter(isFootnote)
    .flatMap((one) => wordsIn(one)).length;

const BASE = "";
const SEEN_BY: Viewer = { base: BASE, mode: "test", who: "audit@example.com", confirmed: true };
const ORIGIN = "https://agentify.example";

const cards: MerchantCardList = MerchantCardListSchema.parse({
  selling: "open",
  cards: [
    {
      id: "itm_1",
      as_of: "2026-09-01T09:00:00Z",
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
    {
      id: "itm_2",
      as_of: "2026-09-01T09:00:00Z",
      card: {
        merchant_item_id: "esim-eu",
        title: "eSIM Europe, 5 GB for 30 days",
        description: "Thirty days of data",
        price: { amount: "8.00", currency: "USD" },
        result: { access_code: { type: "string" } },
        fulfillment: "async",
        fulfill_deadline_seconds: 3600,
      },
      selling: "paused",
      paused: true,
    },
  ],
});

const noCards: MerchantCardList = MerchantCardListSchema.parse({ selling: "open", cards: [] });

const anOrder = (id: string, status: string) => ({
  id,
  merchant_item_id: "room-101",
  params: {},
  price: {
    amount: "80.00",
    currency: "USD",
    at: "2026-09-01T10:20:00Z",
    as_of: "2026-09-01T10:15:00Z",
  },
  test: true,
  status,
});

// Both endings that need the merchant, so the page draws both notices and the
// count beside them says two.
const orders: OrderList = OrderListSchema.parse({
  orders: [
    anOrder("ord_1", "delivered"),
    anOrder("ord_2", "refund_due"),
    anOrder("ord_3", "delivered_unpaid"),
  ],
});
const noOrders: OrderList = OrderListSchema.parse({ orders: [] });

const receipts: ReceiptList = ReceiptListSchema.parse({
  receipts: [
    {
      id: "rcp_1",
      order_id: "ord_1",
      item_id: "itm_1",
      price: {
        amount: "80.00",
        currency: "USD",
        at: "2026-09-01T10:20:00Z",
        as_of: "2026-09-01T10:15:00Z",
      },
      paid_at: "2026-09-01T10:20:03Z",
      outcome: "delivered",
      test: true,
    },
  ],
});
const noReceipts: ReceiptList = ReceiptListSchema.parse({ receipts: [] });

const aKey = (id: string, label: string, used: string | null, off: string | null): MerchantKey => ({
  id,
  label,
  created_at: "2026-08-20T09:00:00.000Z",
  last_used_at: used,
  disabled_at: off,
});
// `this_call` is the key the cabinet itself is signing in with, which the
// gateway names beside the list and which is on no row of it.
const CABINET_KEY = "key_the_cabinet_is_using";
const keys: MerchantKeyList = {
  this_call: CABINET_KEY,
  keys: [
    aKey("key_nightly", "the nightly job", "2026-08-27T02:15:00.000Z", null),
    aKey("key_worker", "the worker on the small box", null, null),
    aKey("key_laptop", "the laptop that went missing", null, "2026-08-26T17:45:00.000Z"),
  ],
};
const noKeys: MerchantKeyList = { this_call: CABINET_KEY, keys: [] };

const settingsViewer: Viewer = {
  ...SEEN_BY,
  sellerName: "Bright Data Plans",
  payout: { wallet: "0x0123456789abCdef0123456789aBcDEF01234567" },
  shop: { kind: "none" },
};

/**
 * Every screen, in the state a merchant meets it in, with what it may say.
 *
 * Two numbers per row where a screen has a footnote and one where it does not.
 * A screen missing from this table is a screen with no ceiling on it, which is
 * how this stopped being true the last two times.
 */
const SCREENS: readonly {
  readonly name: string;
  readonly html: string;
  readonly body: number;
  readonly footnote?: number;
}[] = [
  // The tabbed screens: 25 words of body and a footnote of 20, plus headroom.
  {
    name: "cards, with rows",
    html: cardsScreen(settingsViewer, cards, ORIGIN),
    body: 29,
    footnote: 23,
  },
  {
    name: "cards, empty",
    html: cardsScreen({ ...settingsViewer, sellerName: null }, noCards, ORIGIN, true),
    body: 29,
    footnote: 23,
  },
  {
    name: "orders, with rows",
    html: ordersScreen(SEEN_BY, cards, orders, false),
    body: 29,
    footnote: 23,
  },
  {
    name: "orders, empty",
    html: ordersScreen(SEEN_BY, cards, noOrders, true),
    body: 29,
    footnote: 23,
  },
  {
    name: "receipts, with rows",
    html: receiptsScreen(SEEN_BY, cards, receipts),
    body: 29,
    footnote: 23,
  },
  {
    name: "receipts, empty",
    html: receiptsScreen(SEEN_BY, cards, noReceipts),
    body: 29,
    footnote: 23,
  },
  { name: "keys, with rows", html: keysScreen(SEEN_BY, keys), body: 29, footnote: 23 },
  { name: "keys, empty", html: keysScreen(SEEN_BY, noKeys), body: 29, footnote: 23 },
  {
    name: "a new key",
    html: newKeyScreen(SEEN_BY, "the nightly job", "sk_shown_once"),
    body: 29,
    footnote: 23,
  },

  // The settings page: four cards, each a title, a control and one line.
  { name: "settings", html: settingsScreen(settingsViewer), body: 92 },
  {
    name: "settings, nothing set yet",
    html: settingsScreen({ ...settingsViewer, sellerName: null, payout: { wallet: null } }),
    body: 92,
  },

  // First run, and the doors.
  { name: "choose a seller name", html: chooseNameScreen(BASE, "test"), body: 35 },
  { name: "sign in", html: signInScreen(BASE, "test"), body: 40 },
  {
    name: "check your mail",
    html: linkRequestedScreen(BASE, "test", "audit@example.com", "default"),
    body: 40,
  },
  {
    name: "too many links asked for",
    html: linkRequestedScreen(BASE, "test", "audit@example.com", "default", 600),
    body: 40,
  },
  { name: "mail is unavailable", html: mailUnavailableScreen(BASE, "test"), body: 40 },
  { name: "open your cabinet", html: openLinkScreen(BASE, "a-token", "test"), body: 40 },
  { name: "that link does not work", html: refusedLinkScreen(BASE, "test"), body: 40 },
  {
    name: "that link does not work, already signed in",
    html: refusedLinkScreen(BASE, "test", { email: "audit@example.com", destination: "cards" }),
    body: 40,
  },
  { name: "finish setting up", html: merchantSetupScreen(BASE, "test"), body: 40 },

  // The error page every failed gateway call lands on. Its longest sentence is
  // the one about a key the gateway will not take, which has to say that
  // signing in again does not help.
  {
    name: "something went wrong",
    html: problemPageAt(BASE, "test", KEY_REFUSED_BY_GATEWAY),
    body: 52,
  },

  // WooCommerce: 60 words a screen, plus headroom.
  { name: "woocommerce, connect", html: wooScreen(SEEN_BY, { state: { kind: "none" } }), body: 69 },
  {
    name: "woocommerce, waiting for the keys",
    html: wooScreen(SEEN_BY, {
      state: { kind: "waiting", shopUrl: "https://shop.example.com", startedMinutesAgo: 4 },
    }),
    body: 69,
  },
  {
    name: "woocommerce, connected",
    html: wooScreen(SEEN_BY, {
      state: {
        kind: "connected",
        shop: {
          shopUrl: "https://shop.example.com",
          permissions: "read_write",
          connectedAt: new Date("2026-09-01T12:00:00Z"),
        },
      },
    }),
    body: 69,
    footnote: 23,
  },
  { name: "woocommerce, back from the shop", html: wooReturnScreen(BASE, "test"), body: 69 },
  {
    name: "woocommerce, what came over",
    html: wooImportScreen(SEEN_BY, {
      shopUrl: "https://shop.example.com",
      outcomes: [
        { id: "11", title: "Canvas tote bag", published: "itm_1" },
        { id: "12", title: "Monthly membership", problems: ["description: too long"] },
        { id: "13", title: "Access code", failed: "the gateway could not be reached" },
      ],
      skipped: [],
    }),
    body: 69,
  },
];

describe("how much a screen may say", () => {
  for (const screen of SCREENS) {
    it(`keeps ${screen.name} inside its ceiling`, () => {
      expect(
        bodyWords(screen.html),
        `${screen.name}: words of prose outside the footnote`,
      ).toBeLessThanOrEqual(screen.body);
      if (screen.footnote !== undefined) {
        expect(
          footnoteWords(screen.html),
          `${screen.name}: words in the footnote under the table`,
        ).toBeLessThanOrEqual(screen.footnote);
      }
    });
  }

  it("allows a screen no second footnote", () => {
    // The shape this replaces was two and three notes stacked under one table,
    // each of them true and none of them read. One table, one sentence.
    for (const screen of SCREENS) {
      expect(
        paragraphs(screen.html).filter(isFootnote).length,
        `${screen.name}: footnotes under the table`,
      ).toBeLessThanOrEqual(1);
    }
  });

  it("counts the words a reader reads and not the markup around them", () => {
    // The counter itself, on a page whose answer is known: a heading, a
    // paragraph of four words, a link of three that is a control rather than
    // prose, a table cell, and a footnote of three.
    const page = `<h1>Five words in a heading</h1>
      <p>One two three four <a href="/docs/orders">five six seven</a></p>
      <table><tbody><tr><td>eight nine ten</td></tr></tbody></table>
      <p class="note">eleven twelve thirteen</p>`;

    expect(bodyWords(page)).toBe(4);
    expect(footnoteWords(page)).toBe(3);
  });
});
