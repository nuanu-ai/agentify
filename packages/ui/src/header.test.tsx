// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { createMemoryRouter, createRoutesStub, Link, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Current, SectionNav, SiteHeader, type Surface, WorkHeader } from "./header.js";
import type { Visitor } from "./visitor.js";

/**
 * A click the router does not take would load another document, which jsdom
 * cannot do; it is stopped after the router has had its turn, so the router's
 * location says whether the click was followed in place.
 */
const stopLoadingDocuments = (event: Event) => event.preventDefault();
beforeEach(() => document.addEventListener("click", stopLoadingDocuments));
afterEach(() => {
  document.removeEventListener("click", stopLoadingDocuments);
  cleanup();
});

const PERSON = "owner@example.com";
const GUEST: Visitor = { status: "signed_out" };
const MERCHANT: Visitor = { status: "signed_in", email: PERSON, operator: false };
const OPERATOR = { status: "signed_in", email: PERSON, operator: true } as const;

const BASENAME: Readonly<Record<Surface, string>> = {
  scanner: "/",
  dashboard: "/dashboard",
  docs: "/docs",
};
const START: Readonly<Record<Surface, string>> = {
  scanner: "/privacy",
  dashboard: "/dashboard/cards",
  docs: "/docs/money",
};

/** A header as a surface mounted where it is deployed draws it, on one of its pages. */
const drawnOn = (surface: Surface, header: ReactElement) => {
  const router = createMemoryRouter([{ path: "*", element: header }], {
    basename: BASENAME[surface],
    initialEntries: [START[surface]],
  });
  render(<RouterProvider router={router} />);
  const banner = screen.getByRole("banner");
  /** The row itself, without the narrow window's menu, which repeats some of its links. */
  const row = () => {
    const copy = banner.cloneNode(true) as HTMLElement;
    copy.querySelector(".site-menu")?.remove();
    return within(copy);
  };
  const menu = () => {
    const panel = banner.querySelector<HTMLElement>(".site-menu-panel");
    if (panel === null) throw new Error("the header drew no menu");
    return within(panel);
  };
  return {
    banner,
    row,
    menu,
    href: (name: string) => row().getByRole("link", { name }).getAttribute("href"),
    /** The links marked as the part of the site the page belongs to. */
    marked: () =>
      row()
        .queryAllByRole("link")
        .filter((link) => link.hasAttribute("aria-current"))
        .map((link) => link.textContent),
    /** Where the router is after a click on the link in the row, or the page it was on. */
    afterClicking: (name: string) => {
      const before = router.state.location.pathname;
      const link = within(banner)
        .getAllByRole("link", { name })
        .find((found) => found.closest(".site-menu") === null);
      if (link === undefined) throw new Error(`no ${name} in the row`);
      fireEvent.click(link);
      const after = router.state.location.pathname;
      return after === before ? "not followed in place" : after;
    },
  };
};

const site = (
  surface: Surface,
  { visitor = GUEST, current }: { visitor?: Visitor; current?: Current } = {},
) =>
  drawnOn(
    surface,
    <SiteHeader surface={surface} link={Link} current={current} visitor={visitor} />,
  );

const work = ({
  current = "dashboard",
  visitor = MERCHANT,
  mark,
}: {
  current?: "dashboard" | "admin";
  visitor?: Extract<Visitor, { status: "signed_in" }>;
  mark?: ReactElement;
} = {}) =>
  drawnOn(
    "dashboard",
    <WorkHeader
      surface="dashboard"
      link={Link}
      current={current}
      visitor={visitor}
      mark={mark}
      contents={
        <nav>
          <a href="/dashboard/orders">Orders</a>
          <a href="/dashboard/settings">Settings</a>
        </nav>
      }
    />,
  );

