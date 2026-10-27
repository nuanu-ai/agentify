// @vitest-environment jsdom

/** Every composed visitor page keeps its common destinations and privacy controls reachable. */

import { prerender } from "react-dom/static";
import { describe, expect, it } from "vitest";
import { gallery } from "./gallery";

const COMMON = [
  "/agentic-shop",
  "/docs/",
  "/privacy",
  "/terms",
  "/data-request",
  "/docs/scanner#opt-out",
];

const drawn = async (state: (typeof gallery.states)[number]): Promise<Document> => {
  const { prelude } = await prerender(state.draw());
  return new DOMParser().parseFromString(await new Response(prelude).text(), "text/html");
};

const visitorStates = gallery.states.filter((state) => state.address !== "/admin");

describe("the foot of the scanner's pages", () => {
  it.each(visitorStates.map((state) => [state.id, state]))(
    "%s offers the common footer destinations and privacy choices",
    async (_id, state) => {
      const page = await drawn(state);
      const footer = page.querySelector("footer.foot");

      expect(footer, "the site footer").not.toBeNull();
      if (footer === null) return;
      const hrefs = [...footer.querySelectorAll("a[href]")].map((link) =>
        link.getAttribute("href"),
      );
      for (const href of COMMON) expect(hrefs, href).toContain(href);
      expect(footer.textContent).toContain("Privacy choices");
    },
  );
});
