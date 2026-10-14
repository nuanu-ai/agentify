// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { createMemoryRouter, createRoutesStub, Link, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SectionNav, SignedIn, SiteHeader, type Surface } from "./header.js";

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

/** The header as a surface mounted where it is deployed draws it, on one of its pages. */
const headerOn = (surface: Surface) => {
  const basename = { scanner: "/", dashboard: "/dashboard", docs: "/docs" }[surface];
  const start = { scanner: "/privacy", dashboard: "/dashboard/cards", docs: "/docs/money" }[
    surface
  ];
  const router = createMemoryRouter(
    [{ path: "*", element: <SiteHeader surface={surface} link={Link} /> }],
    { basename, initialEntries: [start] },
  );
  render(<RouterProvider router={router} />);
  const header = within(screen.getByRole("banner"));
  return {
    href: (name: string) => header.getByRole("link", { name }).getAttribute("href"),
    /** Whether the link is marked as the part of the site the page belongs to. */
    current: (name: string) => header.getByRole("link", { name }).hasAttribute("aria-current"),
    /** Where the router is after a click on the link, or the page it was on. */
    afterClicking: (name: string) => {
      const before = router.state.location.pathname;
      fireEvent.click(header.getByRole("link", { name }));
      const after = router.state.location.pathname;
      return after === before ? "not followed in place" : after;
    },
  };
};

describe("the site header", () => {
  it("follows the scanner's own pages in place on the scanner, and loads the dashboard whole", () => {
    const header = headerOn("scanner");

    expect(header.href("Dashboard")).toBe("/dashboard/sign-in");
    expect(header.current("Dashboard")).toBe(false);
    expect(header.afterClicking("Dashboard")).toBe("not followed in place");
    expect(header.href("Docs")).toBe("/docs/");
    expect(header.afterClicking("Docs")).toBe("not followed in place");
    expect(header.afterClicking("Sell to agents")).toBe("/agentic-shop");
  });

  it("leads straight into the dashboard from inside it, marked as where the page is, and loads the scanner's pages whole", () => {
    const header = headerOn("dashboard");

    expect(header.href("Dashboard")).toBe("/dashboard");
    expect(header.current("Dashboard")).toBe(true);
    expect(header.afterClicking("Dashboard")).toBe("/dashboard");
    for (const [name, href] of [
      ["Agentify", "/"],
      ["Sell to agents", "/agentic-shop"],
      ["Scanner", "/scanner"],
      ["Methodology", "/methodology"],
      ["Privacy", "/privacy"],
      ["Docs", "/docs/"],
    ] as const) {
      expect(header.href(name), name).toBe(href);
      expect(header.afterClicking(name), name).toBe("not followed in place");
    }
  });

  it("follows the documentation's own pages in place inside it, marked as where the page is, and leads to the dashboard's sign-in", () => {
    const header = headerOn("docs");

    expect(header.href("Docs")).toBe("/docs");
    expect(header.current("Docs")).toBe(true);
    expect(header.afterClicking("Docs")).toBe("/docs");
    expect(header.href("Dashboard")).toBe("/dashboard/sign-in");
    expect(header.current("Dashboard")).toBe(false);
    expect(header.afterClicking("Dashboard")).toBe("not followed in place");
    expect(header.afterClicking("Agentify")).toBe("not followed in place");
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

describe("who is signed in", () => {
  it("shows the whole address and a sign-out that posts", () => {
    const { container } = inRouter(() => (
      <SignedIn
        who="a-rather-long-address@example.com"
        account="/dashboard/settings"
        signOut="/sign-out"
      />
    ));

    const address = screen.getByText("a-rather-long-address@example.com");
    expect(address.getAttribute("title")).toBe("a-rather-long-address@example.com");
    expect(address.getAttribute("href")).toBe("/dashboard/settings");
    const form = container.querySelector("form");
    expect(form?.getAttribute("method")).toBe("post");
    expect(form?.getAttribute("action")).toBe("/sign-out");
    expect(form?.textContent).toBe("Sign out");
  });
});
