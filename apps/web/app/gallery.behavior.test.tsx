// @vitest-environment jsdom

/**
 * The gallery's states that only the page's script reaches, a scan's progress
 * or the answer to a press, each drawn in a document the way `pnpm gallery`
 * draws it: the page arrives at the words its scene says it shows, asking for
 * nothing the scene does not answer, and a state that opens the header's
 * menu is drawn with the menu open. A page whose script stops reaching such a
 * state, or starts asking the site for something new, fails here.
 *
 * Left alone, as in `gallery.test.tsx`: whether the state looks right, and
 * whether the site would answer as the scene says it does; the scene's
 * answers are the API's shapes and words as its routes write them.
 */

import { drawnInBrowser } from "@agentify/gallery/browser";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { gallery } from "./gallery";

const scenes = gallery.states.flatMap((state) =>
  state.scene === undefined ? [] : [[state.id, state, state.scene] as const],
);

describe("the scanner's gallery, in the browser", () => {
  it.each(scenes)("brings %s about with the page's own script", async (_id, state, scene) => {
    expect(await drawnInBrowser(state, scene, { act, createRoot })).toContain(scene.shows);
  });

  it.each(["scanner-privacy-menu", "scanner-scan-menu"])(
    "draws the header's menu open in %s",
    async (id) => {
      const [, state, scene] = scenes.find(([one]) => one === id) ?? [];
      if (state === undefined || scene === undefined)
        throw new Error(`the gallery has no scene ${id}`);
      const drawn = new DOMParser().parseFromString(
        await drawnInBrowser(state, scene, { act, createRoot }),
        "text/html",
      );

      expect(drawn.querySelector<HTMLDetailsElement>("details.site-menu")?.open).toBe(true);
    },
  );
});
