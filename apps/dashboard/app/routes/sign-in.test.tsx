// @vitest-environment jsdom

/**
 * The sign-in page where script runs: React Router sends the press for a link
 * itself and draws the page from its answer. The page's server half is the
 * real one over the sign-in component's memory store.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRoutesStub, Outlet, RouterContextProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { identityFor } from "../../src/identity.js";
import { pageServicesFor } from "../../src/page-services.js";
import { TEST_AUTH_SECRET } from "../../src/testing/secrets.js";
import { chromeOf } from "../answer.js";
import { ErrorBoundary } from "../root.js";
import { services } from "../services.js";
import SignIn, { action, loader, shouldRevalidate } from "./sign-in.js";

const config = loadConfig({
  DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
  AUTH_SECRET: TEST_AUTH_SECRET,
  PAYMENT_NETWORK: "eip155:84532",
  FACILITATOR_URL: "sandbox:scripted",
});

afterEach(cleanup);

describe("asking for a sign-in link where the page's script runs", () => {
  it("answers the press with the page alone and does not read the page again after it", async () => {
    // A read after the press would be a second visit to the page in the
    // product's analytics, and a request the page does not need.
    const pages = pageServicesFor(config, {
      identity: identityFor(config, { postman: async () => "accepted" }),
      clientFor: () => {
        throw new Error("signing in asks the gateway nothing");
      },
      registrar: {
        register: () => {
          throw new Error("signing in makes no merchant");
        },
      },
      woo: null,
    });
    const asked = () => new RouterContextProvider(new Map([[services, pages]]) as never);
    let reads = 0;
    const Stub = createRoutesStub([
      {
        id: "root",
        path: "/",
        loader: () => chromeOf(asked()),
        Component: Outlet,
        ErrorBoundary,
        children: [
          {
            id: "routes/sign-in",
            path: "sign-in",
            loader: (args) => {
              reads += 1;
              return loader({ ...args, context: asked() } as never);
            },
            action: (args) => action({ ...args, context: asked() } as never),
            shouldRevalidate,
            Component: SignIn,
          },
        ],
      },
    ]);
    render(<Stub initialEntries={["/sign-in"]} />);

    fireEvent.change(await screen.findByLabelText("Email address"), {
      target: { value: "person@example.com" },
    });
    fireEvent.click(screen.getByText("Send me a sign-in link"));

    expect(await screen.findByText(/person@example\.com/)).toBeTruthy();
    expect(reads).toBe(1);
  });
});
