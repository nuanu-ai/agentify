/**
 * The promise the site makes at the foot of every page a visitor opens: the
 * same footer, with the ways to selling, the documentation, the trust pages
 * and the abuse contact and the button that opens the privacy choices, and
 * no page of its own repeating one of them beside it. Each of the scanner's
 * pages is drawn through the route tree in every state the gallery knows, as
 * the server sends it. The operator's page is no visitor's page and is left
 * alone, as is where each link leads, which the footer's own test holds.
 */

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

const drawn = async (state: (typeof gallery.states)[number]): Promise<string> => {
  const { prelude } = await prerender(state.draw());
  return await new Response(prelude).text();
};

/** The foot of the page: from the site footer's opening tag to its close. */
const footOf = (html: string): string | undefined => {
  const start = html.indexOf('<footer class="foot"');
  return start === -1 ? undefined : html.slice(start, html.indexOf("</footer>", start));
};

const visitorStates = gallery.states.filter((state) => state.address !== "/admin");

describe("the foot of the scanner's pages", () => {
  it.each(visitorStates.map((state) => [state.id, state]))(
    "%s ends in the site's footer, each of its pages named once, with the privacy choices",
    async (_id, state) => {
      const foot = footOf(await drawn(state));

      expect(foot, "the site footer").toBeDefined();
      const hrefs = [...(foot ?? "").matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
      for (const href of COMMON) expect(hrefs, href).toContain(href);
      expect(hrefs.filter((href, at) => hrefs.indexOf(href) !== at)).toEqual([]);
      expect(foot).toContain("Privacy choices");
    },
  );
});
