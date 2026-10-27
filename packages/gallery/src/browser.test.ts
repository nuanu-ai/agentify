// @vitest-environment jsdom

/**
 * What a scene promises the surface that writes it: a state whose page asks
 * the site for something the scene does not answer is not drawn, and the
 * refusal names the request. Drawing a real surface's scenes is held by that
 * surface's own gallery check.
 */

import { act, createElement, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { type BrowserReact, drawnInBrowser } from "./browser.js";
import type { GalleryState } from "./index.js";

/** The drawn state itself asks for, then renders, its session answer. */
function Session() {
  const [name, setName] = useState("Loading");
  useEffect(() => {
    void fetch("/api/v2/session")
      .then((answer) => answer.json())
      .then((answer: { name: string }) => setName(answer.name))
      .catch(() => setName("Session unavailable"));
  }, []);
  return createElement("p", null, name);
}
const asking: BrowserReact = { act, createRoot };

const state: GalleryState = {
  id: "surface-signed-in",
  screen: "Header",
  address: "/",
  when: "A person who is signed in opens the page.",
  cause: "The page asks the site who is visiting.",
  draw: () => createElement(Session),
};

describe("a state drawn in the browser", () => {
  it("is drawn once its page shows the scene's words and every request it made was answered", async () => {
    const scene = {
      answers: { "GET /api/v2/session": { status: 200, body: { name: "Signed in" } } },
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
