/**
 * What Chromium does with the built pages where only a browser can tell. The
 * click after the pointer rested on a section link is answered from the fetch
 * the rest made, and after a press nothing the browser kept from before it is
 * shown: the headers that promise this are held offline in `server.test.ts`,
 * and a change of React Router's data addresses could break it with every
 * header still in place. A press answered on its own page leaves the merchant
 * where they were on it, and the sections stay in reach however far a page is
 * scrolled, which only a page that really scrolls can show.
 *
 * It needs the build (`pnpm --filter @agentify/dashboard build`) and
 * Playwright's Chromium, and counts what reaches the dashboard rather than what
 * the browser says about its cache.
 */

import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { type Harness, harness } from "@agentify/gateway/testing";
import { firstVisitScripts, type ViteManifest } from "@agentify/ui/budget";
import { launchChromium } from "@agentify/ui/chromium";
import express from "express";
import type { Browser, Page } from "playwright";
import type { ServerBuild } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { identityFor } from "./identity.js";
import type { Message } from "./mail.js";
import { builtPages } from "./pages.js";
import { buildApp } from "./server.js";
import { TEST_AUTH_SECRET } from "./testing/secrets.js";

const PERSON = "owner@example.com";
const SLOW_MS = 1_500;
const BASE = "/dashboard";

let harnessed: Harness;
let browser: Browser;
let close: () => Promise<void>;
let origin: string;
let cookies: { name: string; value: string }[];
let build: ServerBuild;
let viteManifest: ViteManifest;
const asked: string[] = [];

beforeAll(async () => {
  harnessed = await harness({ PAY_TO_ADDRESS: "0x0000000000000000000000000000000000000001" });
  const config = loadConfig({
    DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
    AUTH_SECRET: TEST_AUTH_SECRET,
    PAYMENT_NETWORK: "eip155:84532",
    FACILITATOR_URL: "sandbox:scripted",
    BASE_PATH: BASE,
  });
  const mails: Message[] = [];
  const identity = identityFor(config, {
    postman: async (message) => {
      mails.push(message);
      return "accepted";
    },
  });
  await identity.make(PERSON, harnessed.merchant.id);
  // Cards enough to scroll a short window, published as the merchant's own
  // code publishes them.
  for (const room of [101, 102, 103, 104]) {
    const published = await harnessed.gateway.publishCard(harnessed.merchant.id, {
      merchant_item_id: `room-${room}`,
      title: "A room for the night",
      description: `One night in room ${room}`,
      price: { amount: "80.00", currency: "USD" },
      result: { access_code: { type: "string" } },
      fulfillment: "sync",
    });
    if (!published.ok) throw new Error("the test's card was not published");
  }
  await identity.requestLink(PERSON, "default");
  const link = new URL(/(https?:\/\/\S+)/.exec(mails.at(-1)?.body ?? "")?.[1] ?? "");
  const opened = await identity.openLink(link.searchParams.get("token") ?? "");
  if (opened.status !== "opened") throw new Error("the test's sign-in link did not open");
  cookies = opened.setCookies.map((line) => {
    const [pair = ""] = line.split(";");
    const at = pair.indexOf("=");
    return { name: pair.slice(0, at), value: pair.slice(at + 1) };
  });

  const pages = await builtPages();
  build = pages.build as ServerBuild;
  viteManifest = JSON.parse(
    await readFile(
      fileURLToPath(new URL("../dist/client/.vite/manifest.json", import.meta.url)),
      "utf8",
    ),
  ) as ViteManifest;
  const dashboard = buildApp(config, { pages, gateway: harnessed.gateway, identity });
  const counted = express();
  counted.use((request, _response, next) => {
    if (request.method === "GET" && request.path.endsWith(".data")) asked.push(request.path);
    // The receipts' data and the open orders' arrive late, as from a slow
    // gateway, so what a page shows before its data is there can be seen.
    if (
      request.path === `${BASE}/receipts.data` ||
      (request.path === `${BASE}/orders.data` && request.query.open === "true")
    ) {
      setTimeout(next, SLOW_MS);
      return;
    }
    next();
  });
  counted.use(dashboard);
  const server = counted.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await launchChromium();
  close = async () => {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await identity.close();
    await harnessed.stop();
  };
});

