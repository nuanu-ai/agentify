/**
 * What Chromium does with the built documentation, served as the Caddyfile's
 * `/docs` block serves it (`edge.ts`), where only a browser can tell: every
 * page comes alive without a complaint and loads the scripts its budget
 * counts; the notice naming the channel and the values a deployment decides
 * stay the channel's after a move between pages, which the browser draws from
 * data Caddy did not fill; a click on a link whose page was fetched ahead asks
 * the network for nothing more; the search finds a page, shows the words it
 * was found by and keeps the query; the outline marks the section being read;
 * a phone reaches the pages and the page's sections; the addresses the
 * documentation answered at before lead on; and so do the scanner's
 * addresses for its pages that are now the documentation's, the one in its
 * user agent among them.
 *
 * It needs the build (`pnpm --filter @agentify/docs build`) and Playwright's
 * Chromium.
 */

import { readFile } from "node:fs/promises";
import { request as forward } from "node:http";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SURFACE_WORDS } from "@agentify/core";
import { firstVisitScripts, type ViteManifest } from "@agentify/ui/budget";
import { launchChromium } from "@agentify/ui/chromium";
import { DOCS_PAGES, docsAddress } from "@agentify/ui/docs";
import type { Browser, Page } from "playwright";
import type { ServerBuild } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUILT, CHANNELS, type Edge, standEdge } from "./edge.js";

/**
 * The scanner as its own tests run it, from source, standing behind the edge
 * for every address outside `/docs` as it stands behind Caddy. Imported by
 * its address, since it is another application's and compiled by its own
 * settings.
 */
const { testScanner } = (await import(
  String(new URL("../../web/testing/scanner.ts", import.meta.url))
)) as { testScanner: () => Promise<{ origin: string }> };

let browser: Browser;
let edge: Edge;
let build: ServerBuild;
let viteManifest: ViteManifest;
/** What reached the edge, as the server rather than the browser's cache tells it. */
const reached: string[] = [];

beforeAll(async () => {
  build = (await import(
    pathToFileURL(fileURLToPath(new URL("../dist/server/index.js", import.meta.url))).href
  )) as ServerBuild;
  viteManifest = JSON.parse(
    await readFile(join(BUILT, ".vite", "manifest.json"), "utf8"),
  ) as ViteManifest;
  const scanner = new URL((await testScanner()).origin);
  edge = await standEdge({
    environment: CHANNELS.test,
    heard: (request) => reached.push(request),
    upstream: (request, response) => {
      const upstream = forward(
        {
          host: scanner.hostname,
          port: scanner.port,
          path: request.url,
          method: request.method,
          headers: request.headers,
        },
        (answered) => {
          response.writeHead(answered.statusCode ?? 502, answered.headers);
          answered.pipe(response);
        },
      );
      request.pipe(upstream);
    },
  });
  browser = await launchChromium();
});

afterAll(async () => {
  await browser?.close();
  await edge?.close();
});

type Visit = Readonly<{ page: Page; complaints: string[]; asked: string[] }>;

/** A browser with nothing kept, on `path`, with what it complained of and what it asked for. */
const visit = async (
  path: string,
  viewport = { width: 1280, height: 900 },
  phone = false,
): Promise<Visit> => {
  const context = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone });
  const page = await context.newPage();
  const complaints: string[] = [];
  const asked: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") complaints.push(message.text());
  });
  page.on("pageerror", (error) => complaints.push(error.message));
  page.on("request", (request) => asked.push(new URL(request.url()).pathname));
  const answered = await page.goto(`${edge.origin}${path}`);
  expect(answered?.status()).toBe(200);
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => {
    (window as Window & { stayed?: boolean }).stayed = true;
  });
  return { page, complaints, asked };
};

const stayed = (page: Page): Promise<boolean | undefined> =>
  page.evaluate(() => (window as Window & { stayed?: boolean }).stayed);

