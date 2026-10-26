/**
 * What the operator's Orders, one order's page and the lookup say, from what
 * the reader answered: a read that failed is never drawn as none, the
 * merchant's side in the merchant's own words, the timeline's untimed steps
 * said as such, and the lookup's three answers.
 */

import { describe, expect, it } from "vitest";
import {
  aPage,
  aRow,
  closedOrder,
  counts,
  EXAMPLE_MERCHANT,
  parcelOrder,
  READ_AT,
  unknownOrder,
} from "./orders-fixtures.js";
import {
  findView,
  type OrderView,
  orderPageView,
  ordersAskedIn,
  ordersListView,
} from "./orders-view.js";

const asked = (search = "") => ordersAskedIn(new URLSearchParams(search));
const EXPLORER = {
  transactionPage: "https://basescan.org/tx/",
  addressPage: "https://basescan.org/address/",
};
const page = (order: ReturnType<typeof closedOrder>): OrderView => {
  const view = orderPageView(order.id, order, EXPLORER, READ_AT);
  if (view.kind !== "order") throw new Error("the order was not drawn");
  return view;
};

describe("the orders list", () => {
  it("says a read that failed could not be read, with no count and no empty list", () => {
    const view = ordersListView(asked(), null, READ_AT);

    expect(view.result).toStrictEqual({ kind: "unread" });
    expect(view.segments.map((segment) => segment.count)).toStrictEqual(Array(7).fill(null));
    expect(view.merchants).toBeNull();
  });

  it("tells a channel with no order from a search that matched none", () => {
    expect(ordersListView(asked(), aPage(), READ_AT).result).toMatchObject({
      kind: "none",
      said: "No order has been made on this channel yet.",
      clear: null,
    });
    expect(ordersListView(asked("q=esim"), aPage(), READ_AT).result).toMatchObject({
      kind: "none",
      said: "No order matches “esim”.",
      clear: "/admin/orders",
    });
    expect(
      ordersListView(asked("segment=lapsed"), aPage({ counts: counts({ ended: 3 }) }), READ_AT)
        .result,
    ).toMatchObject({
      kind: "none",
      said: "No lapsed attempt is kept: the gateway forgets them after thirty days.",
    });
  });

  it("lists the segments in the note's order with their counts, the one shown marked, each keeping the search", () => {
    const view = ordersListView(
      asked("segment=unfulfilled&q=esim&merchant=mch_a"),
      aPage({ counts: counts({ payment_unknown: 2, unfulfilled: 1, ended: 50, lapsed: 6 }) }),
      READ_AT,
    );

    expect(view.segments.map((one) => [one.label, one.count, one.here])).toStrictEqual([
      ["Payment unknown", 2, false],
      ["Unfulfilled", 1, true],
      ["Held for payment", 0, false],
      ["In progress", 0, false],
      ["Ended", 50, false],
      ["Lapsed", 6, false],
      ["All", 59, false],
    ]);
    expect(view.segments[0]?.to).toBe(
      "/admin/orders?segment=payment-unknown&q=esim&merchant=mch_a",
    );
    expect(view.segments[6]?.to).toBe("/admin/orders?q=esim&merchant=mch_a");
  });

  it("says which rows of how many it shows, and leads to the earlier ones and back to the newest", () => {
    const first = ordersListView(
      asked(),
      aPage({
        counts: counts({ ended: 61 }),
        rows: [aRow("ord_a"), aRow("ord_b")],
        earlier: { createdAt: 1_787_000_000_000, id: "ord_b" },
      }),
      READ_AT,
    );
    expect(first.result).toMatchObject({
      kind: "rows",
      cut: "Showing 1–2 of 61, newest first",
      earlier: "/admin/orders?before=1787000000000.ord_b",
      newest: null,
    });

    const later = ordersListView(
      asked("before=1787000000000.ord_b"),
      aPage({ counts: counts({ ended: 61 }), rows: [aRow("ord_c")], newer: 50 }),
      READ_AT,
    );
    expect(later.result).toMatchObject({
      cut: "Showing 51–51 of 61, newest first",
      earlier: null,
      newest: "/admin/orders",
    });
  });

  it("words a row's state and payment as the merchant's dashboard does, and a lost answer as unknown", () => {
    const view = ordersListView(
      asked(),
      aPage({
        counts: counts({ payment_unknown: 1, lapsed: 1 }),
        rows: [
          aRow("ord_u", { status: "payment_unresolved", payment: "unresolved" }),
          aRow("ord_l", { status: "rejected", payment: "not_paid", price: null, pricedAt: null }),
        ],
      }),
      READ_AT,
    );

    expect(view.result.kind === "rows" ? view.result.rows : []).toMatchObject([
      {
        state: { text: "Payment outcome unknown", tone: "warn" },
        payment: { text: "Outcome unknown", tone: "unknown" },
        merchant: "An eSIM shop",
      },
      {
        state: { text: "Refused", tone: "quiet" },
        payment: { text: "Not paid", tone: "quiet" },
        amount: null,
        priced: null,
      },
    ]);
  });

  it("reads an unknown segment, a malformed cursor and an overlong search as the plain list", () => {
    expect(asked(`segment=nonsense&before=yesterday&q=${"x".repeat(500)}`)).toStrictEqual({
      shown: "all",
      q: "x".repeat(200),
      merchantId: null,
      before: null,
    });
  });

  it("reads a cursor past the last moment a date holds, and control characters, as nothing asked", () => {
    expect(asked("before=9999999999999999.ord_x").before).toBeNull();
    expect(asked("before=8640000000000000.ord_x").before).toStrictEqual({
      createdAt: 8.64e15,
      id: "ord_x",
    });
    expect(asked("q=%00esim%1f&merchant=%20mch_a%00")).toMatchObject({
      q: "esim",
      merchantId: "mch_a",
    });
  });

  it("says a segment holds none of what was searched, not that the channel has none", () => {
    expect(
      ordersListView(
        asked("segment=unfulfilled&q=esim"),
        aPage({ counts: counts({ ended: 3 }) }),
        READ_AT,
      ).result,
    ).toMatchObject({ kind: "none", said: "No order among the unfulfilled matches “esim”." });
    expect(
      ordersListView(asked("segment=unfulfilled"), aPage({ counts: counts({ ended: 3 }) }), READ_AT)
        .result,
    ).toMatchObject({ kind: "none", said: "No order is unfulfilled." });
  });
});

