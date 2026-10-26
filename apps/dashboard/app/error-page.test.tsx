// @vitest-environment jsdom

/**
 * The dashboard's own error page for a failure nobody named, such as a page
 * that broke while it was drawn: it does not say a change was made or lost,
 * and its way on is a screen to look at, never another section's.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { createRoutesStub, Outlet, RouterContextProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { identityFor } from "../src/identity.js";
import { pageServicesFor } from "../src/page-services.js";
import { TEST_AUTH_SECRET } from "../src/testing/secrets.js";
import { chromeOf } from "./answer.js";
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