/** The page's heading once the page at `path` is drawn, its contents marking it as the one on screen. */
const drawn = async (page: Page, path: string): Promise<string> => {
  await page.waitForURL(`${edge.origin}${path}`);
  await page
    .locator(`.docs-aside a[aria-current="page"][href="${path === "/docs/" ? "/docs" : path}"]`)
    .waitFor({ state: "attached" });
  return (await page.locator(".doc h1").textContent()) ?? "";
};

const contents = (page: Page) =>
  page.getByRole("navigation", { name: "Documentation", exact: true });

describe("a page of the documentation in Chromium", () => {
  it.each(DOCS_PAGES.map((page) => docsAddress(page.path)))(
    "comes alive without a complaint and moves to another page without a reload: %s",
    async (address) => {
      const { page, complaints } = await visit(address);
      const other = address === "/docs/money" ? "/docs/faq" : "/docs/money";

      await contents(page)
        .getByRole("link", { name: other === "/docs/faq" ? "Common questions" : "Money" })
        .click();
      await drawn(page, other);
      expect(await stayed(page)).toBe(true);
      expect(complaints).toEqual([]);
      await page.context().close();
    },
  );

  it("loads the scripts the speed budget counts for it on a first visit, no more and no fewer", async () => {
    const { page, asked } = await visit("/docs/orders");

    expect(
      asked.filter((path) => path.startsWith("/docs/assets/") && path.endsWith(".js")).sort(),
    ).toEqual(
      [...firstVisitScripts(build, viteManifest, "routes/page")]
        .map((file) => `/docs/${file}`)
        .sort(),
    );
    await page.context().close();
  });

  it("draws every diagram of the orders page as a picture, running no diagram code", async () => {
    const { page, asked } = await visit("/docs/orders");

    expect(await page.locator("figure.diagram svg").count()).toBe(3);
    expect(asked.filter((path) => /mermaid/i.test(path))).toEqual([]);
    await page.context().close();
  });
});

