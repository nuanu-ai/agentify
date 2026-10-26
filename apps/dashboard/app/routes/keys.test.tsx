// @vitest-environment jsdom

/**
 * The keys page where script runs: React Router sends the press itself and
 * draws the page from its answer, so this is the path a merchant with a
 * working browser takes, run in a document, with its history. The page's
 * server half is the real one over a stand-in gateway client, whose list can
 * stop answering the moment a key is issued: the one case where reading the
 * list after a press would cost the merchant the only showing of a secret.
 */

import type { MerchantKey } from "@agentify/gateway";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRoutesStub, Outlet, RouterContextProvider, useNavigate } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import type { GatewayClient } from "../../src/gateway.js";
import { identityFor } from "../../src/identity.js";
import { pageServicesFor } from "../../src/page-services.js";
import { TEST_AUTH_SECRET } from "../../src/testing/secrets.js";
import { chromeOf } from "../answer.js";
import { ErrorBoundary } from "../root.js";
import { services, signedIn } from "../services.js";
import { shouldRevalidate as gateShouldRevalidate } from "./gate.js";
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
  AUTH_SECRET: TEST_AUTH_SECRET,
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
 * once a key is issued. The gate's loader stands for the gate as a whole: a
 * request it answers after the press could find the session gone or the
 * sign-in store not answering.
 */
const keysPage = ({
  listAfterIssue = "fails",
  gateAfterIssue = "answers",
}: {
  listAfterIssue?: "fails" | "answers";
  gateAfterIssue?: "fails" | "answers";
} = {}) => {
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
    registrar: {
      register: () => {
        throw new Error("the keys make no merchant");
      },
    },
    woo: null,
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
          loader: () => {
            if (issued && gateAfterIssue === "fails") {
              throw new Error("the sign-in store did not answer");
            }
            return { who: PERSON };
          },
          shouldRevalidate: gateShouldRevalidate,
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
  fireEvent.change(await screen.findByLabelText("Key name"), {
    target: { value: "the second worker" },
  });
  fireEvent.click(screen.getByText("Create key"));
  expect(await screen.findByText(SECRET)).toBeTruthy();
};

describe("issuing a key where the page's script runs", () => {
  it("shows the secret even when the list cannot be read right after the press", async () => {
    keysPage();

    await issue();

    expect(screen.queryByText("Something went wrong")).toBeNull();
  });

  it("shows the secret even when the gate could not answer right after the press", async () => {
    // The press was drawn for the address signed in, so nothing after it
    // needs the gate asked again before the one showing of the secret.
    keysPage({ listAfterIssue: "answers", gateAfterIssue: "fails" });

    await issue();

    expect(screen.queryByText("Something went wrong")).toBeNull();
  });

  it("goes Back from the new key to the list it was issued from, without the secret", async () => {
    keysPage({ listAfterIssue: "answers" });
    await issue();

    fireEvent.click(screen.getByText("Browser back"));

    expect(await screen.findByText("Create key")).toBeTruthy();
    expect(screen.queryByText("The cards page")).toBeNull();
    expect(screen.queryByText(SECRET)).toBeNull();
  });

  it("takes the secret off a page the browser keeps for Back and Forward, and draws the list when it is brought back", async () => {
    // A browser may keep a page it leaves whole, and show it again as it was.
    // It freezes the page as soon as the event's listeners return, so the
    // secret must be gone by then, not at React's next turn.
    keysPage({ listAfterIssue: "answers" });
    await issue();

    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    expect(document.body.textContent).not.toContain(SECRET);

    act(() => {
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    expect(await screen.findByText("Create key")).toBeTruthy();
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("takes the secret off a page left the moment the secret is drawn", async () => {
    // React runs a page's ordinary effects a turn after it draws, and a browser
    // may leave the page inside that turn: here it is left as soon as the
    // secret is on it.
    keysPage({ listAfterIssue: "answers" });
    let keptWithTheSecret: boolean | undefined;
    const leaveOnSight = new MutationObserver(() => {
      if (keptWithTheSecret !== undefined || !document.body.textContent?.includes(SECRET)) return;
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      keptWithTheSecret = document.body.textContent.includes(SECRET);
    });
    leaveOnSight.observe(document.body, { characterData: true, childList: true, subtree: true });

    fireEvent.change(await screen.findByLabelText("Key name"), {
      target: { value: "the second worker" },
    });
    fireEvent.click(screen.getByText("Create key"));
    await screen.findByText(/the key for “the second worker”/);
    leaveOnSight.disconnect();

    expect(keptWithTheSecret).toBe(false);
  });
});
