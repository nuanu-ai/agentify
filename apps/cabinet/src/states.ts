/**
 * The showcase of rare states, mounted only on a laptop stand (SANDBOX).
 *
 * Some of what the cabinet can say is hard to reach on a stand: a test
 * purchase, an order that owes a refund, a mail provider that is down. This
 * page lists each such state with when a merchant sees it and what causes it,
 * and opens it drawn by the very function the working screen uses, on sample
 * data. A copy of the markup here would drift from the screen it shows; a call
 * cannot.
 */
import {
  MerchantCardListSchema,
  OrderListSchema,
  ReceiptListSchema,
} from "@nuanu-ai/agentify-contracts";
import { escaped, page } from "./html.js";
import { cardsScreen, ordersScreen, receiptsScreen, type Viewer } from "./screens.js";
import {
  linkRequestedScreen,
  mailUnavailableScreen,
  refusedLinkScreen,
  signInScreen,
} from "./sign-in.js";
import { wooDeclinedScreen, wooScreen } from "./woo-screens.js";

const SAMPLE_CARDS = MerchantCardListSchema.parse({
  selling: "open",
  cards: [
    {
      id: "itm_sample",
      as_of: "2026-09-24T09:00:00Z",
      card: {
        merchant_item_id: "access-monthly",
        title: "Monthly access",
        description: "Access to the service for thirty days.",
        price: { amount: "5.00", currency: "USD" },
        result: { access_url: { type: "string" } },
        fulfillment: "async",
        fulfill_deadline_seconds: 14_400,
      },
      selling: "open",
      paused: false,
    },
  ],
});

const PRICE = {
  amount: "5.00",
  currency: "USD",
  at: "2026-09-24T10:20:00Z",
  as_of: "2026-09-24T10:15:00Z",
};

const orders = (...rows: ReadonlyArray<readonly [string, string, boolean]>) =>
  OrderListSchema.parse({
    orders: rows.map(([id, status, test]) => ({
      id,
      merchant_item_id: "access-monthly",
      params: {},
      price: PRICE,
      test,
      status,
    })),
  });

const SHOP = "https://shop.example.com";

/** What the showcase needs from the server that only the server holds. */
export interface StateWords {
  readonly sessionEnded: string;
}

interface ShownState {
  readonly id: string;
  readonly title: string;
  /** When a merchant sees it, in their terms. */
  readonly when: string;
  /** What in the system causes it. */
  readonly cause: string;
  readonly draw: (viewer: Viewer, words: StateWords) => string;
}

