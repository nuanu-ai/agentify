import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarketingHeader } from "../../components/site-chrome";
import { buildLlmsText } from "../../lib/llms";
import { alt as socialImageAlt, tag as socialImageTag } from "./opengraph-image";
import AgenticShopPage, { generateMetadata } from "./page";
import MerchantPrivacyPage, { metadata as privacyMetadata } from "./privacy/page";

const rendered = (): { html: string; links: string[] } => {
  Object.assign(globalThis, { React });
  const html = renderToStaticMarkup(<AgenticShopPage />);
  const links = [...html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)].map((match) => match[1] ?? "");
  return { html, links };
};

describe("the sell-to-agents page", () => {
  it("carries one brand: the page, the privacy notice, their metadata, the social image, the header and llms.txt name no second one", () => {
    const { html } = rendered();
    // Words are compared the way a reader meets them: tags stripped, spacing
    // collapsed, case ignored, so neither a capitalised nor a split rendering
    // of the second name slips through.
    const asRead = (surface: string) =>
      surface
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;|\s+/g, " ")
        .toLowerCase();

    for (const surface of [
      html,
      renderToStaticMarkup(<MerchantPrivacyPage />),
      renderToStaticMarkup(<MarketingHeader />),
      socialImageAlt,
      socialImageTag,
      buildLlmsText(),
      JSON.stringify(generateMetadata()),
      JSON.stringify(privacyMetadata),
    ])
      expect(asRead(surface)).not.toContain("agentic shop");
  });

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
