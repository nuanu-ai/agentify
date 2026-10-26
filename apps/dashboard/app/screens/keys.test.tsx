// @vitest-environment jsdom

/**
 * The keys screens drawn from views built by the real view functions: what the
 * count above the list claims, and the copy button on the one page a secret is
 * shown on, which works only where the page's script runs and so is pressed in
 * a document here.
 */

import type { MerchantKey } from "@agentify/gateway";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { keysView, newKeyView } from "../../src/keys.js";
import { readable } from "../../src/testing/html.js";
import { KeysScreen, NewKeyScreen } from "./keys.js";

const PERSON = "owner@example.com";
const SECRET = "csk_test_the-secret-shown-once";

/** Inside the gate, as the screens are, so a form that posts knows its address. */
const routed = (drawn: () => ReactElement) => {
  const Stub = createRoutesStub([
    { id: "routes/gate", path: "/", children: [{ path: "keys", Component: drawn }] },
  ]);
  return (
    <Stub
      initialEntries={["/keys"]}
      hydrationData={{ loaderData: { "routes/gate": { who: PERSON } } }}
    />
  );
};

const key = (id: string, revoked: boolean): MerchantKey => ({
  id,
  label: `the job behind ${id}`,
  created_at: "2026-08-20T09:00:00.000Z",
  last_used_at: null,
  disabled_at: revoked ? "2026-08-26T17:45:00.000Z" : null,
});

const listed = (keys: readonly MerchantKey[]): string =>
  readable(renderToString(routed(() => <KeysScreen view={keysView(keys)} />)));

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("the line above the key list", () => {
  it("claims no count of working keys, which the rows' own states say", () => {
    expect(listed([key("key_a", false), key("key_b", false), key("key_c", true)])).not.toMatch(
      /\d+ of the \d+/,
    );
  });

  it("tells a merchant with no key that there is none, once, and why their code needs one", () => {
    const empty = listed([]);

    expect(empty.match(/no keys/gi)).toHaveLength(1);
    expect(empty).toMatch(/needs a key/i);
    // The line under the list explains rows, and there are none.
    expect(empty).not.toMatch(/last call/i);
  });
});

describe("the copy button beside a new key", () => {
  const shown = () => render(routed(() => <NewKeyScreen view={newKeyView("a worker", SECRET)} />));

  it("puts the key on the clipboard and says so", async () => {
    let held = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          held = text;
        },
      },
    });
    shown();

    await act(async () => {
      fireEvent.click(screen.getByText("Copy key"));
    });

    expect(held).toBe(SECRET);
    expect(screen.getByRole("status").textContent).toBe("Copied.");
  });

  it("says to select the key by hand where the browser will not copy", async () => {
    // No clipboard at all is what a browser offers a page on plain http.
    shown();

    await act(async () => {
      fireEvent.click(screen.getByText("Copy key"));
    });

    expect(screen.getByRole("status").textContent).toBe("Could not copy. Select the key above.");
    expect(screen.getByText(SECRET)).toBeTruthy();
  });
});
