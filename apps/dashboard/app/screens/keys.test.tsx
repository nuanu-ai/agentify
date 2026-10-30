// @vitest-environment jsdom

/**
 * The keys screens drawn from views built by the real view functions: what the
 * empty state offers, and the copy button on the one page a secret is
 * shown on, which works only where the page's script runs and so is pressed in
 * a document here.
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { keysView, newKeyView } from "../../src/keys.js";
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

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("the line above the key list", () => {
  it("tells a merchant with no key that there is none, once, and why their code needs one", () => {
    render(routed(() => <KeysScreen view={keysView([])} />));
    expect(screen.getByText(/no keys yet/i)).toBeTruthy();
    expect(screen.getByText(/code needs a key/i)).toBeTruthy();
    expect(screen.queryAllByRole("listitem")).toEqual([]);
    const create = screen.queryByRole("button", {
      name: /create key/i,
    }) as HTMLButtonElement | null;
    expect(create).not.toBeNull();
    expect(create?.disabled).toBe(false);
    expect(create?.form?.getAttribute("action")).toBe("/keys");
    expect(create?.form?.getAttribute("method")).toBe("post");
    expect(screen.getByRole("textbox", { name: /key name/i })).toBeTruthy();
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
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    });

    expect(held).toBe(SECRET);
    expect(screen.getByRole("status").textContent).toBe("Copied.");
  });

  it("says to select the key by hand where the browser will not copy", async () => {
    // No clipboard at all is what a browser offers a page on plain http.
    shown();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    });

    expect(screen.getByRole("status").textContent).toMatch(/couldn.t copy.*select.*key/i);
    expect(screen.getByDisplayValue(SECRET)).toBeTruthy();
  });
});
