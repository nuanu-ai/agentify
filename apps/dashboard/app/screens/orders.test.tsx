/**
 * The orders a merchant can find on their Orders page: by the identifier they
 * were handed or pasted from the page, by the product, within the gateway's
 * own open list, newest first and a page at a time. The views are pure
 * functions of the gateway's documents, built here by the contract's own
 * schemas, and each page is drawn as the server sends it.
 */

import { MerchantCardListSchema, OrderListSchema } from "@nuanu-ai/agentify-contracts";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";
import { readable } from "../../src/testing/html.js";
import { ordersView } from "../../src/views.js";
import { shortened } from "../components/copy.js";
import { OrdersScreen } from "./orders.js";

const served = (screen: () => ReactElement): string => {
  const Stub = createRoutesStub([
    { id: "routes/gate", path: "/", children: [{ path: "orders", Component: screen }] },
  ]);
  return renderToString(
    <Stub
      initialEntries={["/orders"]}
      hydrationData={{ loaderData: { "routes/gate": { who: "owner@example.com" } } }}
    />,
  );
};

const CARDS = MerchantCardListSchema.parse({
  selling: "open",
  cards: [
    {
      id: "itm_1",
      as_of: "2026-10-01T09:00:00Z",
      card: {
        merchant_item_id: "number-sms",
        title: "A virtual number",
        description: "Rent a virtual phone number for inbound SMS",
        price: { amount: "2.00", currency: "USD" },
        result: { number: { type: "string" } },
        fulfillment: "sync",
      },
      selling: "open",
      paused: false,
    },
    {
      id: "itm_2",
      as_of: "2026-10-01T09:00:00Z",
      card: {
        merchant_item_id: "vpn-1m",
        title: "VPN, one month",
        description: "Thirty days from the moment it is delivered",
        price: { amount: "5.00", currency: "USD" },
        result: { access_url: { type: "string" } },
        fulfillment: "sync",
      },
      selling: "open",
      paused: false,
    },
  ],
});

/** An order identifier of the gateway's own shape: its kind, then 32 hexadecimal characters. */
const idOf = (head: string, tail: string, middle = "0") => `ord_${head}${middle.repeat(24)}${tail}`;

const FIRST = idOf("17ff", "7de3");
/** Shares the first half of its short form with FIRST. */
const SAME_HEAD = idOf("17ff", "11aa", "9");
/** Shares the second half of its short form with FIRST. */
const SAME_TAIL = idOf("4727", "7de3", "a");

interface Ordered {
  readonly id: string;
  readonly item?: string;
  readonly status?: string;
  readonly at?: string;
  readonly test?: boolean;
}

const ordersOf = (orders: readonly Ordered[]) =>
  OrderListSchema.parse({
    orders: orders.map(({ id, item = "vpn-1m", status = "delivered", at, test = false }) => ({
      id,
      merchant_item_id: item,
      params: {},
      price: {
        amount: item === "vpn-1m" ? "5.00" : "2.00",
        currency: "USD",
        at: at ?? "2026-10-12T16:40:00Z",
        as_of: at ?? "2026-10-12T16:40:00Z",
      },
      test,
      status,
    })),
  });

const THREE = ordersOf([
  { id: FIRST },
  { id: SAME_HEAD, item: "number-sms" },
  { id: SAME_TAIL, status: "in_progress" },
]);

/** The ids of the rows the address asks for, among these orders, all of them open. */
const found = (address: string, orders = THREE, open = orders) =>
  ordersView("live", CARDS, orders, open, new URLSearchParams(address)).listing.rows.map(
    (row) => row.id,
  );

const searched = (q: string) => found(new URLSearchParams({ q }).toString());

