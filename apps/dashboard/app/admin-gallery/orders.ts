/**
 * The orders area's gallery states: Orders, one order's page and the lookup,
 * each drawn from views the real view functions built out of example reads.
 */

import {
  aPage,
  aRow,
  closedOrder,
  counts,
  EXAMPLE_MERCHANT,
  parcelOrder,
  READ_AT,
  unknownOrder,
} from "../../src/admin/orders-fixtures.js";
import {
  findView,
  orderPageView,
  ordersAskedIn,
  ordersListView,
} from "../../src/admin/orders-view.js";
import { type AdminGalleryState, frameIn } from "./state.js";

const LIVE_EXPLORER = {
  transactionPage: "https://basescan.org/tx/",
  addressPage: "https://basescan.org/address/",
};

const list = (search: string, read: Parameters<typeof ordersListView>[1]) =>
  ordersListView(ordersAskedIn(new URLSearchParams(search)), read, READ_AT);

const AT = Date.parse("2026-10-23T13:52:00.000Z");
const minutes = (count: number) => AT - count * 60_000;

/**
 * Merchants and products named at the length a WooCommerce shop names them,
 * so the list is drawn with what a busy channel's rows carry.
 */
const TRAVEL_SHOP = {
  id: "mch_9e2b7c41d0",
  name: "A merchant",
  serviceName: "A travel eSIM, virtual number and VPN shop for people abroad",
};

const LONG_ESIM = {
  itemId: "itm_3",
  merchantItemId: "esim-eu-20gb-30d",
  title: "eSIM Europe – 39 Countries, 20 GB / 30 Days, 5G, Hotspot Allowed",
};

const LONG_NUMBER = {
  itemId: "itm_4",
  merchantItemId: "number-sms-30d",
  title: "Virtual Phone Number for SMS Verification – Any Country, 30-Day Rental",
};

/** A page of the live channel's orders, as busy as the pilot's, newest first as the reader lists them. */
const busy = aPage({
  counts: counts({
    payment_unknown: 2,
    unfulfilled: 1,
    delivered_unpaid: 1,
    in_progress: 1,
    ended: 50,
    lapsed: 6,
  }),
  rows: [
    aRow("ord_6d58e1f0a2b34c5d6e7f8091a2b3a3e7", {
      createdAt: minutes(-12),
      pricedAt: minutes(-12),
      merchant: TRAVEL_SHOP,
      product: LONG_NUMBER,
      price: { amount: "2.00", currency: "USD" },
      status: "in_progress",
      payment: "not_paid",
      segment: "in_progress",
    }),
    aRow("ord_8c2e3b7a91d04f6e8a5c2d1b0e9f41a9", {
      createdAt: minutes(0),
      pricedAt: minutes(0),
      product: {
        itemId: "itm_2",
        merchantItemId: "esim-eu-5gb",
        title: "eSIM Europe, 5 GB for 30 days",
      },
      price: { amount: "8.00", currency: "USD" },
      status: "payment_unresolved",
      payment: "unresolved",
      segment: "payment_unknown",
    }),
    aRow("ord_0aa4b5c6d7e8f9a0b1c2d3e4f5a69c15", {
      createdAt: minutes(340),
      pricedAt: null,
      price: null,
      status: "rejected",
      payment: "not_paid",
      segment: "lapsed",
    }),
    aRow("ord_17ff0c2d3e4f5a6b7c8d9e0f1a2b7de3", {
      createdAt: minutes(1_272),
      pricedAt: minutes(1_272),
      merchant: TRAVEL_SHOP,
      product: LONG_ESIM,
      price: { amount: "24.00", currency: "USD" },
      status: "unfulfilled",
      segment: "unfulfilled",
    }),
    aRow("ord_4727a0b1c2d3e4f5a6b7c8d9e0f1a18b", {
      createdAt: minutes(1_309),
      pricedAt: minutes(1_309),
      status: "delivered_unpaid",
      payment: "not_paid",
      segment: "delivered_unpaid",
    }),
  ],
  earlier: { createdAt: minutes(1_309), id: "ord_4727a0b1c2d3e4f5a6b7c8d9e0f1a18b" },
  merchants: [
    EXAMPLE_MERCHANT,
    TRAVEL_SHOP,
    { id: "mch_2b9d", name: "A merchant", serviceName: null },
  ],
});