afterAll(async () => {
  await close();
});

/** A browser with nothing kept yet, signed in, on the cards. */
const onTheCards = async (viewport = { width: 1280, height: 900 }): Promise<Page> => {
  const context = await browser.newContext({ viewport });
  await context.addCookies(cookies.map((one) => ({ ...one, url: origin })));
  const page = await context.newPage();
  await page.goto(`${origin}${BASE}/cards`);
  await page.waitForLoadState("networkidle");
  return page;
};

/** The sidebar's link, not the narrow menu's copy of it. */
const linkTo = (page: Page, section: string) => page.locator("nav.tabs a", { hasText: section });

/** Rests on a section link long enough for the page to fetch it, then leaves. */
const restOn = async (page: Page, section: string): Promise<void> => {
  await linkTo(page, section).hover();
  await page.waitForTimeout(600);
  await page.mouse.move(1, 1);
};

const open = async (page: Page, section: string, path: string): Promise<void> => {
  await linkTo(page, section).click();
  await page.waitForURL(`${origin}${BASE}${path}`);
  await page.waitForLoadState("networkidle");
};

const timesAsked = (path: string): number =>
  asked.filter((one) => one === `${BASE}${path}.data`).length;

describe("the page data Chromium keeps", () => {
  it("answers the click after the pointer rested on a link from the fetch the rest made", async () => {
    const page = await onTheCards();
    const before = timesAsked("/orders");

    await restOn(page, "Orders");
    await open(page, "Orders", "/orders");

    expect(timesAsked("/orders") - before).toBe(1);
    await page.context().close();
  });

  it("asks the server again for a page it kept, once a press has been made", async () => {
    const page = await onTheCards();
    const before = timesAsked("/orders");

    await restOn(page, "Orders");
    await page.locator("form[action*='selling='] button").first().click();
    await page.waitForLoadState("networkidle");
    await open(page, "Orders", "/orders");

    expect(timesAsked("/orders") - before).toBe(2);
    await page.context().close();
  });
});

describe("a page's first visit in Chromium", () => {
  it.each([
    ["/sign-in", "routes/sign-in", false],
    ["/cards", "routes/cards", true],
  ])(
    "loads the scripts the speed budget counts for it, no more and no fewer: %s",
    async (path, routeId, signedIn) => {
      const context = await browser.newContext();
      if (signedIn) await context.addCookies(cookies.map((one) => ({ ...one, url: origin })));
      const page = await context.newPage();
      const scripts = new Set<string>();
      page.on("request", (request) => {
        const { pathname } = new URL(request.url());
        if (pathname.startsWith(`${BASE}/assets/`) && pathname.endsWith(".js")) {
          scripts.add(pathname.slice(`${BASE}/`.length));
        }
      });
      await page.goto(`${origin}${BASE}${path}`);
      await page.waitForLoadState("networkidle");

      expect([...scripts].sort()).toEqual(
        [...firstVisitScripts(build, viteManifest, routeId)].sort(),
      );
      await context.close();
    },
  );
});

describe("a press answered on its own page", () => {
  it("leaves the merchant where they were on it", async () => {
    // A merchant pausing the last card reads the last card next.
    const page = await onTheCards({ width: 1280, height: 320 });
    // Selling on, as a test above may have left it off, so every card has its
    // switch.
    const resume = page.locator("form[action*='selling=resume'] button");
    if ((await resume.count()) > 0) {
      await resume.click();
      await page.locator("form[action*='selling=pause']").waitFor();
    }
    // The last card's row in the middle of a short window, with the page
    // scrolled to reach it.
    const row = page.locator("tbody tr").last();
    await row.evaluate((element) => element.scrollIntoView({ block: "center" }));
    const scrolled = await page.evaluate(() => window.scrollY);
    const before = await row.evaluate((element) => element.getBoundingClientRect().top);

    await row.locator("form[action*='pause='] button").click();
    await row.locator("form[action*='resume=']").waitFor();
    await page.waitForLoadState("networkidle");

    expect(scrolled).toBeGreaterThan(0);
    expect(await row.evaluate((element) => element.getBoundingClientRect().top)).toBe(before);
    await page.context().close();
  });
});

