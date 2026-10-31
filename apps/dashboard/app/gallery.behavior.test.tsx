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
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { ONBOARDING_CASES } from "../src/testing/onboarding-cases.js";
import { gallery } from "./gallery.js";

const scenes = gallery.states.flatMap((state) =>
  state.scene === undefined ? [] : [[state.id, state, state.scene] as const],
);

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

/** The situation table also drives what the real frame draws over each page. */
describe("onboarding situations in the frame", () => {
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
      expect(drawn.querySelector('a[href="/docs/#how-to-start"]') !== null).toBe(
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
