/**
 * The shipped browser form must navigate to Google and return with its state
 * cookie, with or without JavaScript. Only Google's network boundary is local;
 * the built pages, identity component and browser cookie handling are real.
 */
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { type Harness, harness } from "@agentify/gateway/testing";
import { launchChromium } from "@agentify/ui/chromium";
import express from "express";
import type { Browser, BrowserContext } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { identityFor } from "./identity.js";
import { builtPages } from "./pages.js";
import { buildApp } from "./server.js";
import { type GoogleProfile, googleExchange } from "./testing/google.js";
import { TEST_AUTH_SECRET } from "./testing/secrets.js";

let browser: Browser;
let origin: string;
let googleOrigin: string;
let harnessed: Harness;
let identity: ReturnType<typeof identityFor>;
let close: () => Promise<void>;
const google = googleExchange();
const consents = new Map<string, URLSearchParams>();
/** Where each Google start sent the browser, before the provider is replaced. */
const sentToGoogle: string[] = [];
const rows: Record<string, Record<string, unknown>[]> = {
  dashboard_accounts: [],
  dashboard_sessions: [],
  dashboard_credentials: [],
  dashboard_verifications: [],
  dashboard_link_sends: [],
};
/** In the form the tracker's identifiers take, and nobody's. */
const CLICK = "qa_click_0123456789abcdef";

beforeAll(async () => {
  const nativeFetch = globalThis.fetch;
  vi.stubGlobal("fetch", ((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return url === "https://oauth2.googleapis.com/token"
      ? google.fetch(input, init)
      : nativeFetch(input, init);
  }) satisfies typeof fetch);
  harnessed = await harness({ PAY_TO_ADDRESS: "0x0000000000000000000000000000000000000001" });
  const host = express();
  host.get("/offline-google-consent", (request, response) => {
    const flow = typeof request.query.flow === "string" ? request.query.flow : "";
    const query = consents.get(flow);
    consents.delete(flow);
    if (query === undefined) {
      response.sendStatus(400);
      return;
    }
    response
      .type("html")
      .send(
        `<a href="${origin}/dashboard/sign-in/google/callback?${query}">Continue to Agentify</a>`,
      );
  });
  host.use(
    "/styles",
    express.static(
      fileURLToPath(new URL("../../../packages/visual/public/styles", import.meta.url)),
    ),
  );
  const server = host.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  googleOrigin = `http://localhost:${(server.address() as AddressInfo).port}`;
  const config = loadConfig({
    DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
    AUTH_SECRET: TEST_AUTH_SECRET,
    PAYMENT_NETWORK: "eip155:84532",
    FACILITATOR_URL: "sandbox:scripted",
    BASE_PATH: "/dashboard",
    PUBLIC_BASE_URL: origin,
    GOOGLE_CLIENT_ID: "offline-client",
    GOOGLE_CLIENT_SECRET: "offline-secret",
    // A laptop's report, posting to a receiver of its own; no test here waits
    // for a delivery.
    REGISTRATION_POSTBACK_ENABLED: "true",
    REGISTRATION_POSTBACK_KEY: ["qa", "synthetic", "postback", "key"].join("-"),
    REGISTRATION_POSTBACK_URL: "http://127.0.0.1:4010/postback",
  });
  identity = identityFor(config, { rows });
  const pages = await builtPages();
  host.use(buildApp(config, { pages, gateway: harnessed.gateway, identity }));
  browser = await launchChromium();
  close = async () => {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all([identity.close(), pages.close(), harnessed.stop()]);
  };
});

async function consentFor(
  context: BrowserContext,
  profile: Partial<GoogleProfile> = {},
  answer: "consent" | "cancel" = "consent",
) {
  // Interception runs only for the first URL of a redirect chain. Replace the
  // provider at the outbound Location boundary, before a browser contacts it.
  await context.route("**/*", async (route) => {
    const target = new URL(route.request().url());
    if (target.origin !== origin && target.origin !== googleOrigin) {
      await route.abort("blockedbyclient");
      return;
    }
    if (target.pathname !== "/dashboard/sign-in/google" || route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const response = await route.fetch({ maxRedirects: 0 });
    sentToGoogle.push(response.headers().location ?? "");
    const query = google.authorize(response.headers().location ?? "", profile);
    if (answer === "cancel") {
      query.delete("code");
      query.set("error", "access_denied");
    }
    const flow = query.get("state") ?? "";
    consents.set(flow, query);
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        location: `${googleOrigin}/offline-google-consent?flow=${encodeURIComponent(flow)}`,
      },
    });
  });
}

afterAll(async () => {
  await close?.();
  vi.unstubAllGlobals();
});

