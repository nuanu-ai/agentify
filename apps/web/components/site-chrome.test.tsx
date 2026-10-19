import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { onSite } from "../testing/on-site";
import { SiteFooter, SiteHeader } from "./site-chrome";

describe("the site header", () => {
  it("makes the merchant product reachable from a cold public page", () => {
    const markup = renderToStaticMarkup(onSite(<SiteHeader />));

    expect(markup).toContain('href="/agentic-shop"');
  });

  it("carries the doors to the documentation and the dashboard", () => {
    const markup = renderToStaticMarkup(onSite(<SiteHeader />));

    expect(markup).toContain('href="/docs/"');
    expect(markup).toContain('href="/dashboard/sign-in"');
  });
});

describe("the site footer", () => {
  it("leads to selling, the documentation, the trust pages and the abuse contact, with the privacy choices", () => {
    const markup = renderToStaticMarkup(onSite(<SiteFooter />));
    const footer = markup.slice(markup.indexOf("<footer"));

    for (const href of [
      "/agentic-shop",
      "/docs/",
      "/privacy",
      "/terms",
      "/data-request",
      "/docs/scanner#opt-out",
    ]) {
      expect(footer, href).toContain(`href="${href}"`);
    }
    expect(footer).toContain("Privacy choices");
  });
});
