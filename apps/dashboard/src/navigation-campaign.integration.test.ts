/**
 * Forty-eight seeded parameter traces over real built pages. Every trace has
 * twelve named operations; helper clicks are not counted as extra operations.
 * Only local identity rows, the gateway and Chromium are used. A held data
 * request gives the superseded navigation a deterministic ordering.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type Harness, harness } from "@agentify/gateway/testing";
import { launchChromium } from "@agentify/ui/chromium";
import express from "express";
import type { Browser, BrowserContext, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { gatewayFor } from "./gateway.js";
import { type Identity, identityFor } from "./identity.js";
import { builtPages } from "./pages.js";
import { buildApp } from "./server.js";
import { TEST_AUTH_SECRET } from "./testing/secrets.js";

const BASE = "/dashboard";
const CONFIG = loadConfig({
  DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
  AUTH_SECRET: TEST_AUTH_SECRET,
  PAYMENT_NETWORK: "eip155:84532",
  FACILITATOR_URL: "sandbox:scripted",
  BASE_PATH: BASE,
});
const SEEDS = [0xc61a0001, 0xc61a0002, 0xc61a0003];
const NAV = ["orders", "integrations", "keys", "settings"] as const;
const labels = {
  cards: "Cards",
  orders: "Orders",
  receipts: "Receipts",
  integrations: "Integrations",
  keys: "API keys",
  settings: "Settings",
} as const;
type Section = keyof typeof labels;
const barrier = () => {
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { waiting, release };
};
let held: { arrived: ReturnType<typeof barrier>; resumed: ReturnType<typeof barrier> } | null =
  null;
let real: Harness;
let identity: Identity;
let server: Server;
let browser: Browser;
let origin: string;
const letters = new Map<string, string>();

beforeAll(async () => {
  real = await harness({ PAYMENT_NETWORK: "eip155:84532", FACILITATOR_URL: "sandbox:scripted" });
  identity = identityFor(CONFIG, {
    postman: async (message) => {
      letters.set(message.to, message.body);
      return "accepted";
    },
  });
  const app = express();
  app.use((request, _response, next) => {
    if (held !== null && request.method === "GET" && request.path === `${BASE}/receipts.data`) {
      const mine = held;
      held = null;
      mine.arrived.release();
      void mine.resumed.waiting.then(() => next());
      return;
    }
    next();
  });
  app.use(buildApp(CONFIG, { pages: await builtPages(), gateway: real.gateway, identity }));
  server = createServer(app);
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await launchChromium();
});
afterAll(async () => {
  await browser?.close();
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  await identity?.close();
  await real?.stop();
});

const account = async (index: number) => {
  const merchant = await real.addMerchant();
  const email = `navigation-${index}-${merchant.id}@example.com`;
  const person = await identity.make(email, merchant.id);
  if (person === null) throw new Error("local account was not made");
  await identity.requestLink(email, "default");
  const token = /[?&]token=([A-Za-z0-9]+)/.exec(letters.get(email) ?? "")?.[1];
  if (token === undefined) throw new Error("local sign-in contained no token");
  const opened = await identity.openLink(token);
  if (opened.status !== "opened") throw new Error("local sign-in did not open");
  const cookies = opened.setCookies.map((line) => {
    const pair = line.split(";", 1)[0] ?? "";
    const equals = pair.indexOf("=");
    return { name: pair.slice(0, equals), value: pair.slice(equals + 1), url: origin };
  });
  const gateway = gatewayFor(real.gateway, { merchantId: merchant.id, email });
  await gateway.setSellerSite("https://shop.example.com");
  const sku = `DL-GIFT-MESSAGES-${merchant.id}`;
  const title = `Gift Message Templates ${merchant.id}`;
  const published = await real.gateway.publishCard(merchant.id, {
    merchant_item_id: sku,
    title,
    description: "Twenty gift-card messages delivered as one plain-text file.",
    price: { amount: "1.00", currency: "USD" },
    result: { download_url: { type: "string" } },
    fulfillment: "sync",
  });
  if (!published.ok) throw new Error("local card was not published");
  return { email, person, merchant, cookies, gateway, sku, title };
};
type Account = Awaited<ReturnType<typeof account>>;

const settled = async (page: Page) => {
  await page.locator("h1").waitFor({ state: "visible" });
  await page.locator(".on-its-way").waitFor({ state: "hidden" });
};
const menu = (page: Page) => page.locator(".site-menu > summary");
const openMenuIfNeeded = async (page: Page) => {
  if (await menu(page).isVisible()) {
    const details = page.locator(".site-menu");
    if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open)))
      await menu(page).click();
  }
};
const navigate = async (page: Page, section: Section) => {
  const path = `${BASE}/${section}`;
  if (new URL(page.url()).pathname === path && new URL(page.url()).search === "") return;
  await openMenuIfNeeded(page);
  const link = page
    .locator("nav[aria-label='Dashboard sections'] a")
    .filter({ hasText: labels[section], visible: true });
  if ((await link.count()) === 0) {
    // A current section is drawn as a span, including when only its filter
    // differs; that section's own address is still a normal navigation.
    await page.goto(`${origin}${path}`);
  } else await link.first().click();
  await page.waitForURL(`${origin}${path}`);
  await settled(page);
};

const snapshot = async (who: Account) => ({
  cards: await who.gateway.cards(),
  seller: await who.gateway.seller(),
});
const ownerIs = async (page: Page, owner: Account, other: Account) => {
  await settled(page);
  await openMenuIfNeeded(page);
  expect(await page.getByText(owner.email, { exact: true }).filter({ visible: true }).count()).toBe(
    1,
  );
  expect(await page.getByText(other.email, { exact: true }).filter({ visible: true }).count()).toBe(
    0,
  );
  if (await menu(page).isVisible()) await page.keyboard.press("Escape");
  const marks = await page
    .locator("input[name=signed_in_as]")
    .evaluateAll((elements) => elements.map((element) => (element as HTMLInputElement).value));
  expect(marks.every((mark) => mark === owner.email)).toBe(true);
  const pathname = new URL(page.url()).pathname;
  if (pathname === `${BASE}/cards`) {
    const cards = await owner.gateway.cards();
    if (!cards.ok) throw new Error("local card readback failed");
    expect(await page.locator("#main").textContent()).toContain(owner.title);
    expect(await page.locator("#main").textContent()).not.toContain(other.title);
    const verb = cards.document.selling === "open" ? "pause" : "resume";
    expect(await page.locator(`form[action*='selling=${verb}']`).count()).toBe(1);
  }
  if (pathname === `${BASE}/settings`) {
    const seller = await owner.gateway.seller();
    if (!seller.ok) throw new Error("local seller readback failed");
    expect(await page.locator("input[name=seller_name]").inputValue()).toBe(seller.document.name);
  }
};

const cookieAs = (context: BrowserContext, who: Account) => context.addCookies(who.cookies);

describe("campaign: 48 parameterized browser traces of twelve operations", () => {
  for (const base of SEEDS)
    for (let trace = 0; trace < 16; trace += 1) {
      const seed = (base ^ Math.imul(trace + 1, 0x9e3779b9)) >>> 0;
      const mobile = (seed & 1) === 1;
      it(`seed=0x${seed.toString(16)} ${mobile ? "mobile" : "desktop"}`, async () => {
        const pair = await Promise.all([account(0), account(1)]);
        const owner = pair[(seed >>> 1) & 1];
        const other = pair[1 - ((seed >>> 1) & 1)];
        if (owner === undefined || other === undefined) throw new Error("missing local merchant");
        const context = await browser.newContext({
          viewport: mobile ? { width: 390, height: 800 } : { width: 1280, height: 900 },
          isMobile: mobile,
          hasTouch: mobile,
        });
        const page = await context.newPage();
        let delayed: typeof held = null;
        try {
          await cookieAs(context, owner);
          if ((seed & 4) !== 0) await owner.gateway.setSelling(false);
          await page.goto(`${origin}${BASE}/cards`);
          await ownerIs(page, owner, other);
          // 1. A client navigation selected by the seed.
          await navigate(page, NAV[(seed >>> 3) % NAV.length] ?? "orders");
          await ownerIs(page, owner, other);
          // 2. Intent-prefetch and navigation to another seeded section.
          const next = NAV[((seed >>> 3) + 1) % NAV.length] ?? "settings";
          await openMenuIfNeeded(page);
          const intent = page
            .locator("nav[aria-label='Dashboard sections'] a")
            .filter({ hasText: labels[next], visible: true })
            .first();
          await intent.focus();
          await navigate(page, next);
          await ownerIs(page, owner, other);
          // 3. Mutate selling through the real form, then read the real gateway.
          await navigate(page, "cards");
          const beforeSelling = await owner.gateway.cards();
          if (!beforeSelling.ok) throw new Error("local card readback failed");
          await page.locator("form[action*='selling='] button").click();
          await expect
            .poll(async () => {
              const read = await owner.gateway.cards();
              return read.ok ? read.document.selling : null;
            })
            .not.toBe(beforeSelling.document.selling);
          await ownerIs(page, owner, other);
          // 4. Reload must show the same persisted state.
          await page.reload();
          await ownerIs(page, owner, other);
          // 5. Change the seller name through a whole-document form.
          await navigate(page, "settings");
          const name = `Campaign ${seed.toString(16)}`;
          await page.locator("input[name=seller_name]").fill(name);
          const nameForm = page
            .locator("form")
            .filter({ has: page.locator("input[name=seller_name]") });
          await nameForm.getByRole("button").click();
          await expect
            .poll(async () => {
              const read = await owner.gateway.seller();
              return read.ok ? read.document.name : null;
            })
            .toBe(name);
          await ownerIs(page, owner, other);
          // 6. Back must retain ownership and the completed mutation.
          await page.goBack();
          await ownerIs(page, owner, other);
          expect((await owner.gateway.seller()).ok).toBe(true);
          // 7. The selected Orders filter agrees with its URL after settling.
          await navigate(page, "orders");
          await page.locator(".filter a").filter({ hasText: "Open" }).click();
          await page.waitForURL(`${origin}${BASE}/orders?open=true`);
          await ownerIs(page, owner, other);
          expect(await page.locator(".filter .here").textContent()).toBe("Open");
          // 8. Supersede a held first Receipts visit with Orders. The old data
          // arriving afterwards must not replace the page the merchant chose.
          delayed = { arrived: barrier(), resumed: barrier() };
          held = delayed;
          await openMenuIfNeeded(page);
          await page
            .locator("nav[aria-label='Dashboard sections'] a")
            .filter({ hasText: "Receipts", visible: true })
            .first()
            .click();
          await delayed.arrived.waiting;
          await navigate(page, "orders");
          delayed.resumed.release();
          await ownerIs(page, owner, other);
          expect(new URL(page.url()).pathname).toBe(`${BASE}/orders`);
          // 9. Another tab's account switch leaves this Cards form stale.
          await navigate(page, "cards");
          const [beforeOwner, beforeOther] = await Promise.all([snapshot(owner), snapshot(other)]);
          await cookieAs(context, other);
          await page.locator("form[action*='selling='] button").click();
          await page.locator(".gate-card strong").waitFor({ state: "visible" });
          expect(await page.locator(".gate-card strong").textContent()).toBe(other.email);
          expect(await snapshot(owner)).toEqual(beforeOwner);
          expect(await snapshot(other)).toEqual(beforeOther);
          // 10. Reload now shows the newly signed-in merchant's own cards.
          await page.reload();
          await ownerIs(page, other, owner);
          // 11. Signing out in a second tab is observed by this tab's reload.
          const second = await context.newPage();
          await second.goto(`${origin}${BASE}/cards`);
          await ownerIs(second, other, owner);
          await openMenuIfNeeded(second);
          await second
            .getByRole("button", { name: "Sign out", exact: true })
            .filter({ visible: true })
            .click();
          await second.waitForURL((url) => url.pathname === `${BASE}/sign-in`);
          await page.reload();
          await page.waitForURL((url) => url.pathname === `${BASE}/sign-in`);
          expect(await page.locator("input[name=signed_in_as]").count()).toBe(0);
          await second.close();
          // 12. Returning to the original session shows its persisted changes.
          await cookieAs(context, owner);
          await page.goto(`${origin}${BASE}/cards`);
          await ownerIs(page, owner, other);
          const seller = await owner.gateway.seller();
          if (!seller.ok) throw new Error("local seller readback failed");
          expect(seller.document.name).toBe(name);
        } finally {
          delayed?.resumed.release();
          held = null;
          await context.close();
        }
      });
    }
});
