// @vitest-environment jsdom

/**
 * The promise the site makes at the foot of every page a visitor opens: the
 * page ends in the same footer, with the ways to selling, the documentation,
 * the trust pages and the abuse contact and the button that opens the privacy
 * choices, and nothing of the page's own beside it repeats one of those ways.
 * Each of the scanner's pages is drawn through the route tree in every state
 * the gallery knows, as the server sends it.
 *
 * Left alone: the operator's page, which is no visitor's; the page's top,
 * whose header names some of the same pages; the consent banner and scripts,
 * which every page draws after its footer; links in a page's own sentences,
 * its calls to action drawn as buttons and the trail above its heading that
 * says where the page stands, which may name a page the footer also names;
 * and where each link leads, which the footer's own test holds.
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

const drawn = async (state: (typeof gallery.states)[number]): Promise<Document> => {
  const { prelude } = await prerender(state.draw());
  return new DOMParser().parseFromString(await new Response(prelude).text(), "text/html");
};

/** What follows the footer, at its own level and each above it, that is not allowed to. */
const afterFooter = (footer: Element): string[] => {
  const after: string[] = [];
  for (
    let box: Element | null = footer;
    box !== null && box.tagName !== "BODY";
    box = box.parentElement
  ) {
    for (let next = box.nextElementSibling; next !== null; next = next.nextElementSibling) {
      if (!next.matches(".consent-banner, script, style, template"))
        after.push(next.outerHTML.slice(0, 80));
    }
  }
  return after;
};

/**
 * The footer's ways out offered again elsewhere: every link to one of them
 * outside the footer and the page's top, the header holding the link home
 * (or the group holding it, on a page without a header), save a link in the
 * page's own sentences and a button that is the page's own call to action.
 */
const repeatedBeside = (page: Document, footer: Element): string[] => {
  const home = [...page.querySelectorAll('a[href="/"]')].find((link) => !footer.contains(link));
  const top = home?.closest("header") ?? home?.parentElement ?? null;
  return [...page.querySelectorAll("a[href]")]
    .filter((link) => COMMON.includes(link.getAttribute("href") ?? ""))
    .filter((link) => !footer.contains(link) && !(top?.contains(link) ?? false))
    .filter(
      (link) =>
        !link.matches(".button") &&
        link.closest("p") === null &&
        link.closest(".trail") === null &&
        (link.closest("li") === null || link.closest("nav") !== null),
    )
    .map(
      (link) => `${link.getAttribute("href")} in <${link.parentElement?.tagName.toLowerCase()}>`,
    );
};

const visitorStates = gallery.states.filter((state) => state.address !== "/admin");

describe("the foot of the scanner's pages", () => {
  it.each(visitorStates.map((state) => [state.id, state]))(
    "%s ends in the site's footer, with the privacy choices, and nothing beside it repeats the footer's links",
    async (_id, state) => {
      const page = await drawn(state);
      const footer = page.querySelector("footer.foot");

      expect(footer, "the site footer").not.toBeNull();
      if (footer === null) return;
      const hrefs = [...footer.querySelectorAll("a[href]")].map((link) =>
        link.getAttribute("href"),
      );
      for (const href of COMMON) expect(hrefs, href).toContain(href);
      expect(hrefs.filter((href, at) => hrefs.indexOf(href) !== at)).toEqual([]);
      expect(footer.textContent).toContain("Privacy choices");
      expect(afterFooter(footer)).toEqual([]);
      expect(repeatedBeside(page, footer)).toEqual([]);
    },
  );
});