describe("one order", () => {
  it("is none where the channel holds no such order, and could not be read where the read failed", () => {
    expect(orderPageView("ord_x", null, EXPLORER, READ_AT)).toStrictEqual({
      kind: "none",
      id: "ord_x",
    });
    expect(orderPageView("ord_x", "unread", EXPLORER, READ_AT)).toStrictEqual({
      kind: "unread",
      id: "ord_x",
    });
  });

  it("shows the agent's wire words and the merchant's own words side by side", () => {
    const view = page(closedOrder());

    expect(view.agent).toStrictEqual({
      status: "fulfillment_closed",
      paymentStatus: "paid",
      reason: closedOrder().agent.reason?.message,
      sellerWords: "Our supplier could not issue a profile for this region.",
    });
    expect(view.merchantSide).toStrictEqual({
      heading: "What An eSIM shop reads in its Orders",
      state: { text: "Closed by you", tone: "quiet" },
      payment: "Paid",
      lines: [
        "They closed fulfillment on 2026-10-22 09:12:40 UTC, with their message to the buyer.",
        "It is not on the open list their worker reads.",
      ],
    });
    expect(view.card).toBe("Card esim-7d · Later, within 1 hour");
  });

  it("says the merchant reads a payment after their closure where it is back on their open list", () => {
    const order = closedOrder();
    const reopened = { ...order, merchantReads: { ...order.merchantReads, onOpenList: true } };

    expect(page(reopened).merchantSide.state).toStrictEqual({
      text: "Paid after closure",
      tone: "warn",
    });
  });

  it("says “time not recorded” for a step the record keeps no moment of, and names an actor only where the record does", () => {
    const steps = page(closedOrder()).timeline;

    expect(steps.filter((step) => step.at === null).map((step) => step.what)).toStrictEqual([
      "Charge settled",
      "Time ran out",
    ]);
    expect(steps.find((step) => step.what === "Time ran out")?.said).toBe(
      "The delivery window ran out.",
    );
    // Every caption is checked: the words recorded about a payment are not all the facilitator's.
    expect(
      steps.map((step) => step.who).filter((who) => /facilitator| by /.test(who)),
    ).toStrictEqual(["Payment · by the facilitator's answer", "Closure · by the merchant"]);
  });

  it("links the split and the transaction to the channel's explorer, and none where it has no explorer", () => {
    const linked = page(closedOrder()).payment;
    expect(linked.transaction?.page).toMatch(/^https:\/\/basescan\.org\/tx\/0x6f1d/);
    expect(linked.paidInto?.page).toMatch(/^https:\/\/basescan\.org\/address\/0x2b7c/);

    const view = orderPageView(
      "o",
      closedOrder(),
      { transactionPage: null, addressPage: null },
      READ_AT,
    );
    expect(view.kind === "order" && view.payment.transaction?.page).toBeNull();
  });

  it("says since when and for how long a payment's outcome is unknown, and what recovery holds", () => {
    const { payment } = page(unknownOrder());

    expect(payment.head).toStrictEqual({ text: "Outcome unknown", tone: "unknown" });
    expect(payment.unknown).toBe("Unknown since 2026-10-23 12:05:00 UTC, for 2 hours.");
    expect(payment.recovery?.nextBlock).toBe("0x1c9a3f2");
    expect(payment.recovery?.hint?.whole).toMatch(/^0x91c4/);
    expect(payment.dropped).toBe("2 more fell off the end of the list.");
    expect(payment.transaction).toBeNull();
  });

  it("says what it does not show, and when a parcel's address was erased", () => {
    expect(page(parcelOrder()).withheld).toContain(
      "The buyer's delivery address was erased 2026-10-21 14:50:00 UTC.",
    );
    expect(page(unknownOrder()).withheld).toContain(
      "The values the buyer entered at purchase are held and not shown.",
    );
    expect(page(parcelOrder()).receipt.facts.map((fact) => fact.label)).toStrictEqual([
      "Receipt",
      "Outcome",
      "Paid at",
      "Transaction",
    ]);
  });

  it("says when its receipt was paid as a moment, not as an identifier shown short", () => {
    const paidAt = page(parcelOrder()).receipt.facts.find((fact) => fact.label === "Paid at");

    expect(paidAt).toStrictEqual({
      label: "Paid at",
      at: { date: "2026-10-21", time: expect.stringMatching(/^\d{2}:\d{2}:\d{2} UTC$/) },
    });
  });

  it("tells an order that will never have a receipt from one that has none yet", () => {
    // A closed order's goods are never released, so it never gets a receipt;
    // "not yet" on it would send an operator waiting for one.
    expect(page(closedOrder()).receipt).toMatchObject({ head: "None", facts: [] });
    expect(page(closedOrder()).receipt.said).toMatch(/no receipt will be written/);
    expect(page(unknownOrder()).receipt).toMatchObject({ head: "Not yet", facts: [] });
    expect(page(unknownOrder()).receipt.said).not.toMatch(/will be written/);
  });
});

