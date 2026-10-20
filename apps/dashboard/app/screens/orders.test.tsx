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
import { formsIn, readable } from "../../src/testing/html.js";
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
      payment_status:
        status === "payment_unresolved"
          ? "unresolved"
          : ["delivered", "shipped", "unfulfilled", "fulfillment_closed"].includes(status)
            ? "paid"
            : "not_paid",
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
      { id: FIRST, status: "unfulfilled" },
      { id: SAME_TAIL, status: "unfulfilled" },
    ]);

    const view = ordersView("live", CARDS, owing, owing, new URLSearchParams({ q: FIRST }));

    expect(view.needsYou.rows.map((one) => one.id)).toStrictEqual([FIRST]);
  });
});

describe("the counts beside a search", () => {
  /** The search box and the counts beside it, apart from the lists under them. */
  const toolsOf = (address: string): string =>
    /<div class="list-tools">([\s\S]*?)<section class="group">/.exec(
      served(() => (
        <OrdersScreen
          view={ordersView("live", CARDS, THREE, THREE, new URLSearchParams(address))}
        />
      )),
    )?.[1] ?? "";
  const linksIn = (html: string): readonly string[] =>
    [...html.matchAll(/<a\b[^>]*href="([^"]*)"/g)].map((link) =>
      (link[1] ?? "").replaceAll("&amp;", "&"),
    );

  it("are said to be the search's, with the way back to every order's", () => {
    // A status word finds nothing, and a count of none under it is not a
    // merchant with nothing to do.
    const tools = toolsOf("q=unfulfilled");

    expect(readable(tools)).toContain("“unfulfilled”");
    expect(linksIn(tools)).toContain("/orders");
  });

  it("lead back to the segment the search was made in", () => {
    expect(linksIn(toolsOf("q=virtual&show=open"))).toContain("/orders?show=open");
  });

  it("offer one way back where the search found nothing", () => {
    const page = served(() => (
      <OrdersScreen
        view={ordersView("live", CARDS, THREE, THREE, new URLSearchParams("q=unfulfilled"))}
      />
    ));

    expect(linksIn(page).filter((href) => href === "/orders")).toHaveLength(1);
  });

  it("say nothing more where the page searched for the one order it opens", () => {
    // The page's own links to an order search for it; the merchant searched
    // for nothing.
    expect(readable(toolsOf(`q=${FIRST}&details=${FIRST}`))).not.toContain("“");
    expect(readable(toolsOf(`q=${FIRST}`))).toContain(`“${FIRST}”`);
  });

  it("say nothing of a search where there is none", () => {
    const tools = toolsOf("");

    expect(linksIn(tools)).not.toContain("/orders");
    expect(readable(tools)).not.toContain("“");
  });
});

