// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { createMemoryRouter, createRoutesStub, Link, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SectionNav, SignedIn, SiteHeader, type Surface, WorkHeader } from "./header.js";
import { HeaderMenu } from "./menu.js";

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
  it("follows the scanner's own pages in place on the scanner, and loads the dashboard and the documentation whole", () => {
    const header = headerOn("scanner");

    expect(header.href("Dashboard")).toBe("/dashboard/sign-in");
    expect(header.current("Dashboard")).toBe(false);
    expect(header.afterClicking("Dashboard")).toBe("not followed in place");
    expect(header.href("Docs")).toBe("/docs/");
    expect(header.afterClicking("Docs")).toBe("not followed in place");
    expect(header.afterClicking("Sell to agents")).toBe("/agentic-shop");
    expect(header.href("Scanner")).toBe("/docs/scanner");
    expect(header.afterClicking("Scanner")).toBe("not followed in place");
    expect(header.href("Methodology")).toBe("/docs/scanner/methodology");
  });

  it("leads straight into the dashboard from inside it, marked as where the page is, and loads the scanner's pages whole", () => {
    const header = headerOn("dashboard");

    expect(header.href("Dashboard")).toBe("/dashboard");
    expect(header.current("Dashboard")).toBe(true);
    expect(header.afterClicking("Dashboard")).toBe("/dashboard");
    for (const [name, href] of [
      ["Agentify", "/"],
      ["Sell to agents", "/agentic-shop"],
      ["Scanner", "/docs/scanner"],
      ["Methodology", "/docs/scanner/methodology"],
      ["Privacy", "/privacy"],
      ["Docs", "/docs/"],
    ] as const) {
      expect(header.href(name), name).toBe(href);
      expect(header.afterClicking(name), name).toBe("not followed in place");
    }
  });

  it("follows the documentation's own pages, the scanner's section among them, in place inside it, marked as where the page is, and leads to the dashboard's sign-in", () => {
    const header = headerOn("docs");

    expect(header.href("Docs")).toBe("/docs");
    expect(header.current("Docs")).toBe(true);
    expect(header.afterClicking("Docs")).toBe("/docs");
    expect(header.href("Dashboard")).toBe("/dashboard/sign-in");
    expect(header.current("Dashboard")).toBe(false);
    expect(header.afterClicking("Dashboard")).toBe("not followed in place");
    expect(header.afterClicking("Agentify")).toBe("not followed in place");
    expect(header.afterClicking("Scanner")).toBe("/docs/scanner");
    expect(header.afterClicking("Methodology")).toBe("/docs/scanner/methodology");
    expect(header.afterClicking("Privacy")).toBe("not followed in place");
  });
});

describe("the working header", () => {
  const PERSON = "owner@example.com";

  /** As the dashboard draws it over one of its pages, under the prefix it is deployed at. */
  const workHeader = (mark?: ReactElement) => {
    const router = createMemoryRouter(
      [
        {
          path: "*",
          element: (
            <WorkHeader
              surface="dashboard"
              link={Link}
              {...(mark === undefined ? {} : { mark })}
              visitor={<SignedIn who={PERSON} account="/dashboard/settings" signOut="/sign-out" />}
              menu={
                <HeaderMenu>
                  <a href="/dashboard/orders">Orders</a>
                </HeaderMenu>
              }
            />
          ),
        },
      ],
      { basename: "/dashboard", initialEntries: ["/dashboard/cards"] },
    );
    render(<RouterProvider router={router} />);
    const banner = screen.getByRole("banner");
    return { banner, header: within(banner), router };
  };

  it("leads to the front page and the documentation, loading them whole, and names who is signed in with the way out", () => {
    const { header, router } = workHeader();

    for (const [name, href] of [
      ["Agentify", "/"],
      ["Docs", "/docs/"],
      [PERSON, "/dashboard/settings"],
    ] as const) {
      expect(header.getByRole("link", { name }).getAttribute("href"), name).toBe(href);
    }
    fireEvent.click(header.getByRole("link", { name: "Docs" }));
    fireEvent.click(header.getByRole("link", { name: "Agentify" }));
    expect(router.state.location.pathname).toBe("/dashboard/cards");
    expect(header.getByRole("button", { name: "Sign out" }).closest("form")?.method).toBe("post");
  });

  it("draws a workspace's mark beside the lockup, outside its link, and none where it is given none", () => {
    // The operator's workspace tells itself from a merchant's dashboard by this
    // mark; inside the lockup's link it would rename the way to the front page.
    const marked = workHeader(<span>Operator</span>);
    const lockup = marked.header.getByRole("link", { name: "Agentify" });
    const mark = marked.header.getByText("Operator");

    expect(lockup.contains(mark)).toBe(false);
    expect(lockup.nextElementSibling).toBe(mark);
    cleanup();

    const { header } = workHeader();
    expect(header.queryByText("Operator")).toBeNull();
    expect(header.getByRole("link", { name: "Agentify" }).parentElement?.className).toContain(
      "site-header-inner",
    );
  });

  it("names none of the public site's sections and no door to the dashboard", () => {
    const { header } = workHeader();

    for (const name of ["Sell to agents", "Scanner", "Methodology", "Privacy", "Dashboard"]) {
      expect(header.queryByRole("link", { name }), name).toBeNull();
    }
  });

  it("puts the way past it first, to the page's main part", () => {
    const { banner } = workHeader();

    const first = banner.querySelector("a, button, summary");
    expect(first?.textContent).toBe("Skip to content");
    expect(first?.getAttribute("href")).toBe("#main");
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
