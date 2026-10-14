/**
 * The merchant landing at `/sell`, asked of the whole process as a browser
 * on the test channel asks it, and drawn on its own for the tariffs it is
 * told to show. Whether the live channel's edge lets a visitor reach it is the
 * edge's business, held by the routing smoke and, in a browser, by Chromium.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SellLandingPage } from "../../components/sell-landing";
import { SELL_LANDING } from "../../content/sell";
import { onSite } from "../../testing/on-site";
import { ask } from "../../testing/scanner";

const linksIn = (html: string): string[] =>
  [...html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)].map((match) => match[1] ?? "");

describe("the merchant landing", () => {
  it.each(["GET", "HEAD"])(
    "is kept by no cache past an edit and listed by no search engine, its prices being a draft: %s",
    async (method) => {
      const answered = await ask("/sell", { method });

      expect(answered.status).toBe(200);
      expect(answered.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(answered.headers.get("cache-control")).toBe("no-cache");
      expect(answered.headers.get("x-robots-tag")).toBe("noindex");
      expect(answered.headers.get("x-frame-options")).toBe("DENY");
    },
  );

  it("is offered to no client as Markdown, being no public page", async () => {
    const answered = await ask("/sell", { headers: { accept: "text/markdown" } });

    expect(answered.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(answered.headers.get("cache-control")).toBe("no-cache");
  });

  it("is at the address without a slash, where the one with it is sent", async () => {
    const answered = await ask("/sell/");

    expect(answered.status).toBe(308);
    expect(answered.headers.get("location")).toBe("/sell");
  });

  it("names itself in its head as a link preview reads it", async () => {
    const html = await (await ask("/sell")).text();
    const head = html.slice(0, html.indexOf("</head>"));

    expect(head).toContain(`<title>${SELL_LANDING.head.title}</title>`);
    expect(head).toContain(`<meta name="description" content="${SELL_LANDING.head.description}"/>`);
    expect(head).toContain(`<meta property="og:title" content="${SELL_LANDING.head.cardTitle}"/>`);
    expect(head).toContain('<meta property="og:type" content="website"/>');
  });

  it("leads to the dashboard, the documentation and its own sections, and answers no form", async () => {
    const html = await (await ask("/sell")).text();
    const links = linksIn(html);

    expect(html).toContain(`<h1 class="hero__title">${SELL_LANDING.hero.title}</h1>`);
    for (const href of ["/dashboard/sign-in", "/docs/", "/docs/quickstart", "/docs/cards"]) {
      expect(links).toContain(href);
    }
    for (const section of ["#how", "#connect", "#money", "#pricing"]) {
      expect(links).toContain(section);
      expect(html).toContain(`id="${section.slice(1)}"`);
    }
    expect(html).not.toMatch(/<form\b/);
  });
});

describe("the tariffs the landing is told to show", () => {
  const drawn = (pricing: Partial<(typeof SELL_LANDING)["pricing"]>) =>
    renderToStaticMarkup(
      onSite(
        createElement(SellLandingPage, {
          content: { ...SELL_LANDING, pricing: { ...SELL_LANDING.pricing, ...pricing } },
        }),
        { at: "/sell" },
      ),
    );

  it("are each a section of their own, under the note for choosing between them", () => {
    const html = drawn({});

    for (const tariff of SELL_LANDING.pricing.options) {
      expect(html).toContain(`id="pricing-${tariff.id}"`);
      expect(html).toContain(tariff.note);
    }
  });

  it("are drawn without their notes once the notes are put away", () => {
    const html = drawn({ notesShown: false });

    expect(html).toContain('id="pricing-t1"');
    expect(html).not.toContain("tariff-flag");
  });

  it("leave no pricing and no link to it where none is shown", () => {
    const html = drawn({ options: [] });

    expect(html).not.toContain('id="pricing"');
    expect(linksIn(html)).not.toContain("#pricing");
    expect(linksIn(html)).toContain("#money");
  });
});
