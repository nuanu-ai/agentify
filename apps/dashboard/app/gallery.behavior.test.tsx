// @vitest-environment jsdom

/**
 * The gallery's states that only the page's script reaches, a row opened or
 * the header's menu opened, each drawn in a document the way `pnpm gallery`
 * draws it: the page arrives at the words its scene says it shows, and a
 * state that opens the header's menu is drawn with the menu open.
 *
 * Left alone, as in `gallery.test.tsx`: whether the state looks right, which
 * the person reading the gallery judges.
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
  it.each(scenes)("brings %s about with the page's own script", async (_id, state, scene) => {
    expect(await drawnInBrowser(state, scene, { act, createRoot })).toContain(scene.shows);
  });

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