describe("searching the orders", () => {
  it("finds an order by its whole ID, and only that order", () => {
    expect(searched(FIRST)).toStrictEqual([FIRST]);
  });

  it("finds an order by the short form the page shows it in", () => {
    expect(searched(shortened(FIRST))).toStrictEqual([FIRST]);
  });

  it("finds it by the short form typed with dots, with spaces, or without its prefix", () => {
    expect(searched("ord_17ff...7de3")).toStrictEqual([FIRST]);
    expect(searched("ord_17ff..7de3")).toStrictEqual([FIRST]);
    expect(searched("ord_17ff....7de3")).toStrictEqual([FIRST]);
    expect(searched("ord_17ff … 7de3")).toStrictEqual([FIRST]);
    expect(searched("17ff…7de3")).toStrictEqual([FIRST]);
    expect(searched("ORD_17FF…7DE3")).toStrictEqual([FIRST]);
  });

  it("finds every order either half of a short form belongs to", () => {
    expect(searched("ord_17ff")).toStrictEqual([FIRST, SAME_HEAD]);
    expect(searched("17ff")).toStrictEqual([FIRST, SAME_HEAD]);
    expect(searched("7de3")).toStrictEqual([FIRST, SAME_TAIL]);
    expect(searched("ord_17ff…")).toStrictEqual([FIRST, SAME_HEAD]);
    expect(searched("…7de3")).toStrictEqual([FIRST, SAME_TAIL]);
  });

  it("finds an order by its short form pasted with words or marks around it", () => {
    expect(searched("“ord_17ff…7de3”")).toStrictEqual([FIRST]);
    expect(searched("ord_17ff…7de3.")).toStrictEqual([FIRST]);
    expect(searched("refund for ord_17ff…7de3, please")).toStrictEqual([FIRST]);
    expect(searched("(17ff…7de3)")).toStrictEqual([FIRST]);
  });

  it("finds an order whose whole ID is in what was pasted, as text copied off its row is", () => {
    expect(searched(`${shortened(FIRST)}${FIRST} Price set 2026-10-12 16:40:00 UTC`)).toStrictEqual(
      [FIRST],
    );
  });

  describe("among IDs whose hidden middle holds a word a merchant might search for", () => {
    // The middle of an ID is never shown, so a few characters found only there
    // would list orders whose rows show nothing of what was searched for.
    const MIDDLE = `ord_a1b2${"5de30bed".repeat(3)}c3d4`;
    const orders = ordersOf([{ id: MIDDLE }, { id: FIRST }]);
    const among = (q: string) => found(new URLSearchParams({ q }).toString(), orders);

    it("does not find an order by a few characters from the middle of its ID", () => {
      expect(among("5")).toStrictEqual([]);
      expect(among("de")).toStrictEqual([]);
      expect(among("bed")).toStrictEqual([]);
      expect(among("5de3")).toStrictEqual([]);
      // Fewer characters than the page shows of either end find no ID by its end.
      expect(among("a1")).toStrictEqual([]);
      expect(among("d4")).toStrictEqual([]);
    });

    it("finds an order by a run of its ID too long to turn up in another by chance", () => {
      expect(among("5de30bed")).toStrictEqual([MIDDLE]);
    });
  });

  it("answers at once a search as long as the page keeps, a run of spaces pasted, over many orders", () => {
    const many = ordersOf(
      Array.from({ length: 2_000 }, (_, at) => ({
        id: idOf(at.toString(16).padStart(4, "0"), "0000"),
      })),
    );
    // Two hundred characters, all of them searched for: none is cut.
    const pasted = `a${" ".repeat(198)}b`;
    const started = performance.now();

    const { search } = ordersView(
      "live",
      CARDS,
      many,
      many,
      new URLSearchParams({ q: pasted }),
    ).listing;

    expect(performance.now() - started).toBeLessThan(1_000);
    expect(search).toMatchObject({ q: pasted, cutAt: null });
  });

  it("does not take a short form for an order that shares only one of its halves", () => {
    expect(searched("ord_17ff…11aa")).toStrictEqual([SAME_HEAD]);
    expect(searched("ord_4727…7de3")).toStrictEqual([SAME_TAIL]);
    expect(searched("ord_17ff…a18b")).toStrictEqual([]);
    expect(searched("ord_17ff…7de3…")).toStrictEqual([]);
    expect(searched("…")).toStrictEqual([]);
  });

  it("finds an order by its product's title or its product code", () => {
    expect(searched("virtual")).toStrictEqual([SAME_HEAD]);
    expect(searched("number-sms")).toStrictEqual([SAME_HEAD]);
  });

  it("says what was searched for when nothing matches, which is not what a merchant without orders reads", () => {
    const missed = readable(
      served(() => (
        <OrdersScreen
          view={ordersView("live", CARDS, THREE, THREE, new URLSearchParams({ q: "router" }))}
        />
      )),
    );
    const none = readable(
      served(() => <OrdersScreen view={ordersView("live", CARDS, ordersOf([]), ordersOf([]))} />),
    );

    expect(missed).toContain("No order matches “router”.");
    expect(missed).toContain("Clear the search");
    expect(missed).not.toContain("No orders yet");
    expect(none).toContain("No orders yet");
    expect(none).not.toContain("matches");
  });

  it("narrows the orders that need the merchant by the same search", () => {
    const owing = ordersOf([
      { id: FIRST, status: "refund_due" },
      { id: SAME_TAIL, status: "refund_due" },
    ]);

    const view = ordersView("live", CARDS, owing, owing, new URLSearchParams({ q: FIRST }));

    expect(view.needsYou.rows.map((one) => one.id)).toStrictEqual([FIRST]);
  });
});

