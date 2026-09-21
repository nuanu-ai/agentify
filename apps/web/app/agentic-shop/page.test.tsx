import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import AgenticShopPage, { generateMetadata } from "./page";

const rendered = (): { html: string; links: string[] } => {
  Object.assign(globalThis, { React });
  const html = renderToStaticMarkup(<AgenticShopPage />);
  const links = [...html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)].map(
    (match) => match[1] ?? "",
  );
  return { html, links };
};

describe("the Agentic Shop entry", () => {
  it("opens the cabinet directly instead of collecting a merchant application", () => {
    const { html, links } = rendered();

    expect(links).toContain("/cabinet/sign-in");
    expect(links).toContain("/docs/");
    expect(links).not.toContain("#apply");
    expect(html).not.toMatch(/<form\b/);
    expect(html).not.toContain("/api/v1/merchant-applications");
  });

  it("uses the current site privacy notice and no longer advertises applications", () => {
    const { links } = rendered();
    const metadata = generateMetadata();

    expect(links).toContain("/privacy");
    expect(links).not.toContain("/agentic-shop/privacy");
    expect(metadata.description).not.toMatch(/\bapply|application\b/i);
  });
});
