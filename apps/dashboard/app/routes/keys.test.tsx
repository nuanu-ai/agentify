// @vitest-environment jsdom

/**
 * The keys page where script runs: React Router sends the press itself and
 * draws the page from its answer, so this is the path a merchant with a
 * working browser takes, run in a document, with its history. The page's
 * server half is the real one over a stand-in gateway client, whose list can
 * stop answering the moment a key is issued: the one case where reading the
 * list after a press would cost the merchant the only showing of a secret.
 */

import type { MerchantKey } from "@nuanu-ai/agentify-contracts";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRoutesStub, Outlet, RouterContextProvider, useNavigate } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import type { GatewayClient } from "../../src/gateway.js";
import { identityFor } from "../../src/identity.js";
import { pageServicesFor } from "../../src/page-services.js";
import { chromeOf } from "../answer.js";
import { ErrorBoundary } from "../root.js";
import { services, signedIn } from "../services.js";
import Keys, { action, loader, shouldRevalidate } from "./keys.js";

const PERSON = "owner@example.com";
const SECRET = "csk_test_the-secret-shown-once";
const NIGHTLY: MerchantKey = {
  id: "key_the_nightly_job",
  label: "the nightly job",
  created_at: "2026-08-20T09:00:00.000Z",
  last_used_at: null,
  disabled_at: null,
};

const config = loadConfig({
  DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
  AUTH_SECRET: "a-secret-that-is-at-least-32-characters-long",
  PAYMENT_NETWORK: "eip155:84532",
  FACILITATOR_URL: "sandbox:scripted",
});

afterEach(cleanup);

/** Stands for the browser's Back button, which a memory router has none of. */
function Shell() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => void navigate(-1)}>
        Browser back
      </button>
      <Outlet />
    </>
  );
}

/**
 * The page inside the root and the gate it is drawn under, as the build nests
 * it, opened from the cards. Unless told otherwise, the list stops answering
 * once a key is issued.
 */
const keysPage = ({ listAfterIssue = "fails" }: { listAfterIssue?: "fails" | "answers" } = {}) => {
  let issued = false;
  const client = {
    keys: async () =>
      issued && listAfterIssue === "fails"
        ? { ok: false as const, status: 0, why: "the gateway did not answer in time" }
        : { ok: true as const, document: [NIGHTLY] },
    issueKey: async (label: string) => {
      issued = true;
      return {
        ok: true as const,
        document: { key: { ...NIGHTLY, id: "key_the_new_one", label }, secret: SECRET },
      };
    },
  } as unknown as GatewayClient;
  const pages = pageServicesFor(config, {
    identity: identityFor(config, { postman: async () => "accepted" }),
    clientFor: () => client,
    wooOffered: false,
  });
  // A request of its own each time, as the server gives every call.
  const asked = () =>
    new RouterContextProvider(
      new Map<unknown, unknown>([
        [services, pages],
        [signedIn, { id: "acc_1", email: PERSON, confirmed: true, merchant: { id: "mer_1" } }],
      ]) as never,
    );
  const Stub = createRoutesStub([
    {
      id: "root",
      path: "/",
      loader: () => chromeOf(asked()),
      Component: Shell,
      ErrorBoundary,
      children: [
        { path: "cards", Component: () => <p>The cards page</p> },
        {
          id: "routes/gate",
          loader: () => ({ who: PERSON }),
          Component: Outlet,
          children: [
            {
              id: "routes/keys",
              path: "keys",
              loader: (args) => loader({ ...args, context: asked() } as never),
              action: (args) => action({ ...args, context: asked() } as never),
              shouldRevalidate,
              Component: Keys,
            },
          ],
        },
      ],
    },
  ]);
  return render(<Stub initialEntries={["/cards", "/keys"]} initialIndex={1} />);
};

/** Names a key and presses Issue, as a merchant does. */
const issue = async () => {
  fireEvent.change(await screen.findByLabelText("What this key is for"), {
    target: { value: "the second worker" },
  });
  fireEvent.click(screen.getByText("Issue a key"));
  expect(await screen.findByText(SECRET)).toBeTruthy();
};

describe("issuing a key where the page's script runs", () => {
  it("shows the secret even when the list cannot be read right after the press", async () => {
    keysPage();

    await issue();

    expect(screen.queryByText("Something went wrong")).toBeNull();
  });

  it("goes Back from the new key to the list it was issued from, without the secret", async () => {
    keysPage({ listAfterIssue: "answers" });
    await issue();

    fireEvent.click(screen.getByText("Browser back"));

    expect(await screen.findByText("Issue a key")).toBeTruthy();
    expect(screen.queryByText("The cards page")).toBeNull();
    expect(screen.queryByText(SECRET)).toBeNull();
  });

  it("takes the secret off a page the browser keeps for Back and Forward, and draws the list when it is brought back", async () => {
    // A browser may keep a page it leaves whole, and show it again as it was.
    keysPage({ listAfterIssue: "answers" });
    await issue();

    act(() => {
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    });
    expect(document.body.textContent).not.toContain(SECRET);

    act(() => {
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    expect(await screen.findByText("Issue a key")).toBeTruthy();
    expect(document.body.textContent).not.toContain(SECRET);
  });
});
