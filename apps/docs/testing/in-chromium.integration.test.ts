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
 * documentation answered at before lead on; so do the scanner's addresses
 * for its pages that are now the documentation's, the one in its user agent
 * among them; and a visit is measured only as its visitor chose, one choice
 * holding on the scanner's pages and the documentation's alike.
 *
 * It needs the build (`pnpm --filter @agentify/docs build`) and Playwright's
 * Chromium.
 */

import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  CONSENT_POLICY_VERSION,
  CONSENT_STORAGE_KEY,
  createConsentSnapshot,
} from "@agentify/analytics/browser";
import { SURFACE_WORDS } from "@agentify/core";
import { precompressedFrom } from "@agentify/ui/assets";
import { firstVisitScripts, type ViteManifest } from "@agentify/ui/budget";
import { launchChromium } from "@agentify/ui/chromium";
import { DOCS_PAGES, docsAddress } from "@agentify/ui/docs";
import type { Browser, BrowserContext, Page, Request } from "playwright";
import type { ServerBuild } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUILT, CHANNELS, type Edge, standEdge } from "./edge.js";

/**
 * The scanner as it is built, standing behind the edge for every address
 * outside `/docs` as it stands behind Caddy, its pages coming alive in the
 * browser as they do on the site. It needs `pnpm --filter @agentify/web
 * build`; its pages read the scanner's settings, which name a database that
 * nothing here asks.
 */
const SCANNER = fileURLToPath(new URL("../../web/dist", import.meta.url));
process.env.DATABASE_URL ??= "postgresql://nobody:unused@127.0.0.1:1/nowhere";
const { scannerApp } = (await import(pathToFileURL(join(SCANNER, "server", "index.js")).href)) as {
  scannerApp: (parts: {
    assets: Awaited<ReturnType<typeof precompressedFrom>>;
    mode: "production";
  }) => (request: IncomingMessage, response: ServerResponse) => void;
};

/**
 * Where this stand's measurements go: a PostHog and a Meta pixel named for
 * the environment it runs in, answered by nothing but the browser's own
 * routing, so every request a page makes to them is seen and none leaves the
 * machine.
 */
const POSTHOG = "https://posthog.test.invalid";
const META = "https://connect.facebook.net";
const MEASURED = {
  ANALYTICS_RUNTIME_ENV: "test",
  POSTHOG_BROWSER_KEY: "docs-browser-test",
  POSTHOG_BROWSER_HOST: POSTHOG,
  POSTHOG_DESTINATION_ENV: "test",
  META_PIXEL_ID: "1234567890",
  META_DESTINATION_ENV: "test",
};

/**
 * A person's browser: PostHog drops what a browser naming itself headless, or
 * driven by a tool, sends. The CI runner's Chromium also names itself
 * HeadlessChrome among its brands, which PostHog reads as well as the user
 * agent, so the brands are a person's Chrome too.
 */
const asAPerson = (context: BrowserContext) =>
  context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false });
    type Hints = { brands: ReadonlyArray<{ brand: string; version: string }> };
    const hints = (navigator as Navigator & { userAgentData?: Hints }).userAgentData;
    if (hints === undefined) return;
    const brands = hints.brands.map(({ brand, version }) => ({
      brand: brand.replace("HeadlessChrome", "Google Chrome"),
      version,
    }));
    // Every read of the hints makes a new object, so the brands are replaced
    // where each of them reads its own.
    Object.defineProperty(Object.getPrototypeOf(hints), "brands", { get: () => brands });
  });
const PERSON =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";

/** A visitor's choice as the banner keeps it in the browser. */
const choiceOf = (allowed: boolean): string =>
  JSON.stringify(
    createConsentSnapshot({
      policy: {
        policyVersion: CONSENT_POLICY_VERSION,
        requireOptInForAdsMeasurement: true,
        requireOptInForProductAnalytics: true,
      },
      decisions: { product_analytics: allowed, ads_measurement: allowed },
      source: "banner",
    }),
  );

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
  const scanner = scannerApp({
    assets: await precompressedFrom(join(SCANNER, "client", "assets")),
    mode: "production",
  });
  edge = await standEdge({
    environment: { ...CHANNELS.test, ...MEASURED },
    heard: (request) => reached.push(request),
    upstream: scanner,
  });
  browser = await launchChromium();
});

