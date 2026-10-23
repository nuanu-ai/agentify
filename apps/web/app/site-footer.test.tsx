// @vitest-environment jsdom

/**
 * The promise the site makes at the foot of every page a visitor opens: the
 * page ends in the same footer, with the ways to selling, the documentation,
 * the trust pages and the abuse contact and the button that opens the privacy
 * choices, and no list of the page's own beside it repeats one of those ways.
 * Each of the scanner's pages is drawn through the route tree in every state
 * the gallery knows, as the server sends it.
 *
 * Left alone: the operator's page, which is no visitor's; the page's top,
 * whose header names some of the same pages; the consent banner,
 * which every page draws after its footer; links in a page's own text, which
 * may name a page the footer also names; and where each link leads, which the
 * footer's own test holds.
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

const FOCUSABLE = "a[href], button, input, select, textarea, summary, [tabindex]";

const drawn = async (state: (typeof gallery.states)[number]): Promise<Document> => {
  const { prelude } = await prerender(state.draw());
  return new DOMParser().parseFromString(await new Response(prelude).text(), "text/html");
};

/** What a visitor reads or can focus after the footer, the consent banner and scripts aside. */
const afterFooter = (page: Document, footer: Element): string[] => {
  const after: string[] = [];
  const walker = page.createTreeWalker(page.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (!(footer.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    if (footer.contains(node)) continue;
    const element = node instanceof Element ? node : node.parentElement;
    if (element?.closest(".consent-banner, script, style, template") != null) continue;
    if (node instanceof Element && node.matches(FOCUSABLE)) after.push(`<${node.tagName}>`);
    if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
      after.push(node.textContent.trim());
    }
  }
  return after;
};

/** Whether `element` sits in the page's top: its header, or beside the lockup, which leads home. */
const inTop = (element: Element): boolean => {
  if (element.closest("header") !== null) return true;
  for (let box = element.parentElement; box !== null; box = box.parentElement) {
    if ([...box.children].some((child) => child.matches("a.brand"))) return true;
  }
  return false;
};

/** The footer's ways out, offered again by a list of links outside the page's top and the footer. */
const repeatedBeside = (page: Document, footer: Element): string[] =>
  [...page.querySelectorAll("nav")]
    .filter((nav) => !footer.contains(nav) && !inTop(nav))
    .flatMap((nav) =>
      [...nav.querySelectorAll("a[href]")]
        .map((link) => link.getAttribute("href") ?? "")
        .filter((href) => COMMON.includes(href))
        .map((href) => `${nav.getAttribute("aria-label") ?? "a list"} repeats ${href}`),
    );

const visitorStates = gallery.states.filter((state) => state.address !== "/admin");

describe("the foot of the scanner's pages", () => {
  it.each(visitorStates.map((state) => [state.id, state]))(
    "%s ends in the site's footer, with the privacy choices, and no list beside it repeats the footer's links",
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
      expect(afterFooter(page, footer)).toEqual([]);
      expect(repeatedBeside(page, footer)).toEqual([]);
    },
  );
});
