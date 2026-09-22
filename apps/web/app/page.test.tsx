import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ prefetch: () => undefined, push: () => undefined }),
}));

import { LANDINGS } from "../content/landing";
import HomePage from "./page";

const rendered = (): {
  html: string;
  links: string[];
  underTheForm: string;
} => {
  Object.assign(globalThis, { React });
  const html = renderToStaticMarkup(<HomePage />);
  const links = [...html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)].map((match) => match[1] ?? "");
  const formAt = html.indexOf("<form");
  const underTheForm = html.slice(formAt, html.indexOf("</section>", formAt));
  return { html, links, underTheForm };
};

describe("the front page", () => {
  it("offers the scan first, the doors in the header, and the second door under the form", () => {
    const { html, links, underTheForm } = rendered();

    expect(html).toContain("<form");
    expect(links).toContain("/docs/");
    expect(links).toContain("/cabinet/sign-in");
    expect(underTheForm).toContain('href="/agentic-shop"');
  });

  it("announces its segment and variant, which is what the landing analytics record", () => {
    const { html } = rendered();

    expect(html).toContain('data-agentify-landing-segment="owner"');
    expect(html).toContain(`data-agentify-landing-variant="${LANDINGS.owner.variant}"`);
  });
});
