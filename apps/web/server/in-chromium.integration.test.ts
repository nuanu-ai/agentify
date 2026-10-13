/**
 * What Chromium does with the built scanner where only a browser can tell:
 * every page comes alive in the browser without a complaint, a click on a link
 * shows at once that it was taken and says the page is coming once it takes a
 * moment, a hover fetches a public page's data so the click needs nothing
 * more, the consent banner takes a choice without a reload, the merchant
 * landing's menu opens and closes, and behind the live channel's edge, as
 * `deploy/Caddyfile` routes it, the landing stays the page that says there is
 * none once the browser takes the page over. The headers that promise the
 * caching are held offline in `answers.test.ts`.
 *
 * It needs the build (`pnpm --filter @agentify/web build`) and Playwright's
 * Chromium. The consent route's own answer, which needs a database, is held by
 * its integration test; here the browser is answered as the route answers a
 * saved choice, so what is seen is the banner's.
 */

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CONSENT_STORAGE_KEY } from "@agentify/analytics/browser";
import { precompressedFrom } from "@agentify/ui/assets";
import { firstVisitScripts, type ViteManifest } from "@agentify/ui/budget";
import { launchChromium } from "@agentify/ui/chromium";
import express from "express";
import type { Browser, Page } from "playwright";
import type { ServerBuild } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScannerParts } from "./app";

const DIST = fileURLToPath(new URL("../dist", import.meta.url));
const SLOW_MS = 1_500;

let browser: Browser;
let server: Server;
let origin = "";
let liveEdge: Server;
let liveOrigin = "";
let build: ServerBuild;
let viteManifest: ViteManifest;
const asked: string[] = [];

/**
 * What the live channel's edge does with an address of the merchant landing,
 * read from the edge's own route table: the addresses it withholds and the one
 * it hands the scanner instead.
 */
const withheldOnLive = (): Readonly<{ matches: (path: string) => boolean; to: string }> => {
  const caddyfile = readFileSync(
    fileURLToPath(new URL("../../../deploy/Caddyfile", import.meta.url)),
    "utf8",
  );
  const paths = caddyfile
    .match(/@sell_withheld \{\s*path ([^\n]+)/)?.[1]
    ?.trim()
    .split(/\s+/);
  const to = caddyfile.match(/rewrite @sell_withheld (\S+)/)?.[1];
  if (paths === undefined || to === undefined) {
    throw new Error("deploy/Caddyfile withholds no address of the merchant landing");
  }
  return {
    matches: (path) =>
      paths.some((one) => (one.endsWith("/*") ? path.startsWith(one.slice(0, -1)) : path === one)),
    to,
  };
};

beforeAll(async () => {
  const built = (await import(pathToFileURL(join(DIST, "server", "index.js")).href)) as {
    build: ServerBuild;
    scannerApp: (parts: ScannerParts) => express.Express;
  };
  build = built.build;
  const client = join(DIST, "client");
  viteManifest = JSON.parse(
    await readFile(join(client, ".vite", "manifest.json"), "utf8"),
  ) as ViteManifest;
  const app = built.scannerApp({
    assets: await precompressedFrom(join(client, "assets")),
    files: express.static(client, { index: false, redirect: false }),
    mode: "production",
  });
  server = createServer((request, response) => {
    const path = request.url ?? "";
    if (path.includes(".data")) asked.push(path.split("?")[0] ?? path);
    // The methodology's data arrives late, as over a slow link, so what the
    // page shows before it arrives can be seen.
    if (path.startsWith("/methodology.data")) {
      setTimeout(() => app(request, response), SLOW_MS);
      return;
    }
    app(request, response);
  }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const withheld = withheldOnLive();
  liveEdge = createServer((request, response) => {
    if (withheld.matches((request.url ?? "").split("?")[0] ?? "")) request.url = withheld.to;
    app(request, response);
  }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => liveEdge.once("listening", resolve));
  liveOrigin = `http://127.0.0.1:${(liveEdge.address() as AddressInfo).port}`;
  browser = await launchChromium();
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => liveEdge?.close(() => resolve()));
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

/**
 * A browser with nothing kept, on `path`, with what it complained of and the
 * built files it was refused collected. A request it could not load from an
 * address the scanner has no route for yet is not a complaint here.
 */
const visit = async (
  path: string,
  { consentSaved = false }: Readonly<{ consentSaved?: boolean }> = {},
): Promise<{ page: Page; complaints: string[] }> => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const complaints: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) {
      complaints.push(message.text());
    }
  });
  page.on("pageerror", (error) => complaints.push(error.message));
  page.on("response", (response) => {
    if (new URL(response.url()).pathname.startsWith("/assets/") && response.status() !== 200) {
      complaints.push(`${response.url()} answered ${response.status()}`);
    }
  });
  // The route's answer to a saved choice; see the header. Answering a route
  // in the browser turns its cache off, so only the banner's tests do.
  if (consentSaved) {
    await page.route("**/api/v1/consent", (route) =>
      route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ status: "saved", policy_version: "consent-v1.0.0" }),
      }),
    );
  }
  const answered = await page.goto(`${origin}${path}`);
  expect(answered?.status()).toBe(200);
  await page.waitForLoadState("networkidle");
  return { page, complaints };
};

