// @vitest-environment jsdom

/**
 * What a merchant sees between the click and the next page, where the page's
 * script runs: the section or filter they chose is marked at once, and a page
 * that takes longer than a moment to arrive says it is on its way. The next
 * page's data is held until the test lets it go, as a slow gateway would. Run
 * at the root of an origin and under the prefix the stack deploys at, where
 * every address React Router holds carries the prefix.
 */

import { SURFACE_MARKER_ATTRIBUTE, SURFACE_WORDS } from "@agentify/core";
import { MerchantCardListSchema, OrderListSchema } from "@nuanu-ai/agentify-contracts";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
  createMemoryRouter,
  createRoutesStub,
  UNSAFE_FrameworkContext as FrameworkContext,
  type LoaderFunctionArgs,
  Outlet,
  RouterProvider,
  useLoaderData,
} from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { accountOf } from "../../src/account-banner.js";
import type { Viewer } from "../../src/viewer.js";
import { type FrameView, type OrdersView, ordersView } from "../../src/views.js";
import { shouldRevalidate } from "../routes/merchant-only.js";
import { OrdersScreen } from "../screens/orders.js";
import { Frame, type Tab } from "./frame.js";

const PERSON = "owner@example.com";
const NO_CARDS = MerchantCardListSchema.parse({ selling: "open", cards: [] });
/** One order, open, so the orders' list has its search and its segments. */
const ORDERS = OrderListSchema.parse({
  orders: [
    {
      id: "ord_17ff00a1b2c3d4e5f60718293a4b7de3",
      merchant_item_id: "vpn-1m",
      params: {},
      price: {
        amount: "5.00",
        currency: "USD",
        at: "2026-10-12T16:40:00Z",
        as_of: "2026-10-12T16:40:00Z",
      },
      test: false,
      status: "in_progress",
    },
  ],
});

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
 * What the build gives every page in a browser, which a link that fetches its
 * page ahead reads; nothing in it is asked for here.
 */
const FRAMEWORK = {
  future: {},
  manifest: { routes: {}, entry: { imports: [], module: "" }, url: "", version: "" },
  routeModules: {},
  ssr: false,
  isSpaMode: false,
  routeDiscovery: { mode: "lazy", manifestPath: "/__manifest" },
} as never;

/**
 * The dashboard under `base` opened at `path`. Every load of the orders after
 * the one the page opened with is held until let go.
 */
const dashboardAt = (base: string, path: string) => {
  let ordersAsked = 0;
  const loads: ReturnType<typeof held>[] = [];
  const routes = [
    {
      id: "root",
      path: "/",
      loader: () => ({
        base,
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
                <Frame tab="cards" title="Product cards">
                  <p>The cards</p>
                </Frame>
              ),
            },
            {
              path: "orders",
              loader: async ({ request }: LoaderFunctionArgs) => {
                ordersAsked += 1;
                if (path !== "/orders" || ordersAsked > 1) {
                  const load = held();
                  loads.push(load);
                  await load.done;
                }
                return ordersView(
                  "live",
                  NO_CARDS,
                  ORDERS,
                  ORDERS,
                  new URL(request.url).searchParams,
                );
              },
              Component: () => {
                const view = useLoaderData() as OrdersView;
                return (
                  <Frame tab="orders" title="Orders">
                    <OrdersScreen view={view} />
                  </Frame>
                );
              },
            },
          ],
        },
      ],
    },
  ];
  const router = createMemoryRouter(routes, {
    basename: base === "" ? "/" : base,
    initialEntries: [`${base}${path}`],
  });
  render(
    <FrameworkContext.Provider value={FRAMEWORK}>
      <RouterProvider router={router} />
    </FrameworkContext.Provider>,
  );
  return {
    releaseAll: () => {
      for (const load of loads.splice(0)) load.release();
    },
  };
};

/** The sidebar's sections, not the narrow menu's copy of them. */
const sections = (): HTMLElement => {
  const nav = document.querySelector<HTMLElement>("nav.tabs");
  if (nav === null) throw new Error("the frame drew no sections");
  return nav;
};
const progress = () => screen.getByRole("progressbar", { hidden: true });
const aMoment = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