const loadedList = (view: ReturnType<typeof list>) => ({ "routes/admin/orders": view });
const loadedOrder = (view: ReturnType<typeof orderPageView>) => ({ "routes/admin/order": view });
const loadedFind = (view: ReturnType<typeof findView>) => ({ "routes/admin/find": view });

const several = findView(
  "esim-shop.example",
  [
    { kind: "merchant", by: "site", merchant: EXAMPLE_MERCHANT },
    {
      kind: "merchant",
      by: "site",
      merchant: { id: "mch_c41e", name: "A merchant", serviceName: "eSIMs for travel" },
    },
  ],
  false,
);

export const ORDERS_STATES: readonly AdminGalleryState[] = [
  {
    id: "dashboard-admin-orders",
    screen: "Orders",
    when: "An operator opens Orders on a channel with orders in every segment.",
    cause:
      "The reader counts every segment and lists the newest fifty, cut with the way to the earlier ones.",
    path: "/admin/orders",
    mode: "live",
    loaded: loadedList(list("", busy)),
  },
  {
    id: "dashboard-admin-orders-payment-unknown",
    screen: "Orders",
    when: "An operator opens the orders whose payment outcome is unknown.",
    cause: "The segment reads the payments still settling and those whose answer was lost.",
    path: "/admin/orders?segment=payment-unknown",
    mode: "live",
    loaded: loadedList(
      list(
        "segment=payment-unknown",
        aPage({
          ...busy,
          rows: [
            ...busy.rows.filter((row) => row.segment === "payment_unknown"),
            // The older of the two, whose outcome has been unknown for 3 h 12 min.
            aRow("ord_3f9a51c7e0d24b8a96f1c3e5a7b9d2c4", {
              createdAt: minutes(179),
              pricedAt: minutes(179),
              product: { itemId: "itm_1", merchantItemId: "number-30d", title: "A virtual number" },
              price: { amount: "2.00", currency: "USD" },
              status: "payment_unresolved",
              payment: "unresolved",
              segment: "payment_unknown",
            }),
          ],
          earlier: null,
        }),
      ),
    ),
  },
  {
    id: "dashboard-admin-orders-earlier",
    screen: "Orders",
    when: "An operator follows the cut to the earlier orders.",
    cause:
      "The list's address carries where the last page ended, and the cut says which rows of how many it shows.",
    path: "/admin/orders?before=1787745600000.ord_4727a0b1c2d3e4f5a6b7c8d9e0f1a18b",
    mode: "live",
    loaded: loadedList(
      list(
        "before=1787745600000.ord_4727a0b1c2d3e4f5a6b7c8d9e0f1a18b",
        aPage({
          ...busy,
          rows: [aRow("ord_2805a1b2c3d4e5f6a7b8c9d0e1f2be4c")],
          newer: 50,
          earlier: null,
        }),
      ),
    ),
  },
  {
    id: "dashboard-admin-orders-no-match",
    screen: "Orders",
    when: "An operator searches for something no order holds.",
    cause:
      "The search and the counts are read together, so every segment counts zero from a read that succeeded.",
    path: "/admin/orders?q=0x12ab",
    mode: "live",
    loaded: loadedList(list("q=0x12ab", aPage())),
  },
  {
    id: "dashboard-admin-orders-empty",
    screen: "Orders",
    when: "An operator opens Orders on a channel where nobody has bought anything yet.",
    cause: "The reader found no order at all.",
    path: "/admin/orders",
    mode: "test",
    loaded: loadedList(list("", aPage({ merchants: [] }))),
  },
  {
    id: "dashboard-admin-orders-unread",
    screen: "Orders",
    when: "An operator opens Orders while the database does not answer.",
    cause: "The read failed, so neither a count nor an empty list is drawn.",
    path: "/admin/orders",
    mode: "live",
    frame: frameIn("live", {}),
    loaded: loadedList(list("", null)),
  },
  {
    id: "dashboard-admin-order",
    screen: "Order",
    when: "An operator opens a paid order its merchant closed after the delivery window ran out.",
    cause: "The record keeps the moments of its steps; the ending's moment is not among them.",
    path: "/admin/orders/ord_3e9174b2c80d4f6a91e2d5730a8fc07b",
    mode: "live",
    loaded: loadedOrder(orderPageView(closedOrder().id, closedOrder(), LIVE_EXPLORER, READ_AT)),
  },
  {
    id: "dashboard-admin-order-payment-unknown",
    screen: "Order",
    when: "An operator opens an order whose charge went unanswered.",
    cause:
      "The facilitator never said whether the money moved, and recovery is still reading the chain.",
    path: "/admin/orders/ord_8c2e3b7a91d04f6e8a5c2d1b0e9f41a9",
    mode: "live",
    loaded: loadedOrder(orderPageView(unknownOrder().id, unknownOrder(), LIVE_EXPLORER, READ_AT)),
  },
  {
    id: "dashboard-admin-order-parcel",
    screen: "Order",
    when: "An operator opens a parcel that was shipped, with its receipt.",
    cause: "The address was erased once the merchant had it, and the record keeps when.",
    path: "/admin/orders/ord_b913c0d2e4f5a6b7c8d9e0f1a2b32d70",
    mode: "live",
    loaded: loadedOrder(orderPageView(parcelOrder().id, parcelOrder(), LIVE_EXPLORER, READ_AT)),
  },
  {
    id: "dashboard-admin-order-none",
    screen: "Order",
    when: "An operator opens an order identifier the channel does not hold.",
    cause: "The reader found no such order; it may be on the other channel.",
    path: "/admin/orders/ord_ffff0000aaaa1111bbbb2222cccc3333",
    mode: "live",
    loaded: loadedOrder(
      orderPageView("ord_ffff0000aaaa1111bbbb2222cccc3333", null, LIVE_EXPLORER, READ_AT),
    ),
  },
  {
    id: "dashboard-admin-order-unread",
    screen: "Order",
    when: "An operator opens an order while the database does not answer.",
    cause: "The read failed, so the page says so rather than that there is no such order.",
    path: "/admin/orders/ord_8c2e3b7a91d04f6e8a5c2d1b0e9f41a9",
    mode: "live",
    frame: frameIn("live", {}),
    loaded: loadedOrder(
      orderPageView("ord_8c2e3b7a91d04f6e8a5c2d1b0e9f41a9", "unread", LIVE_EXPLORER, READ_AT),
    ),
  },
  {
    id: "dashboard-admin-find",
    screen: "Find a record",
    when: "An operator opens the lookup with nothing pasted.",
    cause: "The box reads what is pasted by its shape, so it says what it can find.",
    path: "/admin/find",
    mode: "live",
    loaded: loadedFind(findView("", [], false)),
  },
  {
    id: "dashboard-admin-find-several",
    screen: "Find a record",
    when: "An operator pastes a site two merchants sell from.",
    cause: "The text names more than one record, so they are listed with what matched.",
    path: "/admin/find?q=esim-shop.example",
    mode: "live",
    loaded: loadedFind(several),
  },
  {
    id: "dashboard-admin-find-none",
    screen: "Find a record",
    when: "An operator pastes an identifier the channel does not hold.",
    cause: "Nothing matched, so the lookup says so and keeps the text.",
    path: "/admin/find?q=ord_ffff0000aaaa1111bbbb2222cccc3333",
    mode: "live",
    loaded: loadedFind(findView("ord_ffff0000aaaa1111bbbb2222cccc3333", [], false)),
  },
  {
    id: "dashboard-admin-find-transaction-none",
    screen: "Find a record",
    when: "An operator pastes a transaction no order names yet.",
    cause:
      "An order whose payment is unknown may hold no transaction, so none is not proof of no payment.",
    path: `/admin/find?q=0x${"5e".repeat(32)}`,
    mode: "live",
    loaded: loadedFind(findView(`0x${"5e".repeat(32)}`, [], true)),
  },
  {
    id: "dashboard-admin-find-unread",
    screen: "Find a record",
    when: "An operator pastes something while the database does not answer.",
    cause: "The lookup could not search, which it says apart from finding nothing.",
    path: "/admin/find?q=ord_8c2e",
    mode: "live",
    frame: frameIn("live", {}),
    loaded: loadedFind(findView("ord_8c2e", "unread", false)),
  },
];