describe("the site header", () => {
  it("offers the scanner and selling to agents, and leads to the documentation and the dashboard", () => {
    const header = site("scanner");

    expect(
      header
        .row()
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")]),
    ).toStrictEqual([
      ["Skip to content", "#main"],
      ["Agentify", "/"],
      ["Scanner", "/"],
      ["Sell to agents", "/agentic-shop"],
      ["Docs", "/docs/"],
      ["Dashboard", "/dashboard/sign-in"],
    ]);
  });

  it("follows the scanner's own pages in place on the scanner, and loads the dashboard and the documentation whole", () => {
    const header = site("scanner");

    expect(header.afterClicking("Sell to agents")).toBe("/agentic-shop");
    expect(header.afterClicking("Dashboard")).toBe("not followed in place");
    expect(header.afterClicking("Docs")).toBe("not followed in place");
  });

  it("leads straight into the dashboard from inside it, and loads the scanner's pages whole", () => {
    const header = site("dashboard", { current: "dashboard" });

    expect(header.href("Dashboard")).toBe("/dashboard");
    expect(header.afterClicking("Dashboard")).toBe("/dashboard");
    for (const [name, href] of [
      ["Agentify", "/"],
      ["Scanner", "/"],
      ["Sell to agents", "/agentic-shop"],
      ["Docs", "/docs/"],
    ] as const) {
      expect(header.href(name), name).toBe(href);
      expect(header.afterClicking(name), name).toBe("not followed in place");
    }
  });

  it("follows the documentation's own pages in place inside it, and leads to the dashboard's sign-in", () => {
    const header = site("docs", { current: "docs" });

    expect(header.afterClicking("Docs")).toBe("/docs");
    expect(header.href("Dashboard")).toBe("/dashboard/sign-in");
    expect(header.afterClicking("Dashboard")).toBe("not followed in place");
    expect(header.afterClicking("Scanner")).toBe("not followed in place");
  });

  it.each([
    ["scanner", "scanner", "Scanner"],
    ["scanner", "sell", "Sell to agents"],
    ["docs", "docs", "Docs"],
    ["dashboard", "dashboard", "Dashboard"],
  ] as const)(
    "on the %s, marks %s as where the page is, and nothing else",
    (surface, current, name) => {
      expect(site(surface, { current }).marked()).toStrictEqual([name]);
    },
  );

  it("marks nothing on a page of none of the parts, such as the privacy pages", () => {
    expect(site("scanner").marked()).toStrictEqual([]);
  });

  it("puts the way past it first, to the page's main part", () => {
    const { banner } = site("scanner");

    const first = banner.querySelector("a, button, summary");
    expect(first?.textContent).toBe("Skip to content");
    expect(first?.getAttribute("href")).toBe("#main");
  });
});

