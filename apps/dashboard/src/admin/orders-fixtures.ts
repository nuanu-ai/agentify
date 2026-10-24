/**
 * Reads the operator's orders reader could answer, for the orders area's tests
 * and gallery states: example data in the reader's own shapes, never a real
 * merchant's.
 */

import type {
  OperatorOrder,
  OperatorOrderRow,
  OrdersPage,
  OrdersShown,
} from "@agentify/gateway/operator";

/** 23 October 2026, 14:05 UTC: the moment the examples are read at. */
export const READ_AT = new Date("2026-10-23T14:05:00.000Z");

const T = Date.parse("2026-10-21T14:49:00.000Z");

export const EXAMPLE_MERCHANT = {
  id: "mch_4f1a9c2e7b",
  name: "A merchant",
  serviceName: "An eSIM shop",
};

export const aRow = (id: string, change: Partial<OperatorOrderRow> = {}): OperatorOrderRow => ({
  id,
  createdAt: T,
  pricedAt: T,
  merchant: EXAMPLE_MERCHANT,
  product: { itemId: "itm_7d3e", merchantItemId: "esim-7d", title: "A seven day eSIM" },
  price: { amount: "12.00", currency: "USD" },
  status: "delivered",
  payment: "paid",
  segment: "ended",
  test: false,
  ...change,
});

export const counts = (
  given: Partial<Record<OrdersShown, number>> = {},
): Record<OrdersShown, number> => {
  const segments = {
    payment_unknown: 0,
    unfulfilled: 0,
    delivered_unpaid: 0,
    in_progress: 0,
    ended: 0,
    lapsed: 0,
    ...given,
  };
  const all =
    given.all ??
    segments.payment_unknown +
      segments.unfulfilled +
      segments.delivered_unpaid +
      segments.in_progress +
      segments.ended +
      segments.lapsed;
  return { ...segments, all };
};

export const aPage = (change: Partial<OrdersPage> = {}): OrdersPage => ({
  counts: counts(),
  rows: [],
  newer: 0,
  earlier: null,
  merchants: [EXAMPLE_MERCHANT],
  ...change,
});

const SPLIT = "0x2b7c41d09e8a5f3c6b1d2e4f5a6b7c8d9e0f5e10";
const TX = `0x6f1d${"3a".repeat(29)}9a2e`;

/** A paid order the merchant closed with a message after its delivery window ran out. */
export const closedOrder = (): OperatorOrder => ({
  ...aRow("ord_3e9174b2c80d4f6a91e2d5730a8fc07b", {
    status: "fulfillment_closed",
    segment: "ended",
  }),
  state: "fulfillment_closed",
  fulfillment: "async",
  fulfillmentMs: 3_600_000,
  quoteSource: "card_snapshot",
  agent: {
    status: "fulfillment_closed",
    payment_status: "paid",
    seller: { name: "An eSIM shop", site: "https://esim-shop.example" },
    transaction: TX,
    reason: {
      code: "merchant_closed",
      message:
        "This order is paid, and the seller closed fulfillment through Agentify with no delivery recorded. The words under merchant_closure are the seller's own; Agentify has not verified any refund or agreement. Contact the seller.",
    },
    merchant_closure: {
      closed_at: "2026-10-22T09:12:40.000Z",
      message: "Our supplier could not issue a profile for this region.",
    },
  },
  merchantReads: {
    status: "fulfillment_closed",
    payment_status: "paid",
    merchant_closure: {
      closed_at: "2026-10-22T09:12:40.000Z",
      message: "Our supplier could not issue a profile for this region.",
    },
    onOpenList: false,
    lapsed: false,
  },
  timeline: [
    { kind: "created", at: T },
    { kind: "priced", at: T, price: { amount: "12.00", currency: "USD" } },
    { kind: "payment_word", at: T + 2_000, about: "verify", said: "valid" },
    { kind: "charge_sent", at: T + 2_000 },
    { kind: "paid", at: T + 4_000 },
    { kind: "payment_word", at: T + 4_000, about: "settle", said: "success" },
    { kind: "payment_completed", at: null, settled: true, source: "facilitator" },
    { kind: "handed_over", at: T + 1_806_000, times: 2, takenOn: false },
    {
      kind: "ended",
      at: null,
      closure: { cause: "deadline_expired", deadline: "async_fulfillment" },
    },
    { kind: "closed_by_merchant", at: Date.parse("2026-10-22T09:12:40.000Z"), withMessage: true },
  ],
  paid: {
    stage: "settled",
    status: "paid",
    paidInto: SPLIT,
    transaction: TX,
    attempt: {
      startedAt: T + 2_000,
      completion: { settled: true, executedAt: null, source: "facilitator" },
      searchHint: null,
      nextBlock: null,
    },
    words: [
      { at: T + 2_000, about: "verify", said: "valid" },
      { at: T + 4_000, about: "settle", said: "success" },
    ],
    wordsDropped: 0,
    unknownSince: null,
  },
  receipt: null,
  withheld: { buyerEntered: false, address: null, goods: false },
});

