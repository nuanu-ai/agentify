// @vitest-environment jsdom

/**
 * The gallery's states that only the page's script reaches, a row opened or
 * the header's menu opened, each drawn in a document the way `pnpm gallery`
 * draws it: the page arrives at the words its scene says it shows, and a
 * state that opens the header's menu is drawn with the menu open.
 *
 * The gallery builder checks scene completion; this verifies the menu
 * remains open in the generated document.
 */

import { drawnInBrowser } from "@agentify/gallery/browser";
import { within } from "@testing-library/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ONBOARDING_CASES } from "../src/testing/onboarding-cases.js";
import { gallery } from "./gallery.js";

const scenes = gallery.states.flatMap((state) =>
  state.scene === undefined ? [] : [[state.id, state, state.scene] as const],
);

describe("current selling and connection states in the gallery", () => {
  it.each([
    ["dashboard-cards-out-of-touch", "Off sale"],
    ["dashboard-cards", "On sale"],
  ])("shows the effective product state in %s", async (id, expected) => {
    const state = gallery.states.find((one) => one.id === id);
    if (!state) throw new Error(`the gallery has no state ${id}`);
    const drawn = document.createElement("div");
    drawn.innerHTML = await drawnInBrowser(state, { shows: "Products" }, { act, createRoot });
    const products = within(drawn).getByRole("list", { name: "Products" });

    expect(within(products).getAllByText(expected, { exact: true })).toHaveLength(3);
    expect(drawn.querySelector('form[action*="selling=pause"]')).not.toBeNull();
    expect(drawn.querySelectorAll('form[action*="?pause="]')).toHaveLength(3);
  });

  it.each([
    ["reconnect", "Reconnect required"],
    ["earlier-reconnect", "Connected"],
    ["progress", "Connected"],
  ])("shows the current shop connection beside the %s job", (job, expected) => {
    const id = `dashboard-admin-merchant-shop-job-${job}`;
    const state = gallery.states.find((one) => one.id === id);
    if (!state) throw new Error(`the gallery has no state ${id}`);
    const drawn = document.createElement("div");
    drawn.innerHTML = renderToString(state.draw());
    document.body.replaceChildren(drawn);
    const integration = within(drawn).getByRole("region", { name: "Integration" });

    expect(within(integration).getByText(expected, { exact: true })).toBeTruthy();
  });
});

describe("the dashboard's gallery, in the browser", () => {
  it.each(["dashboard-cards-menu"])("draws the header's menu open in %s", async (id) => {
    const [, state, scene] = scenes.find(([one]) => one === id) ?? [];
    if (state === undefined || scene === undefined)
      throw new Error(`the gallery has no scene ${id}`);
    const drawn = new DOMParser().parseFromString(
      await drawnInBrowser(state, scene, { act, createRoot }),
      "text/html",
    );

    expect(drawn.querySelector<HTMLDetailsElement>("details.site-menu")?.open).toBe(true);
  });
});

describe("connected code in the gallery", () => {
  it.each([
    {
      id: "dashboard-code-connected-profile",
      action: { tag: "BUTTON", name: "Ask for live sales" },
    },
    {
      id: "dashboard-code-connected-approval",
      action: { tag: "BUTTON", name: "Ask for live sales" },
    },
    {
      id: "dashboard-code-connected-ready",
      action: { tag: "A", href: "/docs/quickstart#_4-publish-one-card" },
    },
    {
      id: "dashboard-code-connected-test-wallet",
      action: { tag: "BUTTON", name: "Save name and wallet" },
    },
  ])("shows the next account action in $id", async ({ id, action }) => {
    const state = gallery.states.find((one) => one.id === id);
    if (state === undefined) throw new Error(`the gallery has no code connection state ${id}`);
    const drawn = new DOMParser().parseFromString(
      await drawnInBrowser(state, { shows: "Your code connected" }, { act, createRoot }),
      "text/html",
    );
    const actions = [...drawn.querySelectorAll("main button, main a")].map((element) => ({
      tag: element.tagName,
      name: element.textContent?.trim(),
      href: element.getAttribute("href"),
    }));

    expect(
      actions.some(
        (one) =>
          one.tag === action.tag &&
          ("name" in action ? one.name === action.name : one.href === action.href),
      ),
    ).toBe(true);
  });
});

/** The situation table also drives what the real frame draws over each page. */
describe("onboarding situations in the frame", () => {
  it("keeps a declined request's note visible when quiet code has no account warning", async () => {
    const state = gallery.states.find((one) => one.id === "dashboard-onboarding-32");
    if (!state) throw new Error("the gallery has no declined quiet-code situation");
    const drawn = new DOMParser().parseFromString(
      await drawnInBrowser(state, { shows: "Ask again" }, { act, createRoot }),
      "text/html",
    );
    const notices = drawn.querySelectorAll('[aria-label="About your account"]');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.textContent).toContain(
      "Choose a seller name that belongs to your business.",
    );
    expect(drawn.querySelector('main form button[type="submit"]')?.textContent).toBe("Ask again");
  });
  it.each(ONBOARDING_CASES)(
    "situation $row places its account notice and offers practice only on the first live visit",
    async ({ row, facts, reason }) => {
      const state = gallery.states.find((one) => one.id === `dashboard-onboarding-${row}`);
      if (state === undefined) throw new Error(`the gallery has no onboarding situation ${row}`);
      const drawn = new DOMParser().parseFromString(
        await drawnInBrowser(
          state,
          {
            ...state.scene,
            shows: row === 1 ? "How do you want to add your products?" : "Products",
          },
          { act, createRoot },
        ),
        "text/html",
      );
      expect(
        [...drawn.querySelectorAll("[data-reason]")].map((element) =>
          element.getAttribute("data-reason"),
        ),
      ).toEqual(facts.withdrawn || reason === null ? [] : [reason]);
      expect(drawn.querySelector('a[href="/practice"]') !== null).toBe(
        row === 1 && facts.mode === "live",
      );
    },
  );
});

describe("publication results reached from an empty Products list", () => {
  it.each([
    [
      "publication-unread-first",
      "We couldn't read shop.example.com, so nothing is on sale yet.",
      true,
    ],
    ["publication-unread", "We couldn't read shop.example.com, so nothing is on sale yet.", false],
  ] as const)(
    "keeps the first-publication claim tied to known Products for %s",
    async (id, copy, shouldSayNone) => {
      const state = gallery.states.find((one) => one.id === `dashboard-shop-job-${id}`);
      if (state?.scene === undefined) throw new Error(`the gallery has no browser scene for ${id}`);
      const drawn = new DOMParser().parseFromString(
        await drawnInBrowser(state, state.scene, { act, createRoot }),
        "text/html",
      );
      const text = drawn.body.textContent ?? "";

      expect(text).toContain("Sync with your shop");
      expect(text.includes(copy)).toBe(shouldSayNone);
    },
  );
});
