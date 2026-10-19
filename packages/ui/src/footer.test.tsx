// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, Link, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SiteFooter } from "./footer.js";
import type { Surface } from "./header.js";

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

/** The footer as a surface mounted where it is deployed draws it, on one of its pages. */
const footerOn = (surface: Surface) => {
  const basename = { scanner: "/", dashboard: "/dashboard", docs: "/docs" }[surface];
  const start = { scanner: "/privacy", dashboard: "/dashboard/sign-in", docs: "/docs/money" }[
    surface
  ];
  const router = createMemoryRouter(
    [{ path: "*", element: <SiteFooter surface={surface} link={Link} /> }],
    { basename, initialEntries: [start] },
  );
  render(<RouterProvider router={router} />);
  const footer = within(screen.getByRole("contentinfo"));
  return {
    /** Each link's name and the page it leads to, a trailing slash aside. */
    leadsTo: () =>
      footer
        .getAllByRole("link")
        .map((link) => [
          link.textContent,
          (link.getAttribute("href") ?? "").replace(/(.)\/$/, "$1").replace(/(.)\/#/, "$1#"),
        ]),
    /** Where the router is after a click on the link, or the page it was on. */
    afterClicking: (name: string) => {
      const before = router.state.location.pathname;
      fireEvent.click(footer.getByRole("link", { name }));
      const after = router.state.location.pathname;
      return after === before ? "not followed in place" : after;
    },
  };
};

describe("the site footer", () => {
  it.each(["scanner", "dashboard", "docs"] as const)(
    "leads to the same pages from every surface: %s",
    (surface) => {
      expect(footerOn(surface).leadsTo()).toEqual([
        ["Agentify", "/"],
        ["Sell to agents", "/agentic-shop"],
        ["Docs", "/docs"],
        ["Privacy", "/privacy"],
        ["Terms", "/terms"],
        ["Data request", "/data-request"],
        ["Report abuse", "/docs/scanner#opt-out"],
      ]);
    },
  );

  it("follows the scanner's own pages in place on the scanner, and loads the documentation whole", () => {
    const footer = footerOn("scanner");

    expect(footer.afterClicking("Sell to agents")).toBe("/agentic-shop");
    expect(footer.afterClicking("Data request")).toBe("/data-request");
    expect(footer.afterClicking("Docs")).toBe("not followed in place");
    expect(footer.afterClicking("Report abuse")).toBe("not followed in place");
  });

  it("follows the documentation's own pages in place inside it, and loads the scanner's whole", () => {
    const footer = footerOn("docs");

    expect(footer.afterClicking("Report abuse")).toBe("/docs/scanner");
    expect(footer.afterClicking("Privacy")).toBe("not followed in place");
  });
});
