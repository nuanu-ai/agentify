/**
 * What Chromium does with the built scanner where only a browser can tell:
 * every page comes alive in the browser without a complaint, a click on a link
 * shows at once that it was taken and says the page is coming once it takes a
 * moment, a hover fetches a public page's data and stylesheets so the click
 * needs nothing more, the consent banner takes a choice without a reload, the merchant
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
import { dragUp, launchChromium } from "@agentify/ui/chromium";
import express from "express";
import type { Browser, Page } from "playwright";
import type { ServerBuild } from "react-router";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

// The scan's and the report's pages read the scanner's settings, which name a
// database; none is asked, since every API a browser asks here is answered by
// the browser's own stub or needs no database.
beforeAll(() => {
  vi.stubEnv("DATABASE_URL", "postgresql://nobody:unused@127.0.0.1:1/nowhere");
});

afterAll(() => {
  vi.unstubAllEnvs();
});

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
    if (path.includes(".data") || /\.css(?:$|[?#])/.test(path)) {
      asked.push(path.split(/[?#]/)[0] ?? path);
    }
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
    ["/scan/0190f4c5-0000-7000-8000-00000000f003", "routes/scan.id"],
    ["/scan/pending", "routes/scan.pending"],
    ["/report/0190f4c5-0000-7000-8000-00000000f004", "routes/report.scanId"],
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
    // The address changes before the router draws the page it leads to, so
    // the front page's heading is read once it has replaced the missing one.
    await page.waitForFunction(
      () => document.querySelector("h1")?.textContent !== "Page not found",
    );
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
    const link = page.locator("header .site-nav a", { hasText: "Methodology" });

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

  it("to a public page is answered from the fetches a hover made, its stylesheets among them", async () => {
    const { page } = await visit("/");
    const before = timesAsked("/methodology.data");
    const link = page.locator("header .site-nav a", { hasText: "Methodology" });

    await link.hover();
    await page.waitForTimeout(SLOW_MS + 500);
    await page.mouse.move(1, 1);
    const askedBeforeTheClick = asked.length;
    await link.click();
    await page.waitForURL(`${origin}/methodology`);
    await page.locator("h1", { hasText: "How the agent-readiness scan works" }).waitFor();

    expect(timesAsked("/methodology.data") - before).toBe(1);
    expect(asked.slice(askedBeforeTheClick)).toEqual([]);
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

const SCAN_ID = "0190f4c5-0000-7000-8000-00000000f001";
const SCAN_TOKEN = "t".repeat(43);

const checksAt = (status: string) =>
  Array.from({ length: 18 }, (_, index) => ({
    id: index + 1,
    label_code: "robots",
    status: index < 7 ? "pass" : status,
    robots: null,
  }));

const RUNNING = {
  status: "running",
  progress: { completed: 7, total: 18 },
  checks: checksAt("running"),
  updated_at: "2026-10-13T09:00:00.000Z",
  target_host: "shop.example",
};

const FINISHED = {
  ...RUNNING,
  status: "completed",
  progress: { completed: 18, total: 18 },
  checks: checksAt("pass"),
  teaser: {
    score: 46,
    coverage: 1,
    level: "readable",
    top_findings: ["vertical_jsonld_missing"],
    positive: null,
    hidden_count: 7,
  },
};

const FAILED = {
  ...RUNNING,
  status: "failed",
  progress: { completed: 18, total: 18 },
  checks: checksAt("unavailable"),
};

/**
 * A browser with nothing kept whose API is answered here: the scan is
 * accepted, its status is each of `statuses` in turn and the last one from
 * then on, and the visitor is signed out. What it complained of is collected.
 */
const answered = async (...statuses: readonly object[]) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const complaints: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) {
      complaints.push(message.text());
    }
  });
  page.on("pageerror", (error) => complaints.push(error.message));
  let statusAsks = 0;
  await page.route("**/api/v1/scans", (route) =>
    route.fulfill({
      status: 202,
      json: {
        scan_id: SCAN_ID,
        access_token: SCAN_TOKEN,
        status: "accepted",
        status_url: `/api/v1/scans/${SCAN_ID}/status`,
        estimated_seconds: 30,
      },
    }),
  );
  await page.route(`**/api/v1/scans/${SCAN_ID}/status`, (route) => {
    statusAsks += 1;
    return route.fulfill({ json: statuses[Math.min(statusAsks, statuses.length) - 1] });
  });
  await page.route("**/api/v2/session", (route) =>
    route.fulfill({ json: { status: "signed_out" } }),
  );
  return { page, complaints };
};

