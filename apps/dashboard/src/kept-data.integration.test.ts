/**
 * What Chromium does with the dashboard's page data, against the built pages:
 * the click after the pointer rested on a section link is answered from the
 * fetch the rest made, and after a press nothing the browser kept from before
 * it is shown. The headers that promise this are held offline in
 * `server.test.ts`; this holds what a browser does with them, which a change of
 * React Router's data addresses could break with every header still in place.
 *
 * It needs the build (`pnpm --filter @agentify/dashboard build`) and
 * Playwright's Chromium, and counts what reaches the dashboard rather than what
 * the browser says about its cache.
 */

import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { type Harness, harness } from "@agentify/gateway/testing";
import express from "express";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { identityFor } from "./identity.js";
import type { Message } from "./mail.js";
import { builtPages } from "./pages.js";
import { buildApp } from "./server.js";

const PERSON = "owner@example.com";
const BASE = "/dashboard";

let harnessed: Harness;
let browser: Browser;
let close: () => Promise<void>;
let origin: string;
let cookies: { name: string; value: string }[];
const asked: string[] = [];

beforeAll(async () => {
  harnessed = await harness({ PAY_TO_ADDRESS: "0x0000000000000000000000000000000000000001" });
  const config = loadConfig({
    DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
    AUTH_SECRET: "a-secret-that-is-at-least-32-characters-long",
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
  const dashboard = buildApp(config, { pages, gateway: harnessed.gateway, identity });
  const counted = express();
  counted.use((request, _response, next) => {
    if (request.method === "GET" && request.path.endsWith(".data")) asked.push(request.path);
    next();
  });
  counted.use(dashboard);
  const server = counted.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The Chrome a Mac already has, as the browser observer's test does;
  // Playwright's own Chromium wherever there is none.
  const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch(
    process.platform === "darwin" && existsSync(macChrome) ? { executablePath: macChrome } : {},
  );
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
const onTheCards = async (): Promise<Page> => {
  const context = await browser.newContext();
  await context.addCookies(cookies.map((one) => ({ ...one, url: origin })));
  const page = await context.newPage();
  await page.goto(`${origin}${BASE}/cards`);
  await page.waitForLoadState("networkidle");
  return page;
};

/** The sidebar's link, not the narrow menu's copy of it. */
const linkTo = (page: Page, section: string) =>
  page.locator("nav.tabs a", { hasText: section });

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