const STATES: readonly ShownState[] = [
  {
    id: "orders-test",
    title: "Orders with test purchases",
    when: "An order was paid on the test network or on this stand, so no real money moved.",
    cause: "The order has test: true.",
    draw: (viewer) =>
      ordersScreen(
        viewer,
        SAMPLE_CARDS,
        orders(["ord_test", "delivered", true], ["ord_real", "delivered", false]),
        false,
      ),
  },
  {
    id: "orders-refund",
    title: "An order that owes a refund",
    when: "A buyer paid, the delivery window ran out, and nothing was delivered.",
    cause: "Order status refund_due: the card's delivery deadline passed without a delivery.",
    draw: (viewer) =>
      ordersScreen(viewer, SAMPLE_CARDS, orders(["ord_late", "refund_due", false]), false),
  },
  {
    id: "orders-unpaid",
    title: "Delivered, but not paid",
    when: "Your integration delivered the goods, but the payment did not go through.",
    cause: "Order status delivered_unpaid.",
    draw: (viewer) =>
      ordersScreen(viewer, SAMPLE_CARDS, orders(["ord_unpaid", "delivered_unpaid", false]), false),
  },
  {
    id: "orders-unresolved",
    title: "Payment result unknown",
    when: "It is not yet known whether the buyer was charged.",
    cause: "Order status payment_unresolved.",
    draw: (viewer) =>
      ordersScreen(
        viewer,
        SAMPLE_CARDS,
        orders(["ord_unknown", "payment_unresolved", false]),
        false,
      ),
  },
  {
    id: "receipts-test",
    title: "Receipts for test purchases",
    when: "The goods for a test purchase were delivered.",
    cause: "The receipt has test: true.",
    draw: (viewer) =>
      receiptsScreen(
        viewer,
        SAMPLE_CARDS,
        ReceiptListSchema.parse({
          receipts: [true, false].map((test, index) => ({
            id: `rcp_${index}`,
            order_id: `ord_${index}`,
            item_id: "itm_sample",
            price: PRICE,
            paid_at: "2026-09-24T10:20:03Z",
            outcome: "delivered",
            test,
          })),
        }),
      ),
  },
  {
    id: "no-seller-name",
    title: "No seller name yet",
    when: "A new account hasn't chosen the name buyers see yet.",
    cause: "The merchant's seller name is empty.",
    draw: (viewer) => cardsScreen({ ...viewer, sellerName: null }, SAMPLE_CARDS, "", true),
  },
  {
    id: "link-sent",
    title: "Sign-in link sent",
    when: "Someone asked for a sign-in link.",
    cause: "The mail provider accepted the email.",
    draw: (viewer) =>
      linkRequestedScreen(viewer.base, viewer.mode, "person@example.com", "default", {
        sent: true,
        seconds: 60,
      }),
  },
  {
    id: "link-interval",
    title: "A link was sent a moment ago",
    when: "Someone asked for another link less than a minute after the last one.",
    cause: "The limit of one link per minute for this address.",
    draw: (viewer) =>
      linkRequestedScreen(viewer.base, viewer.mode, "person@example.com", "default", {
        wall: "interval",
        seconds: 42,
      }),
  },
  {
    id: "link-hourly",
    title: "Too many links this hour",
    when: "Someone asked for a fourth link within an hour.",
    cause: "The limit of three links per hour for this address.",
    draw: (viewer) =>
      linkRequestedScreen(viewer.base, viewer.mode, "person@example.com", "default", {
        wall: "hourly",
        seconds: 1_800,
      }),
  },
  {
    id: "link-refused",
    title: "The link no longer works",
    when: "Someone opened a link that was already used, is more than an hour old, or was replaced by a newer one.",
    cause: "The sign-in link was used, expired, or replaced.",
    draw: (viewer) => refusedLinkScreen(viewer.base, viewer.mode),
  },
  {
    id: "mail-down",
    title: "The sign-in email could not be sent",
    when: "Someone asked for a link and the email did not go out.",
    cause: "The mail provider refused the email or did not respond.",
    draw: (viewer) => mailUnavailableScreen(viewer.base, viewer.mode),
  },
  {
    id: "session-ended",
    title: "The session ended",
    when: "Someone clicked something after their session expired or was ended elsewhere.",
    cause: "The request reached the dashboard without a session.",
    draw: (viewer, words) =>
      signInScreen(viewer.base, viewer.mode, "default", undefined, "", words.sessionEnded),
  },
  {
    id: "shop-waiting",
    title: "Waiting for the shop's keys",
    when: "Someone started connecting a WooCommerce shop and its keys haven't arrived yet.",
    cause: "Connection started, no keys yet, and less than 15 minutes have passed.",
    draw: (viewer) =>
      wooScreen(viewer, { state: { kind: "waiting", shopUrl: SHOP, startedMinutesAgo: 3 } }),
  },
  {
    id: "shop-unanswered",
    title: "The shop's keys did not arrive",
    when: "Someone started connecting a shop and no keys arrived within 15 minutes.",
    cause: "Connection started, no keys yet, and 15 minutes have passed.",
    draw: (viewer) => wooScreen(viewer, { state: { kind: "unanswered", shopUrl: SHOP } }),
  },
  {
    id: "shop-declined",
    title: "Connecting the shop was declined",
    when: "Will show once the server gets a reliable signal that the seller declined in their shop. Until then it stays hidden: by Dmitry's decision, we don't trust success=0 in the shop's return link.",
    cause: "The seller declined on the shop's approval screen.",
    draw: (viewer) => wooDeclinedScreen(viewer, SHOP),
  },
  {
    id: "shop-connected",
    title: "The shop is connected",
    when: "Someone approved access in their shop and came back.",
    cause: "The keys arrived in a request from the shop's own server.",
    draw: (viewer) =>
      wooScreen(viewer, {
        state: {
          kind: "connected",
          shop: {
            shopUrl: SHOP,
            connectedAt: new Date("2026-09-24T10:00:00Z"),
            permissions: "read_write",
          },
        },
        cameBack: true,
      }),
  },
];

export const stateScreen = (viewer: Viewer, id: string, words: StateWords): string | null => {
  const found = STATES.find((state) => state.id === id);
  return found === undefined ? null : found.draw(viewer, words);
};

export const statesScreen = (viewer: Viewer): string =>
  page({
    mode: viewer.mode,
    base: viewer.base,
    who: viewer.who,
    confirmed: viewer.confirmed,
    tab: null,
    title: "Rare states",
    body: `
  <div class="lede">
    <div>
      <h1>Rare states</h1>
      <p>Screens that are hard to reach on this stand. They are drawn from sample data by the same code as the live dashboard. This page exists only on the stand.</p>
    </div>
  </div>
  <div class="state-list">
${STATES.map(
  (state) => `    <section class="state-item">
      <h2>${escaped(state.title)}</h2>
      <p><b>When it shows.</b> ${escaped(state.when)}</p>
      <p class="quiet"><b>What causes it.</b> ${escaped(state.cause)}</p>
      <div class="connect-actions"><a class="button button-secondary" href="${escaped(viewer.base)}/states/${state.id}">Show</a></div>
    </section>`,
).join("\n")}
  </div>
`,
  });