type CardFrame = Readonly<{
  badge: string;
  heading: string | null;
  reading: boolean;
  stepsDone: boolean;
}>;

/**
 * Has the page note, at every frame it draws, what the scan's card shows: the
 * badge's word, the heading under it, the words that say the scan's state is
 * still being read, and a list of the scan's steps with every one of them
 * done. Only a change is noted.
 */
const watchCardFrames = (page: Page) =>
  page.addInitScript(() => {
    const frames: CardFrame[] = [];
    (window as Window & { cardFrames?: CardFrame[] }).cardFrames = frames;
    const look = () => {
      const card = document.querySelector("main section");
      if (card !== null) {
        const frame = {
          badge: card.querySelector("header [class*=badge]")?.textContent?.trim() ?? "",
          heading: card.querySelector("h1")?.textContent ?? null,
          reading: card.textContent?.includes("Reading the scan state") === true,
          stepsDone:
            card.querySelector("ol") !== null &&
            [...card.querySelectorAll("ol > li")].every(
              (step) => step.lastElementChild?.textContent === "done",
            ),
        };
        if (JSON.stringify(frames.at(-1)) !== JSON.stringify(frame)) frames.push(frame);
      }
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });

const cardFrames = (page: Page): Promise<CardFrame[]> =>
  page.evaluate(() => (window as Window & { cardFrames?: CardFrame[] }).cardFrames ?? []);

describe("a scan in Chromium", () => {
  it("goes from the front page's form to the scan's progress, its result and the ask for the full report, without a complaint and with no token left in the address", async () => {
    const { page, complaints } = await answered(RUNNING, FINISHED);

    await page.goto(`${origin}/`);
    await page.getByRole("textbox", { name: "Website URL" }).first().fill("shop.example");
    await page.locator("form button[type=submit]").first().click();
    await page.waitForURL(`${origin}/scan/${SCAN_ID}?segment=owner`);
    await page.getByText("7 of 18 checks reported").waitFor();
    await page.getByLabel("Email").waitFor();

    expect(await page.locator("h1").first().textContent()).toBe("Readable");
    expect(page.url()).not.toContain(SCAN_TOKEN);
    expect(
      await page.evaluate((key) => sessionStorage.getItem(key), `agentify:scan-token:${SCAN_ID}`),
    ).toBe(SCAN_TOKEN);
    expect(complaints).toEqual([]);
    await page.context().close();
  });

  it("fetches the result's script while the scan runs, and draws the result in the frame that first says the scan is complete", async () => {
    const { page, complaints } = await answered(RUNNING, RUNNING, FINISHED);
    const teaser = page.waitForRequest(/\/assets\/scan-teaser-[^/]*\.js$/);
    await watchCardFrames(page);

    await page.goto(`${origin}/scan/${SCAN_ID}?segment=owner#access_token=${SCAN_TOKEN}`);
    await teaser;
    expect(await page.locator("main section header").textContent()).not.toContain("complete");
    await page.getByLabel("Email").waitFor();

    const frames = await cardFrames(page);
    expect(
      frames.filter((frame) => frame.badge === "complete" && frame.heading !== "Readable"),
    ).toEqual([]);
    expect(complaints).toEqual([]);
    await page.context().close();
  });

  it("shows the finished progress, and never words that doubt the scan is complete, while the result's script is on its way", async () => {
    const { page } = await answered(FINISHED);
    await page.route("**/assets/scan-teaser-*.js", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.continue();
    });
    await watchCardFrames(page);

    await page.goto(`${origin}/scan/${SCAN_ID}?segment=owner#access_token=${SCAN_TOKEN}`);
    await page.getByLabel("Email").waitFor();

    const waiting = (await cardFrames(page)).filter(
      (frame) => frame.badge === "complete" && frame.heading !== "Readable",
    );
    expect(waiting.length).toBeGreaterThan(0);
    for (const frame of waiting) {
      expect(frame).toEqual({ badge: "complete", heading: null, reading: false, stepsDone: true });
    }
    await page.context().close();
  });

  it("keeps the progress it showed, its open details too, when the scan completes before the result's script is here", async () => {
    const { page } = await answered(RUNNING, FINISHED);
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/assets/scan-teaser-*.js", async (route) => {
      await released;
      await route.continue();
    });

    await page.goto(`${origin}/scan/${SCAN_ID}?segment=owner#access_token=${SCAN_TOKEN}`);
    await page.getByText("7 of 18 checks reported").waitFor();
    await page.getByText("Live check details").click();
    // A mark only the list drawn while the scan ran carries.
    await page.locator("main section ol").evaluate((list) => list.setAttribute("data-seen", ""));
    await page.locator("main section header", { hasText: "complete" }).waitFor();

    expect(await page.locator("main section ol[data-seen]").count()).toBe(1);
    expect(await page.locator("main section details[open]").count()).toBe(1);
    release();
    await page.getByLabel("Email").waitFor();
    await page.context().close();
  });

  it("says why a scan ended without a result in the frame its badge first says so", async () => {
    const { page } = await answered(FAILED);
    await page.route("**/assets/scan-failed-*.js", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.continue();
    });
    await watchCardFrames(page);

    await page.goto(`${origin}/scan/${SCAN_ID}?segment=owner#access_token=${SCAN_TOKEN}`);
    await page.getByText("No reliable diagnostic was produced").waitFor();

    const frames = await cardFrames(page);
    expect(frames.filter((frame) => frame.badge === "fail" && frame.heading === null)).toEqual([]);
    await page.context().close();
  });

  it.each([
    ["opened after it ended", [FINISHED]],
    ["watched running", [RUNNING, FINISHED]],
  ])(
    "draws the result of a scan %s, rather than failing, where the result's script was replaced by a newer deployment",
    async (_scan, statuses) => {
      const { page } = await answered(...statuses);
      let refused = false;
      await page.route("**/assets/scan-teaser-*.js", (route) => {
        if (refused) return route.continue();
        refused = true;
        return route.fulfill({ status: 404, body: "" });
      });
      await page.goto(`${origin}/scan/${SCAN_ID}?segment=owner#access_token=${SCAN_TOKEN}`);
      await page.waitForLoadState("networkidle");

      await page.getByLabel("Email").waitFor();

      expect(refused).toBe(true);
      expect(await page.locator("h1").first().textContent()).toBe("Readable");
      expect(await page.getByText("Something went wrong").count()).toBe(0);
      await page.context().close();
    },
  );

  it("reloads only once where the result's script cannot be fetched at all, and then says something failed", async () => {
    const { page } = await answered(FINISHED);
    await page.route("**/assets/scan-teaser-*.js", (route) => route.fulfill({ status: 404 }));
    let documents = 0;
    page.on("request", (request) => {
      if (request.resourceType() === "document") documents += 1;
    });
    await page.goto(`${origin}/scan/${SCAN_ID}?segment=owner#access_token=${SCAN_TOKEN}`);

    await page.getByText("Something went wrong").waitFor();
    await page.waitForTimeout(2_000);

    expect(documents).toBe(2);
    await page.context().close();
  });

  it("asks a stranger at a report to sign in, and its own links need no reload", async () => {
    const { page, complaints } = await visit("/report/0190f4c5-0000-7000-8000-00000000f002");
    await page.evaluate(() => {
      (window as Window & { stayed?: boolean }).stayed = true;
    });

    expect(await page.locator("h1").textContent()).toBe("Private report access required");
    await page.locator("a.brand").click();
    await page.waitForURL(`${origin}/`);
    await page.locator("h1").first().waitFor();
    expect(await page.evaluate(() => (window as Window & { stayed?: boolean }).stayed)).toBe(true);
    expect(complaints).toEqual([]);
    await page.context().close();
  });
});