const timesAsked = (path: string): number => asked.filter((one) => one === path).length;

describe("a page in Chromium", () => {
  it.each([
    "/",
    "/store",
    "/local",
    "/methodology",
    "/scanner",
    "/privacy",
    "/terms",
    "/agentic-shop",
    "/agentic-shop/privacy",
    "/data-request",
    "/email/unsubscribe",
  ])("comes alive without a complaint: %s", async (path) => {
    const { page, complaints } = await visit(path);
    await page.evaluate(() => {
      (window as Window & { stayed?: boolean }).stayed = true;
    });

    // Only a page the router took over in the browser follows its own link
    // without loading a document; one drawn there otherwise than on the
    // server is a complaint React logs.
    await page.locator("header a.brand").click();
    await page.waitForURL(`${origin}/`);
    await page.locator("h1").first().waitFor();
    expect(await page.evaluate(() => (window as Window & { stayed?: boolean }).stayed)).toBe(true);
    expect(complaints).toEqual([]);
    await page.context().close();
  });
});

describe("a page's first visit in Chromium", () => {
  it.each([
    ["/", "routes/home"],
    ["/methodology", "routes/methodology"],
    ["/agentic-shop", "routes/agentic-shop"],
    ["/sell", "routes/sell"],
    ["/no-such-page", "routes/not-found"],
  ])(
    "loads the scripts the speed budget counts for it, no more and no fewer: %s",
    async (path, routeId) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const scripts = new Set<string>();
      page.on("request", (request) => {
        const { pathname } = new URL(request.url());
        if (pathname.startsWith("/assets/") && pathname.endsWith(".js"))
          scripts.add(pathname.slice(1));
      });
      await page.goto(`${origin}${path}`);
      await page.waitForLoadState("networkidle");

      expect([...scripts].sort()).toEqual(
        [...firstVisitScripts(build, viteManifest, routeId)].sort(),
      );
      await context.close();
    },
  );
});

describe("the sell-to-agents page", () => {
  it("shows its still life", async () => {
    const { page } = await visit("/agentic-shop");
    const image = page.locator("main img").first();
    await page.waitForFunction(
      (element) => element instanceof HTMLImageElement && element.complete,
      await image.elementHandle(),
    );

    const shown = await image.evaluate((element: HTMLImageElement) => ({
      width: element.naturalWidth,
      from: new URL(element.currentSrc).pathname,
    }));
    expect(shown.width).toBeGreaterThan(0);
    expect(shown.from).toMatch(/^\/agentic-shop\/merchant-still-life-\d+\.webp$/);
    await page.context().close();
  });
});