afterAll(async () => {
  await browser?.close();
  await edge?.close();
});

type Visit = Readonly<{ page: Page; complaints: string[]; asked: string[] }>;

/** A browser with nothing kept, on `path`, with what it complained of and what it asked for. */
/**
 * A browser with nothing kept, on `path`, with what it complained of and what
 * it asked for. Unless `chosen` is false, its visitor has already chosen to
 * keep optional measuring off, so the banner is not over the page. `arranged`
 * prepares the browser before the page is asked for.
 */
const visit = async (
  path: string,
  viewport = { width: 1280, height: 900 },
  phone = false,
  chosen = true,
  arranged: (context: BrowserContext) => Promise<unknown> = async () => {},
): Promise<Visit> => {
  const context = await browser.newContext({
    viewport,
    isMobile: phone,
    hasTouch: phone,
    userAgent: PERSON,
  });
  await asAPerson(context);
  await arranged(context);
  if (chosen) {
    await context.addInitScript(
      ([key, value]) => {
        if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
      },
      [CONSENT_STORAGE_KEY, choiceOf(false)] as const,
    );
  }
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

/** The scripts the speed budget counts for a first visit to a page of the documentation. */
const firstVisitScriptsOfAPage = (): string[] =>
  [...firstVisitScripts(build, viteManifest, "routes/page")].map((file) => `/docs/${file}`).sort();

/** The documentation's own scripts among the addresses a page asked for. */
const scriptsAmong = (asked: readonly string[]): string[] =>
  asked.filter((path) => path.startsWith("/docs/assets/") && path.endsWith(".js")).sort();

const stayed = (page: Page): Promise<boolean | undefined> =>
  page.evaluate(() => (window as Window & { stayed?: boolean }).stayed);

/** The page's heading once the page at `path` is drawn, its contents marking it as the one on screen. */
const drawn = async (page: Page, path: string): Promise<string> => {
  await page.waitForURL(`${edge.origin}${path}`);
  await page
    .locator(`.docs-aside a[aria-current="page"][href="${path}"]`)
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

    expect(scriptsAmong(asked)).toEqual(firstVisitScriptsOfAPage());
    await page.context().close();
  });

  it("loads no code of a measuring service on a first visit, which waits for the visitor's choice", async () => {
    for (const script of firstVisitScriptsOfAPage()) {
      const code = await readFile(join(BUILT, script.replace(/^\/docs\//, "")), "utf8");
      expect(code, script).not.toContain("fbevents.js");
      expect(code, script).not.toContain("api_host");
    }
  });

  it("draws every diagram of the orders page as a named, described picture, running no diagram code", async () => {
    const { page, asked } = await visit("/docs/orders");

    expect(await page.locator("figure.diagram svg").count()).toBe(3);
    for (const diagram of await page.locator("figure.diagram svg").all()) {
      const accessible = await diagram.evaluate((element) => {
        const texts = (attribute: string, tag: string) => {
          const ids = element.getAttribute(attribute)?.trim().split(/\s+/) ?? [];
          return ids.map(
            (id) => element.querySelector(`${tag}[id="${id}"]`)?.textContent?.trim() ?? "",
          );
        };
        return {
          name: texts("aria-labelledby", "title"),
          description: texts("aria-describedby", "desc"),
        };
      });
      for (const [kind, texts] of Object.entries(accessible)) {
        expect(texts.length, kind).toBeGreaterThan(0);
        expect(texts.every(Boolean), kind).toBe(true);
      }
      expect(accessible.description.join(" ")).not.toBe(accessible.name.join(" "));
    }
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
    const input = page.getByRole("combobox", { name: "Search the documentation" });
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

  it("is a combobox a screen reader follows, keeps Tab inside, and hands the focus back on Escape", async () => {
    const { page } = await visit("/docs/");
    const button = page.locator(".docs-aside .docs-search-button");
    await button.focus();
    await page.keyboard.press("Enter");
    const input = page.getByRole("combobox", { name: "Search the documentation" });
    await input.fill("refusal codes");
    await page.getByRole("option").first().waitFor();

    expect(await input.getAttribute("aria-activedescendant")).toBe("search-result-0");
    await page.keyboard.press("ArrowDown");
    expect(await input.getAttribute("aria-activedescendant")).toBe("search-result-1");
    expect(await page.locator("#search-result-1").getAttribute("aria-selected")).toBe("true");
    await page.keyboard.press("Tab");
    expect(await input.evaluate((element) => element === document.activeElement)).toBe(true);
    await page.keyboard.press("Escape");
    await input.waitFor({ state: "detached" });
    await page.waitForFunction(() =>
      document.activeElement?.classList.contains("docs-search-button"),
    );
    await page.context().close();
  });

  it("says it could not load, rather than loading forever, and loads when opened again", async () => {
    const { page } = await visit("/docs/");
    let refused = true;
    await page.route("**/docs/search-index.json", (route) =>
      refused ? route.fulfill({ status: 503, body: "" }) : route.continue(),
    );
    await page.keyboard.press("/");
    await page.getByText("The search could not be loaded").waitFor();

    refused = false;
    await page.keyboard.press("Escape");
    await page.keyboard.press("/");
    await page.getByRole("combobox").fill("metamask");
    await page.getByRole("option").first().waitFor();
    await page.context().close();
  });

  it("says when nothing matches, where a screen reader reads it out", async () => {
    const { page } = await visit("/docs/");
    await page.keyboard.press("/");
    await page.getByRole("combobox").fill("zzqqxx");

    await page
      .getByRole("dialog", { name: "Search the documentation" })
      .getByRole("status")
      .getByText("Nothing in the documentation matches")
      .waitFor();
    await page.context().close();
  });

  it("keeps the result the arrows reach in sight", async () => {
    const { page } = await visit("/docs/", { width: 390, height: 640 }, true);
    await page.locator(".docs-bar .docs-search-button").click();
    await page.getByRole("combobox").fill("order");
    await page.locator("#search-result-11").waitFor();
    for (let press = 0; press < 11; press += 1) await page.keyboard.press("ArrowDown");

    const list = await page.locator(".search-results").boundingBox();
    const reached = await page.locator("#search-result-11").boundingBox();
    expect(reached?.y ?? 0).toBeGreaterThanOrEqual(list?.y ?? 0);
    expect((reached?.y ?? 0) + (reached?.height ?? 0)).toBeLessThanOrEqual(
      (list?.y ?? 0) + (list?.height ?? 0) + 1,
    );
    await page.context().close();
  });

  it("hands the focus to the heading of a result on the page being read", async () => {
    const { page } = await visit("/docs/orders");
    await page.keyboard.press("/");
    await page.getByRole("combobox").fill("tracking number");
    const first = page.locator(".search-results a").first();
    await first.waitFor();
    const anchor = ((await first.getAttribute("href")) ?? "").split("#")[1] ?? "";
    expect(anchor).not.toBe("");

    await page.keyboard.press("Enter");
    await page.waitForFunction((id) => document.activeElement?.id === id, anchor);
    await page.context().close();
  });
});

describe("a move between pages", () => {
  it("lands at the new page's top at once and gives its heading the focus", async () => {
    const { page } = await visit("/docs/money");
    await page.evaluate(() => window.scrollTo({ top: 1200, behavior: "instant" }));
    await contents(page).getByRole("link", { name: "Orders and fulfillment modes" }).click();
    await drawn(page, "/docs/orders");

    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await page.waitForFunction(() => document.activeElement === document.querySelector(".doc h1"));
    await page.context().close();
  });

  it("that fails says the page could not be loaded, not that there is none", async () => {
    const { page } = await visit("/docs/money");
    await page.route("**/docs/orders.data", (route) => route.fulfill({ status: 500, body: "" }));
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await contents(page).getByRole("link", { name: "Orders and fulfillment modes" }).click();

    await page.getByRole("heading", { name: "This page could not be loaded" }).waitFor();
    expect(await page.getByText("There is no such page").count()).toBe(0);
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

    // A section followed from the outline is not left under the bar.
    const section = outline.getByRole("link").nth(3);
    const id = ((await section.getAttribute("href")) ?? "").slice(1);
    await section.click();
    await page.waitForFunction((target) => {
      const heading = document.getElementById(target);
      return heading !== null && Math.abs(heading.getBoundingClientRect().top - 136) < 4;
    }, id);
    const barBottom = await bar.evaluate((element) => element.getBoundingClientRect().bottom);
    const headingTop = await page
      .locator(`[id="${id}"]`)
      .evaluate((element) => element.getBoundingClientRect().top);
    expect(headingTop).toBeGreaterThan(barBottom);

    await bar.getByText("On this page").click();
    await outline.getByRole("link", { name: "Return to top" }).click();
    await page.waitForFunction(() => window.scrollY === 0);
    await bar.locator(".docs-search-button").click();
    await page.getByRole("combobox").waitFor();
    await page.context().close();
  });
});

describe("on a tablet", () => {
  it("reads the article at its whole measure, with the search and the sections in the bar and the pages in the menu", async () => {
    const { page } = await visit("/docs/orders", { width: 768, height: 1024 });
    const article = await page.locator("article").boundingBox();

    // The page's whole width inside its margins, as today's portal gives it.
    expect(article?.width).toBeGreaterThanOrEqual(680);
    expect(await page.locator(".docs-aside").isVisible()).toBe(false);
    expect(await page.locator(".docs-bar .docs-search-button").isVisible()).toBe(true);
    await page.locator(".site-menu > summary").click();
    expect(
      await page
        .getByRole("navigation", { name: "Documentation pages" })
        .getByRole("link", { name: "Money", exact: true })
        .isVisible(),
    ).toBe(true);
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

describe("the documentation's canonical addresses", () => {
  it.each(DOCS_PAGES.filter((page) => page.path !== "/"))(
    "permanently redirects a trailing slash on $path, keeping the query",
    async (page) => {
      const address = docsAddress(page.path);
      const query = "?source=a%2Bb&count=2";
      const answered = await fetch(`${edge.origin}${address}/${query}`, { redirect: "manual" });

      expect(answered.status).toBe(308);
      expect(answered.headers.get("location")).toBe(`${address}${query}`);
      const canonical = await fetch(`${edge.origin}${answered.headers.get("location")}`);
      expect(canonical.status).toBe(200);
    },
  );

  it("keeps the documentation root and refuses a missing page instead of redirecting it", async () => {
    const root = await fetch(`${edge.origin}/docs/`, { redirect: "manual" });
    expect(root.status).toBe(200);
    expect(root.headers.get("location")).toBeNull();

    for (const path of [
      "/docs/no-such-page/",
      "/docs/assets/no-such-file/",
      "/docs/index/",
      "/docs/404/",
    ]) {
      const missing = await fetch(`${edge.origin}${path}`, { redirect: "manual" });
      expect(missing.status).toBe(404);
      expect(missing.headers.get("location")).toBeNull();
    }
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

/** The events a request to PostHog carries, however PostHog chose to pack them. */
const eventsIn = (
  request: Request,
): Array<{ event: string; properties: Record<string, unknown> }> => {
  const body = request.postDataBuffer();
  if (body === null) return [];
  let text = (body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body).toString("utf8");
  if (text.startsWith("data=")) {
    text = Buffer.from(decodeURIComponent(text.slice(5)), "base64").toString("utf8");
  }
  const packed = JSON.parse(text) as unknown;
  return (Array.isArray(packed) ? packed : [packed]) as ReturnType<typeof eventsIn>;
};

type Measuring = Readonly<{ elsewhere: string[]; views: string[] }>;

/**
 * What a page asked of the measuring services, its consent recorded as the
 * scanner records it: every address it asked of a host other than the edge,
 * and the page each view PostHog was sent names.
 */
const measured = async (context: BrowserContext): Promise<Measuring> => {
  const elsewhere: string[] = [];
  const views: string[] = [];
  context.on("request", (request) => {
    if (new URL(request.url()).origin !== edge.origin) elsewhere.push(request.url());
  });
  await context.route(`${POSTHOG}/**`, (route) => {
    for (const { event, properties } of eventsIn(route.request())) {
      if (event === "$pageview") views.push(new URL(String(properties.$current_url)).pathname);
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await context.route(`${META}/**`, (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: "" }),
  );
  // The route's own answer, which needs a database, is held by its integration
  // test; here the browser is answered as the route answers a saved choice.
  await context.route("**/api/v1/consent", (route) =>
    route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ status: "saved", policy_version: CONSENT_POLICY_VERSION }),
    }),
  );
  return { elsewhere, views };
};

/** A first visit to `path`, watched from before the page is asked for, by a visitor who has not chosen yet. */
const firstVisit = async (path: string): Promise<Visit & Measuring> => {
  let measuring: Measuring = { elsewhere: [], views: [] };
  const visited = await visit(path, undefined, false, false, async (context) => {
    measuring = await measured(context);
  });
  return { ...visited, ...measuring };
};

/**
 * The page views the Meta pixel was told of. The pixel's script is answered
 * empty here, so what the page told it stays in the pixel's queue.
 */
const metaViews = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      ((window as Window & { fbq?: { queue?: unknown[][] } }).fbq?.queue ?? []).filter(
        ([kind, name]) => kind === "track" && name === "PageView",
      ).length,
  );

describe("measuring a visit", () => {
  it("asks on a first visit, and sends nothing and loads nothing to measure before a choice", async () => {
    const { page, asked, elsewhere } = await firstVisit("/docs/money");
    const banner = page.getByRole("complementary", { name: "Privacy choices" });

    expect(await banner.isVisible()).toBe(true);
    await contents(page).getByRole("link", { name: "Orders and fulfillment modes" }).click();
    await drawn(page, "/docs/orders");
    await page.waitForTimeout(500);

    expect(elsewhere).toEqual([]);
    expect(scriptsAmong(asked)).toEqual(firstVisitScriptsOfAPage());
    expect(await banner.isVisible()).toBe(true);
    await page.context().close();
  });

  it("counts one view of the page a visitor allowed it on and one of every page they move to", async () => {
    const { page, views } = await firstVisit("/docs/money");

    await page.getByRole("button", { name: "Allow optional analytics" }).click();
    await expect.poll(() => views.length, { timeout: 10_000 }).toBe(1);
    await contents(page).getByRole("link", { name: "Orders and fulfillment modes" }).click();
    await drawn(page, "/docs/orders");
    await expect.poll(() => views.length, { timeout: 10_000 }).toBe(2);
    await page.waitForTimeout(500);

    expect(views).toEqual(["/docs/money", "/docs/orders"]);
    expect(await metaViews(page)).toBe(2);
    expect(await stayed(page)).toBe(true);
    await page.context().close();
  });

  it("counts the page a visitor allowed it on by that page's address though they move on at once, and counts no page twice", async () => {
    const { page, views } = await firstVisit("/docs/money");
    // The code that measures arrives only after the visitor has moved on, as on a slow line.
    await page.context().route("**/assets/page-view-*.js", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await route.continue();
    });

    await page.getByRole("button", { name: "Allow optional analytics" }).click();
    await contents(page).getByRole("link", { name: "Orders and fulfillment modes" }).click();
    await drawn(page, "/docs/orders");
    await expect.poll(() => views.length, { timeout: 10_000 }).toBe(2);
    await page.locator("footer").getByRole("button", { name: "Privacy choices" }).click();
    await page.getByRole("button", { name: "Save choices" }).click();
    await page.getByRole("dialog", { name: "Privacy choices" }).waitFor({ state: "detached" });
    await page.waitForTimeout(1_000);

    expect(views.toSorted()).toEqual(["/docs/money", "/docs/orders"]);
    expect(await metaViews(page)).toBe(2);
    await page.context().close();
  });

  it("records nothing and loads nothing to measure after a visitor kept optional measuring off, a move included", async () => {
    const { page, asked, elsewhere } = await firstVisit("/docs/money");

    await page.getByRole("button", { name: "Essential only" }).click();
    await page
      .getByRole("complementary", { name: "Privacy choices" })
      .waitFor({ state: "detached" });
    await contents(page).getByRole("link", { name: "Orders and fulfillment modes" }).click();
    await drawn(page, "/docs/orders");
    await page.waitForTimeout(1_000);

    expect(elsewhere).toEqual([]);
    expect(scriptsAmong(asked)).toEqual(firstVisitScriptsOfAPage());
    await page.context().close();
  });

  it.each([
    ["the documentation's", "/docs/money"],
    ["the scanner's", "/privacy"],
  ])(
    "shows %s banner before the page's script runs only to a visitor who has not chosen",
    async (_whose, path) => {
      for (const chosen of [false, true]) {
        // The page as it stands until its script runs, which here it never does.
        const { page } = await visit(path, undefined, false, chosen, (context) =>
          context.route(/\.js(?:\?|$)/, (route) => route.abort()),
        );
        const banner = page.getByRole("complementary", {
          name: "Privacy choices",
          includeHidden: true,
        });

        expect(await banner.count(), `chosen: ${chosen}`).toBe(1);
        expect(await banner.isVisible(), `chosen: ${chosen}`).toBe(!chosen);
        await page.context().close();
      }
    },
  );

  it("asks again, in a tab open on a page, a visitor whose choice is withdrawn in another tab", async () => {
    const { page } = await visit("/docs/money");
    const banner = page.getByRole("complementary", { name: "Privacy choices" });
    expect(await banner.isVisible()).toBe(false);

    const other = await page.context().newPage();
    await other.goto(`${edge.origin}/docs/faq`);
    await other.evaluate((key) => window.localStorage.removeItem(key), CONSENT_STORAGE_KEY);

    await banner.waitFor({ state: "visible" });
    await page.context().close();
  });

  it.each([
    ["the contents column on a wide screen", { width: 1440, height: 760 }, false],
    ["the page's sections on a phone", { width: 390, height: 844 }, true],
  ])("keeps the end of %s clear of the banner that asks", async (_what, viewport, phone) => {
    const { page } = await visit("/docs/orders", viewport, phone, false);
    const banner = page.getByRole("complementary", { name: "Privacy choices" });
    await page.waitForFunction(
      () =>
        getComputedStyle(document.documentElement).getPropertyValue("--consent-banner-height") !==
        "0px",
    );
    // Read further down, where the column and the bar stay in place as the page scrolls.
    await page.evaluate(() => window.scrollTo({ top: 1200, behavior: "instant" }));
    if (phone) await page.locator(".docs-bar").getByText("On this page").click();
    const list = page.locator(phone ? ".docs-bar .docs-outline nav" : ".docs-aside");
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const last = await list.locator("a").last().boundingBox();
    const asking = await banner.boundingBox();

    expect((last?.y ?? 0) + (last?.height ?? 0)).toBeLessThanOrEqual(asking?.y ?? 0);
    await page.context().close();
  });

  it("lays the search over the banner that asks, which cannot be reached past it", async () => {
    const { page } = await visit("/docs/orders", { width: 390, height: 844 }, true, false);
    const asking = await page.getByRole("complementary", { name: "Privacy choices" }).boundingBox();
    await page.locator(".docs-bar .docs-search-button").click();
    await page.getByRole("combobox").waitFor();

    const above = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.closest(".search-backdrop") !== null,
      [(asking?.x ?? 0) + 20, (asking?.y ?? 0) + 20] as const,
    );
    expect(above).toBe(true);
    await page.context().close();
  });

  it.each([
    ["the scanner's", "/privacy", "the documentation", "/docs/money"],
    ["the documentation's", "/docs/money", "the scanner's", "/privacy"],
  ])("holds a choice made on %s pages on %s pages", async (_where, from, _there, to) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await measured(context);
    await page.goto(`${edge.origin}${from}`);
    await page.getByRole("button", { name: "Essential only" }).click();
    await page
      .getByRole("complementary", { name: "Privacy choices" })
      .waitFor({ state: "detached" });

    await page.goto(`${edge.origin}${to}`);
    await page.waitForLoadState("networkidle");
    expect(await page.getByRole("complementary", { name: "Privacy choices" }).count()).toBe(0);
    await context.close();
  });

  it("opens the choices again from the foot of a page", async () => {
    const { page } = await visit("/docs/money");
    await page.locator("footer").getByRole("button", { name: "Privacy choices" }).click();

    await page.getByRole("dialog", { name: "Privacy choices" }).waitFor();
    await page.context().close();
  });
});
