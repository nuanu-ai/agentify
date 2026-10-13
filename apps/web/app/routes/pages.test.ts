/**
 * The scanner's pages, drawn by the whole process and read as the HTML a
 * browser or a crawler receives: what each page offers, the head it
 * carries, and the consent banner every page draws.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LANDINGS } from "../../content/landing";
import { ask } from "../../testing/scanner";

beforeEach(() => {
  vi.stubEnv("APP_BASE_URL", "https://agentify.ad");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const page = async (path: string) => {
  const answered = await ask(path, { headers: { accept: "text/html" } });
  expect(answered.status).toBe(200);
  const html = await answered.text();
  const head = html.slice(0, html.indexOf("</head>"));
  return {
    html,
    links: [...html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)].map((match) => match[1] ?? ""),
    title: head.match(/<title>([^<]*)<\/title>/)?.[1],
    meta: (key: string) =>
      head.match(new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)"`))?.[1],
    canonical: head.match(/<link rel="canonical" href="([^"]*)"/)?.[1],
  };
};

describe("the front page", () => {
  it("offers the scan first, the doors in the header, and the second door under the form", async () => {
    const { html, links } = await page("/");
    const formAt = html.indexOf("<form");
    const underTheForm = html.slice(formAt, html.indexOf("</section>", formAt));

    expect(formAt).toBeGreaterThan(-1);
    expect(links).toContain("/docs/");
    expect(links).toContain("/dashboard/sign-in");
    expect(underTheForm).toContain('href="/agentic-shop"');
  });

  it("announces its segment and variant, which is what the landing analytics record", async () => {
    const { html } = await page("/");

    expect(html).toContain('data-agentify-landing-segment="owner"');
    expect(html).toContain(`data-agentify-landing-variant="${LANDINGS.owner.variant}"`);
  });

  it("carries its own title and the site's description, named by the origin alone", async () => {
    const head = await page("/");

    expect(head.title).toBe("What your website shows to AI agents, and how to sell to them");
    expect(head.meta("description")).toBe(
      "A public-HTTP diagnostic showing what your website makes readable to AI agents.",
    );
    expect(head.canonical).toBe("https://agentify.ad");
    expect(head.meta("og:title")).toBe(head.title);
    expect(head.meta("og:image")).toBe("https://agentify.ad/opengraph-image");
    expect(head.meta("twitter:card")).toBe("summary_large_image");
  });

  it("tells a crawler what the site is", async () => {
    const { html } = await page("/");
    const graph = JSON.parse(
      html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1] ?? "{}",
    ) as { "@graph"?: { "@type": string; url?: string }[] };

    expect(graph["@graph"]?.find((node) => node["@type"] === "Organization")?.url).toBe(
      "https://agentify.ad/",
    );
  });
});

describe("the landings for a kind of business", () => {
  it.each([
    ["/store", LANDINGS.store, "Agent-readiness diagnostic for online stores · Agentify"],
    ["/local", LANDINGS.local, "Website diagnostic for local businesses · Agentify"],
  ])(
    "%s offers the scan for its segment, under its own title and address",
    async (path, landing, title) => {
      const { html, title: drawn, canonical, meta } = await page(path);

      expect(html).toContain(`data-agentify-landing-segment="${landing.segment}"`);
      expect(html).toContain(`data-agentify-landing-variant="${landing.variant}"`);
      expect(html).toContain(landing.hero.cta);
      expect(drawn).toBe(title);
      expect(meta("og:title")).toBe(title);
      expect(canonical).toBe(`https://agentify.ad${path}`);
    },
  );
});

describe("the methodology", () => {
  it("is the trust page about how the scan works, with the doors to the documentation and the dashboard", async () => {
    const { html, links } = await page("/methodology");

    expect(html).toContain("How the agent-readiness scan works");
    expect(links).toContain("/docs/");
    expect(links).toContain("/dashboard/sign-in");
  });

  it("carries its title after the site's name and its own address", async () => {
    const head = await page("/methodology");

    expect(head.title).toBe("Methodology · Agentify");
    expect(head.meta("description")).toBe(
      "How the Agentify public-HTTP agent-readiness diagnostic works and its limits.",
    );
    expect(head.canonical).toBe("https://agentify.ad/methodology");
  });
});

describe("every page", () => {
  it.each(["/", "/store", "/local", "/methodology", "/no-such-page"])(
    "is drawn with the consent banner up until the visitor chooses: %s",
    async (path) => {
      const answered = await ask(path);
      const html = await answered.text();

      expect(html).toContain('aria-label="Privacy choices"');
      expect(html).toContain("Allow optional analytics");
      expect(html).toContain('<html lang="en-US">');
    },
  );
});