/** How the dashboard can answer who is visiting: a person, an operator, nobody, or not at all. */
const VISITORS = [
  [
    "a signed-in address",
    {
      status: 200,
      body: {
        status: "signed_in",
        email: "accounts-payable@an-example-company.com",
        operator: false,
      },
    },
  ],
  [
    "an operator",
    {
      status: 200,
      body: { status: "signed_in", email: "ops@agentify.example", operator: true },
    },
  ],
  ["nobody signed in", { status: 200, body: { status: "signed_out" } }],
  ["no answer", { status: 503, body: {} }],
] as const;

/**
 * A phone-sized browser on `path` whose question of who is visiting is held
 * until `release`, and answered then with `answer`; the scan's status is the
 * running one.
 */
const onAPhone = async (
  path: string,
  answer: Readonly<{ status: number; body: object }>,
  width = 320,
) => {
  const context = await browser.newContext({ viewport: { width, height: 640 } });
  const page = await context.newPage();
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/v1/scans/${SCAN_ID}/status`, (route) =>
    route.fulfill({ json: RUNNING }),
  );
  await page.route("**/api/v2/session", async (route) => {
    await released;
    await route.fulfill({ status: answer.status, json: answer.body });
  });
  await page.goto(`${origin}${path}`);
  const answered = async () => {
    release();
    await page.locator('.site-visitor[aria-busy="false"]').first().waitFor({ state: "attached" });
  };
  return { page, answered };
};

describe("the doors on a phone", () => {
  it.each(
    VISITORS.flatMap(([who, answer]) => [
      [
        who,
        "a scan",
        answer,
        `/scan/${SCAN_ID}?segment=owner#access_token=${SCAN_TOKEN}`,
        "main section",
        "7 of 18 checks reported",
      ],
      [
        who,
        "a report",
        answer,
        "/report/0190f4c5-0000-7000-8000-00000000f002",
        "h1",
        "Private report access required",
      ],
    ]),
  )(
    "keep their row when %s comes back, so %s does not move, on the narrowest page",
    async (_who, _page, answer, path, under, drawn) => {
      const { page, answered } = await onAPhone(path, answer);
      await page.getByText(drawn).first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      const before = await page.locator(under).first().boundingBox();

      await answered();

      expect(await page.locator(under).first().boundingBox()).toEqual(before);
      await page.context().close();
    },
  );
});

