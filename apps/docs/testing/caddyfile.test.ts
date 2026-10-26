/**
 * What the Caddyfile's `/docs` block decides by rules of its own, read from
 * the Caddyfile: a client that prefers Markdown is told apart as the scanner
 * tells it apart for its own pages, so an agent reading the site is answered
 * the same way on every page of it, and an address the documentation
 * answered at before leads to the page's own.
 */

import { describe, expect, it } from "vitest";
import { prefersMarkdown as scannerPrefersMarkdown } from "../../web/lib/accept-negotiation.js";
import { prefersMarkdown, RULES } from "./edge.js";

/** As agents, tools and browsers send them. */
const ACCEPT = [
  "text/markdown",
  "text/markdown, text/html;q=0.9, */*;q=0.8",
  "text/markdown,text/plain;q=0.9,*/*;q=0.8",
  "text/markdown;q=1.0, text/html;q=0.5",
  "text/markdown, */*",
  "TEXT/MARKDOWN",
  "text/plain, text/markdown",
  "text/html;q=0, text/markdown",
  "text/html, text/markdown",
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "text/html",
  "*/*",
  "text/*",
  "text/markdown;q=0",
  "text/markdown;q=0.0, text/html",
  "text/markdown; charset=utf-8",
  "text/markdown;charset=UTF-8, text/html;q=0.9",
  "text/markdown; variant=GFM; charset=utf-8",
  "text/markdown; charset=utf-8; q=0.5, text/html;q=0.4",
  "text/markdown; charset=utf-8; q=0",
  "text/markdown; q=0; charset=utf-8",
  "text/markdown; q=0.5x",
  "text/html; charset=utf-8, text/markdown",
  "text/html; charset=utf-8; q=0, text/markdown",
  "application/json",
  "",
];

/** The same header with a parameter beside the type of every media range in it. */
const withParameter = (accept: string): string =>
  accept
    .split(",")
    .map((range) => {
      const [type, ...parameters] = range.split(";");
      return [`${type}; charset=utf-8`, ...parameters].join(";");
    })
    .join(",");

describe("the Caddyfile's /docs block", () => {
  it.each(ACCEPT)("answers %j with Markdown exactly where the scanner would", (accept) => {
    expect(prefersMarkdown(accept)).toBe(scannerPrefersMarkdown(accept));
  });

  it.each(ACCEPT.filter((accept) => accept !== ""))(
    "answers %j with a parameter on each media range as it answers it without one",
    (accept) => {
      expect(prefersMarkdown(withParameter(accept))).toBe(prefersMarkdown(accept));
      expect(prefersMarkdown(withParameter(accept))).toBe(
        scannerPrefersMarkdown(withParameter(accept)),
      );
    },
  );

  it("tells a client apart at all", () => {
    expect(prefersMarkdown("text/markdown")).toBe(true);
    expect(prefersMarkdown("text/html")).toBe(false);
  });

  it.each([
    ["/docs/money.html", "money"],
    ["/docs/index.html", ""],
    ["/docs/scanner.html", "scanner"],
    ["/docs/scanner/index.html", "scanner"],
    ["/docs/scanner/methodology.html", "scanner/methodology"],
  ])("leads %s to the page's own address", (former, page) => {
    expect(RULES.formerAddress.exec(former)?.[1]).toBe(page);
  });

  it.each(["/docs/money", "/docs/", "/docs/assets/root-x.css", "/privacy.html"])(
    "leaves %s where it is",
    (address) => {
      expect(RULES.formerAddress.test(address)).toBe(false);
    },
  );
});