describe("what Caddy fills in", () => {
  it("names the channel once, in its own words, after a move as on arrival", async () => {
    const { page, complaints } = await visit("/docs/money");
    const words = () => page.locator(".surface-words").allTextContents();

    expect(await words()).toEqual([SURFACE_WORDS.test]);
    await contents(page).getByRole("link", { name: "Orders and fulfillment modes" }).click();
    await drawn(page, "/docs/orders");
    await page.locator('a[rel="next"]').click();
    await drawn(page, "/docs/failures");

    expect(await stayed(page)).toBe(true);
    expect(await words()).toEqual([SURFACE_WORDS.test]);
    expect(await page.locator("body").innerText()).not.toContain(
      SURFACE_WORDS.sandbox ?? "Sandbox",
    );
    expect(complaints).toEqual([]);
    await page.context().close();
  });

  it("names the channel's own address and contact on a page reached by a move", async () => {
    const { page } = await visit("/docs/money");
    await contents(page).getByRole("link", { name: "About agentify-scanner" }).click();
    await drawn(page, "/docs/scanner");
    const article = (await page.locator("article").textContent()) ?? "";

    expect(await stayed(page)).toBe(true);
    expect(article).toContain("agentify-scanner/1.0 (+https://test.agentify.ad/scanner)");
    expect(article).toContain("abuse@test.agentify.ad");
    expect(article).toContain("The final legal identity is not published yet.");
    expect(await page.locator('a[href="mailto:abuse@test.agentify.ad"]').count()).toBe(2);
    expect(await page.locator('link[rel="canonical"]').getAttribute("href")).toBe(
      "https://test.agentify.ad/docs/scanner",
    );
    expect(await page.content()).not.toMatch(/<!--\{\{|&lt;!--\{\{/);
    await page.context().close();
  });
});

describe("the browser observer", () => {
  it("is named on the test channel as it is sent, by the live site's address", async () => {
    const { page } = await visit("/docs/scanner");
    const article = (await page.locator("article").textContent()) ?? "";

    expect(article).toContain("agentify-browser-observer/1.0 (+https://agentify.ad/scanner)");
    expect(article).not.toContain("agentify-browser-observer/1.0 (+https://test.agentify.ad");
    await page.context().close();
  });
});

describe("a link whose page was fetched ahead", () => {
  it("is followed with nothing more asked of the edge", async () => {
    const { page } = await visit("/docs/money");
    await page.waitForFunction(() =>
      performance
        .getEntriesByType("resource")
        .some((entry) => entry.name.endsWith("/docs/orders.data")),
    );
    await page.waitForLoadState("networkidle");
    const before = reached.length;

    await contents(page).getByRole("link", { name: "Orders and fulfillment modes" }).click();
    await drawn(page, "/docs/orders");

    expect(reached.slice(before)).toEqual([]);
    await page.context().close();
  });
});

describe("the search", () => {
  it("finds a page, shows the words it was found by, and keeps the query", async () => {
    const { page } = await visit("/docs/");
    await page.keyboard.press("/");
    const input = page.getByRole("searchbox", { name: "Search the documentation" });
    await input.fill("tracking number");
    const first = page.locator(".search-results a").first();
    await first.waitFor();

    expect(await first.getAttribute("href")).toMatch(/^\/docs\/orders#/);
    expect(await page.locator(".search-results mark").count()).toBeGreaterThan(0);
    expect(
      (await page.locator(".search-results mark").first().textContent())?.toLowerCase(),
    ).toMatch(/^(tracking|number)$/);

    await page.keyboard.press("Enter");
    await page.waitForURL(/\/docs\/orders#/);
    await page.locator(".docs-aside .docs-search-button").click();
    expect(await input.inputValue()).toBe("tracking number");

    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.keyboard.press("/");
    expect(await input.inputValue()).toBe("tracking number");
    await page.context().close();
  });

  it("says when nothing matches", async () => {
    const { page } = await visit("/docs/");
    await page.keyboard.press("/");
    await page.getByRole("searchbox").fill("zzqqxx");

    await page.getByText("Nothing in the documentation matches").waitFor();
    await page.context().close();
  });
});

describe("the outline", () => {
  it("marks the section being read as the page scrolls, and none at its top", async () => {
    const { page } = await visit("/docs/orders");
    const marked = () =>
      page.locator('.docs-aside .docs-sections a[aria-current="location"]').allTextContents();
    const headings = await page.locator(".doc h2").evaluateAll((all) =>
      all.map((heading) => ({
        id: heading.id,
        title: heading.textContent?.replace(/[\s\u200b]+$/, "") ?? "",
      })),
    );
    const third = headings[2];
    if (third === undefined) throw new Error("the orders page has fewer than three sections");

    expect(await marked()).toEqual([]);
    await page.evaluate((id) => {
      const heading = document.getElementById(id);
      window.scrollTo({
        top: (heading?.getBoundingClientRect().top ?? 0) + window.scrollY - 90,
        behavior: "instant",
      });
    }, third.id);
    await page.waitForFunction(
      (title) =>
        document.querySelector('.docs-aside .docs-sections a[aria-current="location"]')
          ?.textContent === title,
      third.title,
    );
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await page.waitForFunction(
      () =>
        document.querySelector('.docs-aside .docs-sections a[aria-current="location"]') === null,
    );
    await page.context().close();
  });
});

describe("on a phone", () => {
  const PHONE = { width: 390, height: 844 };

  it("reaches every page from the header's menu, the one on screen marked", async () => {
    const { page } = await visit("/docs/money", PHONE, true);
    await page.locator(".site-menu > summary").click();
    const pages = page.getByRole("navigation", { name: "Documentation pages" });

    for (const entry of DOCS_PAGES) {
      expect(
        await pages.getByRole("link", { name: entry.label, exact: true }).isVisible(),
        entry.label,
      ).toBe(true);
    }
    expect(await pages.locator('a[aria-current="page"]').textContent()).toBe("Money");
    await pages.getByRole("link", { name: "The product card" }).click();
    await drawn(page, "/docs/cards");
    expect(await stayed(page)).toBe(true);
    expect(await page.locator(".site-menu").getAttribute("open")).toBeNull();
    await page.context().close();
  });

  it("keeps the search and the page's sections under the header as the page scrolls", async () => {
    const { page } = await visit("/docs/orders", PHONE, true);
    await page.evaluate(() => window.scrollTo({ top: 3000, behavior: "instant" }));
    const bar = page.locator(".docs-bar");
    const header = await page.locator(".site-header").boundingBox();
    const placed = await bar.boundingBox();

    expect(placed?.y).toBeCloseTo((header?.y ?? 0) + (header?.height ?? 0), 0);
    await bar.getByText("On this page").click();
    const outline = bar.getByRole("navigation", { name: "On this page" });
    const sections = await page.locator(".doc h2").count();
    expect(await outline.getByRole("link").count()).toBe(sections + 1);
    expect(await outline.locator('a[aria-current="location"]').count()).toBe(1);

    await outline.getByRole("link", { name: "Return to top" }).click();
    await page.waitForFunction(() => window.scrollY === 0);
    await bar.locator(".docs-search-button").click();
    await page.getByRole("searchbox").waitFor();
    await page.context().close();
  });
});

describe("an address the documentation answered at before", () => {
  it.each([
    ["/docs/money.html", "/docs/money"],
    ["/docs/index.html", "/docs/"],
    ["/docs/scanner/methodology.html", "/docs/scanner/methodology"],
  ])("leads %s to %s", async (former, now) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const answered = await page.goto(`${edge.origin}${former}`);

    expect(answered?.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe(now);
    expect(answered?.request().redirectedFrom()?.url()).toBe(`${edge.origin}${former}`);
    await context.close();
  });

  it("answers a page it never had with the page that says so, as a 404", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const answered = await page.goto(`${edge.origin}/docs/no-such-page`);

    expect(answered?.status()).toBe(404);
    expect(await page.locator("h1").textContent()).toContain("There is no such page");
    await context.close();
  });
});

describe("a client that prefers Markdown", () => {
  it.each(DOCS_PAGES.map((page) => docsAddress(page.path)))(
    "is given the page's Markdown, filled for the channel: %s",
    async (address) => {
      const answered = await fetch(`${edge.origin}${address}`, {
        headers: { accept: "text/markdown, text/html;q=0.9" },
      });
      const text = await answered.text();

      expect(answered.status).toBe(200);
      expect(answered.headers.get("content-type")).toMatch(/^text\/markdown/);
      expect(answered.headers.get("vary")).toMatch(/Accept/);
      expect(text).toMatch(/^# \S/);
      expect(text).not.toContain("<!--{{");
      expect(text).not.toMatch(/\]\(\/(?!\/)/);
    },
  );
});

describe("the scanner's addresses for its pages in the documentation", () => {
  it.each([
    ["/scanner", "/docs/scanner", "About agentify-scanner"],
    ["/methodology", "/docs/scanner/methodology", "How the agent-readiness scan works"],
  ])("lead %s, which a user agent or an old link names, to %s", async (address, now, heading) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const answered = await page.goto(`${edge.origin}${address}`);

    expect(answered?.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe(now);
    expect(await page.locator(".doc h1").textContent()).toContain(heading);
    await context.close();
  });

  it("are where the scanner's header leads", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${edge.origin}/privacy`);
    await page.locator("header .site-nav a", { hasText: "Methodology" }).click();
    await page.waitForURL(`${edge.origin}/docs/scanner/methodology`);

    expect(await page.locator(".doc h1").textContent()).toContain(
      "How the agent-readiness scan works",
    );
    expect(await page.locator('.docs-aside a[aria-current="page"]').textContent()).toBe(
      "Methodology",
    );
    await context.close();
  });
});