describe("the site's menu on a phone", () => {
  it("holds the site's sections, Sell to agents first, closes on Escape, and closes once a link in it is followed, fetched ahead as the bar's are", async () => {
    const { page, complaints } = await visit("/methodology");
    await page.setViewportSize({ width: 390, height: 800 });
    await page.evaluate(() => {
      (window as Window & { stayed?: boolean }).stayed = true;
    });
    const burger = page.locator("header .site-menu > summary");
    const panel = page.locator("header .site-menu-panel");

    expect(await panel.isVisible()).toBe(false);
    await burger.click();
    await panel.waitFor({ state: "visible" });
    expect(await panel.locator("nav a").allTextContents()).toEqual([
      "Sell to agents",
      "Scanner",
      "Methodology",
      "Privacy",
    ]);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "hidden" });
    expect(await burger.evaluate((element) => element === document.activeElement)).toBe(true);

    await burger.click();
    const privacy = panel.getByRole("link", { name: "Privacy" });
    const before = timesAsked("/privacy.data");
    await privacy.hover();
    await page.waitForTimeout(600);
    await privacy.click();
    await page.waitForURL(`${origin}/privacy`);
    await page.locator("h1", { hasText: "Privacy" }).first().waitFor();

    expect(await panel.isVisible()).toBe(false);
    expect(timesAsked("/privacy.data") - before).toBe(1);
    expect(await page.evaluate(() => (window as Window & { stayed?: boolean }).stayed)).toBe(true);
    expect(complaints).toEqual([]);
    await page.context().close();
  });

  it("opened on a scrolled page keeps the bar at the top and itself in view, and holds the page still under a wheel and a finger until it closes", async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 700 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    await page.route("**/api/v2/session", (route) =>
      route.fulfill({ json: { status: "signed_out" } }),
    );
    await page.goto(`${origin}/methodology`);
    await page.waitForLoadState("networkidle");
    const burger = page.locator("header .site-menu > summary");
    const panel = page.locator("header .site-menu-panel");
    const scrolled = () => page.evaluate(() => window.scrollY);
    await page.evaluate(() => window.scrollTo(0, 300));
    await dragUp(page, { x: 100, y: 450 }, 200);
    const before = await scrolled();
    expect(before).toBeGreaterThan(300);

    await burger.tap();
    await panel.waitFor({ state: "visible" });
    expect((await page.locator("header.site-header").boundingBox())?.y).toBe(0);
    const box = await panel.boundingBox();
    const bottom = (box?.y ?? 0) + (box?.height ?? 0);
    expect(box?.y).toBeGreaterThan(0);
    expect(bottom).toBeLessThanOrEqual(700);
    // A point on the page itself, just under the panel.
    const under = { x: 100, y: bottom + 20 };
    await page.mouse.move(under.x, under.y);
    await page.mouse.wheel(0, 400);
    await dragUp(page, under, 200);
    await page.waitForTimeout(300);
    expect(await scrolled()).toBe(before);
    expect((await page.locator("header.site-header").boundingBox())?.y).toBe(0);

    await burger.tap();
    await panel.waitFor({ state: "hidden" });
    await dragUp(page, under, 200);
    expect(await scrolled()).toBeGreaterThan(before);
    await context.close();
  });

  it.each(
    (
      [
        [
          "a scan",
          `/scan/${SCAN_ID}?segment=owner#access_token=${SCAN_TOKEN}`,
          "7 of 18 checks reported",
        ],
        [
          "a report",
          "/report/0190f4c5-0000-7000-8000-00000000f002",
          "Private report access required",
        ],
      ] as const
    ).flatMap(([top, path, drawn]) =>
      [
        { width: 740, height: 360 },
        { width: 568, height: 320 },
      ].map(
        (viewport) => [top, `${viewport.width}x${viewport.height}`, viewport, path, drawn] as const,
      ),
    ),
  )(
    "fits the room under the top of %s in a landscape phone's window of %s, its last item in reach",
    async (_top, _size, viewport, path, drawn) => {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      await page.route(`**/api/v1/scans/${SCAN_ID}/status`, (route) =>
        route.fulfill({ json: RUNNING }),
      );
      await page.route("**/api/v2/session", (route) =>
        route.fulfill({
          json: { status: "signed_in", email: "ops@agentify.example", operator: true },
        }),
      );
      await page.goto(`${origin}${path}`);
      await page.getByText(drawn).first().waitFor();
      await page.locator('.site-visitor[aria-busy="false"]').first().waitFor({ state: "attached" });
      const panel = page.locator(".site-menu-panel");

      await page.locator(".site-menu > summary").click();
      await panel.waitFor({ state: "visible" });
      const room = await panel.boundingBox();
      const end = (room?.y ?? 0) + (room?.height ?? 0);
      expect(end).toBeLessThanOrEqual(viewport.height);
      await page.mouse.move(370, (room?.y ?? 0) + 20);
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(300);
      const last = await panel.getByRole("button", { name: "Sign out" }).boundingBox();
      expect((last?.y ?? 0) + (last?.height ?? 0)).toBeLessThanOrEqual(end);
      await context.close();
    },
  );

  it("closes once the focus leaves it, so what has the focus is not behind it", async () => {
    const { page, complaints } = await visit("/methodology");
    await page.setViewportSize({ width: 390, height: 800 });
    const menu = page.locator("header .site-menu");
    const open = () => menu.evaluate((details) => (details as HTMLDetailsElement).open);

    await menu.locator("summary").focus();
    await page.keyboard.press("Enter");
    await menu.locator(".site-menu-panel").waitFor({ state: "visible" });
    await page.keyboard.press("Tab");
    expect(await open()).toBe(true);
    await menu.locator(".site-menu-panel a").last().focus();
    await page.keyboard.press("Tab");

    expect(await open()).toBe(false);
    expect(await page.evaluate(() => document.activeElement?.closest(".site-menu"))).toBeNull();
    expect(complaints).toEqual([]);
    await page.context().close();
  });

  it.each(
    VISITORS.flatMap(([who, answer]) => [320, 390].map((width) => [who, width, answer] as const)),
  )(
    "keeps the header to one row of the same height when %s comes back at %ipx, and holds who is visiting",
    async (_who, width, answer) => {
      const { page, answered } = await onAPhone("/methodology", answer, width);
      await page.locator("h1").first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      const header = page.locator("header.site-header");
      const before = await header.boundingBox();

      await answered();
      expect(await header.boundingBox()).toEqual(before);
      const middles = await header.evaluate((bar) =>
        [...bar.querySelectorAll(".brand, .site-doors > a, .site-menu > summary")].map((item) => {
          const box = item.getBoundingClientRect();
          return box.top + box.height / 2;
        }),
      );
      expect(middles).toHaveLength(4);
      expect(Math.max(...middles) - Math.min(...middles)).toBeLessThanOrEqual(1);

      await header.locator(".site-menu > summary").click();
      const visitor = header.locator(".site-menu-panel .site-visitor");
      if ("email" in answer.body) {
        const address = visitor.getByRole("link", { name: answer.body.email });
        expect(await address.getAttribute("href")).toBe("/dashboard/settings");
        expect(
          await address.evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
        expect(await visitor.getByRole("button", { name: "Sign out" }).isVisible()).toBe(true);
        expect(await visitor.getByRole("link", { name: "Admin" }).count()).toBe(
          answer.body.operator ? 1 : 0,
        );
      } else if (answer.status === 200) {
        expect(await visitor.isVisible()).toBe(false);
      } else {
        expect(await visitor.getByText("Sign-in unknown").isVisible()).toBe(true);
      }
      await page.context().close();
    },
  );
});