describe("a click under the dashboard's prefix", () => {
  it("marks the section or filter chosen before its page arrives, and says the page is coming", async () => {
    const page = await onTheCards();

    await linkTo(page, "Receipts").click();
    await page.waitForTimeout(400);
    expect(await linkTo(page, "Receipts").count()).toBe(0);
    expect(await page.locator("nav.tabs [aria-current=page]").textContent()).toContain("Receipts");
    expect(await page.locator(".on-its-way").isVisible()).toBe(true);
    await page.waitForURL(`${origin}${BASE}/receipts`);
    await page.waitForLoadState("networkidle");
    expect(await page.locator(".on-its-way").isVisible()).toBe(false);

    await page.goto(`${origin}${BASE}/orders`);
    await page.waitForLoadState("networkidle");
    await page.locator(".filter a", { hasText: "Open" }).click();
    await page.waitForTimeout(400);
    expect(await page.locator(".filter .here").textContent()).toBe("Open");
    await page.waitForURL(`${origin}${BASE}/orders?open=true`);
    await page.context().close();
  });
});

describe("the sections on a long page", () => {
  it("stay in reach on a phone from the menu at the end of the header's row, which shows who is signed in and closes on Escape", async () => {
    const page = await onTheCards({ width: 390, height: 600 });
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const burger = page.locator(".app-menu > summary");
    const panel = page.locator(".app-menu-panel");

    const reach = await burger.boundingBox();
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    expect(reach?.y).toBeGreaterThanOrEqual(0);
    expect((reach?.y ?? 600) + (reach?.height ?? 0)).toBeLessThanOrEqual(600);
    await burger.click();
    await panel.waitFor({ state: "visible" });
    expect(await panel.getByRole("link", { name: /Orders/ }).isVisible()).toBe(true);
    expect(await panel.getByText(PERSON).isVisible()).toBe(true);
    expect(await panel.getByRole("button", { name: "Sign out" }).isVisible()).toBe(true);

    await panel.getByRole("link", { name: /Orders/ }).focus();
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "hidden" });
    expect(await burger.evaluate((element) => element === document.activeElement)).toBe(true);
    await page.context().close();
  });

  it("are in a phone's menu that Escape closes wherever the focus is, so the page scrolls again", async () => {
    const page = await onTheCards({ width: 390, height: 600 });
    const burger = page.locator(".app-menu > summary");
    const panel = page.locator(".app-menu-panel");
    const pageScrolls = () =>
      page.evaluate(() => getComputedStyle(document.body).overflowY !== "hidden");

    await burger.click();
    await panel.waitFor({ state: "visible" });
    expect(await pageScrolls()).toBe(false);
    // A browser that does not focus a pressed summary, as Safari does not.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Escape");

    await panel.waitFor({ state: "hidden" });
    expect(await pageScrolls()).toBe(true);
    expect(await burger.evaluate((element) => element === document.activeElement)).toBe(true);
    await page.context().close();
  });

  it("are in a phone's menu that closes when the page moves on, though the page drawn stays", async () => {
    const page = await onTheCards({ width: 390, height: 600 });
    await page.goto(`${origin}${BASE}/orders`);
    await page.waitForLoadState("networkidle");
    const panel = page.locator(".app-menu-panel");

    await page.locator(".app-menu > summary").click();
    await panel.waitFor({ state: "visible" });
    // The orders' filter leads to the same page, which is drawn again in
    // place rather than anew; the menu is open over it.
    await page.locator(".filter a", { hasText: "Open" }).focus();
    await page.keyboard.press("Enter");
    await page.waitForURL(`${origin}${BASE}/orders?open=true`);
    await page.waitForLoadState("networkidle");

    expect(await page.locator(".filter .here").textContent()).toBe("Open");
    expect(await panel.isVisible()).toBe(false);
    await page.context().close();
  });

  it("keep the chosen one under the header on a laptop, down to the foot of the page", async () => {
    const page = await onTheCards({ width: 1280, height: 600 });
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));

    const header = await page.locator("header.site-header").boundingBox();
    const chosen = await page.locator("nav.tabs [aria-current=page]").boundingBox();
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    expect(chosen?.y).toBeGreaterThanOrEqual((header?.y ?? 0) + (header?.height ?? 0));
    await page.context().close();
  });
});
