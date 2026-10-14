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

describe("the owner landing's old address", () => {
  it.each([
    ["read", "/owner", "GET"],
    ["read with a query", "/owner?utm_source=a-link", "GET"],
    ["asked for its headers", "/owner", "HEAD"],
    ["posted to", "/owner", "POST"],
  ])("sends a visitor permanently to the front page when %s", async (_how, path, method) => {
    const answered = await ask(path, { method });

    expect(answered.status).toBe(308);
    expect(answered.headers.get("location")).toBe("/");
  });

  it("is a redirect no cache keeps, so a browser never loops on a stale one", async () => {
    const answered = await ask("/owner");

    expect(answered.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
    expect(answered.headers.get("x-frame-options")).toBe("DENY");
  });

  it("is not the owner's landing under a second address", async () => {
    const answered = await ask("/owner", { headers: { accept: "text/markdown" } });

    expect(answered.status).toBe(308);
    expect(answered.headers.get("location")).toBe("/");
    expect(await answered.text()).not.toContain("# ");
  });
});

describe("the scanner's pages that moved into the documentation", () => {
  it.each([
    ["/methodology", "/docs/scanner/methodology"],
    ["/scanner", "/docs/scanner"],
  ])("send %s on to %s, permanently and kept by nobody", async (path, moved) => {
    for (const method of ["GET", "HEAD", "POST"]) {
      const answered = await ask(path, { method });

      expect(answered.status, method).toBe(308);
      expect(answered.headers.get("location"), method).toBe(moved);
      expect(answered.headers.get("cache-control"), method).toBe(
        "private, no-cache, no-store, max-age=0, must-revalidate",
      );
    }
  });

  it("send a client that asks for Markdown on too, where the documentation answers it", async () => {
    const answered = await ask("/scanner", { headers: { accept: "text/markdown" } });

    expect(answered.status).toBe(308);
    expect(answered.headers.get("location")).toBe("/docs/scanner");
  });
});

describe("a trust page's header", () => {
  it("leads to the site's sections, the scanner's in the documentation, and the doors", async () => {
    const { html } = await page("/privacy");
    const header = html.match(/<header class="site-header">[\s\S]*?<\/header>/)?.[0] ?? "";

    for (const href of [
      "/agentic-shop",
      "/docs/scanner",
      "/docs/scanner/methodology",
      "/privacy",
      "/docs/",
      "/dashboard/sign-in",
    ]) {
      expect(header, href).toContain(`href="${href}"`);
    }
  });
});

describe("the trust pages", () => {
  it.each([
    [
      "/privacy",
      "Privacy and data controls",
      "Privacy · Agentify",
      "Privacy, retention, consent, processors, and data-control information for Agentify.",
    ],
    [
      "/terms",
      "Terms of use",
      "Terms · Agentify",
      "A public-HTTP diagnostic showing what your website makes readable to AI agents.",
    ],
  ])(
    "%s says what it is, under its own title and address",
    async (path, h1, title, description) => {
      const head = await page(path);

      expect(head.html).toMatch(new RegExp(`<h1[^>]*>${h1}</h1>`));
      expect(head.title).toBe(title);
      expect(head.meta("description")).toBe(description);
      expect(head.canonical).toBe(`https://agentify.ad${path}`);
    },
  );

  it("name the contacts this deployment is configured with", async () => {
    vi.stubEnv("APP_BASE_URL", "https://test.agentify.ad");
    vi.stubEnv("PRIVACY_EMAIL", "privacy@test.agentify.ad");
    vi.stubEnv("ABUSE_EMAIL", "abuse@test.agentify.ad");

    const terms = await page("/terms");
    const privacy = await page("/privacy");

    expect(terms.links).toContain("mailto:abuse@test.agentify.ad");
    expect(privacy.links).toContain("mailto:privacy@test.agentify.ad");
    expect(privacy.links).not.toContain("mailto:privacy@agentify.ad");
  });

  it("asks every crawler to index the terms and follow them, and no other trust page", async () => {
    expect((await page("/terms")).meta("robots")).toBe("index, follow");
    expect((await page("/privacy")).meta("robots")).toBeUndefined();
  });
});

describe("every page", () => {
  it.each(["/", "/store", "/local", "/privacy", "/terms", "/no-such-page"])(
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