describe("an unfulfilled test purchase", () => {
  it("marks the original amount as a test", () => {
    const orders = ordersOf([{ id: FIRST, status: "unfulfilled", test: true }]);
    const html = served(() => <OrdersScreen view={ordersView("live", CARDS, orders, orders)} />);
    expect(readable(html)).toContain("5.00 USD test");
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
      ["Needs you", 0],
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
    const group = new RegExp(`<ul class="list" aria-label="${label}"[^>]*>([\\s\\S]*?)</ul>`).exec(
      html,
    );
    return [...(group?.[1] ?? "").matchAll(/ord_[0-9a-f]{32}/g)]
      .map((id) => id[0])
      .filter((id, at, all) => all.indexOf(id) === at);
  };

  it.each([
    ["unfulfilled", "Needs you", "Orders that need you"],
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
    const orders = ordersOf([{ id: FIRST, status: "unfulfilled" }]);

    const html = served(() => <OrdersScreen view={ordersView("live", CARDS, orders, orders)} />);

    expect(toldIn(html, "Orders that need you")).toStrictEqual([FIRST]);
    expect(readable(html)).not.toContain("Showing the newest");
  });

  /** The ids drawn in each list on the page, list after list, each once in its list. */
  const listedIn = (html: string): readonly string[] =>
    [...html.matchAll(/<ul class="list"[^>]*>([\s\S]*?)<\/ul>/g)].flatMap((list) =>
      [...(list[1] ?? "").matchAll(/ord_[0-9a-f]{32}/g)]
        .map((id) => id[0])
        .filter((id, at, all) => all.indexOf(id) === at),
    );

  /**
   * The addresses the Needs you group leads to on this page, other than an
   * order's own details and the documentation.
   */
  const waysOnFrom = (html: string): readonly string[] => {
    const group =
      /<section class="group">(?:(?!<\/section>)[\s\S])*?aria-label="Orders that need you"[\s\S]*?<\/section>/.exec(
        html,
      )?.[0] ?? "";
    return [...group.matchAll(/<a [^>]*href="([^"]*)"/g)]
      .map((link) => (link[1] ?? "").replaceAll("&amp;", "&"))
      .filter((href) => href.startsWith("/orders") && !href.includes("details="));
  };

  it("leads from a cut Needs you to every order that needs the merchant, a page at a time and each drawn once", () => {
    const done = idOf("ffff", "1111");
    // Closed, then paid: the gateway keeps it open until it is closed again.
    const reopened = {
      ...ordersOf([{ id: idOf("eeee", "2222"), status: "fulfillment_closed" }]).orders[0],
      merchant_closure: { closed_at: "2026-10-12T16:41:00Z" },
    };
    const owing = OrderListSchema.parse({
      orders: [...sixtyOf("unfulfilled").orders, reopened],
    });
    const orders = OrderListSchema.parse({
      orders: [...owing.orders, ...ordersOf([{ id: done }]).orders],
    });
    const preview = served(() => <OrdersScreen view={ordersView("live", CARDS, orders, owing)} />);

    const [way, ...more] = waysOnFrom(preview);
    expect(more).toStrictEqual([]);
    const reached: string[] = [];
    let address: string | null = way ?? null;
    for (let pages = 0; address !== null && pages < 3; pages += 1) {
      const view = ordersView(
        "live",
        CARDS,
        orders,
        owing,
        new URL(address, "https://agentify.ad").searchParams,
      );
      const html = served(() => <OrdersScreen view={view} />);
      const told = toldIn(html, "Orders that need you");
      // Nothing else on the page draws the same orders again.
      expect(listedIn(html)).toStrictEqual(told);
      reached.push(...told);
      address = view.listing.cut?.next ?? null;
      if (address !== null) expect(html).toContain(`href="${address.replaceAll("&", "&amp;")}"`);
    }

    expect(reached).toHaveLength(61);
    expect([...reached].sort()).toStrictEqual(owing.orders.map((order) => order.id).sort());
    expect(reached).not.toContain(done);
  });

  it("opens an order's closure on the page of Needs you it was found on, and carries that page in the form", () => {
    // A merchant working through the orders that need them comes back where
    // they were after each closure.
    const owing = sixtyOf("unfulfilled");
    const drawnAt = (address: URLSearchParams) =>
      served(() => <OrdersScreen view={ordersView("live", CARDS, owing, owing, address)} />);
    const second = drawnAt(new URLSearchParams("show=needs&page=2"));
    const [id] = toldIn(second, "Orders that need you");

    const link =
      [...second.matchAll(/<a [^>]*href="([^"]*)"/g)]
        .map((found) => (found[1] ?? "").replaceAll("&amp;", "&"))
        .find((href) => href.includes(`details=${id}`)) ?? "";
    const opened = new URL(link, "https://agentify.ad").searchParams;
    const form = formsIn(drawnAt(opened)).find((one) => one.fields.get("order_id") === id);

    expect([opened.get("show"), opened.get("page")]).toStrictEqual(["needs", "2"]);
    expect(form?.fields.get("show")).toBe("needs");
    expect(form?.fields.get("page")).toBe("2");
  });

  it("says once which of how many it shows where the list is the orders that need the merchant", () => {
    const owing = sixtyOf("unfulfilled");

    const text = readable(
      served(() => (
        <OrdersScreen
          view={ordersView("live", CARDS, owing, owing, new URLSearchParams("show=needs"))}
        />
      )),
    );

    expect(text.match(/Showing/g)).toHaveLength(1);
    expect(text).toContain("Showing 1–50 of 60");
  });

  it("offers no other way on where Needs you already holds every order", () => {
    const orders = ordersOf([{ id: FIRST, status: "unfulfilled" }, { id: SAME_HEAD }]);

    const html = served(() => <OrdersScreen view={ordersView("live", CARDS, orders, orders)} />);

    expect(waysOnFrom(html)).toStrictEqual([]);
  });
});

describe("merchant fulfillment closure", () => {
  const closedAt = "2026-10-19T09:30:00Z";
  const closed = (status = "fulfillment_closed", payment = "paid", message?: string) =>
    OrderListSchema.parse({
      orders: [
        {
          ...THREE.orders[0],
          status,
          payment_status: payment,
          merchant_closure: { closed_at: closedAt, ...(message === undefined ? {} : { message }) },
        },
      ],
    });

  it("keeps the original payment fact and attributes the explanation to the merchant", () => {
    const orders = closed("fulfillment_closed", "paid", "A refund was agreed <outside Agentify>.");
    const html = served(() => (
      <OrdersScreen view={ordersView("live", CARDS, orders, ordersOf([]))} />
    ));
    const text = readable(html);

    expect(text).toContain("Closed by you");
    expect(text).toContain("Payment Paid");
    expect(text).toContain("Your explanation");
    expect(text).toContain("A refund was agreed <outside Agentify>.");
    expect(html).toContain("&lt;outside Agentify&gt;");
    expect(html).not.toContain("<outside Agentify>");
    expect(text).toContain("2026-10-19 09:30:00 UTC");
    expect(text).not.toContain("Refunded");
  });

  it("shows closure without pretending an unresolved payment is known", () => {
    const orders = closed("payment_unresolved", "unresolved");
    const text = readable(
      served(() => <OrdersScreen view={ordersView("live", CARDS, orders, ordersOf([]))} />),
    );

    expect(text).toContain("Payment outcome unknown");
    expect(text).toContain("Closed by you 2026-10-19 09:30:00 UTC");
    expect(text).toContain("Payment Outcome unknown");
    expect(text).not.toContain("Your explanation");
  });

  it("does not invent an actor for a historical closure without metadata", () => {
    const orders = OrderListSchema.parse({
      orders: [{ ...THREE.orders[0], status: "fulfillment_closed", payment_status: "paid" }],
    });
    const text = readable(
      served(() => <OrdersScreen view={ordersView("live", CARDS, orders, ordersOf([]))} />),
    );

    expect(text).toContain("Fulfillment closed");
    expect(text).not.toContain("Closed by you");
  });

  it("counts a closed order whose payment completed afterwards as needing the merchant, and offers closing it again", () => {
    // The gateway keeps such an order on the open list until the merchant
    // closes it again; one it no longer lists is settled.
    const orders = closed("fulfillment_closed", "paid", "Your payment did not go through.");
    const id = orders.orders[0]?.id ?? "";
    const reopened = served(() => (
      <OrdersScreen view={ordersView("live", CARDS, orders, orders)} />
    ));
    const settled = served(() => (
      <OrdersScreen view={ordersView("live", CARDS, orders, ordersOf([]))} />
    ));
    const needs = (html: string) =>
      readable(
        /<section class="group">(?:(?!<\/section>)[\s\S])*?aria-label="Orders that need you"[\s\S]*?<\/section>/.exec(
          html,
        )?.[0] ?? "",
      );

    expect(needs(reopened)).toContain("Needs you 1");
    expect(needs(reopened)).toContain("payment completed after you closed fulfillment");
    expect(reopened).toContain(`name="order_id" value="${id}"`);
    expect(readable(reopened)).toContain("Close again");
    expect(needs(settled)).toBe("");
    expect(settled).not.toContain(`name="order_id" value="${id}"`);
  });

  it("offers closure only while fulfillment can still be stopped", () => {
    // Each order is named by its own hexadecimal tail, so a form is found by the order it closes.
    const cases = [
      ["unfulfilled", "paid", true],
      ["payment_unresolved", "unresolved", true],
      ["delivered_unpaid", "not_paid", true],
      ["in_progress", "paid", true],
      ["in_progress", "not_paid", false],
      ["rejected", "not_paid", false],
      ["declined", "not_paid", false],
      ["expired", "not_paid", false],
      ["cancelled", "not_paid", false],
      ["delivered", "paid", false],
      ["shipped", "paid", false],
      ["fulfillment_closed", "paid", false],
    ] as const;
    const idAt = (at: number) => idOf("c1a5", at.toString(16).padStart(4, "0"));
    const orders = OrderListSchema.parse({
      orders: [
        ...cases.map(([status, payment], at) => ({
          ...THREE.orders[0],
          id: idAt(at),
          status,
          payment_status: payment,
        })),
        {
          ...THREE.orders[0],
          id: SAME_TAIL,
          status: "payment_unresolved",
          payment_status: "unresolved",
          merchant_closure: { closed_at: closedAt },
        },
      ],
    });
    const html = served(() => <OrdersScreen view={ordersView("live", CARDS, orders, orders)} />);

    cases.forEach(([status, payment, offered], at) => {
      expect(
        html.includes(`name="order_id" value="${idAt(at)}"`),
        `${status} with payment ${payment}`,
      ).toBe(offered);
    });
    expect(html).not.toContain(`name="order_id" value="${SAME_TAIL}"`);
  });
});

describe("an order's details", () => {
  const detailsOf = (html: string, id: string) =>
    new RegExp(`<details[^>]*id="details-${id}"[^>]*>`).exec(html)?.[0] ?? "";

  it("are drawn under a wide row only where they hold something its columns do not", () => {
    const orders = ordersOf([
      { id: FIRST, status: "unfulfilled" },
      { id: SAME_HEAD, status: "delivered" },
    ]);
    const html = served(() => <OrdersScreen view={ordersView("live", CARDS, orders, orders)} />);

    expect(detailsOf(html, FIRST)).toContain("wide");
    expect(detailsOf(html, SAME_HEAD)).not.toBe("");
    expect(detailsOf(html, SAME_HEAD)).not.toContain("wide");
  });

  it("are reached from Needs you without searching for an order already on the page", () => {
    const orders = ordersOf([{ id: FIRST, status: "unfulfilled" }]);
    const opens = (address: string, open = orders) =>
      ordersView("live", CARDS, orders, open, new URLSearchParams(address)).needsYou.rows[0]?.opens;

    expect(opens("")).toStrictEqual({
      search: `?details=${FIRST}`,
      words: "Close fulfillment",
    });
    expect(opens("q=vpn&show=open")?.search).toBe(`?q=vpn&show=open&details=${FIRST}`);
    // Where the list below does not hold it, the order is found by its ID.
    expect(opens("show=open", ordersOf([]))?.search).toBe(`?q=${FIRST}&details=${FIRST}`);
  });
});