/** A charge whose answer was lost, two hours before the page was read. */
export const unknownOrder = (): OperatorOrder => {
  const sent = READ_AT.getTime() - 2 * 3_600_000;
  return {
    ...aRow("ord_8c2e3b7a91d04f6e8a5c2d1b0e9f41a9", {
      createdAt: sent - 2_000,
      pricedAt: sent - 2_000,
      price: { amount: "8.00", currency: "USD" },
      status: "payment_unresolved",
      payment: "unresolved",
      segment: "payment_unknown",
    }),
    product: {
      itemId: "itm_9a1b",
      merchantItemId: "esim-eu-5gb",
      title: "eSIM Europe, 5 GB for 30 days",
    },
    state: "dispatched",
    fulfillment: "async",
    fulfillmentMs: 3_600_000,
    quoteSource: "card_snapshot",
    agent: {
      status: "payment_unresolved",
      payment_status: "unresolved",
      seller: { name: "An eSIM shop", site: null },
    },
    merchantReads: {
      status: "payment_unresolved",
      payment_status: "unresolved",
      onOpenList: true,
      lapsed: false,
    },
    timeline: [
      { kind: "created", at: sent - 2_000 },
      { kind: "priced", at: sent - 2_000, price: { amount: "8.00", currency: "USD" } },
      {
        kind: "payment_word",
        at: sent - 1_000,
        about: "verify",
        said: "valid, signed by a wallet",
      },
      { kind: "charge_sent", at: sent },
    ],
    paid: {
      stage: "outcome_unknown",
      status: "unresolved",
      paidInto: SPLIT,
      transaction: null,
      attempt: {
        startedAt: sent,
        completion: null,
        searchHint: `0x91c4${"0b".repeat(29)}77d1`,
        nextBlock: "0x1c9a3f2",
      },
      words: [{ at: sent - 1_000, about: "verify", said: "valid, signed by a wallet" }],
      wordsDropped: 2,
      unknownSince: sent,
    },
    receipt: null,
    withheld: { buyerEntered: true, address: null, goods: false },
  };
};

/** A parcel shipped, its address erased once the merchant had it, and its receipt. */
export const parcelOrder = (): OperatorOrder => ({
  ...aRow("ord_b913c0d2e4f5a6b7c8d9e0f1a2b32d70", {
    product: { itemId: "itm_5c2d", merchantItemId: "router-mini", title: "A travel router" },
    price: { amount: "39.00", currency: "USD" },
    status: "shipped",
  }),
  state: "delivered",
  fulfillment: "ship",
  fulfillmentMs: 86_400_000,
  quoteSource: "merchant_answer",
  agent: {
    status: "shipped",
    payment_status: "paid",
    seller: { name: "An eSIM shop", site: "https://esim-shop.example" },
    transaction: TX,
    ship_by: "2026-10-23T14:49:00.000Z",
  },
  merchantReads: { status: "shipped", payment_status: "paid", onOpenList: false, lapsed: false },
  timeline: [
    { kind: "created", at: T },
    { kind: "priced", at: T + 1_000, price: { amount: "39.00", currency: "USD" } },
    { kind: "charge_sent", at: T + 3_000 },
    { kind: "paid", at: T + 5_000 },
    { kind: "handed_over", at: T + 6_000, times: 1, takenOn: true },
    { kind: "address_erased", at: T + 60_000 },
    { kind: "shipment_recorded", at: T + 7_200_000 },
  ],
  paid: {
    stage: "settled",
    status: "paid",
    paidInto: SPLIT,
    transaction: TX,
    attempt: {
      startedAt: T + 3_000,
      completion: { settled: true, executedAt: T + 5_000, source: "chain" },
      searchHint: TX,
      nextBlock: null,
    },
    words: [],
    wordsDropped: 0,
    unknownSince: null,
  },
  receipt: {
    id: "rcp_41d2",
    order_id: "ord_b913c0d2e4f5a6b7c8d9e0f1a2b32d70",
    item_id: "itm_5c2d",
    price: {
      amount: "39.00",
      currency: "USD",
      at: "2026-10-21T14:49:01.000Z",
      as_of: "2026-10-21T14:49:01.000Z",
    },
    paid_at: "2026-10-21T14:49:05.000Z",
    outcome: "shipped",
    transaction: TX,
    test: false,
  },
  withheld: { buyerEntered: false, address: { erasedAt: T + 60_000 }, goods: false },
});
