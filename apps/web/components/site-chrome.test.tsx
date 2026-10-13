import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { onSite } from "../testing/on-site";
import { MarketingHeader, SiteFooter } from "./site-chrome";

describe("MarketingHeader", () => {
  it("makes the merchant product reachable from a cold public page", () => {
    const markup = renderToStaticMarkup(onSite(<MarketingHeader />));

    expect(markup).toContain('href="/agentic-shop"');
  });

  it("carries the doors to the documentation and the dashboard", () => {
    const markup = renderToStaticMarkup(onSite(<MarketingHeader />));

    expect(markup).toContain('href="/docs/"');
    expect(markup).toContain('href="/dashboard/sign-in"');
  });
});

describe("SiteFooter", () => {
  it("keeps privacy choices reachable from the footer control group", () => {
    const markup = renderToStaticMarkup(onSite(<SiteFooter />));
    expect(markup).toContain("Privacy choices");
    expect(markup).toContain("Data request");
    expect(markup).toContain('href="/agentic-shop"');
  });
});