describe("the merchant landing", () => {
  it("comes alive without a complaint and goes home without a reload", async () => {
    const { page, complaints } = await visit("/sell");
    await page.evaluate(() => {
      (window as Window & { stayed?: boolean }).stayed = true;
    });

    await page.locator("header a.wordmark").click();
    await page.waitForURL(`${origin}/`);
    await page.locator("h1").first().waitFor();
    expect(await page.evaluate(() => (window as Window & { stayed?: boolean }).stayed)).toBe(true);
    expect(complaints).toEqual([]);
    await page.context().close();
  });

  it("folds its sections into a menu the burger opens, and closes it on a chosen link, on Escape and on growing to the desktop width", async () => {
    const { page, complaints } = await visit("/sell");
    await page.setViewportSize({ width: 390, height: 800 });
    const burger = page.locator(".masthead__burger");
    const menu = page.locator("#site-menu");
    const opened = async () => {
      await burger.click();
      await menu.waitFor({ state: "visible" });
      expect(await burger.getAttribute("aria-expanded")).toBe("true");
      expect(await burger.getAttribute("aria-label")).toBe("Close menu");
    };

    expect(await menu.isVisible()).toBe(false);
    await opened();
    await menu.getByRole("link", { name: "Payments" }).click();
    await menu.waitFor({ state: "hidden" });
    expect(await burger.getAttribute("aria-label")).toBe("Open menu");

    await opened();
    await menu.getByRole("link", { name: "Documentation" }).focus();
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });
    expect(await burger.evaluate((element) => element === document.activeElement)).toBe(true);

    await opened();
    await page.setViewportSize({ width: 1280, height: 800 });
    await menu.waitFor({ state: "hidden" });
    expect(await burger.getAttribute("aria-expanded")).toBe("false");
    expect(complaints).toEqual([]);
    await page.context().close();
  });

  it("is, behind the live channel's edge, the page that says there is none, and stays it once the browser takes over, back and forth", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const complaints: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) {
        complaints.push(message.text());
      }
    });
    page.on("pageerror", (error) => complaints.push(error.message));
    const withheld = async () => {
      await page.waitForLoadState("networkidle");
      expect(new URL(page.url()).pathname).toBe("/sell");
      expect(await page.locator("h1").first().textContent()).toBe("Page not found");
      expect(await page.locator(".sell").count()).toBe(0);
    };

    const answered = await page.goto(`${liveOrigin}/sell`);
    expect(answered?.status()).toBe(404);
    await withheld();

    // Going back is the router's own navigation: it asks for the landing's
    // route and data itself, which the edge must withhold as it does the page.
    await page.locator("a.brand").click();
    await page.waitForURL(`${liveOrigin}/`);
    const home = await page.locator("h1").first().textContent();
    await page.goBack();
    await page.waitForFunction((left) => document.querySelector("h1")?.textContent !== left, home);
    await withheld();
    expect(complaints).toEqual([]);
    await context.close();
  });
});

describe("a click on a link", () => {
  it("shows at once that it was taken, says the page is coming once it takes a moment, and draws it without a reload", async () => {
    const { page } = await visit("/");
    await page.evaluate(() => {
      (window as Window & { stayed?: boolean }).stayed = true;
    });
    const link = page.locator("header nav[aria-label=Primary] a", { hasText: "Methodology" });

    await link.click();
    await page.waitForTimeout(80);
    expect(await link.getAttribute("data-going")).toBe("");
    expect(await page.locator(".on-its-way").isVisible()).toBe(false);
    await page.waitForTimeout(300);
    expect(await page.locator(".on-its-way").isVisible()).toBe(true);

    await page.waitForURL(`${origin}/methodology`);
    await page.locator("h1", { hasText: "How the agent-readiness scan works" }).waitFor();
    expect(await page.locator(".on-its-way").isVisible()).toBe(false);
    expect(await page.evaluate(() => (window as Window & { stayed?: boolean }).stayed)).toBe(true);
    await page.context().close();
  });

  it("to a public page is answered from the fetch a hover made", async () => {
    const { page } = await visit("/");
    const before = timesAsked("/methodology.data");
    const link = page.locator("header nav[aria-label=Primary] a", { hasText: "Methodology" });

    await link.hover();
    await page.waitForTimeout(SLOW_MS + 500);
    await page.mouse.move(1, 1);
    await link.click();
    await page.waitForURL(`${origin}/methodology`);
    await page.locator("h1", { hasText: "How the agent-readiness scan works" }).waitFor();

    expect(timesAsked("/methodology.data") - before).toBe(1);
    await page.context().close();
  });
});

describe("the consent banner", () => {
  it.each([
    ["Allow optional analytics", true],
    ["Essential only", false],
  ])("takes %s and goes, without a reload", async (button, measured) => {
    const { page } = await visit("/methodology", { consentSaved: true });
    await page.evaluate(() => {
      (window as Window & { stayed?: boolean }).stayed = true;
    });
    const banner = page.locator("aside[aria-label='Privacy choices']");
    expect(await banner.isVisible()).toBe(true);

    await banner.getByRole("button", { name: button }).click();
    await banner.waitFor({ state: "detached" });

    const stored = await page.evaluate(
      (key) => JSON.parse(window.localStorage.getItem(key) ?? "null"),
      CONSENT_STORAGE_KEY,
    );
    expect(stored?.categories?.product_analytics).toBe(measured);
    expect(await page.evaluate(() => (window as Window & { stayed?: boolean }).stayed)).toBe(true);
    await page.context().close();
  });
});
