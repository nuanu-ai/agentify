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
