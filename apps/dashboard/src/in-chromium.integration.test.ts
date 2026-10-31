/**
 * What Chromium does with the built pages where only a browser can tell. The
 * click after the pointer rested on a section link is answered from the fetch
 * the rest made, and after a press nothing the browser kept from before it is
 * shown: the headers that promise this are held offline in `server.test.ts`,
 * and a change of React Router's data addresses could break it with every
 * header still in place. A press answered on its own page leaves the merchant
 * where they were on it, the sections stay in reach however far a page is
 * scrolled, which only a page that really scrolls can show, and a copy button
 * writes to a real clipboard.
 *
 * It needs the build (`pnpm --filter @agentify/dashboard build`) and
 * Playwright's Chromium, and counts what reaches the dashboard rather than what
 * the browser says about its cache.
 */

import { readFile, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { randomIds } from "@agentify/gateway";
import { type Harness, harness } from "@agentify/gateway/testing";
import { firstVisitScripts, type ViteManifest } from "@agentify/ui/budget";
import { dragUp, launchChromium } from "@agentify/ui/chromium";
import express from "express";
import type { Browser, Locator, Page, Route } from "playwright";
import type { ServerBuild } from "react-router";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { loadConfig } from "./config.js";
import { DRAWN_FOR } from "./drawn-for.js";
import { type Identity, identityFor } from "./identity.js";
import type { Message } from "./mail.js";
import { builtPages } from "./pages.js";
import { SCRIPT_BUDGET } from "./script-budget.js";
import { buildApp } from "./server.js";
import { ONE_CLIENT } from "./testing/link-sends.js";
import { TEST_AUTH_SECRET } from "./testing/secrets.js";
import { merchantItemIdFor } from "./woo-catalog.js";
import { publicShopOf } from "./woo-connect.js";
import { inspectProductInTheShop } from "./woo-shop.js";
import { memoryWooShops } from "./woo-shops.js";

const PERSON = "owner@example.com";
const SLOW_MS = 1_500;
const BASE = "/dashboard";

let harnessed: Harness;
let onboardingIdentity: Identity;
let onboardingMessages: Message[];
let signInMailHandover: "accepted" | "refused" = "accepted";
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
  onboardingMessages = mails;
  const identity = identityFor(config, {
    postman: async (message) => {
      mails.push(message);
      return signInMailHandover;
    },
  });
  onboardingIdentity = identity;
  await identity.make(PERSON, harnessed.merchant.id);
  // Cards enough to scroll a short window, published as the merchant's own
  // code publishes them, and one paid order awaiting delivery, so the orders
  // have a list to search and narrow.
  for (const room of [101, 102, 103, 104]) {
    const published = await harnessed.gateway.publishCard(harnessed.merchant.id, {
      merchant_item_id: `room-${room}`,
      title: "A room for the night",
      description: `One night in room ${room}`,
      price: { amount: "80.00", currency: "USD" },
      result: { access_code: { type: "string" } },
      ...(room === 101
        ? { fulfillment: "async", fulfill_deadline_seconds: 3600 }
        : { fulfillment: "sync" }),
    });
    if (!published.ok) throw new Error("the test's card was not published");
    if (room === 101) {
      const offered = await harnessed.gateway.beginPurchase(published.id, {});
      if (offered.step !== "pay") throw new Error("the room order was not priced");
      const paid = await harnessed.gateway.payPurchase(
        offered.order.priceOffer.stamp,
        "ROOM_PAYMENT",
        "ROOM_PAYMENT",
        undefined,
        { itemId: offered.order.itemId, params: offered.order.params },
      );
      if (paid.step !== "under_way") throw new Error("the room payment was not accepted");
    }
  }
  await identity.requestLink(PERSON, "default", ONE_CLIENT);
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
  // The site's font, which the edge serves to every process's pages, so the
  // pages are measured in the face a visitor sees.
  counted.use(
    "/styles",
    express.static(
      fileURLToPath(new URL("../../../packages/visual/public/styles", import.meta.url)),
    ),
  );
  counted.use((request, _response, next) => {
    if (request.method === "GET" && request.path.endsWith(".data")) asked.push(request.path);
    // The receipts' data and the open orders' arrive late, as from a slow
    // gateway, so what a page shows before its data is there can be seen.
    // So do the searched cards a press leads back to, so what the page marks
    // before they arrive can be seen too.
    if (
      request.path === `${BASE}/receipts.data` ||
      (request.path === `${BASE}/orders.data` && request.query.show === "open") ||
      (request.method === "GET" &&
        request.path === `${BASE}/products.data` &&
        request.query.q === "suite")
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

/** A browser with nothing kept yet, signed in, on the cards; `phone` gives it a phone's touch. */
const onTheCards = async (
  viewport = { width: 1280, height: 900 },
  phone = false,
): Promise<Page> => {
  const context = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone });
  await context.addCookies(cookies.map((one) => ({ ...one, url: origin })));
  const page = await context.newPage();
  await page.goto(`${origin}${BASE}/products`);
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
    expect(timesAsked("/orders") - before).toBe(1);
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

/** Initial conditional modules count too, even where the route graph calls them dynamic. */
const scriptsRequestedBy = (page: Page): Set<string> => {
  const scripts = new Set<string>();
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith(`${BASE}/assets/`) && pathname.endsWith(".js")) {
      scripts.add(pathname.slice(`${BASE}/`.length));
    }
  });
  return scripts;
};

const withinScriptBudget = async (state: string, page: Page, scripts: ReadonlySet<string>) => {
  await page.waitForLoadState("networkidle");
  const files = await Promise.all(
    [...scripts].map(async (script) => ({
      script,
      bytes: (await stat(fileURLToPath(new URL(`../dist/client/${script}.br`, import.meta.url))))
        .size,
    })),
  );
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  console.info("[initial scripts]", JSON.stringify({ state, bytes, limit: SCRIPT_BUDGET, files }));
  expect.soft(bytes, `${state}: initial script bytes`).toBeLessThanOrEqual(SCRIPT_BUDGET);
};