describe("the lookup", () => {
  const merchant = { kind: "merchant", by: "site", merchant: EXAMPLE_MERCHANT } as const;
  const order = { kind: "order", by: "id", order: aRow("ord_a") } as const;

  it("opens the one record a text names", () => {
    expect(findView("ord_a", [order], false)).toStrictEqual({
      kind: "open",
      to: "/admin/orders/ord_a",
    });
    expect(
      findView("x@example.com", [{ kind: "account", id: "acc_1", email: "x@example.com" }], false),
    ).toStrictEqual({ kind: "open", to: "/admin/accounts/acc_1" });
  });

  it("lists several, each with what in it matched", () => {
    expect(findView("esim-shop.example", [merchant, merchant], false)).toMatchObject({
      kind: "several",
      found: [
        {
          kind: "Merchant",
          label: "An eSIM shop",
          by: "the site it sells from, esim-shop.example",
        },
        { kind: "Merchant" },
      ],
    });
  });

  it("says none in words that claim no more than it knows, keeping the text", () => {
    expect(findView("ord_zz", [], false)).toMatchObject({
      kind: "none",
      q: "ord_zz",
      said: expect.stringContaining("Nothing on this channel matches “ord_zz”."),
      unknown: null,
      merchants: null,
    });
    expect(findView("0xabc", [], true)).toMatchObject({
      said: "No order on this channel names the transaction “0xabc” yet.",
      unknown: expect.stringContaining("may have no transaction yet"),
    });
  });

  it("never says nothing matches text it did not look up, and offers the merchants' search for it", () => {
    // A shop's name read out on a call is no identifier; "nothing matches"
    // would claim a search that never ran.
    const view = findView("City Walking Tours", [], false, "not-read");

    expect(view).toMatchObject({
      kind: "none",
      merchants: "/admin/merchants?q=City+Walking+Tours",
    });
    const lookedUp = findView("City Walking Tours", [], false);
    expect(view.kind === "none" && view.said).not.toBe(lookedUp.kind === "none" && lookedUp.said);
  });

  it("names the site a merchant was found by, so two found by one site are told apart by it", () => {
    expect(findView("esim-shop.example", [merchant, merchant], false)).toMatchObject({
      found: [{ by: "the site it sells from, esim-shop.example" }, {}],
    });
  });

  it("tells a lookup that failed from one that found nothing, and asks nothing of an empty box", () => {
    expect(findView("ord_a", "unread", false)).toStrictEqual({ kind: "unread", q: "ord_a" });
    expect(findView("", [], false)).toStrictEqual({ kind: "asked", q: "" });
  });
});