describe("Google sign-in in the built dashboard", () => {
  for (const javaScriptEnabled of [true, false]) {
    it(`returns from a full browser navigation with JavaScript ${javaScriptEnabled ? "on" : "off"}`, async () => {
      const context = await browser.newContext({ javaScriptEnabled });
      try {
        await consentFor(context);
        const page = await context.newPage();
        await page.goto(`${origin}/dashboard/sign-in?destination=settings`, {
          waitUntil: "domcontentloaded",
        });
        await page.getByRole("button", { name: "Sign in with Google", exact: true }).click();
        await page.getByRole("link", { name: "Continue to Agentify" }).click();
        await page.waitForURL(`${origin}/dashboard/merchant`);
        expect(await page.locator("body").innerText()).toContain("person@gmail.com");
        const cookie = (await context.cookies())
          .map(({ name, value }) => `${name}=${value}`)
          .join("; ");
        expect((await identity.whoIs(cookie))?.person).toMatchObject({
          email: "person@gmail.com",
          confirmed: true,
          merchant: null,
        });
        expect((await context.cookies()).some(({ name }) => name === "agentify.state")).toBe(false);
      } finally {
        await context.close();
      }
    });
  }

  it("lets a refused Google address use its prefilled email alternative on a phone", async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      await consentFor(context, { email: "reader@outside.example", sub: "outside-reader" });
      const page = await context.newPage();
      await page.goto(`${origin}/dashboard/sign-in?destination=keys`);
      await page.getByRole("button", { name: "Sign in with Google", exact: true }).click();
      await page.getByRole("link", { name: "Continue to Agentify" }).click();
      await page.waitForURL(/\/sign-in\/google\/callback\?/);
      await page.getByRole("button", { name: "Send me a sign-in link" }).waitFor();
      expect(await page.getByLabel("Email address").inputValue()).toBe("reader@outside.example");
      expect(
        await page
          .locator('form[action="/dashboard/sign-in"] input[name="destination"]')
          .inputValue(),
      ).toBe("keys");
      expect(
        await page.locator("body").evaluate((body) => body.scrollWidth <= window.innerWidth),
      ).toBe(true);
      expect(
        await identity.whoIs(
          (await context.cookies()).map(({ name, value }) => `${name}=${value}`).join("; "),
        ),
      ).toBeNull();
    } finally {
      await context.close();
    }
  });
});

describe("a Google sign-in from an ad in the built dashboard", () => {
  const registrationOf = async (email: string) => {
    const person = await identity.byEmail(email);
    return (rows.dashboard_ad_reports ?? []).filter(
      (row) => person !== null && row.accountId === person.id && row.event === "reg",
    );
  };

  for (const javaScriptEnabled of [true, false]) {
    it(`tells the tracker of the sign-up an ad brought, asking nothing and keeping the click out of cookies and Google's address, with JavaScript ${javaScriptEnabled ? "on" : "off"}`, async () => {
      const email = `ad-${javaScriptEnabled ? "script" : "plain"}@gmail.com`;
      const context = await browser.newContext({ javaScriptEnabled });
      try {
        await consentFor(context, { sub: email, email });
        const page = await context.newPage();
        await page.goto(`${origin}/dashboard/sign-in?clickid=${CLICK}&destination=settings`, {
          waitUntil: "domcontentloaded",
        });
        expect(await page.getByRole("checkbox").count()).toBe(0);
        // Nothing is typed into the address: the Google press needs none.
        await page.getByRole("button", { name: "Sign in with Google", exact: true }).click();
        await page.getByRole("link", { name: "Continue to Agentify" }).waitFor();
        const cookiesAtGoogle = JSON.stringify(await context.cookies());
        await page.getByRole("link", { name: "Continue to Agentify" }).click();
        await page.waitForURL(`${origin}/dashboard/merchant`);

        expect(await registrationOf(email)).toMatchObject([{ clickId: CLICK, state: "pending" }]);
        expect(sentToGoogle.at(-1)).toMatch(/^https:\/\/accounts\.google\.com\//);
        expect(decodeURIComponent(sentToGoogle.at(-1) ?? "")).not.toContain(CLICK);
        expect(cookiesAtGoogle).not.toContain(CLICK);
        expect(JSON.stringify(await context.cookies())).not.toContain(CLICK);
      } finally {
        await context.close();
      }
    });
  }

  it("carries the click on the page a cancelled Google sign-in returns to, from which a link can be asked for", async () => {
    const context = await browser.newContext();
    try {
      await consentFor(context, {}, "cancel");
      const page = await context.newPage();
      await page.goto(`${origin}/dashboard/sign-in?clickid=${CLICK}&destination=settings`);
      await page.getByRole("button", { name: "Sign in with Google", exact: true }).click();
      await page.getByRole("link", { name: "Continue to Agentify" }).click();
      await page.waitForURL(/\/sign-in\/google\/callback\?/);

      expect(
        await page.locator('form[action="/dashboard/sign-in"] input[name="clickid"]').inputValue(),
      ).toBe(CLICK);
      expect(JSON.stringify(await context.cookies())).not.toContain(CLICK);
      await page.getByLabel("Email address").fill("cancelled-google@example.com");
      await page.getByRole("button", { name: "Send me a sign-in link" }).click();
      await page.getByRole("heading", { name: "Check your mail" }).waitFor();
    } finally {
      await context.close();
    }
  });

  for (const javaScriptEnabled of [true, false]) {
    it(`asks for a mailed link, not Google, when Enter is pressed in the address, with JavaScript ${javaScriptEnabled ? "on" : "off"}`, async () => {
      const context = await browser.newContext({ javaScriptEnabled });
      try {
        await consentFor(context);
        const page = await context.newPage();
        await page.goto(`${origin}/dashboard/sign-in?clickid=${CLICK}`, {
          waitUntil: "domcontentloaded",
        });
        const started = sentToGoogle.length;
        await page.getByLabel("Email address").fill(`enter-${javaScriptEnabled}@example.com`);
        await page.getByLabel("Email address").press("Enter");

        await page.getByRole("heading", { name: "Check your mail" }).waitFor();
        expect(sentToGoogle).toHaveLength(started);
      } finally {
        await context.close();
      }
    });
  }
});