describe("a page's first visit in Chromium", () => {
  it.each([
    ["/sign-in", "routes/sign-in", false],
    ["/products", "routes/products", true],
  ])(
    "loads the scripts the speed budget counts for it, no more and no fewer: %s",
    async (path, routeId, signedIn) => {
      // The manifest's base graph is an open catalog; paused banners have separate state budgets.
      if (signedIn) await harnessed.gateway.setSelling(harnessed.merchant.id, "open");
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
    const row = page.locator(".list-row").last();
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

  it("keeps the segment marked while the cards arrive, and the search and the page once they have", async () => {
    // Suites enough to fill more than one page of the cards on sale.
    for (let suite = 1; suite <= 55; suite += 1) {
      const published = await harnessed.gateway.publishCard(harnessed.merchant.id, {
        merchant_item_id: `suite-${suite}`,
        title: "A suite for the night",
        description: `One night in suite ${suite}`,
        price: { amount: "180.00", currency: "USD" },
        result: { access_code: { type: "string" } },
        fulfillment: "sync",
      });
      if (!published.ok) throw new Error("the test's card was not published");
    }
    // The page Next leads to from the first: right after the fiftieth suite.
    const fiftieth = (await harnessed.store.cards(harnessed.merchant.id))
      .filter((card) => card.card.merchant_item_id.startsWith("suite-"))
      .sort((one, other) => one.asOf - other.asOf || (one.id < other.id ? -1 : 1))[49];
    const listing = `${origin}${BASE}/products?q=suite&show=on-sale&after=${fiftieth?.asOf}.${fiftieth?.id}`;
    const page = await onTheCards();
    await page.goto(listing);
    await page.waitForLoadState("networkidle");
    const marked = () => page.locator(".segments .here").textContent();

    const arrived = page.waitForResponse(
      (answer) =>
        answer.request().method() === "GET" &&
        new URL(answer.url()).pathname === `${BASE}/products.data`,
    );
    await page.locator(".list-row form[action*='pause='] button").first().click();
    await page.waitForTimeout(400);
    const meanwhile = await marked();
    await arrived;
    // The pressed button is busy until the cards answering it are drawn.
    await page.waitForFunction(() => document.querySelector("[aria-busy='true']") === null);

    expect(meanwhile).toContain("On sale");
    expect(page.url()).toBe(listing);
    expect(await marked()).toContain("On sale");
    expect(await page.getByRole("searchbox", { name: "Search products" }).inputValue()).toBe(
      "suite",
    );
    expect(await page.locator(".cut").textContent()).toContain("Showing 51–54 of 54");
    await page.context().close();
  });
});

describe("a switch pressed from the keyboard", () => {
  /** The cards called rooms, listed as `show` asks, with selling on so every card has its switch. */
  const onTheRooms = async (show: string): Promise<Page> => {
    const page = await onTheCards();
    const resume = page.locator("form[action*='selling=resume'] button");
    if ((await resume.count()) > 0) {
      await resume.click();
      await page.locator("form[action*='selling=pause']").waitFor();
    }
    await page.goto(`${origin}${BASE}/products?q=room${show}`);
    await page.waitForLoadState("networkidle");
    return page;
  };

  /** What has the focus once the press is answered: its words, and the row it is in. */
  const focusedAfter = async (page: Page) => {
    await page.waitForFunction(() => document.querySelector("[aria-busy='true']") === null);
    await page
      .waitForFunction(() => document.activeElement !== document.body, null, { timeout: 2_000 })
      .catch(() => {});
    return await page.evaluate(() => ({
      button: document.activeElement?.textContent,
      row: document.activeElement?.closest(".list-row")?.textContent,
    }));
  };

  it("keeps the focus on the switch where its row stays", async () => {
    const page = await onTheRooms("");
    const row = page.locator(".list-row").first();
    const switched =
      (await row.locator("form button").textContent()) === "Pause" ? "Resume" : "Pause";

    await row.locator("form button").focus();
    await page.keyboard.press("Enter");
    await row.locator("form button", { hasText: switched }).waitFor();

    expect((await focusedAfter(page)).button).toBe(switched);
    await page.context().close();
  });

  it("hands the focus to the row that takes the place of one the press took out of the list", async () => {
    const page = await onTheRooms("&show=on-sale");
    const rows = page.locator(".list-row");
    const pressed = await rows.first().textContent();
    const after = await rows.nth(1).textContent();

    await rows.first().locator("form[action*='pause='] button").focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      (gone) =>
        ![...document.querySelectorAll(".list-row")].some((row) => row.textContent === gone),
      pressed,
    );

    expect(await focusedAfter(page)).toStrictEqual({ button: "Pause", row: after });
    await page.context().close();
  });
});

describe("a copy button once the page's script runs", () => {
  it("puts the whole purchase address on the clipboard and shows it did", async () => {
    const page = await onTheCards();
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    const button = page.getByRole("button", { name: "Copy the purchase address" }).first();
    const title = (await button.getAttribute("title")) ?? "";

    await button.click();
    await page.locator("button.copy.copied").first().waitFor();

    expect(title).toMatch(/^Copy the purchase address: http\S+\/purchase$/);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      title.replace("Copy the purchase address: ", ""),
    );
    await page.context().close();
  });
});

describe("a copy out of a page", () => {
  it("carries the spaces a person types where the page keeps a number with its unit", async () => {
    const page = await onTheCards();
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    const price = page.getByText(/^80\.00\sUSD$/).first();

    await price.selectText();
    await page.keyboard.press("ControlOrMeta+C");

    expect(await price.textContent()).toBe("80.00\u00a0USD");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("80.00 USD");
    await page.context().close();
  });
});

describe("a click under the dashboard's prefix", () => {
  it("marks the section or filter chosen before its page arrives, and says the page is coming", async () => {
    const page = await onTheCards();
    // Held back so the page is still on its way when read; a fast runner
    // otherwise draws Receipts before the bar's moment has passed.
    await page.route(
      `${origin}${BASE}/receipts.data*`,
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        await route.fallback();
      },
      { times: 1 },
    );

    await linkTo(page, "Receipts").click();
    await page.waitForTimeout(400);
    expect(await linkTo(page, "Receipts").count()).toBe(0);
    expect(await page.locator("nav.tabs [aria-current=page]").textContent()).toContain("Receipts");
    expect(await page.locator(".on-its-way").isVisible()).toBe(true);
    await page.waitForURL(`${origin}${BASE}/receipts`);
    // The address moves before the arrived page is drawn, and a load state the
    // page reached on its first load is not waited for again, so the bar is
    // waited out rather than read once.
    await page.locator(".on-its-way").waitFor({ state: "hidden", timeout: 5000 });

    await page.goto(`${origin}${BASE}/orders`);
    await page.waitForLoadState("networkidle");
    await page.locator(".segments a", { hasText: "Open" }).click();
    await page.waitForTimeout(400);
    expect(await page.locator(".segments .here").textContent()).toMatch(/^Open/);
    await page.waitForURL(`${origin}${BASE}/orders?show=open`);
    await page.context().close();
  });
});

describe("the sections on a long page", () => {
  it.each(["focused-link", "blurred-summary"])(
    "keeps phone navigation reachable after scrolling and restores focus after Escape: %s",
    async (focus) => {
      const page = await onTheCards({ width: 390, height: 600 });
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const burger = page.locator(".site-menu > summary");
      const panel = page.locator(".site-menu-panel");

      const reach = await burger.boundingBox();
      expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
      expect(reach?.y).toBeGreaterThanOrEqual(0);
      expect((reach?.y ?? 600) + (reach?.height ?? 0)).toBeLessThanOrEqual(600);
      await burger.click();
      await panel.waitFor({ state: "visible" });
      expect(await panel.getByRole("link", { name: /Orders/ }).isVisible()).toBe(true);
      expect(await panel.getByText(PERSON).isVisible()).toBe(true);
      expect(await panel.getByRole("button", { name: "Sign out" }).isVisible()).toBe(true);

      if (focus === "focused-link") await panel.getByRole("link", { name: /Orders/ }).focus();
      else await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("Escape");
      await panel.waitFor({ state: "hidden" });
      expect(await burger.evaluate((element) => element === document.activeElement)).toBe(true);
      await page.context().close();
    },
  );

  it("are in a phone's menu that, opened on a scrolled page, keeps the header at the top and holds the page still under a wheel and a finger until it closes", async () => {
    const page = await onTheCards({ width: 390, height: 600 }, true);
    const burger = page.locator(".site-menu > summary");
    const panel = page.locator(".site-menu-panel");
    const scrolled = () => page.evaluate(() => window.scrollY);
    await page.evaluate(() => window.scrollTo(0, 300));
    const before = await scrolled();
    expect(before).toBe(300);

    await burger.tap();
    await panel.waitFor({ state: "visible" });
    expect((await page.locator("header.site-header").boundingBox())?.y).toBe(0);
    const box = await panel.boundingBox();
    const bottom = (box?.y ?? 0) + (box?.height ?? 0);
    expect(box?.y).toBeGreaterThan(0);
    expect(bottom).toBeLessThanOrEqual(600);
    // A point on the page itself, just under the panel.
    const under = { x: 100, y: bottom + 20 };
    await page.mouse.move(under.x, under.y);
    await page.mouse.wheel(0, 400);
    await dragUp(page, under, 200);
    await page.waitForTimeout(300);
    expect(await scrolled()).toBe(before);

    await burger.tap();
    await panel.waitFor({ state: "hidden" });
    await dragUp(page, under, 200);
    expect(await scrolled()).toBeGreaterThan(before);
    await page.context().close();
  });

  it("are in a phone's menu that closes once the focus leaves it, so what has the focus is not behind it", async () => {
    const page = await onTheCards({ width: 390, height: 800 });
    const menu = page.locator(".site-menu");
    const open = () => menu.evaluate((details) => (details as HTMLDetailsElement).open);

    await menu.locator("summary").focus();
    await page.keyboard.press("Enter");
    await menu.locator(".site-menu-panel").waitFor({ state: "visible" });
    await page.keyboard.press("Tab");
    expect(await open()).toBe(true);
    await menu.getByRole("button", { name: "Sign out" }).focus();
    await page.keyboard.press("Tab");

    expect(await open()).toBe(false);
    expect(await page.evaluate(() => document.activeElement?.closest(".site-menu"))).toBeNull();
    await page.context().close();
  });

  it("are in a phone's menu that closes when the page moves on, though the page drawn stays", async () => {
    const page = await onTheCards({ width: 390, height: 600 });
    await page.goto(`${origin}${BASE}/orders`);
    await page.waitForLoadState("networkidle");
    const panel = page.locator(".site-menu-panel");

    await page.locator(".site-menu > summary").click();
    await panel.waitFor({ state: "visible" });
    // The orders' segment leads to the same page, which is drawn again in
    // place rather than anew; the menu is open over it.
    await page.locator(".segments a", { hasText: "Open" }).focus();
    await page.keyboard.press("Enter");
    await page.waitForURL(`${origin}${BASE}/orders?show=open`);
    await page.waitForLoadState("networkidle");

    expect(await page.locator(".segments .here").textContent()).toMatch(/^Open/);
    expect(await panel.isVisible()).toBe(false);
    await page.context().close();
  });

  it("stay whole under the header on a laptop, down to the foot of the page", async () => {
    // A window taller than the sidebar's words and the foot together.
    const page = await onTheCards({ width: 1280, height: 700 });
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));

    const header = await page.locator("header.site-header").boundingBox();
    const sidebar = await page.locator(".app-sidebar-inner").boundingBox();
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    expect(sidebar?.y).toBeGreaterThanOrEqual((header?.y ?? 0) + (header?.height ?? 0));
    expect((sidebar?.y ?? 0) + (sidebar?.height ?? 0)).toBeLessThanOrEqual(700);
    for (const name of ["Orders", "Receipts", "API keys", "Integrations", "Settings"]) {
      const link = page.locator(".app-sidebar").getByRole("link", { name, exact: true });
      const box = await link.boundingBox();
      expect(box?.y).toBeGreaterThanOrEqual((header?.y ?? 0) + (header?.height ?? 0));
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(700);
      await link.click({ trial: true });
    }
    expect(await page.locator("footer").isVisible()).toBe(true);
    expect(
      await page.locator("footer").evaluate((element) => element.getBoundingClientRect().bottom),
    ).toBeLessThanOrEqual(701);
    await page.context().close();
  });
});