describe("who is visiting, in the bar", () => {
  it.each([
    ["a stranger", GUEST],
    ["somebody the surface is still asking about", { status: "loading" } as const],
  ])("shows %s the documentation and the dashboard, and no account", (_, visitor) => {
    const header = site("scanner", { visitor });

    expect(header.row().getByRole("link", { name: "Docs" })).toBeTruthy();
    expect(header.row().getByRole("link", { name: "Dashboard" })).toBeTruthy();
    expect(header.banner.querySelector(".site-account, form")).toBeNull();
    expect(header.row().queryByText(/sign-in unknown/i)).toBeNull();
  });

  it("names the signed-in address on the account's menu, which holds the settings and a sign-out that posts", () => {
    const header = site("scanner", { visitor: MERCHANT });

    const account = header.banner.querySelector<HTMLDetailsElement>(".site-account");
    if (account === null) throw new Error("no account menu for somebody signed in");
    const button = account.querySelector("summary");
    expect(button?.textContent).toBe(PERSON);
    const panel = within(account);
    expect(panel.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe(
      "/dashboard/settings",
    );
    const signOut = panel.getByRole("button", { name: "Sign out" }).closest("form");
    expect(signOut?.getAttribute("method")).toBe("post");
    expect(signOut?.getAttribute("action")).toBe("/dashboard/sign-out");
  });

  it("posts the sign-out to the dashboard under the prefix it is deployed at, from inside it", () => {
    const header = site("dashboard", { visitor: MERCHANT, current: "dashboard" });

    for (const form of header.banner.querySelectorAll("form")) {
      expect(form.getAttribute("action")).toBe("/dashboard/sign-out");
    }
  });

  it("says it does not know who is signed in, apart from nobody being signed in", () => {
    const header = site("scanner", { visitor: { status: "unknown" } });

    expect(header.row().getByText(/sign-in unknown/i)).toBeTruthy();
    expect(header.banner.querySelector("form")).toBeNull();
  });

  it("shows an operator the way to the operator's workspace, and nobody else", () => {
    expect(site("scanner", { visitor: OPERATOR }).href("Admin")).toBe("/dashboard/admin");
    cleanup();
    for (const visitor of [MERCHANT, GUEST, { status: "unknown" } as const]) {
      expect(site("scanner", { visitor }).banner.querySelector('a[href*="admin"]')).toBeNull();
      cleanup();
    }
  });
});

describe("the menu of a narrow window", () => {
  it("holds what the site offers and, under the documentation's contents, who is signed in with the way out", () => {
    const header = drawnOn(
      "docs",
      <SiteHeader
        surface="docs"
        link={Link}
        current="docs"
        visitor={OPERATOR}
        contents={<a href="/docs/money">Money</a>}
      />,
    );
    const menu = header.menu();

    expect(menu.getByRole("link", { name: "Money" })).toBeTruthy();
    expect(menu.getByRole("link", { name: "Scanner" }).getAttribute("href")).toBe("/");
    expect(menu.getByRole("link", { name: "Sell to agents" }).getAttribute("href")).toBe(
      "/agentic-shop",
    );
    expect(menu.getByRole("link", { name: "Admin" }).getAttribute("href")).toBe("/dashboard/admin");
    expect(menu.getByText(PERSON)).toBeTruthy();
    expect(menu.getByRole("link", { name: "Settings" })).toBeTruthy();
    expect(menu.getByRole("button", { name: "Sign out" }).closest("form")?.method).toBe("post");
  });

  it("gives the sign-in pages the menu as well, with what the site offers", () => {
    const header = site("dashboard", { current: "dashboard" });

    expect(header.menu().getByRole("link", { name: "Sell to agents" })).toBeTruthy();
  });

  it("names a stranger no account", () => {
    const header = site("scanner");

    expect(header.menu().queryByRole("button", { name: "Sign out" })).toBeNull();
  });
});

describe("the working header", () => {
  it("offers none of the public site's offers, and keeps the documentation, the dashboard, marked, and the account", () => {
    const header = work();

    for (const name of ["Scanner", "Sell to agents"]) {
      expect(header.row().queryByRole("link", { name }), name).toBeNull();
    }
    expect(header.href("Docs")).toBe("/docs/");
    expect(header.marked()).toStrictEqual(["Dashboard"]);
    expect(header.banner.querySelector(".site-account summary")?.textContent).toBe(PERSON);
  });

  it("lists the seller dashboard's sections in its menu, and its settings once, among them", () => {
    const header = work();
    const menu = header.menu();

    expect(menu.getByRole("link", { name: "Orders" })).toBeTruthy();
    expect(menu.getAllByRole("link", { name: "Settings" })).toHaveLength(1);
    expect(menu.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("gives an operator in the workspace the way back to the seller dashboard, the workspace marked", () => {
    const header = work({
      current: "admin",
      visitor: OPERATOR,
      mark: <span className="op-mark">Operator</span>,
    });

    expect(header.marked()).toStrictEqual(["Admin"]);
    expect(header.afterClicking("Dashboard")).toBe("/dashboard");
    // The mark takes the narrow row's room, so the menu holds every door.
    for (const name of ["Docs", "Dashboard", "Admin"]) {
      expect(header.menu().getByRole("link", { name }), name).toBeTruthy();
    }
    const account = header.banner.querySelector<HTMLElement>(".site-menu-account");
    if (account === null) throw new Error("the menu names nobody signed in");
    expect(within(account).getByRole("link", { name: "Settings" })).toBeTruthy();
  });

  it("draws a workspace's mark beside the lockup, outside its link", () => {
    // The operator's workspace tells itself from a merchant's dashboard by this
    // mark; inside the lockup's link it would rename the way to the front page.
    const header = work({ current: "admin", visitor: OPERATOR, mark: <span>Operator</span> });
    const lockup = within(header.banner).getByRole("link", { name: "Agentify" });
    const mark = within(header.banner).getByText("Operator");

    expect(lockup.contains(mark)).toBe(false);
    expect(lockup.nextElementSibling).toBe(mark);
  });
});

/** The parts link through the router, so they are drawn inside one. */
const inRouter = (element: () => ReactElement) => {
  const Stub = createRoutesStub([{ path: "*", Component: element }]);
  return render(<Stub initialEntries={["/orders"]} />);
};

describe("the sections", () => {
  it("names the one on screen as current and links every other", () => {
    inRouter(() => (
      <SectionNav
        label="Dashboard sections"
        sections={[
          { key: "cards", label: "Cards", to: "/cards" },
          { key: "orders", label: "Orders", to: "/orders", current: true },
          { key: "settings", label: "Settings", href: "/dashboard/settings" },
        ]}
      />
    ));
    const nav = screen.getByRole("navigation", { name: "Dashboard sections" });

    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe("Orders");
    expect(screen.getByText("Orders").closest("a")).toBeNull();
    expect(screen.getByText("Cards").closest("a")?.getAttribute("href")).toBe("/cards");
    expect(screen.getByText("Settings").closest("a")?.getAttribute("href")).toBe(
      "/dashboard/settings",
    );
  });
});
