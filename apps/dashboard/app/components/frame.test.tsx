// @vitest-environment jsdom

/**
 * What a merchant sees between the click and the next page, where the page's
 * script runs: the section or filter they chose is marked at once, and a page
 * that takes longer than a moment to arrive says it is on its way. The next
 * page's data is held until the test lets it go, as a slow gateway would.
 */

import { SURFACE_MARKER_ATTRIBUTE, SURFACE_WORDS } from "@agentify/core";
import { MerchantCardListSchema, OrderListSchema } from "@nuanu-ai/agentify-contracts";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createRoutesStub, Outlet, useLoaderData } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import type { Viewer } from "../../src/viewer.js";
import { type OrdersView, ordersView } from "../../src/views.js";
import { OrdersScreen } from "../screens/orders.js";
import { Frame } from "./frame.js";

const PERSON = "owner@example.com";
const SEEN_BY: Viewer = { base: "", mode: "sandbox", who: PERSON, confirmed: true };
const NO_CARDS = MerchantCardListSchema.parse({ selling: "open", cards: [] });
const NO_ORDERS = OrderListSchema.parse({ orders: [] });

afterEach(cleanup);

/** A load the test lets go of when it says. */
const held = () => {
  let release = () => {};
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { done, release };
};

/**
 * The dashboard opened at `path`. Every load of the orders after the one the
 * page opened with is held until let go.
 */
const dashboardAt = (path: string) => {
  let ordersAsked = 0;
  const loads: ReturnType<typeof held>[] = [];
  const Stub = createRoutesStub([
    {
      id: "root",
      path: "/",
      loader: () => ({
        base: "",
        surface: {
          attribute: SURFACE_MARKER_ATTRIBUTE,
          mode: "sandbox",
          words: SURFACE_WORDS.sandbox,
        },
      }),
      Component: Outlet,
      children: [
        {
          id: "routes/gate",
          loader: () => ({ who: PERSON }),
          Component: Outlet,
          children: [
            {
              path: "cards",
              Component: () => (
                <Frame tab="cards" title="Product cards" frame={{ unnamed: false }}>
                  <p>The cards</p>
                </Frame>
              ),
            },
            {
              path: "orders",
              loader: async ({ request }) => {
                ordersAsked += 1;
                if (path !== "/orders" || ordersAsked > 1) {
                  const load = held();
                  loads.push(load);
                  await load.done;
                }
                const open = new URL(request.url).searchParams.get("open") === "true";
                return ordersView(SEEN_BY, NO_CARDS, NO_ORDERS, open);
              },
              Component: () => {
                const view = useLoaderData() as OrdersView;
                return (
                  <Frame tab="orders" title="Orders" frame={view.frame}>
                    <OrdersScreen view={view} />
                  </Frame>
                );
              },
            },
          ],
        },
      ],
    },
  ]);
  render(<Stub initialEntries={[path]} />);
  return { releaseAll: () => loads.splice(0).forEach((load) => load.release()) };
};

/** The sidebar's sections, not the narrow menu's copy of them. */
const sections = (): HTMLElement => {
  const nav = document.querySelector<HTMLElement>("nav.tabs");
  if (nav === null) throw new Error("the frame drew no sections");
  return nav;
};
const progress = () => screen.getByRole("progressbar", { hidden: true });
const aMoment = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

describe("between a click and the next page", () => {
  it("marks the section chosen at once, and says the page is coming once it takes a moment", async () => {
    const dashboard = dashboardAt("/cards");
    await screen.findByText("The cards");

    fireEvent.click(within(sections()).getByText("Orders"));
    await aMoment(20);

    // Still on the cards, with the orders' data held.
    expect(screen.getByText("The cards")).toBeTruthy();
    expect(within(sections()).getByText("Orders").closest("[aria-current=page]")).not.toBeNull();
    expect(progress().hidden).toBe(true);

    await aMoment(200);
    expect(progress().hidden).toBe(false);

    act(() => dashboard.releaseAll());
    await screen.findByText("Orders", { selector: "h1" });
    expect(progress().hidden).toBe(true);
  });

  it("marks the orders' filter chosen at once", async () => {
    const dashboard = dashboardAt("/orders");
    await screen.findByText("Orders", { selector: "h1" });

    fireEvent.click(screen.getByText("Open", { selector: "a" }));
    await aMoment(20);

    expect(screen.getByText("Open", { selector: ".here" })).toBeTruthy();
    expect(screen.getByText("All", { selector: "a" })).toBeTruthy();

    act(() => dashboard.releaseAll());
  });
});