describe("a refund due on a test purchase", () => {
  it("says the sum to return is a test purchase's, and says nothing of tests for a real one", () => {
    const owing = ordersOf([
      { id: FIRST, status: "refund_due", test: true },
      { id: SAME_TAIL, status: "refund_due" },
    ]);

    const [test, real] = ordersView("live", CARDS, owing, owing).needsYou.rows;

    // The test word stands with the sum itself.
    expect(test?.why).toMatch(/test purchase, 5\.00 USD/);
    expect(real?.why).toContain("5.00 USD");
    expect(real?.why).not.toMatch(/test/i);
  });
});

describe("the open orders", () => {
  it("are the orders the gateway's open list holds, whatever their state says", () => {
    // Both read "In progress"; only the one the merchant was handed is open.
    const all = ordersOf([
      { id: FIRST, status: "in_progress" },
      { id: SAME_TAIL, status: "in_progress" },
      { id: SAME_HEAD },
    ]);
    const open = ordersOf([{ id: FIRST, status: "in_progress" }]);

    const view = ordersView("live", CARDS, all, open, new URLSearchParams("show=open"));

    expect(view.listing.rows.map((row) => row.id)).toStrictEqual([FIRST]);
    expect(view.listing.segments.map((one) => [one.label, one.count])).toStrictEqual([
      ["All", 3],
      ["Open", 1],
    ]);
  });

  it("say in words of their own that none is open, and lead back to all of them", () => {
    const text = readable(
      served(() => (
        <OrdersScreen
          view={ordersView("live", CARDS, THREE, ordersOf([]), new URLSearchParams("show=open"))}
        />
      )),
    );

    expect(text).toContain("Nothing is open");
    expect(text).toContain("Show all orders");
    expect(text).not.toContain("No orders yet");
  });
});

describe("a long list of orders", () => {
  // As the gateway lists them: oldest first, a minute apart.
  const many = ordersOf(
    Array.from({ length: 120 }, (_, at) => ({
      id: idOf(at.toString(16).padStart(4, "0"), "0000"),
      at: new Date(Date.parse("2026-10-11T23:00:00Z") + at * 60_000).toISOString(),
    })),
  );

  it("draws the newest fifty first and says which of how many", () => {
    const view = ordersView("live", CARDS, many, many);

    expect(view.listing.rows[0]?.id).toBe(many.orders[119]?.id);
    expect(view.listing.rows).toHaveLength(50);
    expect(readable(served(() => <OrdersScreen view={view} />))).toContain("Showing 1–50 of 120");
  });

  it("puts each day's orders under one heading, the newest day first", () => {
    // The oldest sixty fall on the eleventh of October and the newest sixty on
    // the twelfth, so the second page holds the turn of the day.
    const html = served(() => (
      <OrdersScreen view={ordersView("live", CARDS, many, many, new URLSearchParams("page=2"))} />
    ));

    const days = [...html.matchAll(/<li class="list-day"><h3>([^<]*)<\/h3><\/li>/g)].map(
      (day) => day[1],
    );

    expect(days).toStrictEqual(["12 October 2026", "11 October 2026"]);
  });
});

describe("a long run of orders told in full", () => {
  const sixtyOf = (status: string) =>
    ordersOf(
      Array.from({ length: 60 }, (_, at) => ({
        id: idOf(at.toString(16).padStart(4, "0"), "0000"),
        status,
        at: new Date(Date.parse("2026-10-11T23:00:00Z") + at * 60_000).toISOString(),
      })),
    );

  /** The ids of the rows drawn in the group the list is labelled with, in order. */
  const toldIn = (html: string, label: string): readonly string[] => {
    const group = new RegExp(`<ul class="list" aria-label="${label}">([\\s\\S]*?)</ul>`).exec(html);
    return [...(group?.[1] ?? "").matchAll(/ord_[0-9a-f]{32}/g)]
      .map((id) => id[0])
      .filter((id, at, all) => all.indexOf(id) === at);
  };

  it.each([
    ["refund_due", "Needs you", "Orders that need you"],
    ["delivered_unpaid", "Waiting on the buyer", "Orders waiting on the buyer"],
  ])("draws the newest fifty orders %s and says which of how many", (status, title, label) => {
    const orders = sixtyOf(status);

    const html = served(() => <OrdersScreen view={ordersView("live", CARDS, orders, orders)} />);

    const told = toldIn(html, label);
    expect(told).toHaveLength(50);
    expect(told[0]).toBe(orders.orders[59]?.id);
    expect(readable(html)).toContain(`${title} 60`);
    expect(readable(html)).toContain("Showing the newest 50 of 60");
  });

  it("says nothing of a cut where the group holds every order", () => {
    const orders = ordersOf([{ id: FIRST, status: "refund_due" }]);

    const html = served(() => <OrdersScreen view={ordersView("live", CARDS, orders, orders)} />);

    expect(toldIn(html, "Orders that need you")).toStrictEqual([FIRST]);
    expect(readable(html)).not.toContain("Showing the newest");
  });
});
