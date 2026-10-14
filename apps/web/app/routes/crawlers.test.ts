/**
 * What the site tells crawlers and language models, asked of the whole process
 * over HTTP and read with the scanner's own parsers, the way it reads any
 * other site: robots.txt, the sitemap it names, and llms.txt.
 */

import { parseRobots, parseSitemap } from "@agentify/scanner";
import { DOCS_PAGES, docsAddress } from "@agentify/ui/docs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PUBLIC_PAGE_METADATA, PUBLIC_PAGE_PATHS } from "../../content/public-page-metadata";
import { ask } from "../../testing/scanner";

const ORIGIN = "https://agentify.ad";

beforeEach(() => {
  vi.stubEnv("APP_BASE_URL", ORIGIN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const KEPT_AN_HOUR = "public, max-age=3600, stale-while-revalidate=86400";

describe("robots.txt", () => {
  it("is a policy that parses whole, as text a cache may keep for an hour", async () => {
    const answered = await ask("/robots.txt");

    expect(answered.status).toBe(200);
    expect(answered.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(answered.headers.get("cache-control")).toBe(KEPT_AN_HOUR);
    expect(parseRobots(await answered.text())).toMatchObject({
      fatal: false,
      contentSignalMalformed: false,
    });
  });

  it("names the sitemap at its canonical address, and the scanner answers there", async () => {
    const { sitemaps } = parseRobots(await (await ask("/robots.txt")).text());

    expect(sitemaps).toEqual([`${ORIGIN}/sitemap.xml`]);
    expect((await ask(new URL(sitemaps[0] ?? "").pathname)).status).toBe(200);
  });
});

describe("the sitemap", () => {
  it("lists exactly the public pages, the page about selling to agents and every page of the documentation, with honest dates", async () => {
    const answered = await ask("/sitemap.xml");
    const sitemap = parseSitemap(await answered.text());
    const now = Date.now();

    expect(answered.headers.get("content-type")).toMatch(/^application\/xml\b/);
    expect(answered.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(sitemap).toMatchObject({ valid: true, isIndex: false });
    expect(sitemap.urls).toEqual([
      ...PUBLIC_PAGE_PATHS.map((path) => `${ORIGIN}${path}`),
      `${ORIGIN}/agentic-shop`,
      ...DOCS_PAGES.map((page) => `${ORIGIN}${docsAddress(page.path)}`),
    ]);
    // The list above is the documentation's own, so a page of each kind is named too.
    expect(sitemap.urls).toContain(`${ORIGIN}/docs/scanner`);
    expect(sitemap.urls).toContain(`${ORIGIN}/docs/money`);
    expect(sitemap.lastmods.slice(0, PUBLIC_PAGE_PATHS.length)).toEqual(
      PUBLIC_PAGE_PATHS.map((path) => PUBLIC_PAGE_METADATA[path].lastModified),
    );
    for (const lastmod of sitemap.lastmods) {
      expect(Number.isNaN(Date.parse(lastmod)), lastmod).toBe(false);
      expect(Date.parse(lastmod), lastmod).toBeLessThanOrEqual(now);
    }
  });
});

describe("llms.txt", () => {
  it("introduces the site under its name with links to its public pages, as text a cache may keep for an hour", async () => {
    const answered = await ask("/llms.txt");
    const body = await answered.text();

    expect(answered.status).toBe(200);
    expect(answered.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(answered.headers.get("cache-control")).toBe(KEPT_AN_HOUR);
    expect(body).toMatch(/^# Agentify$/m);
    for (const path of PUBLIC_PAGE_PATHS) expect(body).toContain(`(${ORIGIN}${path})`);
  });
});

describe("the crawlers' texts", () => {
  it.each(["/robots.txt", "/sitemap.xml", "/llms.txt"])("are read alone: %s", async (path) => {
    expect((await ask(path, { method: "POST" })).status).toBe(405);
  });
});
