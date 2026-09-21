/*
 * The boundary sentences a visitor relies on are on the page.
 *
 * The word ceiling beside this file (screen-word-count.test.tsx) only ever
 * pulls words off a screen, and a pass that trimmed the site deleted the one
 * test that held a boundary in place. This is the floor: a claim about what
 * the scanner does not do, the claim that the result is not a certification,
 * and the claim that the site itself is left alone are promises, and a screen
 * that loses one has broken a promise, however many words it saved.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import MethodologyPage from "../app/(trust)/methodology/page";
import { LANDINGS } from "../content/landing";
import { LandingPage } from "./landing-page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ prefetch: () => undefined, push: () => undefined }),
}));

Object.assign(globalThis, { React });

describe("the boundaries a visitor relies on", () => {
  it.each(Object.values(LANDINGS))(
    "every landing says the site itself is left alone ($segment)",
    (config) => {
      const markup = renderToStaticMarkup(<LandingPage config={config} />);
      expect(markup).toContain("Nothing on your site is changed");
    },
  );

  it("the front page says no model's answer is tested", () => {
    const markup = renderToStaticMarkup(
      <LandingPage config={LANDINGS.owner} />,
    );
    expect(markup).toMatch(/do not test any model/);
  });

  it("the methodology says the result is not a certification", () => {
    const markup = renderToStaticMarkup(<MethodologyPage />);
    expect(markup).toContain("never a certification");
  });
});
