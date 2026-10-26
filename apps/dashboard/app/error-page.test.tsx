// @vitest-environment jsdom

/**
 * The dashboard's own error page for a failure nobody named, such as a page
 * that broke while it was drawn: it does not say a change was made or lost,
 * and its way on is a screen to look at, never another section's.
 */

import { SURFACE_MARKER_ATTRIBUTE, SURFACE_WORDS } from "@agentify/ui/surface";
import { cleanup, render, screen } from "@testing-library/react";
import { createRoutesStub, data, Outlet, RouterContextProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { identityFor } from "../src/identity.js";
import { pageServicesFor } from "../src/page-services.js";
import { TEST_AUTH_SECRET } from "../src/testing/secrets.js";
import { type Chrome, chromeOf, type Trouble } from "./answer.js";
import { ErrorBoundary } from "./root.js";
import { services } from "./services.js";

const config = loadConfig({
  DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
  AUTH_SECRET: TEST_AUTH_SECRET,
  PAYMENT_NETWORK: "eip155:84532",
  FACILITATOR_URL: "sandbox:scripted",
});

afterEach(cleanup);

describe("a page that failed for a reason nobody named", () => {
  it("says it could not be shown, asks a person who pressed something to look first, and leads to the dashboard's start rather than to Cards", async () => {
    const pages = pageServicesFor(config, {
      identity: identityFor(config, { postman: async () => "accepted" }),
      clientFor: () => {
        throw new Error("this page asks the gateway nothing");
      },
      registrar: {
        register: () => {
          throw new Error("this page makes no merchant");
        },
      },
      woo: null,
    });
    const Stub = createRoutesStub([
      {
        id: "root",
        path: "/",
        loader: () => chromeOf(new RouterContextProvider(new Map([[services, pages]]) as never)),
        Component: Outlet,
        ErrorBoundary,
        children: [
          {
            id: "routes/sign-in",
            path: "sign-in",
            loader: () => {
              throw new Error("the page broke while it was drawn");
            },
          },
        ],
      },
    ]);

    render(<Stub initialEntries={["/sign-in?destination=%2Freport"]} />);
    const way = await screen.findByRole("link", { name: "Open the dashboard" });

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "This page could not be shown",
    );
    expect(document.body.textContent).toContain("If you pressed a button, check the dashboard");
    expect(document.body.textContent).not.toMatch(/went through|may or may not/);
    expect(way.getAttribute("href")).toBe("/");
    expect(screen.queryByRole("link", { name: /Cards|Products/ })).toBeNull();
  });
});

/** The root's error page for what a request at `path` failed with. */
const failedWith = async (path: string, status: number, trouble: Trouble) => {
  const chrome: Chrome = {
    base: "",
    surface: { attribute: SURFACE_MARKER_ATTRIBUTE, mode: "live", words: SURFACE_WORDS.live },
  };
  const Stub = createRoutesStub([
    {
      id: "root",
      path: "/",
      loader: () => chrome,
      Component: Outlet,
      ErrorBoundary,
      children: [
        {
          id: "routes/page",
          path: "*",
          loader: () => {
            throw data(trouble, { status });
          },
        },
      ],
    },
  ]);
  render(<Stub initialEntries={[path]} />);
  const heading = await screen.findByRole("heading", { level: 1 });
  const way = screen.getAllByRole("link").filter((link) => link.className.includes("button"));
  return {
    title: heading.textContent,
    said: heading.nextElementSibling?.textContent ?? "",
    ways: way.map((link) => [link.textContent, link.getAttribute("href")]),
  };
};

describe("the error page after a failed request", () => {
  it("names the screen a press on a filtered list came from, and leads back to the list as it was", async () => {
    const page = await failedWith("/products?q=room", 500, {
      kind: "unanswered",
      reopen: "/products?q=room&page=2",
    });

    expect(page.title).toBe("We don't know if this was done");
    expect(page.ways).toStrictEqual([["Open Products", "/products?q=room&page=2"]]);
  });

  it("says a read that failed can be tried again, without naming a cause it cannot know", async () => {
    const page = await failedWith("/orders?show=open", 500, {
      kind: "unread",
      again: "/orders?show=open",
    });

    expect(page.title).toBe("This page could not be loaded");
    expect(page.said).toBe("Loading it again changes nothing.");
    expect(page.ways).toStrictEqual([["Try again", "/orders?show=open"]]);
  });

  it("offers no Try again for a read refused in so many words, which would only be refused again", async () => {
    const page = await failedWith("/integrations/woocommerce/recover/ord_1", 404, {
      kind: "problem",
      chrome: {
        base: "",
        surface: { attribute: SURFACE_MARKER_ATTRIBUTE, mode: "live", words: SURFACE_WORDS.live },
      },
      said: "No recoverable WooCommerce order has that id.",
      again: "/integrations/woocommerce/recover/ord_1",
    });

    expect(page.said).toBe("No recoverable WooCommerce order has that id.");
    expect(page.ways.map(([words]) => words)).not.toContain("Try again");
    expect(page.ways).toStrictEqual([["Open Integrations", "/integrations"]]);
  });

  it("titles a refused press by what the server half knows of it, and a fault it does not know about by its status", async () => {
    const chrome: Chrome = {
      base: "",
      surface: { attribute: SURFACE_MARKER_ATTRIBUTE, mode: "live", words: SURFACE_WORDS.live },
    };
    const pressed = (status: number, outcome?: "refused") =>
      failedWith("/settings/payout-wallet", status, {
        kind: "problem",
        chrome,
        said: "The message about this change could not be confirmed as sent, so nothing was recorded",
        reopen: "/settings/payout-wallet",
        ...(outcome === undefined ? {} : { outcome }),
      });

    expect((await pressed(503, "refused")).title).toBe("Nothing was changed");
    cleanup();
    expect((await pressed(500)).title).toBe("We don't know if this was done");
    cleanup();
    expect((await pressed(409)).title).toBe("Nothing was changed");
  });
});
