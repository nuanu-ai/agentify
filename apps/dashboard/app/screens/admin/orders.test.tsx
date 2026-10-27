// @vitest-environment jsdom
/**
 * The orders screens drawn from views the real view functions built: a read
 * that failed shows no count, an untimed step says so, an identifier opens to
 * its whole value with no button that needs script, and a lookup that found
 * nothing keeps the text.
 */

import { SURFACE_MARKER_ATTRIBUTE } from "@agentify/ui/surface";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";
import {
  aPage,
  aRow,
  closedOrder,
  counts,
  READ_AT,
  unknownOrder,
} from "../../../src/admin/orders-fixtures.js";
import {
  findView,
  orderPageView,
  ordersAskedIn,
  ordersListView,
} from "../../../src/admin/orders-view.js";
import { readable } from "../../../src/testing/html.js";
import { FindScreen, OrderScreen, OrdersScreen } from "./orders.js";

const drawn = (screen: () => ReactElement): string => {
  const Stub = createRoutesStub([{ id: "root", path: "/", Component: screen }]);
  return renderToString(
    <Stub
      initialEntries={["/"]}
      hydrationData={{
        loaderData: {
          root: {
            base: "/dashboard",
            surface: { attribute: SURFACE_MARKER_ATTRIBUTE, mode: "live", words: null },
          },
        },
      }}
    />,
  );
};

const NO_EXPLORER = { transactionPage: null, addressPage: null };

describe("the orders screens", () => {
  it("draw a list that could not be read with no count and no empty list", () => {
    const view = ordersListView(ordersAskedIn(new URLSearchParams()), null, READ_AT);
    const text = readable(drawn(() => <OrdersScreen view={view} />));

    expect(text).toContain("Payment unknown Unfulfilled");
    expect(text).toContain("The orders could not be read.");
    expect(text).not.toMatch(/\b0\b/);
    expect(text).not.toContain("No order");
  });

  it("draw an empty channel as a read that found none", () => {
    const view = ordersListView(ordersAskedIn(new URLSearchParams()), aPage(), READ_AT);

    const page = new DOMParser().parseFromString(
      drawn(() => <OrdersScreen view={view} />),
      "text/html",
    );
    expect(page.querySelector(".list-empty")?.textContent).toMatch(/no order.*yet/i);
    expect(page.querySelectorAll("li.list-row, li.list-opens")).toHaveLength(0);
    expect(page.body.textContent).not.toMatch(/could not be read/i);
  });

  it("draw an order's untimed steps as such, its identifier whole on opening, and no copy button", () => {
    const view = orderPageView(closedOrder().id, closedOrder(), NO_EXPLORER, READ_AT);
    const html = drawn(() => <OrderScreen view={view} />);

    expect(readable(html)).toContain("Time ran out");
    expect(readable(html)).toContain("time not recorded");
    const page = new DOMParser().parseFromString(html, "text/html");
    const disclosure = [...page.querySelectorAll("details")].find(
      (one) => one.querySelector(".ident-all")?.textContent === closedOrder().id,
    );
    expect(disclosure).toBeDefined();
    expect(disclosure?.hasAttribute("open")).toBe(false);
    expect(disclosure?.querySelector(":scope > summary")?.textContent).toContain("ord_3e91…c07b");
    expect(disclosure?.querySelector(".ident-all")?.textContent).toBe(
      "ord_3e9174b2c80d4f6a91e2d5730a8fc07b",
    );
  });

  it("draw an unknown payment outcome dashed, as every unknown, never in a failure's colour", () => {
    const unknown = unknownOrder();
    const list = ordersListView(
      ordersAskedIn(new URLSearchParams()),
      aPage({
        counts: counts({ payment_unknown: 1 }),
        rows: [aRow(unknown.id, { status: "payment_unresolved", payment: "unresolved" })],
      }),
      READ_AT,
    );
    const page = orderPageView(unknown.id, unknown, NO_EXPLORER, READ_AT);
    const listed = drawn(() => <OrdersScreen view={list} />);
    const head = drawn(() => <OrderScreen view={page} />).split('class="op-voices"')[0] ?? "";

    for (const html of [listed, head]) {
      expect(html).toContain('<span class="badge badge-unknown">Payment outcome unknown</span>');
      expect(html).not.toMatch(/badge-fail[^>]*>Payment outcome unknown/);
    }
  });

  it("draw a lookup that found nothing with the text kept in its box", () => {
    const view = findView("ord_nothing", [], false);
    if (view.kind === "open") throw new Error("nothing was found, so nothing opens");
    const html = drawn(() => <FindScreen view={view} />);

    expect(readable(html)).toContain("Nothing here matches “ord_nothing”.");
    expect(html).toMatch(/value="ord_nothing"/);
  });
});
