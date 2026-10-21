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

describe("the count above the key list", () => {
  it("counts the keys that work among the rows below, in the number it names", () => {
    expect(listed([key("key_a", false), key("key_b", false), key("key_c", true)])).toContain(
      "2 of the 3 keys below work.",
    );
    expect(listed([key("key_a", false)])).toContain("1 of the 1 key below works.");
    expect(listed([key("key_a", true), key("key_b", true)])).toContain(
      "0 of the 2 keys below work.",
    );
  });

  it("says what the list is for a merchant with no key, rather than counting nothing", () => {
    const empty = listed([]);

    expect(empty).toContain("You haven't created any API keys yet.");
    expect(empty).toContain("Your code uses these keys to connect to Agentify.");
    expect(empty).not.toMatch(/\b0 of the 0\b/);
    // The notes explain rows, and there are none.
    expect(empty).not.toContain("A revoked key stops working");
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
