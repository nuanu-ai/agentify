// @vitest-environment jsdom

/**
 * What a scene promises the surface that writes it: a state whose page asks
 * the site for something the scene does not answer is not drawn, and the
 * refusal names the request. Drawing a real surface's scenes is held by that
 * surface's own gallery check.
 */

import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { type BrowserReact, drawnInBrowser } from "./browser.js";
import type { GalleryState } from "./index.js";

/** A page that asks the site who is visiting as soon as it is drawn, and shows nothing else. */
const asking: BrowserReact = {
  act: async (work) => await work(),
  createRoot: (container) => ({
    render: () => {
      container.textContent = "Signed in";
      void fetch("/api/v2/session").catch(() => undefined);
    },
    unmount: () => undefined,
  }),
};

const state: GalleryState = {
  id: "surface-signed-in",
  screen: "Header",
  address: "/",
  when: "A person who is signed in opens the page.",
  cause: "The page asks the site who is visiting.",
  draw: () => null as unknown as ReactElement,
};

describe("a state drawn in the browser", () => {
  it("is drawn once its page shows the scene's words and every request it made was answered", async () => {
    const scene = {
      answers: { "GET /api/v2/session": { status: 200, body: {} } },
      shows: "Signed in",
    };

    await expect(drawnInBrowser(state, scene, asking)).resolves.toContain("Signed in");
  });

  it("is refused, naming the request, when its page asks for something its scene does not answer", async () => {
    await expect(
      drawnInBrowser(state, { answers: {}, shows: "Signed in" }, asking),
    ).rejects.toThrow("GET /api/v2/session");
  });
});