/** Once the site's face is drawn, so a bar is measured in the face a visitor sees. */
const inTheSiteFace = async (page: Page): Promise<boolean> => {
  await page.evaluate(() => document.fonts.ready);
  return await page.evaluate(() =>
    [...document.fonts].some(
      (face) => face.family.includes("Schibsted Grotesk") && face.status === "loaded",
    ),
  );
};

/** How many of what the locator finds are in sight. */
const inSight = (found: Locator): Promise<number> => found.filter({ visible: true }).count();

describe("navigation in the loaded dashboard", () => {
  it.each(
    [320, 390, 768, 905, 910, 911, 1440].flatMap((width) =>
      [true, false].map((signedIn) => ({ width, signedIn })),
    ),
  )(
    "keeps doors and account controls reachable at $width px, signed in $signedIn",
    async ({ width, signedIn }) => {
      const context = await browser.newContext({ viewport: { width, height: 700 } });
      if (signedIn) await context.addCookies(cookies.map((one) => ({ ...one, url: origin })));
      const page = await context.newPage();
      try {
        await page.goto(`${origin}${BASE}${signedIn ? "/products" : "/sign-in"}`);
        await page.waitForLoadState("networkidle");
        expect(await inTheSiteFace(page)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          width,
        );
        const header = page.locator("header.site-header");
        const menu = header.locator(".site-menu > summary");
        if (await menu.isVisible()) await menu.click();
        else if (signedIn) await header.locator(".site-account > summary").click();
        const controls = [
          header.getByRole("link", { name: "Docs", exact: true }).filter({ visible: true }),
          header.getByRole("link", { name: "Dashboard", exact: true }).filter({ visible: true }),
        ];
        if (signedIn) {
          expect(await inSight(page.getByRole("link", { name: "Orders", exact: true }))).toBe(1);
          expect(await inSight(page.getByText(PERSON, { exact: true }))).toBe(1);
          controls.push(
            page.getByRole("button", { name: "Sign out", exact: true }).filter({ visible: true }),
          );
        } else {
          controls.push(
            header.getByRole("link", { name: "Scanner", exact: true }).filter({ visible: true }),
            header
              .getByRole("link", { name: "Sell to agents", exact: true })
              .filter({ visible: true }),
          );
          expect(await page.getByLabel("Email address").isVisible()).toBe(true);
        }
        for (const control of controls) {
          expect(await control.count()).toBe(1);
          const box = await control.boundingBox();
          expect(box?.x).toBeGreaterThanOrEqual(0);
          expect((box?.x ?? width) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
          expect(box?.y).toBeGreaterThanOrEqual(0);
          expect((box?.y ?? 700) + (box?.height ?? 0)).toBeLessThanOrEqual(700);
          await control.click({ trial: true });
        }
      } finally {
        await context.close();
      }
    },
  );

  it.each([320, 390, 1280])(
    "keeps the global selling switch reachable before the product list at %ipx",
    async (width) => {
      await harnessed.gateway.setSelling(harnessed.merchant.id, "open");
      const page = await onTheCards({ width, height: 700 });
      try {
        const pause = page.getByRole("button", { name: "Pause all sales", exact: true });
        const box = await pause.boundingBox();
        expect(await page.evaluate(() => window.scrollY)).toBe(0);
        expect(box?.y).toBeGreaterThanOrEqual(0);
        expect((box?.y ?? 700) + (box?.height ?? 0)).toBeLessThanOrEqual(700);
        expect((await harnessed.gateway.catalog()).items.length).toBeGreaterThan(0);
        await pause.click();
        await page.getByRole("button", { name: "Resume all sales", exact: true }).waitFor();
        expect((await harnessed.gateway.catalog()).items).toStrictEqual([]);
      } finally {
        await harnessed.gateway.setSelling(harnessed.merchant.id, "open");
        await page.context().close();
      }
    },
  );

  it("renders frame, list and form boundaries with the styles actually loaded by Chromium", async () => {
    const page = await onTheCards();
    try {
      const body = await page.locator("body").evaluate((element) => {
        const s = getComputedStyle(element);
        return { background: s.backgroundColor, color: s.color };
      });
      expect(body).toStrictEqual({ background: "rgb(246, 244, 239)", color: "rgb(26, 25, 23)" });
      for (const selector of ["header.site-header", ".list"]) {
        const painted = await page
          .locator(selector)
          .first()
          .evaluate((element) => {
            const s = getComputedStyle(element);
            return {
              width: parseFloat(s.borderBottomWidth),
              style: s.borderBottomStyle,
              color: s.borderBottomColor,
              background: s.backgroundColor,
            };
          });
        expect(painted.width).toBeGreaterThan(0);
        expect(painted.style).toBe("solid");
        expect(painted.color).toBe("rgb(231, 227, 219)");
        expect(painted.background).not.toBe("rgba(0, 0, 0, 0)");
      }
      await page.goto(`${origin}${BASE}/settings`);
      const field = await page.getByLabel("Shop's site").evaluate((element) => {
        const s = getComputedStyle(element);
        return {
          width: parseFloat(s.borderTopWidth),
          style: s.borderTopStyle,
          border: s.borderTopColor,
          background: s.backgroundColor,
          color: s.color,
        };
      });
      expect(field.width).toBeGreaterThan(0);
      expect(field).toMatchObject({
        style: "solid",
        border: "rgb(141, 137, 129)",
        background: "rgb(255, 254, 250)",
        color: "rgb(26, 25, 23)",
      });
    } finally {
      await page.context().close();
    }
  });
});

it("closes fulfillment from a keyboard-accessible order form and preserves the merchant statement, line breaks and all", async () => {
  const published = await harnessed.gateway.publishCard(harnessed.merchant.id, {
    merchant_item_id: "esim-closure",
    title: "eSIM Europe, 5 GB for 30 days",
    description: "A profile delivered after purchase",
    price: { amount: "8.00", currency: "USD" },
    result: { activation_code: { type: "string" } },
    fulfillment: "async",
    fulfill_deadline_seconds: 3600,
  });
  if (!published.ok) throw new Error("the closure card was refused");
  const offered = await harnessed.gateway.beginPurchase(published.id, {});
  if (offered.step !== "pay") throw new Error("the closure order was not priced");
  const id = offered.order.order.id;
  const paid = await harnessed.gateway.payPurchase(
    offered.order.priceOffer.stamp,
    "CLOSURE_PAYMENT",
    "CLOSURE_PAYMENT",
    undefined,
    { itemId: offered.order.itemId, params: offered.order.params },
  );
  if (paid.step !== "under_way") throw new Error("the closure payment was not accepted");
  const page = await onTheCards({ width: 390, height: 844 }, true);
  try {
    await page.goto(`${origin}${BASE}/orders?q=${encodeURIComponent(id)}`);
    const summary = page.locator("details.row-more > summary");
    await summary.focus();
    await page.keyboard.press("Enter");
    const message = "  A remedy was agreed outside Agentify.\nNothing more is owed.  ";
    await page.getByLabel("Note to the buyer (optional)").fill(message);
    await page.getByRole("button", { name: "Close fulfillment", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.waitForURL(
      `${origin}${BASE}/orders?q=${encodeURIComponent(id)}&details=${encodeURIComponent(id)}#details-${encodeURIComponent(id)}`,
    );
    const details = page.locator(`[id="details-${id}"] .more-body`);
    await details.getByText("Closed by you", { exact: true }).waitFor();
    expect(await details.innerText()).toMatch(/Payment\s+Paid/);
    expect(await details.textContent()).toContain(message);
    expect(await page.getByRole("button", { name: "Close fulfillment", exact: true }).count()).toBe(
      0,
    );
    expect((await harnessed.store.orderById(id))?.order.merchantClosure?.message).toBe(message);
  } finally {
    await page.context().close();
  }
});

describe("a request that fails or stops on its way", () => {
  it("keeps the unknown-outcome recovery visible when the browser loses both data and asset access", async () => {
    const page = await onTheCards();
    try {
      await page.context().setOffline(true);
      await page.locator("form[action*='pause='] button").first().click();
      await page
        .getByRole("heading", { name: "We don't know if this was done", exact: true })
        .waitFor({ timeout: 5000 });
      expect(
        await page.getByRole("link", { name: "Open Products", exact: true }).getAttribute("href"),
      ).toBe(`${BASE}/products`);
    } finally {
      await page.context().setOffline(false);
      await page.context().close();
    }
  });

  /** A failure on the way to the dashboard: the connection dropped, or a proxy answered for it while it restarted. */
  const FAILURES = [
    ["the connection drops", (route: Route) => route.abort("connectionreset")],
    [
      "a proxy answers 502 in its own words",
      (route: Route) =>
        route.fulfill({ status: 502, contentType: "text/html", body: "<h1>502 Bad Gateway</h1>" }),
    ],
  ] as const;

  /** The words of the page's main region, spaces folded. */
  const mainText = async (page: Page): Promise<string> =>
    ((await page.locator("main").innerText()) ?? "").replace(/\s+/g, " ");

  it.each(FAILURES)(
    "says a list that could not be read could not be loaded, and offers the same list again, search and all, when %s",
    async (_, fail) => {
      const page = await onTheCards();
      await page.goto(`${origin}${BASE}/orders`);
      await page.waitForLoadState("networkidle");
      await page.route(`${origin}${BASE}/orders.data?show=open*`, fail);

      await page.locator(".segments a", { hasText: "Open" }).click();
      const again = page.getByRole("link", { name: "Try again" });
      await again.waitFor({ timeout: 5_000 });

      expect(await mainText(page)).toMatch(/could not be loaded/);
      expect(await mainText(page)).not.toMatch(/went through|may or may not|don't know/i);
      expect(await again.getAttribute("href")).toBe(`${BASE}/orders?show=open`);
      await page.context().close();
    },
  );

  it.each(FAILURES)(
    "says nobody knows whether a press whose answer was lost was done, and leads back to the list it was pressed on with a read that sends nothing again, when %s",
    async (_, fail) => {
      const page = await onTheCards();
      await page.goto(`${origin}${BASE}/products?q=room`);
      await page.waitForLoadState("networkidle");
      const posts: string[] = [];
      page.on("request", (request) => {
        if (request.method() === "POST") posts.push(request.url());
      });
      await page.route(`${origin}${BASE}/products.data?*`, (route) =>
        route.request().method() === "POST" ? fail(route) : route.fallback(),
      );

      await page.locator(".list-row form[action*='pause='] button").first().click();
      const reopen = page.getByRole("link", { name: "Open Products" });
      await reopen.waitFor({ timeout: 5_000 });
      const href = (await reopen.getAttribute("href")) ?? "";

      expect(await mainText(page)).toMatch(/We don't know if this was done/);
      expect(await mainText(page)).not.toMatch(/could not be loaded/);
      expect(href).toBe(`${BASE}/products?q=room`);
      await reopen.click();
      await page.waitForURL(`${origin}${href}`);
      await page.waitForLoadState("networkidle");
      expect(posts).toHaveLength(1);
      await page.context().close();
    },
  );

  it("locks what was typed while a save is on its way, sends it whole, says it is still waiting, and once the server's deadline has passed says the change could not be confirmed, still locked", async () => {
    const page = await onTheCards();
    await page.goto(`${origin}${BASE}/settings`);
    await page.waitForLoadState("networkidle");
    const held: Route[] = [];
    await page.route(`${origin}${BASE}/settings/site`, (route) => {
      if (route.request().method() === "POST") held.push(route);
      else void route.fallback();
    });
    const site = page.getByLabel("Shop's site");
    const form = page.locator("form[action$='/settings/site']");

    await site.fill("https://rooms.example.com");
    // Playwright waits out a page that is loading before it reads one, and the
    // save's answer is held, so the page reads itself: what the field allows a
    // moment after the press, then what the form says once seconds have passed
    // with no answer, before the load is stopped.
    await form.evaluate((sending) => {
      const field = sending.querySelector<HTMLInputElement>("input[name='seller_site']");
      const seen = document.body.dataset;
      sending.addEventListener("submit", () => {
        setTimeout(() => {
          seen.typableSoon = String(field?.matches(":enabled:read-write"));
        }, 300);
        setTimeout(() => {
          seen.waiting = sending.querySelector("[role='status']")?.textContent ?? "";
        }, 6_000);
        setTimeout(() => {
          seen.typableLater = String(field?.matches(":enabled:read-write"));
          seen.said = sending.querySelector("[role='status']")?.textContent ?? "";
          seen.reads = sending.querySelector("[role='status'] a")?.getAttribute("href") ?? "";
          seen.saveable = String(!sending.querySelector("button")?.disabled);
          window.stop();
        }, 15_000);
      });
    });
    // Not waited for: a click waits for the page it starts, which is held.
    const clicked = form.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => held.length).toBe(1);
    const sent = new URLSearchParams(held[0]?.request().postData() ?? "");
    await page.waitForTimeout(15_500);
    await held[0]?.abort().catch(() => {});
    await clicked.catch(() => {});
    const seen = await page.evaluate(() => ({ ...document.body.dataset }));

    expect(sent.get("seller_site")).toBe("https://rooms.example.com");
    expect(sent.get(DRAWN_FOR)).toBe(PERSON);
    expect(seen).toMatchObject({
      typableSoon: "false",
      typableLater: "false",
      saveable: "false",
      reads: `${BASE}/settings`,
    });
    expect(seen.waiting).toMatch(/still waiting.*answer/i);
    expect(seen.said).toMatch(/could not confirm.*change.*made/i);
    expect(seen.said).not.toMatch(/nothing was changed|saved successfully/i);
    expect(await site.inputValue()).toBe("https://rooms.example.com");
    await page.context().close();
    // The site's save waits out the gateway's ten seconds before it says so.
  }, 40_000);
});

it.each(["products", "keys"])(
  "keeps the new-key dialog protected and clears its secret on Done from %s",
  async (section) => {
    const email = `onboarding-${section}@example.com`;
    const merchant = await harnessed.gateway.registerMerchant();
    const person = await onboardingIdentity.make(email, merchant);
    if (person === null) throw new Error("the account was not created");
    await onboardingIdentity.choosePlatform(person.id, "api");
    await onboardingIdentity.requestLink(email, "default", ONE_CLIENT);
    const mail = onboardingMessages.at(-1);
    const link = new URL(mail?.body.match(/https?:\/\/\S+/)?.[0] ?? "");
    const signedIn = await onboardingIdentity.openLink(link.searchParams.get("token") ?? "");
    if (signedIn.status !== "opened") throw new Error("onboarding sign-in did not open");
    const context = await browser.newContext({
      viewport: { width: section === "products" ? 375 : 1024, height: 812 },
    });
    await context.addCookies(
      signedIn.setCookies.map((line) => {
        const pair = line.split(";")[0] ?? "";
        const equals = pair.indexOf("=");
        return { name: pair.slice(0, equals), value: pair.slice(equals + 1), url: origin };
      }),
    );
    const page = await context.newPage();
    try {
      const scripts = scriptsRequestedBy(page);
      await page.goto(`${origin}${BASE}/${section}`);
      await withinScriptBudget(`${section}: code entry`, page, scripts);
      const keyLabel = `Worker${"x".repeat(94)}`;
      await page.getByRole("textbox", { name: "Key name" }).fill(keyLabel);
      const beforeIssue = [...scripts].sort();
      await page.getByRole("button", { name: "Create key", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Copy your new key" });
      await dialog.waitFor();
      expect([...scripts].sort(), "issuance must not fetch disclosure code").toEqual(beforeIssue);
      if (section === "products") {
        await page.waitForTimeout(11_000);
        expect(await dialog.isVisible()).toBe(true);
      }
      const secret = await dialog.getByRole("textbox", { name: "New API key" }).inputValue();
      expect(secret).toMatch(/^csk_test_/);
      expect(await page.locator("dialog").evaluate((element) => element.matches(":modal"))).toBe(
        true,
      );
      await page.keyboard.press("Escape");
      expect(await dialog.isVisible()).toBe(true);
      await page.mouse.click(1, 1);
      expect(await dialog.isVisible()).toBe(true);
      for (let count = 0; count < 8; count += 1) {
        await page.keyboard.press("Tab");
        expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(
          true,
        );
      }
      const focusAfter = section === "products" ? "code-quickstart" : "create-api-key";
      const destination = await page.locator(`#${focusAfter}`).elementHandle();
      if (destination === null) throw new Error("the dialog has no return control");
      // Keep the final page on its way while dismissal restores its first focus.
      const held: Route[] = [];
      await page.route(
        `${origin}${BASE}/${section}.data*`,
        (route) => {
          if (route.request().method() === "GET") held.push(route);
          else void route.fallback();
        },
        { times: 1 },
      );
      await dialog.getByRole("button", { name: "Done", exact: true }).click();
      await expect.poll(() => held.length).toBe(1);
      await dialog.waitFor({ state: "hidden" });
      await expect
        .poll(() => destination.evaluate((element) => element === document.activeElement))
        .toBe(true);
      expect(await page.locator("body").innerHTML()).not.toContain(secret);
      await held[0]?.continue();
      // The issued label proves the loader's view arrived at this unchanged URL.
      await page.getByText(keyLabel, { exact: section === "keys" }).waitFor();
      await page.waitForURL(`${origin}${BASE}/${section}`);
      await page.waitForFunction((id) => document.activeElement?.id === id, focusAfter);
      expect(await page.getByRole("dialog").count()).toBe(0);
      expect(await page.locator("body").innerHTML()).not.toContain(secret);
      if (section === "products") {
        await harnessed.gateway.poll(merchant, 0, { through: "api" });
        await expect
          .poll(() => page.getByText("Your code connected", { exact: false }).count(), {
            timeout: 15_000,
          })
          .toBe(1);
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.reload();
      expect(await page.getByRole("dialog").count()).toBe(0);
      expect(await page.locator("body").innerHTML()).not.toContain(secret);
    } finally {
      await context.close();
    }
  },
  40_000,
);

it.each([
  {
    state: "live code request",
    test: false,
    shop: false,
    pending: false,
    intent: "request-live-sales",
    fields: ["seller_name"],
  },
  {
    state: "live code request with a pending wallet change",
    test: false,
    shop: false,
    pending: false,
    intent: "request-live-sales",
    fields: ["seller_name"],
    walletChange: true,
  },
  {
    state: "live pending wallet",
    test: false,
    shop: false,
    pending: true,
    intent: "save-onboarding-wallet",
    fields: ["payout_wallet"],
  },
  {
    state: "test code profile",
    test: true,
    shop: false,
    pending: false,
    intent: "save-onboarding-profile",
    fields: ["seller_name", "payout_wallet"],
  },
  {
    state: "test checked shop profile and publish",
    test: true,
    shop: true,
    pending: false,
    intent: "save-onboarding-profile",
    fields: ["seller_name", "payout_wallet", "checked_job"],
  },
])(
  "keeps the first account form usable within the initial script budget: $state",
  async (fixture) => {
    const channel: Record<string, string> = fixture.test
      ? { PAYMENT_NETWORK: "eip155:84532", FACILITATOR_URL: "https://x402.org/facilitator" }
      : {
          PAYMENT_NETWORK: "eip155:8453",
          FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
          CDP_API_KEY_ID: "local-browser-fixture",
          CDP_API_KEY_SECRET: "local-browser-fixture",
        };
    // Real channel rules, with local payment I/O and an inert transactional notice adapter.
    const isolated = await harness(channel, { liveSalesNotices: { stage: () => () => {} } });
    onTestFinished(() => isolated.stop());
    const config = loadConfig({
      ...channel,
      DATABASE_URL: "postgres://nobody@nowhere/unused",
      AUTH_SECRET: TEST_AUTH_SECRET,
      BASE_PATH: BASE,
    });
    const mails: Message[] = [];
    const identity = identityFor(config, {
      postman: async (message) => {
        mails.push(message);
        return "accepted";
      },
    });
    onTestFinished(() => identity.close());
    const merchant = await isolated.gateway.registerMerchant();
    const person = await identity.make("account-first-visit@example.com", merchant);
    if (person === null) throw new Error("the account was not created");
    if ("walletChange" in fixture && fixture.walletChange) {
      const waiting = "0x0000000000000000000000000000000000000009";
      await isolated.gateway.setPayoutWallet(
        merchant,
        "0x0000000000000000000000000000000000000008",
        { kind: "signed_in", email: person.email },
      );
      await isolated.gateway.setPayoutWallet(merchant, waiting, {
        kind: "signed_in",
        email: person.email,
      });
      expect((await isolated.store.merchantById(merchant))?.payoutWallet.pending?.address).toBe(
        waiting,
      );
    }
    await identity.acknowledgeTest(person.id);
    await identity.choosePlatform(person.id, fixture.shop ? "woocommerce" : "api");
    const shops = memoryWooShops();
    let checkedJob: string | undefined;
    if (fixture.shop) {
      await isolated.gateway.setSellerName(merchant, { seller_site: "https://woo.nuanu.ai" });
      await isolated.gateway.sellThrough(merchant, "woocommerce");
      await shops.connect({
        accountId: person.id,
        shopUrl: "https://woo.nuanu.ai",
        consumerKey: "ck_browser_fixture",
        consumerSecret: "cs_browser_fixture",
        permissions: "read_write",
        revision: "account-first-visit",
        connectedAt: new Date(isolated.now()),
        currency: { code: "USD", decimals: 2 },
      });
      const { job } = await shops.jobs.request({
        accountId: person.id,
        merchantId: merchant,
        connectionRevision: "account-first-visit",
        shopUrl: "https://woo.nuanu.ai",
        kind: "check",
      });
      checkedJob = job.id;
      if ((await shops.jobs.claim())?.id !== job.id) throw new Error("the check was not claimed");
      await shops.jobs.currency(job.id, { code: "USD", decimals: 2 });
      await shops.jobs.record(
        job.id,
        {
          id: "28",
          title: "Canvas tote bag",
          group: "ready",
          reason: "ready",
          why: "",
          published: false,
        },
        1,
      );
      await shops.jobs.total(job.id, 1);
      await shops.jobs.finish(job.id, { status: "completed", stopCode: null, why: null });
    }
    if (!fixture.shop) await isolated.addKey(merchant);
    await isolated.gateway.poll(merchant, 0, { through: fixture.shop ? "woocommerce" : "api" });
    if (fixture.pending) {
      await isolated.gateway.setSellerName(merchant, { seller_name: "Their own shop" });
      await isolated.store.requestLiveSales(
        {
          merchantId: merchant,
          accountId: person.id,
          sellerName: "Their own shop",
          evidence: { integration: "api", connectedAt: isolated.now() },
        },
        isolated.now(),
      );
    }
    await identity.requestLink(person.email, "default", ONE_CLIENT);
    const link = new URL(mails.at(-1)?.body.match(/https?:\/\/\S+/)?.[0] ?? "");
    const signedIn = await identity.openLink(link.searchParams.get("token") ?? "");
    if (signedIn.status !== "opened") throw new Error("the account sign-in did not open");
    const app = buildApp(config, {
      pages: await builtPages(),
      gateway: isolated.gateway,
      identity,
      wooShops: shops,
      now: () => new Date(isolated.now()),
      shop: {
        grantScreen: async () => {
          throw new Error("this first visit must not connect a shop");
        },
        preview: async () => {
          throw new Error("this first visit must not read a shop");
        },
        inspectProduct: async () => {
          throw new Error("this first visit must not read a product");
        },
        reference: async () => ({ ok: false, listed: null }),
      },
    });
    const server = app.listen(0, "127.0.0.1");
    onTestFinished(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const context = await browser.newContext();
    onTestFinished(() => context.close());
    {
      await context.addCookies(
        signedIn.setCookies.map((line) => {
          const pair = line.split(";")[0] ?? "";
          const at = pair.indexOf("=");
          return { name: pair.slice(0, at), value: pair.slice(at + 1), url: local };
        }),
      );
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const scripts = scriptsRequestedBy(page);
      const response = await page.goto(`${local}${BASE}/products`);
      if (response === null) throw new Error("the account page did not arrive");
      const html = await response.text();
      await withinScriptBudget(fixture.state, page, scripts);
      if ("walletChange" in fixture && fixture.walletChange) {
        expect(await page.getByRole("button", { name: "Cancel this change" }).isVisible()).toBe(
          true,
        );
      }
      // The form is server-rendered and still actionable after hydration; no copy is pinned.
      expect(
        await page.evaluate(
          ({ html, intent }) => {
            const document = new DOMParser().parseFromString(html, "text/html");
            return [...document.querySelectorAll('form input[name="intent"]')].some(
              (input) => (input as HTMLInputElement).value === intent,
            );
          },
          { html, intent: fixture.intent },
        ),
      ).toBe(true);
      const form = page
        .locator("main form")
        .filter({ has: page.locator(`input[name="intent"][value="${fixture.intent}"]`) });
      expect(await form.isVisible()).toBe(true);
      for (const field of fixture.fields) {
        const input = form.locator(`input[name="${field}"]`);
        expect(await input.count(), `${fixture.state}: ${field}`).toBe(1);
        expect(await input.isEnabled()).toBe(true);
        if (field === "checked_job") expect(await input.inputValue()).toBe(checkedJob);
        else expect(await input.isVisible()).toBe(true);
      }
      const primary = page.locator("main .button-primary");
      expect(await primary.count()).toBe(1);
      expect(await form.locator(".button-primary").isEnabled()).toBe(true);
      expect(await page.getByRole("dialog").count()).toBe(0);
      if (fixture.fields.includes("payout_wallet")) {
        const wallet = "0x0000000000000000000000000000000000000009";
        const box = form.locator('input[name="payout_wallet"]');
        await box.fill(wallet);
        await page.waitForFunction(
          (wallet) =>
            document.querySelector("#payout_wallet-entered .address")?.textContent === wallet,
          wallet,
        );
        const overlong = `0x${"a".repeat(64)}`;
        await box.fill("");
        await box.pressSequentially(overlong);
        expect(await box.inputValue(), `${fixture.state}: complete wallet input`).toBe(overlong);
      }
      expect(errors).toEqual([]);
    }
  },
);

it("keeps an overlong wallet address whole in Settings", async () => {
  const page = await onTheCards();
  onTestFinished(() => page.context().close());
  await page.goto(`${origin}${BASE}/settings`);
  await page.waitForLoadState("networkidle");
  const box = page.locator('input[name="payout_wallet"]');
  const overlong = `0x${"a".repeat(64)}`;

  await box.fill("");
  await box.pressSequentially(overlong);

  expect(await box.inputValue()).toBe(overlong);
});

it("keeps the compiled sign-in page and its answers out of search when mail or the session read fails", async () => {
  const context = await browser.newContext();
  const whoIs = onboardingIdentity.whoIs;
  const address = `${origin}${BASE}/sign-in`;
  try {
    const normal = await context.request.get(address);
    const trailingSlash = await context.request.get(`${address}/`);
    const requested = await context.request.post(address, {
      headers: { Origin: origin },
      form: { email: "metadata-requested@example.com" },
    });
    signInMailHandover = "refused";
    const unavailable = await context.request.post(address, {
      headers: { Origin: origin },
      form: { email: "metadata-unavailable@example.com" },
    });
    // A real dependency read fails after the compiled route has been selected.
    onboardingIdentity.whoIs = async () => {
      throw new Error("declared session storage read failure");
    };
    const failed = await context.request.get(address);
    for (const [response, status] of [
      [normal, 200],
      [trailingSlash, 200],
      [requested, 202],
      [unavailable, 503],
      [failed, 500],
    ] as const) {
      expect(response.status()).toBe(status);
      const html = await response.text();
      const head = html.slice(0, html.indexOf("</head>"));
      expect(
        head.match(/<meta\b[^>]*name="robots"[^>]*>/)?.[0] ?? "",
        `sign-in status ${status}`,
      ).toMatch(/content="noindex"/);
    }
  } finally {
    signInMailHandover = "accepted";
    onboardingIdentity.whoIs = whoIs;
    await context.close();
  }
});

it("requires the test acknowledgement, keeps focus inside it and focuses the first platform after saving", async () => {
  const channel = {
    PAYMENT_NETWORK: "eip155:84532",
    FACILITATOR_URL: "https://x402.org/facilitator",
  };
  const isolated = await harness(channel);
  const config = loadConfig({
    ...channel,
    DATABASE_URL: "postgres://nobody@nowhere/unused",
    AUTH_SECRET: TEST_AUTH_SECRET,
    BASE_PATH: BASE,
  });
  const mails: Message[] = [];
  const identity = identityFor(config, {
    postman: async (message) => {
      mails.push(message);
      return "accepted";
    },
  });
  const merchant = await isolated.gateway.registerMerchant();
  await identity.make("test-welcome@example.com", merchant);
  await identity.requestLink("test-welcome@example.com", "default", ONE_CLIENT);
  const link = new URL(mails.at(-1)?.body.match(/https?:\/\/\S+/)?.[0] ?? "");
  const signedIn = await identity.openLink(link.searchParams.get("token") ?? "");
  if (signedIn.status !== "opened") throw new Error("the test sign-in did not open");
  const testShops = memoryWooShops();
  const app = buildApp(config, {
    pages: await builtPages(),
    gateway: isolated.gateway,
    identity,
    wooShops: testShops,
    shop: {
      reference: async () => ({ ok: false, listed: null }),
      preview: async () => {
        throw new Error("This stored-result reader does not preview a shop");
      },
      grantScreen: async () => {
        throw new Error("This stored-result reader does not request a grant");
      },
      inspectProduct: async () => {
        throw new Error("This stored-result reader does not buy a product");
      },
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const testOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
  await context.addCookies(
    signedIn.setCookies.map((line) => {
      const pair = line.split(";")[0] ?? "";
      const equals = pair.indexOf("=");
      return { name: pair.slice(0, equals), value: pair.slice(equals + 1), url: testOrigin };
    }),
  );
  const plain = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 375, height: 812 },
  });
  await plain.addCookies(await context.cookies());
  try {
    const page = await plain.newPage();
    await page.goto(`${testOrigin}${BASE}/products`);
    const welcome = page.getByRole("dialog", { name: "This is the test environment" });
    await welcome.waitFor();
    const bounds = await welcome.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds?.y).toBeGreaterThanOrEqual(0);
    expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(812);
    expect(await welcome.getByRole("button", { name: "Start testing" }).isVisible()).toBe(true);
  } finally {
    await plain.close();
  }
  const page = await context.newPage();
  try {
    const scripts = scriptsRequestedBy(page);
    await page.goto(`${testOrigin}${BASE}/products`);
    await withinScriptBudget("TEST acknowledgement and platform choice", page, scripts);
    const dialog = page.getByRole("dialog", { name: "This is the test environment" });
    await dialog.waitFor();
    const start = dialog.getByRole("button", { name: "Start testing" });
    await expect.poll(() => start.isDisabled()).toBe(true);
    await page.keyboard.press("Escape");
    expect(await dialog.isVisible()).toBe(true);
    for (let count = 0; count < 4; count += 1) {
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(
        true,
      );
    }
    await dialog.getByRole("checkbox", { name: "I've read and understood" }).check();
    await start.click();
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("data-platform") === "woocommerce",
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(await page.getByRole("dialog").count()).toBe(0);
    await page.reload();
    expect(await page.getByRole("dialog").count()).toBe(0);

    const shopMerchantId = await isolated.gateway.registerMerchant();
    await isolated.gateway.setSellerName(shopMerchantId, {
      seller_name: "Their own shop",
      seller_site: "https://woo.nuanu.ai",
    });
    const existing = await identity.make("existing-test-shop@example.com", shopMerchantId);
    if (existing === null) throw new Error("the existing shop identity was not created");
    await isolated.gateway.setPayoutWallet(
      shopMerchantId,
      "0x0000000000000000000000000000000000000004",
      { kind: "signed_in", email: existing.email },
    );
    await identity.choosePlatform(existing.id, "woocommerce");
    await identity.requestLink(existing.email, "default", ONE_CLIENT);
    const existingLink = new URL(mails.at(-1)?.body.match(/https?:\/\/\S+/)?.[0] ?? "");
    const existingSession = await identity.openLink(existingLink.searchParams.get("token") ?? "");
    if (existingSession.status !== "opened")
      throw new Error("the existing shop sign-in did not open");
    for (const state of ["new", "paused", "connected", "checked", "checked_idr"] as const) {
      const checked = state === "checked" || state === "checked_idr";
      if (state === "paused") {
        const card = await isolated.gateway.publishCard(shopMerchantId, {
          merchant_item_id: "room-101",
          title: "A room for the night",
          description: "One night in room 101",
          price: { amount: "80.00", currency: "USD" },
          result: { access_code: { type: "string" } },
          fulfillment: "sync",
        });
        if (!card.ok) throw new Error("the existing shop product was not published");
        await isolated.gateway.setSelling(shopMerchantId, "paused");
      }
      if (state === "connected")
        await testShops.connect({
          accountId: existing.id,
          shopUrl: "https://woo.nuanu.ai",
          consumerKey: "ck_browser_fixture",
          consumerSecret: "cs_browser_fixture",
          permissions: "read_write",
          revision: "browser-fixture-connection",
          connectedAt: new Date("2026-10-30T12:00:00Z"),
          currency: { code: "USD", decimals: 2 },
        });
      if (checked) {
        await isolated.gateway.sellThrough(shopMerchantId, "woocommerce");
        const wooCard = await isolated.gateway.publishCard(
          shopMerchantId,
          {
            merchant_item_id: merchantItemIdFor("https://woo.nuanu.ai", "28"),
            title: "Canvas tote bag",
            description: "A physical item shipped to the buyer.",
            price: { amount: "20.00", currency: "USD" },
            fulfillment: "ship",
            price_check: "handler",
            ship_within_seconds: 604800,
          },
          "woocommerce",
        );
        expect(wooCard.ok).toBe(true);
        await isolated.gateway.setSelling(shopMerchantId, "paused");
        expect(await isolated.store.merchantById(shopMerchantId)).toMatchObject({
          integration: "woocommerce",
          selling: "paused",
        });
        const currency =
          state === "checked_idr"
            ? { code: "IDR", decimals: 0 as const }
            : { code: "USD", decimals: 2 as const };
        await testShops.noteCurrency(existing.id, currency, "browser-fixture-connection");
        if (state === "checked_idr")
          await testShops.saveRate(existing.id, "https://woo.nuanu.ai", {
            currency: "IDR",
            rate: "16000",
            setAt: new Date(),
            sessionSignedInAt: null,
            reference: null,
            confirmed: false,
          });
        const { job } = await testShops.jobs.request({
          accountId: existing.id,
          merchantId: shopMerchantId,
          connectionRevision: "browser-fixture-connection",
          shopUrl: "https://woo.nuanu.ai",
          kind: "check",
        });
        expect((await testShops.jobs.claim())?.id).toBe(job.id);
        await testShops.jobs.currency(job.id, currency);
        await testShops.jobs.rate(
          job.id,
          await testShops.currentRate(existing.id, "https://woo.nuanu.ai", currency.code),
        );
        await testShops.jobs.record(
          job.id,
          {
            id: "28",
            title: "Canvas tote bag",
            group: "ready",
            reason: "ready",
            why: "",
            published: false,
          },
          1,
        );
        await testShops.jobs.finish(job.id, { status: "completed", stopCode: null, why: null });
      }
      const firstVisit = await browser.newContext();
      await firstVisit.addCookies(
        existingSession.setCookies.map((line) => {
          const pair = line.split(";")[0] ?? "";
          const at = pair.indexOf("=");
          return { name: pair.slice(0, at), value: pair.slice(at + 1), url: testOrigin };
        }),
      );
      try {
        const entry = await firstVisit.newPage();
        const initial = scriptsRequestedBy(entry);
        await entry.goto(`${testOrigin}${BASE}/${state === "new" ? "products" : "woocommerce"}`);
        await withinScriptBudget(
          state === "new"
            ? "TEST and Woo entry"
            : state === "paused"
              ? "TEST, Woo and paused account"
              : state === "connected"
                ? "TEST, connected Woo and paused account"
                : state === "checked_idr"
                  ? "TEST, paused Woo account, checked products and saved IDR rate"
                  : "TEST, paused Woo account and checked products",
          entry,
          initial,
        );
        expect(
          await entry.getByRole("dialog", { name: "This is the test environment" }).isVisible(),
        ).toBe(true);
        if (state === "connected" || checked)
          expect(await entry.getByText("Connected", { exact: true }).count()).toBe(1);
        else
          expect(
            await entry.getByRole("textbox", { name: "Shop address", includeHidden: true }).count(),
          ).toBe(1);
        if (state !== "new") expect(await entry.locator("[data-reason=paused]").count()).toBe(1);
        if (state === "checked_idr")
          expect(
            await entry
              .getByRole("textbox", { name: "IDR per US dollar", includeHidden: true })
              .inputValue(),
          ).toBe("16000");
        if (checked) {
          expect(
            await (await entry.request.get(`${testOrigin}${BASE}/shop-job`)).json(),
          ).toMatchObject({
            current: true,
            currency: state === "checked_idr" ? "IDR" : "USD",
            status: "completed",
            ready: 1,
          });
          expect(await entry.locator('[aria-label="Shop products"]').textContent()).toContain(
            "Canvas tote bag",
          );
          expect(
            await entry
              .getByRole("button", { name: "Check again", exact: true, includeHidden: true })
              .count(),
          ).toBe(1);
        }
      } finally {
        await firstVisit.close();
      }
    }
  } finally {
    await context.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await identity.close();
    await isolated.stop();
  }
});

it("checks a WooCommerce shop on Products, invalidates edited results and keeps the action below the result at four widths", async () => {
  const isolated = await harness({}, { ids: randomIds });
  const mails: Message[] = [];
  const config = loadConfig({
    DATABASE_URL: "postgres://nobody@nowhere/unused",
    AUTH_SECRET: TEST_AUTH_SECRET,
    PAYMENT_NETWORK: "eip155:84532",
    FACILITATOR_URL: "sandbox:scripted",
    BASE_PATH: BASE,
    PUBLIC_BASE_URL: "https://dashboard.example.com",
  });
  const identity = identityFor(config, {
    postman: async (message) => {
      mails.push(message);
      return "accepted";
    },
  });
  const shopMerchantId = await isolated.gateway.registerMerchant();
  const person = await identity.make("shop-check@example.com", shopMerchantId);
  if (person === null) throw new Error("the shop account was not created");
  await identity.choosePlatform(person.id, "woocommerce");
  await identity.requestLink(person.email, "default", ONE_CLIENT);
  const link = new URL(mails.at(-1)?.body.match(/https?:\/\/\S+/)?.[0] ?? "");
  const signedIn = await identity.openLink(link.searchParams.get("token") ?? "");
  if (signedIn.status !== "opened") throw new Error("the shop sign-in did not open");
  const codePerson = await identity.make("existing-code-shop@example.com", isolated.merchant.id);
  if (codePerson === null) throw new Error("the existing-code account was not created");
  await identity.choosePlatform(codePerson.id, "woocommerce");
  await identity.requestLink(codePerson.email, "default", ONE_CLIENT);
  const codeLink = new URL(mails.at(-1)?.body.match(/https?:\/\/\S+/)?.[0] ?? "");
  const codeSession = await identity.openLink(codeLink.searchParams.get("token") ?? "");
  if (codeSession.status !== "opened") throw new Error("the existing-code sign-in did not open");
  const shops = memoryWooShops();
  const product = {
    type: "simple",
    is_purchasable: true,
    is_in_stock: true,
    is_on_backorder: false,
    stock_availability: { text: "" },
    low_stock_remaining: null,
    prices: { price: "2500", currency_code: "USD", currency_minor_unit: 2 },
  };
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let first = true;
  const app = express();
  app.use(
    "/styles",
    express.static(
      fileURLToPath(new URL("../../../packages/visual/public/styles", import.meta.url)),
    ),
  );
  app.use(
    buildApp(config, {
      pages: await builtPages(),
      gateway: isolated.gateway,
      identity,
      wooShops: shops,
      shop: {
        preview: (url) =>
          publicShopOf(url, async () => {
            if (first) {
              first = false;
              entered.resolve();
              await release.promise;
            }
            return Response.json(
              [product, { ...product, type: "variable" }, { ...product, low_stock_remaining: 0 }],
              { headers: { "x-wp-total": "3" } },
            );
          }),
        grantScreen: async () => ({
          ok: false,
          why: "This local browser test never leaves for approval.",
        }),
        inspectProduct: inspectProductInTheShop,
      },
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const testOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const context = await browser.newContext();
  await context.addCookies(
    signedIn.setCookies.map((line) => {
      const pair = line.split(";")[0] ?? "";
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: testOrigin };
    }),
  );
  const plain = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 375, height: 900 },
  });
  await plain.addCookies(await context.cookies());
  try {
    const page = await plain.newPage();
    await page.goto(`${testOrigin}${BASE}/products`);
    expect(await page.getByRole("textbox", { name: "Shop address" }).isVisible()).toBe(true);
    await page.getByRole("textbox", { name: "Shop address" }).fill("woo.nuanu.ai");
    // This first request also checks the SSR path before the lazy module is warm.
    first = false;
    await page.getByRole("button", { name: "Check my shop", exact: true }).click();
    expect(await page.getByRole("button", { name: "Connect shop", exact: true }).isVisible()).toBe(
      true,
    );
    expect(
      await page.getByText("1 of 3 products looks ready to sell.", { exact: true }).isVisible(),
    ).toBe(true);
  } finally {
    await plain.close();
    first = true;
  }
  const page = await context.newPage();
  const scripts = scriptsRequestedBy(page);
  try {
    for (const width of [1440, 1024, 768, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${testOrigin}${BASE}/products`);
      await page.waitForLoadState("networkidle");
      if (width === 1440) await withinScriptBudget("Products: Woo shop entry", page, scripts);
      const address = page.getByRole("textbox", { name: "Shop address" });
      await address.fill("woo.nuanu.ai/");
      const check = page.getByRole("button", { name: "Check my shop", exact: true });
      const clicked = check.click();
      if (width === 1440) {
        await entered.promise;
        await expect.poll(() => check.isEnabled()).toBe(false);
        expect(await address.getAttribute("readonly")).not.toBeNull();
        release.resolve();
      }
      await clicked;
      const connect = page.getByRole("button", { name: "Connect shop", exact: true });
      await connect.waitFor();
      expect(await address.inputValue()).toBe("https://woo.nuanu.ai");
      const result = page.getByText("1 of 3 products looks ready to sell.", { exact: true });
      const geometry = await result.boundingBox();
      const press = await connect.boundingBox();
      expect((geometry?.y ?? 0) + (geometry?.height ?? 0)).toBeLessThan(press?.y ?? 0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(await shops.grantFor(person.id)).toBeNull();
      await address.fill("www.woo.nuanu.ai");
      expect(await result.count()).toBe(0);
      expect(await connect.count()).toBe(0);
      await address.press("Enter");
      await connect.waitFor();
      expect(await address.inputValue()).toBe("https://www.woo.nuanu.ai");
      expect(await shops.grantFor(person.id)).toBeNull();
      expect(new URL(page.url()).pathname).toBe(`${BASE}/products`);
    }

    const published = await isolated.gateway.publishCard(isolated.merchant.id, {
      merchant_item_id: "pending-delivery",
      title: "A room for the night",
      description: "One night in room 101",
      price: { amount: "80.00", currency: "USD" },
      result: { access_code: { type: "string" } },
      fulfillment: "async",
      fulfill_deadline_seconds: 3600,
    });
    if (!published.ok) throw new Error("the blocking product was not published");
    const offered = await isolated.gateway.beginPurchase(published.id, {});
    if (offered.step !== "pay") throw new Error("the blocking order was not priced");
    const paid = await isolated.gateway.payPurchase(
      offered.order.priceOffer.stamp,
      "BLOCKING_ORDER_PAYMENT",
      "BLOCKING_ORDER_PAYMENT",
      undefined,
      { itemId: offered.order.itemId, params: offered.order.params },
    );
    if (paid.step !== "under_way") throw new Error("the blocking order was not accepted");
    const orderId = paid.order.order.id;
    const refusal = await browser.newContext({ javaScriptEnabled: false });
    await refusal.addCookies(
      codeSession.setCookies.map((line) => {
        const pair = line.split(";")[0] ?? "";
        const at = pair.indexOf("=");
        return { name: pair.slice(0, at), value: pair.slice(at + 1), url: testOrigin };
      }),
    );
    try {
      const plainPage = await refusal.newPage();
      await plainPage.goto(`${testOrigin}${BASE}/woocommerce`);
      await plainPage.getByRole("textbox", { name: "Shop address" }).fill("woo.nuanu.ai");
      await plainPage.getByRole("button", { name: "Check my shop", exact: true }).click();
      const orders = plainPage.getByRole("list", { name: "The orders still open" });
      expect(await orders.isVisible()).toBe(true);
      await orders.locator("summary").click();
      expect(await orders.locator(".ident-all").textContent()).toBe(orderId);
    } finally {
      await refusal.close();
    }
    await context.grantPermissions([], { origin: testOrigin });
    await page.context().clearCookies();
    await page.context().addCookies(
      codeSession.setCookies.map((line) => {
        const pair = line.split(";")[0] ?? "";
        const at = pair.indexOf("=");
        return { name: pair.slice(0, at), value: pair.slice(at + 1), url: testOrigin };
      }),
    );
    await page.goto(`${testOrigin}${BASE}/woocommerce`);
    await page.getByRole("textbox", { name: "Shop address" }).fill("woo.nuanu.ai");
    await page.getByRole("button", { name: "Check my shop", exact: true }).click();
    const orders = page.getByRole("list", { name: "The orders still open" });
    await orders.getByRole("button", { name: /Copy the whole order ID/ }).click();
    await expect.poll(() => orders.locator(".copy-whole").textContent()).toBe(orderId);
    expect(await orders.locator(".copy-whole").isVisible()).toBe(true);
  } finally {
    release.resolve();
    await context.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await identity.close();
    await isolated.stop();
  }
}, 40_000);
