/**
 * The page about selling to agents and the notice for the retired merchant
 * application form, drawn by the whole process and read as the HTML a browser
 * or a link preview receives, or as the Markdown a client asks for.
 */

import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SELL_TO_AGENTS_PICTURE } from "../../content/pictures";
import { buildLlmsText } from "../../lib/llms";
import { ask } from "../../testing/scanner";

beforeEach(() => {
  vi.stubEnv("APP_BASE_URL", "https://agentify.ad");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const drawn = async (path: string) => {
  const answered = await ask(path, { headers: { accept: "text/html" } });
  expect(answered.status).toBe(200);
  const html = await answered.text();
  const head = html.slice(0, html.indexOf("</head>"));
  return {
    answered,
    html,
    links: [...html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)].map((match) => match[1] ?? ""),
    title: head.match(/<title>([^<]*)<\/title>/)?.[1],
    /** Every value the head gives a reader or a link preview, which tags hide from the text. */
    headWords: [...head.matchAll(/ content="([^"]*)"/g)].map((match) => match[1]).join("\n"),
    meta: (key: string) =>
      head.match(new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)"`))?.[1],
    canonical: head.match(/<link rel="canonical" href="([^"]*)"/)?.[1],
  };
};

describe("the sell-to-agents page", () => {
  it("carries one brand: the page, the privacy notice, their heads, the header, the card and llms.txt name no second one", async () => {
    // Words are compared the way a reader meets them: tags stripped, spacing
    // collapsed, case ignored, so neither a capitalised nor a split rendering
    // of the second name slips through.
    const asRead = (surface: string) =>
      surface
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;|\s+/g, " ")
        .toLowerCase();

    const page = await drawn("/agentic-shop");
    const notice = await drawn("/agentic-shop/privacy");
    for (const surface of [
      page.html,
      page.headWords,
      notice.html,
      notice.headWords,
      SELL_TO_AGENTS_PICTURE.alt,
      SELL_TO_AGENTS_PICTURE.tag,
      buildLlmsText(),
    ])
      expect(asRead(surface)).not.toContain("agentic shop");
  });

  it("opens the dashboard directly instead of collecting a merchant application", async () => {
    const { html, links } = await drawn("/agentic-shop");

    expect(links).toContain("/dashboard/sign-in");
    expect(links).toContain("/docs/");
    expect(links).not.toContain("#apply");
    expect(html).not.toMatch(/<form\b/);
    expect(html).not.toContain("/api/v1/merchant-applications");
  });

  it("leads the owner to the owner's documentation and money, the engineer to the quickstart, and a first test to the test channel's own dashboard", async () => {
    const { html } = await drawn("/agentic-shop");
    const main = html.slice(html.indexOf("<main"), html.indexOf("</main>"));
    const links = [...main.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)].map((match) => match[1]);

    expect(links).toContain("/docs/");
    expect(links).toContain("/docs/money");
    expect(links).toContain("/docs/quickstart");
    expect(links).toContain("https://test.agentify.ad/dashboard/sign-in");
    expect(links).not.toContain("/docs/faq");
  });

  it("links the site's privacy notice and invites no application", async () => {
    const { links, meta } = await drawn("/agentic-shop");

    expect(links).toContain("/privacy");
    expect(links).not.toContain("/agentic-shop/privacy");
    expect(meta("description")).not.toMatch(/\bapply|application\b/i);
  });

  it("names the research its market numbers come from", async () => {
    const { html } = await drawn("/agentic-shop");

    expect(html).toContain(
      'href="https://business.adobe.com/blog/ai-traffic-surge-retail-sites-not-machine-readable"',
    );
    expect(html).toMatch(/\+<!-- -->393/);
  });

  it("unfurls into its own card at its own address, with the sell-to-agents image", async () => {
    const page = await drawn("/agentic-shop");

    expect(page.title).toMatch(/^\S.+ · Agentify$/);
    expect(page.canonical).toBe("https://agentify.ad/agentic-shop");
    expect(page.meta("og:title")).toBe("Your next customer sends an agent. Be ready.");
    expect(page.meta("twitter:title")).toBe("Your next customer sends an agent. Be ready.");
    expect(page.meta("og:description")).toBe(
      "Your products and services, ready for a new way to buy.",
    );
    expect(page.meta("og:url")).toBe("https://agentify.ad/agentic-shop");
    expect(page.meta("og:type")).toBe("website");
    expect(page.meta("og:image")).toBe("https://agentify.ad/agentic-shop/opengraph-image");
    expect(page.meta("twitter:image")).toBe("https://agentify.ad/agentic-shop/opengraph-image");
    expect(page.meta("og:image:alt")).toBe(SELL_TO_AGENTS_PICTURE.alt);
  });

  it("shows its still life at a width the screen asks for, and fetches it with the page", async () => {
    const { html } = await drawn("/agentic-shop");
    const image = html.match(/<img\b[^>]*>/)?.[0] ?? "";
    const widths = [...(image.match(/srcSet="([^"]+)"/)?.[1] ?? "").matchAll(/ (\d+)w/g)].map(
      (match) => Number(match[1]),
    );

    expect(widths).toEqual([640, 1080, 1448]);
    expect(html).toMatch(/<link rel="preload" as="image" imageSrcSet="[^"]+640w/);
    // The process serves `public/` as it is, so each file named is one there.
    for (const [, path] of image.matchAll(/(\/agentic-shop\/[^ "]+\.webp)/g)) {
      expect(existsSync(new URL(`../../public${path}`, import.meta.url)), path).toBe(true);
    }
  });

  it("may be kept by a shared cache for an hour, as every public page may", async () => {
    const { answered } = await drawn("/agentic-shop");

    expect(answered.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=3600");
    expect(answered.headers.get("vary")).toContain("Accept");
  });

  it("answers a client that asks for Markdown with the page in Markdown, every heading the page draws included", async () => {
    const page = await drawn("/agentic-shop");
    const answered = await ask("/agentic-shop", { headers: { accept: "text/markdown" } });
    const markdown = await answered.text();
    const main = page.html.slice(page.html.indexOf("<main"), page.html.indexOf("</main>"));
    const headings = [...main.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/g)].map((match) =>
      (match[1] ?? "")
        .replace(/<br\/?>/g, " ")
        .replace(/<[^>]+>/g, "")
        .replace(/&#x27;/g, "'"),
    );

    expect(answered.status).toBe(200);
    expect(answered.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(answered.headers.get("vary")).toContain("Accept");
    expect(markdown).toMatch(/^# \S/);
    expect(headings.length).toBeGreaterThan(5);
    for (const heading of headings) expect(markdown, heading).toContain(heading);
    expect(markdown).toContain("](https://agentify.ad/dashboard/sign-in)");
    expect(markdown).toContain("](https://agentify.ad/docs/money)");
    expect(markdown).not.toContain("undefined");
  });
});

describe("the notice for the retired merchant application form", () => {
  it("says how long a submission is kept and under which notice version", async () => {
    const { html } = await drawn("/agentic-shop/privacy");

    expect(html).toMatch(/Applications expire after <!-- -->\d+<!-- --> days/);
    expect(html).toMatch(/Notice version: <!-- -->\S+/);
  });

  it("names the privacy contact and the operator this deployment is configured with", async () => {
    vi.stubEnv("PRIVACY_EMAIL", "privacy@test.agentify.ad");
    vi.stubEnv("LEGAL_IDENTITY_CONFIRMED", "true");
    vi.stubEnv("LEGAL_OPERATOR", "Example Operator Ltd");

    const { html, links } = await drawn("/agentic-shop/privacy");
    const notice = html.slice(html.indexOf("<main"), html.indexOf("</main>"));

    expect(links).toContain("mailto:privacy@test.agentify.ad");
    expect(notice).toContain("Example Operator Ltd");
    expect(notice).not.toContain("Registered operator details are pending confirmation");
  });

  it("says the operator is pending where the deployment has not confirmed one", async () => {
    vi.stubEnv("LEGAL_IDENTITY_CONFIRMED", "false");
    vi.stubEnv("LEGAL_OPERATOR", "Example Operator Ltd");

    const { html } = await drawn("/agentic-shop/privacy");
    const notice = html.slice(html.indexOf("<main"), html.indexOf("</main>"));

    expect(notice).toContain("Registered operator details are pending confirmation");
    expect(notice).not.toContain("Example Operator Ltd");
  });

  it("leads back to the site's privacy policy and the sell-to-agents page", async () => {
    const { links } = await drawn("/agentic-shop/privacy");

    expect(links).toContain("/privacy");
    expect(links).toContain("/agentic-shop");
  });

  it("unfurls into the sell-to-agents card under its own title, at no address of its own", async () => {
    const page = await drawn("/agentic-shop/privacy");

    expect(page.title).toBe("Historical application privacy · Agentify");
    expect(page.canonical).toBe("https://agentify.ad/agentic-shop/privacy");
    expect(page.meta("og:title")).toBe(page.title);
    expect(page.meta("og:image")).toBe("https://agentify.ad/agentic-shop/opengraph-image");
    expect(page.meta("og:url")).toBeUndefined();
  });
});