describe.each([
  ["at the root of its origin", ""],
  ["under its prefix", "/dashboard"],
])("between a click and the next page, %s", (_where, base) => {
  it("marks the section chosen at once, and says the page is coming once it takes a moment", async () => {
    const dashboard = dashboardAt(base, "/cards");
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

  it("marks the orders' segment chosen at once", async () => {
    const dashboard = dashboardAt(base, "/orders");
    await screen.findByText("Orders", { selector: "h1" });

    fireEvent.click(screen.getByText("Open", { selector: "a" }));
    await aMoment(20);

    expect(screen.getByText("Open", { selector: ".here" })).toBeTruthy();
    expect(screen.getByText("All", { selector: "a" })).toBeTruthy();

    act(() => dashboard.releaseAll());
  });
});

/**
 * One screen drawn in the frame, behind the gate and the merchant's own pages
 * as every section is.
 */
const framed = (tab: Tab, { account = [] }: Partial<FrameView> = {}, at: string = tab) => {
  const Stub = createRoutesStub([
    {
      id: "root",
      path: "/",
      Component: Outlet,
      children: [
        {
          id: "routes/gate",
          Component: Outlet,
          children: [
            {
              id: "routes/merchant-only",
              Component: Outlet,
              children: [
                {
                  path: at,
                  Component: () => (
                    <Frame
                      tab={tab}
                      title="A screen"
                      action={<button type="button">The page's control</button>}
                    >
                      <p>The screen</p>
                    </Frame>
                  ),
                },
              ],
            },
          ],
        },
      ],
    },
  ]);
  render(
    <Stub
      initialEntries={[`/${at}`]}
      hydrationData={{
        loaderData: {
          root: {
            base: "",
            surface: { attribute: SURFACE_MARKER_ATTRIBUTE, mode: "live", words: null },
          },
          "routes/gate": { who: PERSON },
          "routes/merchant-only": { account } satisfies FrameView,
        },
      }}
    />,
  );
};

const banner = () => screen.queryByRole("region", { name: "About your account" });

const TEST_DASHBOARD = "https://test.agentify.ad/dashboard/sign-in";

describe("the banner about the account", () => {
  const LIVE: Viewer = {
    base: "",
    mode: "live",
    who: PERSON,
    confirmed: true,
    sellerName: "Freeland",
    payout: { wallet: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" },
    liveApproval: true,
  };

  it("is not drawn while the account sells as usual", async () => {
    framed("cards", { account: accountOf(LIVE, { selling: "open", through: "api" }) });
    await screen.findByText("The screen");

    expect(banner()).toBeNull();
  });

  it("says each reason with its title and sentence, and the way on from it", async () => {
    framed("orders", { account: accountOf({ ...LIVE, sellerName: null, liveApproval: false }) });
    await screen.findByText("The screen");
    const drawn = banner();
    if (drawn === null) throw new Error("no banner was drawn");

    expect(within(drawn).getByText("Not approved for live sales yet")).toBeTruthy();
    expect(within(drawn).getByText("No seller name yet")).toBeTruthy();
    expect(drawn.textContent).toContain("until you choose the name buyers see");
    // The approval is nobody's to set on a page, so it leads on to the test
    // channel, where the first sale is made, and not to a page of this one.
    expect(
      within(drawn)
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")]),
    ).toStrictEqual([
      ["Open the test dashboard", TEST_DASHBOARD],
      ["Choose it in Settings", "/settings"],
    ]);
  });

  it("leads a live merchant not yet approved to the test channel's own dashboard, and nobody else", async () => {
    // A merchant who signed up on the live site makes the first sale on the
    // test channel, which is another dashboard and another account.
    const toTheTest = () =>
      banner() === null
        ? []
        : within(banner() as HTMLElement)
            .queryAllByRole("link")
            .filter((link) => link.getAttribute("href") === TEST_DASHBOARD);

    framed("cards", { account: accountOf({ ...LIVE, liveApproval: false }) });
    await screen.findByText("The screen");
    expect(toTheTest()).toHaveLength(1);

    for (const viewer of [
      LIVE,
      { ...LIVE, mode: "test", liveApproval: false, sellerName: null },
    ] satisfies Viewer[]) {
      cleanup();
      framed("cards", { account: accountOf(viewer) });
      await screen.findByText("The screen");
      expect(toTheTest(), JSON.stringify(viewer)).toStrictEqual([]);
    }
  });

  it("leaves out the way to the page it is drawn on", async () => {
    // On the cards the control that resumes the sales is already on screen.
    framed("cards", { account: accountOf(LIVE, { selling: "paused" }) });
    await screen.findByText("The screen");
    const onCards = banner();
    if (onCards === null) throw new Error("no banner was drawn");

    expect(within(onCards).getByText("All sales are paused")).toBeTruthy();
    expect(within(onCards).queryByRole("link")).toBeNull();

    cleanup();
    framed("orders", { account: accountOf(LIVE, { selling: "paused" }) });
    await screen.findByText("The screen");

    expect(screen.getByRole("link", { name: "Resume on Cards" }).getAttribute("href")).toBe(
      "/cards",
    );
  });
});

describe("the banner on the pages that say a reason themselves", () => {
  const SHOP: Viewer = {
    base: "",
    mode: "test",
    who: PERSON,
    confirmed: true,
    sellerName: "Freeland",
    payout: { wallet: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" },
  };
  const selling = accountOf(SHOP, { selling: "paused", through: "woocommerce" });

  it.each(["woocommerce", "woocommerce/import"])(
    "leaves out selling through the shop on %s, and keeps the other reasons",
    async (at) => {
      framed("integrations", { account: selling }, at);
      await screen.findByText("The screen");
      const drawn = banner();
      if (drawn === null) throw new Error("no banner was drawn");

      expect(within(drawn).getByText("All sales are paused")).toBeTruthy();
      expect(within(drawn).queryByText("Selling through your WooCommerce shop")).toBeNull();
    },
  );

  it("says it, with the way to the shop's page, everywhere else", async () => {
    framed("cards", { account: selling });
    await screen.findByText("The screen");
    const drawn = banner();
    if (drawn === null) throw new Error("no banner was drawn");

    expect(within(drawn).getByText("Selling through your WooCommerce shop")).toBeTruthy();
    expect(within(drawn).getByRole("link", { name: "Open WooCommerce" })).toBeTruthy();
  });

  it("draws no banner on the shop's page when selling through the shop is all there is", async () => {
    framed("integrations", { account: accountOf(SHOP, { through: "woocommerce" }) }, "woocommerce");
    await screen.findByText("The screen");

    expect(banner()).toBeNull();
  });
});

describe("the way past the header", () => {
  it("leads to the page's title and its control about the whole page, before the screen", async () => {
    framed("cards");
    await screen.findByText("The screen");
    const target = document.getElementById("main");
    if (target === null) throw new Error("the skip link leads nowhere");

    expect(within(target).getByRole("heading", { level: 1, name: "A screen" })).toBeTruthy();
    expect(within(target).getByRole("button", { name: "The page's control" })).toBeTruthy();
  });
});

describe("the sidebar", () => {
  const orders = () => within(sections()).getByRole("link", { name: /^Orders/ });

  it("lists the sections by name alone", async () => {
    framed("cards", { account: [] });
    await screen.findByText("The screen");

    expect(within(sections()).getByText("Cards").textContent).toBe("Cards");
    expect(orders().textContent).toBe("Orders");
  });

  it("holds the sections and nothing else", async () => {
    framed("cards");
    await screen.findByText("The screen");
    const sidebar = document.querySelector<HTMLElement>(".app-sidebar");
    if (sidebar === null) throw new Error("the frame drew no sidebar");

    expect(sidebar.textContent).toBe(sections().textContent);
  });
});

describe("the banner, read by the merchant's layout", () => {
  /**
   * The cards and the orders under a layout whose loader answers the banner as
   * the server does, through a promise, and which is read again when the real
   * layout says it is; each answer after the first is held until the test lets
   * it go.
   */
  const reading = (banners: readonly FrameView["account"][]) => {
    const loads: ReturnType<typeof held>[] = [];
    let asked = 0;
    const screenAt = (tab: Tab) => ({
      path: tab,
      Component: () => (
        <Frame tab={tab} title={tab}>
          <p>{`The ${tab}`}</p>
        </Frame>
      ),
    });
    const router = createMemoryRouter(
      [
        {
          id: "root",
          path: "/",
          loader: () => ({
            base: "",
            surface: { attribute: SURFACE_MARKER_ATTRIBUTE, mode: "live", words: null },
          }),
          Component: Outlet,
          children: [
            {
              id: "routes/gate",
              loader: () => ({ who: PERSON }),
              Component: Outlet,
              children: [
                {
                  id: "routes/merchant-only",
                  loader: async () => {
                    const account = banners[Math.min(asked, banners.length - 1)] ?? [];
                    asked += 1;
                    if (asked > 1) {
                      const load = held();
                      loads.push(load);
                      await load.done;
                    }
                    return { account } satisfies FrameView;
                  },
                  shouldRevalidate,
                  Component: Outlet,
                  children: [screenAt("cards"), screenAt("orders")],
                },
              ],
            },
          ],
        },
      ],
      { initialEntries: ["/cards"] },
    );
    render(
      <FrameworkContext.Provider value={FRAMEWORK}>
        <RouterProvider router={router} />
      </FrameworkContext.Provider>,
    );
    return {
      releaseAll: () => {
        for (const load of loads.splice(0)) load.release();
      },
    };
  };
  const orders = () => within(sections()).getByText(/^Orders/);

  it("keeps the page it has while the next page's banner is read, then draws that one", async () => {
    const paused = accountOf(
      { base: "", mode: "sandbox", who: PERSON, confirmed: true },
      { selling: "paused" },
    );
    const dashboard = reading([[], paused]);
    await screen.findByText("The cards");
    expect(banner()).toBeNull();

    fireEvent.click(orders());
    await aMoment(50);

    // Still the cards as they were drawn, while the orders' banner is read.
    expect(screen.getByText("The cards")).toBeTruthy();
    expect(banner()).toBeNull();

    act(() => dashboard.releaseAll());
    await screen.findByText("The orders");
    expect(banner()?.textContent).toContain("All sales are paused");
  });
});
