/**
 * Nothing between the browser and the catalogue is stubbed except the
 * merchant's shop: a shop must be https and a loopback server is not, so the
 * two calls that reach a shop are handed in. The assertions that matter most
 * decide whether a stranger can plant keys on somebody's account: a callback
 * with a token nobody issued writes nothing, and a token that already worked
 * does not work again.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Gateway } from "@agentify/gateway";
import type { AnalyticsEvent, SetupResult } from "@agentify/gateway/analytics";
import { type Harness, harness, type Served, serve } from "@agentify/gateway/testing";
import { MERCHANT_FINDINGS } from "@nuanu-ai/agentify-contracts";
import type { Express } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { DRAWN_FOR } from "./drawn-for.js";
import { type Acting, gatewayFor } from "./gateway.js";
import { type Identity, identityFor } from "./identity.js";
import type { Message } from "./mail.js";
import { buildApp } from "./server.js";
import { formTo, importFormOf, readable, shownMarkIn } from "./testing/html.js";
import { rewindLinkSends } from "./testing/link-sends.js";
import { testPages } from "./testing/pages.js";
import { TEST_AUTH_SECRET } from "./testing/secrets.js";
import { merchantItemIdFor, type StoreProduct } from "./woo-catalog.js";
import type { Preflight, PricedExample, ShopSample } from "./woo-connect.js";
import type { ReferenceRead } from "./woo-reference.js";
import type { WooRequest } from "./woo-request.js";
import {
  type CatalogueRead,
  inspectProductInTheShop,
  type ProductInspection,
  type WooOrderLookup,
} from "./woo-shop.js";
import { memoryWooShops, type WooShops } from "./woo-shops.js";

const PERSON = "owner@example.com";
const IN_DOLLARS: ShopSample = {
  currency: "USD",
  decimals: 2,
};
const COINBASE_READ_AT = new Date("2026-10-21T14:52:48.000Z");
const SHOP = "https://shop.example.com";
const PUBLIC = "https://dashboard.example.com";

const aProduct = (overrides: Partial<StoreProduct> = {}): StoreProduct => ({
  id: 11,
  name: "Canvas tote bag",
  sku: "agentify-tote",
  type: "simple",
  description: "<p>A physical item that has to be shipped somewhere.</p>",
  short_description: "",
  is_purchasable: true,
  is_in_stock: true,
  status: "publish",
  virtual: true,
  downloadable: true,
  manage_stock: false,
  download_limit: -1,
  download_expiry: -1,
  downloads: [{ id: "dl_guide", name: "Guide", file: `${SHOP}/protected/guide.txt` }],
  qualification_problem: null,
  prices: { price: "2500", currency_code: "USD", currency_minor_unit: 2 },
  ...overrides,
});

interface Visit {
  readonly status: number;
  readonly html: string;
  readonly to: string | null;
}

interface Running {
  readonly gateway: Served;
  readonly harnessed: Harness;
  readonly identity: Identity;
  readonly shops: WooShops;
  /** What the connector recorded for product analytics, oldest first. */
  readonly connectorAnalytics: () => readonly AnalyticsEvent[];
  /**
   * For the tests that put a Connect in the past rather than wait for it to
   * expire.
   */
  readonly accountId: string;
  readonly url: string;
  readonly asked: string[];
  /** Once per read. */
  readonly read: string[];
  /** For reading their catalogue off the gateway. */
  readonly ownKey: string;
  /** Every message the dashboard handed to its mail provider, the sign-in links among them. */
  readonly messages: readonly Message[];
  /** The sessions table as the in-memory store keeps it, for a test that puts a sign-in in the past. */
  readonly sessions: Record<string, unknown>[];
  get(path: string): Promise<Visit>;
  /**
   * A browser coming back from its shop without a session. The session cookie
   * is `SameSite=Lax`, so a signed-in browser carries it back and is sent on
   * into the dashboard; the return page is for the browser that does not.
   */
  getWithoutCookie(path: string): Promise<Visit>;
  post(path: string, form?: Record<string, string>): Promise<Visit>;
  /**
   * No cookie is the point: the callback comes from the shop's own server, and
   * only a route above the sign-in gate can be reached by it.
   */
  postJson(path: string, body: unknown): Promise<Visit>;
  signIn(destination?: "default" | "woocommerce"): Promise<Visit>;
  signOut(): Promise<void>;
  close(): Promise<void>;
}

/** Everything written to the console while `during` runs, as one text. */
const loggedDuring = async (during: () => Promise<void>): Promise<string> => {
  const lines: string[] = [];
  const collect = (...parts: unknown[]) => {
    lines.push(parts.map((part) => (part instanceof Error ? part.stack : String(part))).join(" "));
  };
  const spies = (["log", "warn", "error"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(collect),
  );
  try {
    await during();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  return lines.join("\n");
};

let open: Running | null = null;

afterEach(async () => {
  await open?.close();
  open = null;
});

interface Standing {
  readonly grantScreen?: (authorizeUrl: string) => Promise<Preflight>;
  /** One product priced in US dollars where a test does not say. */
  readonly sample?: (shopUrl: string) => Promise<ShopSample | null>;
  /** The rate guard's example product; a catalogue that did not answer where a test does not say. */
  readonly example?: (shopUrl: string) => Promise<PricedExample>;
  /** Coinbase's rupiah rate as it read on 2026-10-21 where a test does not say. */
  readonly reference?: (currency: string) => Promise<ReferenceRead>;
  /** Every message handed over where a test does not say. */
  readonly mailRefused?: boolean;
  readonly catalogue?: (shopUrl: string) => Promise<CatalogueRead>;
  readonly inspectProduct?: (
    keys: Parameters<typeof inspectProductInTheShop>[0],
    merchantItemId: string,
  ) => Promise<ProductInspection>;
  readonly readOrder?: (orderId: string) => Promise<WooOrderLookup>;
  /**
   * Fails every read of the connections table, as an unreachable Postgres
   * would. Only the screens' reads break; the Connect path's writes still work,
   * so a test can put a row there to be read.
   */
  readonly breakTheShopsRead?: () => never;
  /**
   * Every gateway call never finishing (nothing answers an import); only
   * publishing never finishing (the gateway stopped mid-import, after answering
   * what the merchant has set); or publishing failing in our own code, as when
   * a database goes away.
   */
  readonly silent?: "everything" | "publishing" | "publishing fails";
  /** The sandbox where a test does not say. */
  readonly channel?: Channel;
  /**
   * A merchant just registered through the gateway rather than the harness's
   * ready seller: no wallet, and a seller name only where asked.
   */
  readonly fresh?: "named" | "unnamed";
  /** The prefix the dashboard is mounted under; none where a test does not say. */
  readonly base?: string;
}

const CHANNELS = {
  sandbox: { PAYMENT_NETWORK: "eip155:84532", FACILITATOR_URL: "sandbox:scripted" },
  test: { PAYMENT_NETWORK: "eip155:84532", FACILITATOR_URL: "https://x402.org/facilitator" },
  live: {
    PAYMENT_NETWORK: "eip155:8453",
    FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
  },
} as const;
type Channel = keyof typeof CHANNELS;

const LIVE_GATEWAY_ONLY = {
  CDP_API_KEY_ID: "key-id",
  CDP_API_KEY_SECRET: "key-secret",
} as const;

const registered = async (application: Gateway, named: boolean): Promise<string> => {
  const made = await application.registerMerchant();
  if (named) {
    await application.setSellerName(made, { seller_name: "Their own shop" });
  }
  return made;
};

const silenced = (application: Gateway): Gateway =>
  new Proxy(application, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? () => new Promise(() => undefined) : value;
    },
  });

/** Long enough to start, short enough not to stall. */
const SILENT_FOR_MS = 50;

const started = async (standing: Standing = {}): Promise<Running> => {
  const channel = standing.channel ?? "sandbox";
  const harnessed = await harness({
    ...CHANNELS[channel],
    ...(channel === "live" ? LIVE_GATEWAY_ONLY : {}),
  });
  const gateway = await serve(harnessed);
  const config = loadConfig({
    DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
    AUTH_SECRET: TEST_AUTH_SECRET,
    ...CHANNELS[channel],
    PUBLIC_BASE_URL: PUBLIC,
    ...(standing.base === undefined ? {} : { BASE_PATH: standing.base }),
  });
  const messages: Message[] = [];
  const rows: Record<string, Record<string, unknown>[]> = {
    dashboard_accounts: [],
    dashboard_sessions: [],
    dashboard_credentials: [],
    dashboard_verifications: [],
    dashboard_link_sends: [],
  };
  const identity = identityFor(config, {
    rows,
    postman: async (message) => {
      messages.push(message);
      return "accepted";
    },
  });
  const merchant =
    standing.fresh === undefined
      ? harnessed.merchant.id
      : await registered(harnessed.gateway, standing.fresh === "named");
  // For the calls a test makes as the merchant's code.
  const ownKey =
    standing.fresh === undefined ? harnessed.merchant.key : await harnessed.addKey(merchant);
  const person = await identity.make(PERSON, merchant);
  if (person === null) {
    throw new Error("the test account could not be made");
  }

  const kept = memoryWooShops();
  const breakRead = standing.breakTheShopsRead;
  const shops: WooShops =
    breakRead === undefined
      ? kept
      : {
          ...kept,
          connectionOf: async () => breakRead(),
          grantFor: async () => breakRead(),
        };
  const asked: string[] = [];
  const read: string[] = [];
  const silent = standing.silent;
  const app: Express = buildApp(config, {
    pages: await testPages(),
    gateway: harnessed.gateway,
    identity,
    wooShops: shops,
    postman: async (message) => {
      if (standing.mailRefused === true) return "refused";
      messages.push(message);
      return "accepted";
    },
    ...(silent === undefined
      ? {}
      : {
          clientFor: (acting: Acting, answerWithinMs?: number) => {
            const quiet = gatewayFor(silenced(harnessed.gateway), acting, SILENT_FOR_MS);
            if (silent === "everything") return quiet;
            return {
              ...gatewayFor(harnessed.gateway, acting, answerWithinMs),
              publishCard:
                silent === "publishing"
                  ? quiet.publishCard
                  : async () => {
                      throw new Error("the database went away");
                    },
            };
          },
        }),
    shop: {
      grantScreen: async (authorizeUrl) => {
        asked.push(authorizeUrl);
        return standing.grantScreen === undefined
          ? { ok: true }
          : await standing.grantScreen(authorizeUrl);
      },
      sample: async (shopUrl) =>
        standing.sample === undefined ? IN_DOLLARS : await standing.sample(shopUrl),
      example: async (shopUrl) =>
        standing.example === undefined ? { kind: "unanswered" } : await standing.example(shopUrl),
      reference: async (currency) =>
        standing.reference === undefined
          ? { ok: true, rate: "18035.292596", source: "Coinbase", readAt: COINBASE_READ_AT }
          : await standing.reference(currency),
      catalogue: async (shopUrl) => {
        read.push(shopUrl);
        return standing.catalogue === undefined
          ? { ok: true, products: [] }
          : await standing.catalogue(shopUrl);
      },
      inspectProduct:
        standing.inspectProduct ??
        (async (_keys, merchantItemId) => ({
          ok: true,
          product: {
            kind: "download",
            productId: merchantItemId.split("_").at(-1) ?? "",
            downloadId: "dl_guide",
            fileName: "Guide",
            price: { amount: "25.00", currency: "USD" },
            fingerprint: "accepted-download-fingerprint",
            tax: { mode: "off" as const },
          },
        })),
      ...(standing.readOrder === undefined
        ? {}
        : { readOrder: (_keys, id) => standing.readOrder?.(id) as Promise<WooOrderLookup> }),
    },
  });

  const server: Server = createServer(app);
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  const base = standing.base ?? "";
  const jar = new Map<string, string>();
  let shownMark: string | undefined;

  const visit = async (
    method: string,
    path: string,
    given: { body?: string; type?: string; noCookie?: boolean } = {},
  ): Promise<Visit> => {
    const form = given.body !== undefined && given.type === undefined;
    const marked =
      form && shownMark !== undefined && !new URLSearchParams(given.body).has(DRAWN_FOR);
    const options = marked
      ? {
          ...given,
          body: `${given.body === "" ? "" : `${given.body}&`}${new URLSearchParams({ [DRAWN_FOR]: shownMark ?? "" })}`,
        }
      : given;
    const answered = await fetch(`${url}${path}`, {
      method,
      redirect: "manual",
      headers: {
        ...(jar.size === 0 || options.noCookie === true
          ? {}
          : { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; ") }),
        ...(options.body === undefined
          ? {}
          : { "content-type": options.type ?? "application/x-www-form-urlencoded" }),
      },
      ...(options.body === undefined ? {} : { body: options.body }),
    });
    for (const line of answered.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const at = (pair ?? "").indexOf("=");
      if (at > 0) {
        jar.set((pair ?? "").slice(0, at), (pair ?? "").slice(at + 1));
      }
    }
    const html = await answered.text();
    shownMark = shownMarkIn(html) ?? shownMark;
    return {
      status: answered.status,
      html,
      to: answered.headers.get("location"),
    };
  };

  open = {
    gateway,
    harnessed,
    identity,
    shops,
    connectorAnalytics: () => kept.recordedAnalytics.map(({ event }) => event),
    accountId: person.id,
    url,
    asked,
    read,
    ownKey,
    messages,
    sessions: rows.dashboard_sessions ?? [],
    get: (path) => visit("GET", `${base}${path}`),
    getWithoutCookie: (path) => visit("GET", `${base}${path}`, { noCookie: true }),
    post: (path, form = {}) =>
      visit("POST", `${base}${path}`, { body: new URLSearchParams(form).toString() }),
    postJson: (path, body) =>
      // No cookie, as WooCommerce posts from the shop's server; sent with one,
      // every callback test would pass with the route mounted below the sign-in
      // while every real Connect broke in silence.
      visit("POST", `${base}${path}`, {
        body: JSON.stringify(body),
        type: "application/json;charset=UTF-8",
        noCookie: true,
      }),
    async signIn(destination = "default") {
      // A minute must pass between two links to one address; these tests sign
      // in twice and are about where WooCommerce sends a merchant, so the
      // minute is moved out of the way.
      rewindLinkSends(rows);
      await visit("POST", `${base}/sign-in`, {
        body: new URLSearchParams({
          email: PERSON,
          ...(destination === "default" ? {} : { destination }),
        }).toString(),
      });
      const found = /(https?:\/\/\S+)/.exec(messages.at(-1)?.body ?? "")?.[1];
      if (found === undefined) throw new Error("the sign-in message carried no action URL");
      const action = new URL(found);
      const opened = await visit("POST", action.pathname, {
        body: new URLSearchParams({ token: action.searchParams.get("token") ?? "" }).toString(),
      });
      // A browser shows the screen the link leads to, and the forms a test then
      // presses are that screen's.
      if (opened.to?.startsWith("/") === true) await visit("GET", opened.to);
      return opened;
    },
    async signOut() {
      await visit("POST", "/sign-out");
      jar.clear();
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await identity.close();
      await gateway.close();
      await harnessed.stop();
    },
  };
  return open;
};

const tokenIn = (authorizeUrl: string): string =>
  new URL(authorizeUrl).searchParams.get("user_id") ?? "";

const grantedBody = (token: string, permissions = "read_write") => ({
  key_id: 2,
  user_id: token,
  consumer_key: "ck_a-key-from-the-shop",
  consumer_secret: "cs_a-secret-from-the-shop",
  key_permissions: permissions,
});

/** The banner over the page, as a merchant reads it. */
const bannerIn = (html: string): string =>
  readable(/<section class="account-banner"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "");

describe("the shop screens are behind the sign-in", () => {
  it("sends a stranger to the sign-in", async () => {
    const running = await started();
    const seen = await running.get("/woocommerce");
    expect(seen.status).toBe(303);
    expect(seen.to).toBe("/sign-in?destination=woocommerce");
  });
});

describe("pressing Connect", () => {
  it("sends the merchant to their own shop with all five parameters", async () => {
    const running = await started();
    await running.signIn();

    const pressed = await running.post("/woocommerce/connect", { shop_url: SHOP });

    expect(pressed.status).toBe(303);
    const to = new URL(pressed.to ?? "");
    expect(to.origin).toBe(SHOP);
    expect(to.pathname).toBe("/wc-auth/v1/authorize");
    expect(to.searchParams.get("app_name")).toBe("Agentify");
    expect(to.searchParams.get("scope")).toBe("read_write");
    expect(to.searchParams.get("user_id")).not.toBe("");
    expect(to.searchParams.get("return_url")).toBe(`${PUBLIC}/woocommerce/return`);
    expect(to.searchParams.get("callback_url")).toBe(`${PUBLIC}/woocommerce/callback`);
  });

  it("sends the merchant to their shop from a dashboard under a prefix, and names its addresses there", async () => {
    // The shop is another site: sent as a path of this one, the browser would
    // land on a page of the dashboard that does not exist.
    const running = await started({ base: "/dashboard" });
    await running.signIn();

    const pressed = await running.post("/woocommerce/connect", { shop_url: SHOP });

    expect(pressed.status).toBe(303);
    const to = new URL(pressed.to ?? "");
    expect(to.origin).toBe(SHOP);
    expect(to.searchParams.get("return_url")).toBe(`${PUBLIC}/dashboard/woocommerce/return`);
    expect(to.searchParams.get("callback_url")).toBe(`${PUBLIC}/dashboard/woocommerce/callback`);
  });

  it("sends the merchant to a shop whose name is written in another script", async () => {
    // An address that cannot travel in a header as typed reaches the browser
    // in the form a browser reads it, rather than failing after the press has
    // switched the merchant to the shop.
    const running = await started();
    await running.signIn();

    const pressed = await running.post("/woocommerce/connect", { shop_url: "https://магазин.рф" });

    expect(pressed.status).toBe(303);
    const to = new URL(pressed.to ?? "");
    expect(to.hostname).toBe(new URL("https://магазин.рф").hostname);
    expect(to.pathname).toBe("/wc-auth/v1/authorize");
    expect(to.searchParams.get("user_id")).not.toBe("");
  });

  it("asks the shop about the very address the browser is sent to", async () => {
    // The very address, not a similar one: a preflight on a differently built
    // address would measure something nobody is about to visit.
    const running = await started();
    await running.signIn();
    const pressed = await running.post("/woocommerce/connect", { shop_url: SHOP });
    expect(running.asked).toEqual([pressed.to]);
  });

  it("refuses a shop on plain http without asking it anything", async () => {
    const running = await started();
    await running.signIn();

    const pressed = await running.post("/woocommerce/connect", {
      shop_url: "http://shop.example.com",
    });

    expect(pressed.status).toBe(400);
    expect(pressed.html).toContain("https");
    expect(running.asked).toEqual([]);
  });

  it("refuses a shop whose grant screen we never reached, and sends nobody there", async () => {
    // Plain permalinks: the shop answers with its own front page and a 200.
    const running = await started({
      grantScreen: async () => ({ ok: false, why: "…the shop's permalink setting…" }),
    });
    await running.signIn();

    const pressed = await running.post("/woocommerce/connect", { shop_url: SHOP });

    expect(pressed.status).toBe(400);
    expect(pressed.html).toContain("permalink");
    // A Connect nobody could complete leaves no token for anybody to post
    // against.
    expect(
      await running.shops.connectFromGrant(
        tokenIn(running.asked[0] ?? ""),
        { consumerKey: "ck_abc", consumerSecret: "cs_def", permissions: "read_write" },
        new Date(),
      ),
    ).toBeNull();
  });
});

describe("the keys arriving from the shop", () => {
  it("connects the shop the merchant typed", async () => {
    const running = await started();
    await running.signIn();
    const pressed = await running.post("/woocommerce/connect", { shop_url: SHOP });
    const token = tokenIn(pressed.to ?? "");

    const posted = await running.postJson("/woocommerce/callback", grantedBody(token));

    expect(posted.status).toBe(200);
    const connections = await running.shops.connections();
    expect(connections).toHaveLength(1);
    expect(connections[0]?.shopUrl).toBe(SHOP);
    expect(connections[0]?.consumerKey).toBe("ck_a-key-from-the-shop");
  });

  it("writes down a callback it could not keep without the keys or anything a stranger sent", async () => {
    // The failure of a write can carry the values it was given, the shop's
    // secret among them, and the token is text anybody can send; a status
    // still tells the shop to take its key back.
    const running = await started();
    await running.signIn();
    const pressed = await running.post("/woocommerce/connect", { shop_url: SHOP });
    const carried = "cs_a-secret-from-the-shop\n[dashboard] forged";
    Object.assign(running.shops, {
      connectFromGrant: async () => {
        throw new Error(carried);
      },
    });

    let status = 0;
    const written = await loggedDuring(async () => {
      status = (
        await running.postJson("/woocommerce/callback", grantedBody(tokenIn(pressed.to ?? "")))
      ).status;
    });

    expect(status).toBe(500);
    expect(written).toMatch(/could not be written down/);
    expect(written).not.toContain("cs_a-secret-from-the-shop");
    expect(written).not.toContain("forged");
  });

  it("refuses a token nobody issued, and writes nothing", async () => {
    // The callback carries no session and no key of ours, so this is all that
    // stops a stranger putting their shop's keys on this account. A status, not
    // a page: WooCommerce takes back the key it minted when the post fails.
    const running = await started();
    await running.signIn();
    await running.post("/woocommerce/connect", { shop_url: SHOP });

    const posted = await running.postJson(
      "/woocommerce/callback",
      grantedBody("a-token-nobody-issued"),
    );

    expect(posted.status).toBe(401);
    expect(await running.shops.connections()).toEqual([]);
  });

  it("refuses a token that already worked", async () => {
    const running = await started();
    await running.signIn();
    const pressed = await running.post("/woocommerce/connect", { shop_url: SHOP });
    const token = tokenIn(pressed.to ?? "");

    expect((await running.postJson("/woocommerce/callback", grantedBody(token))).status).toBe(200);
    await running.post("/woocommerce/disconnect");

    const again = await running.postJson("/woocommerce/callback", {
      ...grantedBody(token),
      consumer_key: "ck_somebody-elses-shop",
    });

    expect(again.status).toBe(401);
    expect(await running.shops.connections()).toEqual([]);
  });

  it("forgets stale Connect attempts and keeps the former shop as a clean prefill", async () => {
    const running = await started();
    await running.signIn();
    await running.shops.connect({
      accountId: running.accountId,
      shopUrl: SHOP,
      consumerKey: "ck_connected",
      consumerSecret: "cs_connected",
      permissions: "read_write",
      revision: "connected-token",
      connectedAt: new Date(),
      currency: null,
    });
    await running.shops.beginGrant({
      token: "old-unanswered-token",
      accountId: running.accountId,
      shopUrl: SHOP,
      currency: null,
      startedAt: new Date(Date.now() - 40 * 60_000),
      expiresAt: new Date(Date.now() - 25 * 60_000),
    });

    const forgot = await running.post("/woocommerce/disconnect");

    expect(forgot.status).toBe(303);
    expect(forgot.to).toBe(`/woocommerce?shop_url=${encodeURIComponent(SHOP)}`);
    const screen = await running.get(forgot.to ?? "");
    expect(screen.html).toContain(`value="${SHOP}"`);
    expect(readable(screen.html)).not.toContain("The connection you started");
    expect(readable(screen.html)).not.toContain("no keys arrived");
    expect(await running.shops.grantFor(running.accountId)).toBeNull();
  });

  it("refuses an older callback after the merchant starts a newer Connect", async () => {
    const running = await started();
    await running.signIn();
    const first = await running.post("/woocommerce/connect", { shop_url: SHOP });
    const second = await running.post("/woocommerce/connect", {
      shop_url: "https://second.example.com",
    });

    expect(
      (await running.postJson("/woocommerce/callback", grantedBody(tokenIn(first.to ?? ""))))
        .status,
    ).toBe(401);
    expect(
      (await running.postJson("/woocommerce/callback", grantedBody(tokenIn(second.to ?? ""))))
        .status,
    ).toBe(200);
    expect((await running.shops.connections())[0]?.shopUrl).toBe("https://second.example.com");
  });

  it("does not let an in-flight older callback replace a newer Connect", async () => {
    const running = await started();
    await running.signIn();
    const first = await running.post("/woocommerce/connect", { shop_url: SHOP });
    const firstToken = tokenIn(first.to ?? "");
    const spent = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const connect = running.shops.connectFromGrant.bind(running.shops);
    const mutable = running.shops as {
      connectFromGrant: WooShops["connectFromGrant"];
    };
    mutable.connectFromGrant = async (token, keys, now) => {
      spent.resolve();
      await finish.promise;
      return await connect(token, keys, now);
    };

    const older = running.postJson("/woocommerce/callback", grantedBody(firstToken));
    await spent.promise;
    await running.shops.beginGrant({
      token: "newer-token",
      accountId: running.accountId,
      shopUrl: "https://second.example.com",
      currency: null,
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    finish.resolve();

    expect((await older).status).toBe(401);
    expect(await running.shops.connections()).toEqual([]);
    expect((await running.shops.grantFor(running.accountId))?.token).toBe("newer-token");
  });

  it("refuses a callback with no keys in it", async () => {
    const running = await started();
    await running.signIn();
    const pressed = await running.post("/woocommerce/connect", { shop_url: SHOP });
    const token = tokenIn(pressed.to ?? "");

    const posted = await running.postJson("/woocommerce/callback", { user_id: token });

    expect(posted.status).toBe(400);
    expect(await running.shops.connections()).toEqual([]);
  });

  it("keeps what the shop actually granted rather than what we asked for", async () => {
    const running = await started();
    await running.signIn();
    const pressed = await running.post("/woocommerce/connect", { shop_url: SHOP });
    const token = tokenIn(pressed.to ?? "");

    await running.postJson("/woocommerce/callback", grantedBody(token, "read"));

    expect((await running.shops.connections())[0]?.permissions).toBe("read");
    // Told, rather than finding out from a refunded buyer.
    const seen = await running.get("/woocommerce");
    expect(seen.html).toContain("read and write");
  });

  it("offers a shop that granted read alone a Connect again at its own address, which goes to that shop", async () => {
    const running = await started();
    await running.signIn();
    const pressed = await running.post("/woocommerce/connect", { shop_url: SHOP });
    await running.postJson("/woocommerce/callback", grantedBody(tokenIn(pressed.to ?? ""), "read"));

    const seen = await running.get("/woocommerce");
    const again = formTo(seen.html, "post", "/woocommerce/connect");
    const sent = await running.post(
      "/woocommerce/connect",
      Object.fromEntries(again?.fields ?? []),
    );

    expect(again?.fields.get("shop_url")).toBe(SHOP);
    expect(sent.status).toBe(303);
    expect(new URL(sent.to ?? "", PUBLIC).origin).toBe(SHOP);
  });
});

describe("the page the shop sends the browser back to, with a session on the request", () => {
  // Under `SameSite=Lax` a signed-in browser carries its cookie back, and that
  // branch owes only the redirect; where it lands is covered on the settings
  // and shop screens.
  it("takes the state token out of the address bar", async () => {
    // WooCommerce hands `user_id` back on this redirect, and when the keys
    // never arrived that token is unspent for the rest of its fifteen minutes.
    // Left in the address it would sit in history, in every Referer the page
    // sends, and on a screen somebody else can walk up to.
    const running = await started();
    await running.signIn();
    const pressed = await running.post("/woocommerce/connect", { shop_url: SHOP });
    const token = tokenIn(pressed.to ?? "");

    const came = await running.get(`/woocommerce/return?success=1&user_id=${token}`);

    expect(came.status).toBe(303);
    expect(came.to).toBe("/woocommerce?from=shop");
  });
});

describe("an expired session returning to WooCommerce", () => {
  it("keeps WooCommerce as a closed signed-link destination", async () => {
    const running = await started();
    await running.signIn();
    await running.identity.endEverySessionFor(PERSON);

    const expired = await running.get("/woocommerce");

    expect(expired.to).toBe("/sign-in?reason=session-ended&destination=woocommerce");
    const recovery = await running.get(expired.to ?? "");
    expect(recovery.html).toContain('name="destination" value="woocommerce"');
    const opened = await running.signIn("woocommerce");
    expect(opened.to).toBe("/woocommerce");
  });
});

describe("importing the catalogue", () => {
  const connected = async (running: Running): Promise<void> => {
    await running.signIn();
    // The drawn-for mark is sent here rather than read off the Connect page,
    // because one test below has no gateway, and with none every page drawn is
    // the error page.
    const pressed = await running.post("/woocommerce/connect", {
      shop_url: SHOP,
      [DRAWN_FOR]: PERSON,
    });
    await running.postJson("/woocommerce/callback", {
      user_id: tokenIn(pressed.to ?? ""),
      consumer_key: "ck_a",
      consumer_secret: "cs_b",
      key_permissions: "read_write",
    });
  };

  interface Held {
    readonly id: string;
    readonly paused: boolean;
    readonly card: { readonly title: string; readonly price: { readonly amount: string } };
  }

  /** Read with the merchant's own key. */
  const cardsOf = async (running: Running): Promise<readonly Held[]> => {
    const answered = await running.gateway.call("GET", "/v0/cards", {
      headers: { authorization: `Bearer ${running.ownKey}` },
    });
    return (answered.body as { cards: Held[] }).cards;
  };

  it("publishes what it found, through the door every card goes through", async () => {
    const running = await started({
      catalogue: async () => ({ ok: true, products: [aProduct()] }),
    });
    await connected(running);

    const imported = await running.post("/woocommerce/import");

    expect(imported.status).toBe(200);
    expect(imported.html).toContain("Canvas tote bag");
    // An import the gateway answered in full claims no other kind of outcome.
    expect(readable(imported.html)).not.toContain("no verdict");
    // Priced at the scale the shop sent, not at a hundred times it.
    const listed = await cardsOf(running);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.card.price.amount).toBe("25.00");
  });

  it("publishes a physical product as a parcel, once the merchant has given the shop's site", async () => {
    // A parcel's card is held back from a merchant with no site, because the
    // site is where a buyer asks about a parcel that did not come. The import
    // says so and never fills the site in for the merchant.
    const running = await started({
      catalogue: async () => ({
        ok: true,
        products: [aProduct({ virtual: false, downloadable: false, downloads: [] })],
      }),
      inspectProduct: async () => ({
        ok: true,
        product: {
          kind: "parcel",
          productId: "11",
          price: { amount: "25.00", currency: "USD" },
          fingerprint: "accepted-parcel-fingerprint",
          tax: { mode: "off" as const },
        },
      }),
    });
    await connected(running);

    const held = await running.post("/woocommerce/import");

    expect(held.status).toBe(200);
    expect(await cardsOf(running)).toHaveLength(0);
    expect(readable(held.html)).toContain("site");

    await running.harnessed.gateway.setSellerName(running.harnessed.merchant.id, {
      seller_site: SHOP,
    });
    await running.post("/woocommerce/import");

    const listed = (await cardsOf(running)) as unknown as readonly {
      card: { fulfillment: string; ship_within_seconds?: number; result?: unknown };
    }[];
    expect(listed).toHaveLength(1);
    expect(listed[0]?.card).toMatchObject({ fulfillment: "ship", ship_within_seconds: 604_800 });
    expect(listed[0]?.card.result).toBeUndefined();
  });

  it("tells an owner whose parcel is held for want of the shop's site to set it in Settings", async () => {
    // The gateway's words name an API call; the person who pressed Import sets
    // the site in Settings.
    const running = await started({
      catalogue: async () => ({
        ok: true,
        products: [aProduct({ virtual: false, downloadable: false, downloads: [] })],
      }),
      inspectProduct: async () => ({
        ok: true,
        product: {
          kind: "parcel",
          productId: "11",
          price: { amount: "25.00", currency: "USD" },
          fingerprint: "accepted-parcel-fingerprint",
          tax: { mode: "off" as const },
        },
      }),
    });
    await connected(running);

    const held = readable((await running.post("/woocommerce/import")).html);

    expect(held).toMatch(/shop's site in Settings/);
    expect(held).not.toMatch(/\/v0\//);
  });

  it("keeps imported cards when the merchant forgets the shop", async () => {
    const running = await started({
      catalogue: async () => ({ ok: true, products: [aProduct()] }),
    });
    await connected(running);
    await running.post("/woocommerce/import");

    await running.post("/woocommerce/disconnect");

    expect(await cardsOf(running)).toHaveLength(1);
  });

  it("bounds protected product checks during a whole-catalogue import", async () => {
    let active = 0;
    let most = 0;
    const products = Array.from({ length: 12 }, (_, index) =>
      aProduct({ id: index + 1, name: `Download ${index + 1}`, sku: `download-${index + 1}` }),
    );
    const running = await started({
      catalogue: async () => ({ ok: true, products }),
      inspectProduct: async (_keys, merchantItemId) => {
        active += 1;
        most = Math.max(most, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return {
          ok: true,
          product: {
            kind: "download",
            productId: merchantItemId.split("_").at(-1) ?? "",
            downloadId: "dl_guide",
            fileName: "Guide",
            price: { amount: "25.00", currency: "USD" },
            fingerprint: "accepted-download-fingerprint",
            tax: { mode: "off" as const },
          },
        };
      },
    });
    await connected(running);

    const imported = await running.post("/woocommerce/import");

    expect(imported.status).toBe(200);
    expect(most).toBeLessThanOrEqual(4);
    expect(most).toBeGreaterThan(1);
  });

  it("counts a card it published again and does not call it on sale while it is paused", async () => {
    // Republishing a paused card leaves it paused, and the gateway's answer
    // says nothing about selling, so "on sale" over it would tell the merchant
    // agents can buy what they cannot. Two products and one pause, the list a
    // merchant actually reads.
    const running = await started({
      catalogue: async () => ({
        ok: true,
        products: [aProduct(), aProduct({ id: 10, name: "Access code", sku: "agentify-code" })],
      }),
    });
    await connected(running);
    await running.post("/woocommerce/import");
    const tote = (await cardsOf(running)).find((one) => one.card.title === "Canvas tote bag");
    await running.post(`/cards?${new URLSearchParams({ pause: tote?.id ?? "" })}`);

    const imported = await running.post("/woocommerce/import");
    const text = readable(imported.html);

    expect(imported.status).toBe(200);
    expect(text).toContain("2 published");
    expect(text).toContain("Canvas tote bag");
    expect(text).not.toMatch(/on sale/i);
    expect((await cardsOf(running)).find((one) => one.id === tote?.id)?.paused).toBe(true);
  });

  it("shows the door's own refusal word for word", async () => {
    // The merchant's move is to shorten it in their shop, and only the
    // gateway's sentence tells them so.
    const running = await started({
      catalogue: async () => ({
        ok: true,
        products: [aProduct({ description: `<p>${"a".repeat(900)}</p>` })],
      }),
    });
    await connected(running);

    const imported = await running.post("/woocommerce/import");

    expect(imported.html).toContain("To fix");
    // The ceiling and the length they wrote: the second says how much to cut,
    // and a summary would lose it.
    expect(readable(imported.html)).toContain("at most 500");
    expect(readable(imported.html)).toContain("900 characters");
  });

  it("says the door did not answer, and does not send the merchant to their shop to fix it", async () => {
    // A valid product and no gateway: nothing in the shop can repair it, so the
    // page must not send the merchant to edit a product nobody read.
    const running = await started({
      catalogue: async () => ({ ok: true, products: [aProduct()] }),
      silent: "publishing",
    });
    await connected(running);

    const imported = await running.post("/woocommerce/import");
    const text = readable(imported.html);

    expect(imported.status).toBe(200);
    expect(text).toContain("1 without a verdict");
    expect(text).toContain("Canvas tote bag");
    expect(text).toContain("Agentify did not answer");
    // Neither the refusals' heading nor their count.
    expect(text).not.toContain("To fix");
    expect(text).not.toContain("publishing rules");
  });

  it("keeps what it did when publishing fails in our own code, and says nobody knows whether it went", async () => {
    // A failure of ours may come after the card was written, so it is no
    // verdict rather than a refusal, and the import stops with its record.
    const running = await started({
      catalogue: async () => ({
        ok: true,
        products: [aProduct(), aProduct({ id: 10, name: "Access code" })],
      }),
      silent: "publishing fails",
    });
    await connected(running);

    const imported = await running.post("/woocommerce/import");
    const text = readable(imported.html);

    expect(imported.status).toBe(200);
    expect(text).toContain("1 without a verdict");
    expect(text).toContain("1 not attempted");
    expect(text).toContain("whether it was published is not known");
  });

  it("writes down a publish that failed in our own code without what the failure carried", async () => {
    // A store's exception can carry the values it was given; the log goes
    // places the database does not.
    const running = await started({
      catalogue: async () => ({ ok: true, products: [aProduct()] }),
      silent: "publishing fails",
    });
    await connected(running);

    const written = await loggedDuring(async () => {
      await running.post("/woocommerce/import");
    });

    expect(written).toMatch(/publishing a card failed/);
    expect(written).not.toContain("the database went away");
  });

  it("stops after the first unknown publish and names the products it did not attempt", async () => {
    const running = await started({
      catalogue: async () => ({
        ok: true,
        products: [aProduct(), aProduct({ id: 10, name: "Access code" })],
      }),
      silent: "publishing",
    });
    await connected(running);

    const imported = await running.post("/woocommerce/import");
    const text = readable(imported.html);

    expect(text).toContain("1 without a verdict");
    expect(text).toContain("1 not attempted");
    expect(text).toContain("Canvas tote bag");
    expect(text).toContain("Access code");
  });

  it("leads from each product it published to Cards by its product code, not by a title it shares", async () => {
    // Two products of one name, as a shop selling a size apart may list them:
    // a way found by the title would land on both. Cards finds any card whose
    // code contains the one asked for, so product 1's way would also list
    // product 11; these two are chosen apart from that.
    const running = await started({
      catalogue: async () => ({
        ok: true,
        products: [aProduct(), aProduct({ id: 10, sku: "canvas-tote-large" })],
      }),
    });
    await connected(running);

    const imported = await running.post("/woocommerce/import");
    const ways = [...imported.html.matchAll(/href="(\/cards\?[^"]+)"/g)].map(([, to = ""]) =>
      to.replaceAll("&amp;", "&"),
    );
    const listed = await Promise.all(
      ways.map(
        async (to) => readable((await running.get(to)).html).split("Canvas tote bag").length - 1,
      ),
    );

    expect(ways).toHaveLength(2);
    expect(new Set(ways).size).toBe(2);
    expect(listed).toStrictEqual([1, 1]);
  });

  it("does not call an import finished when it stopped before the last product", async () => {
    const running = await started({
      catalogue: async () => ({
        ok: true,
        products: [aProduct(), aProduct({ id: 10, name: "Access code" })],
      }),
      silent: "publishing",
    });
    await connected(running);

    const stopped = readable((await running.post("/woocommerce/import")).html);

    expect(stopped).not.toMatch(/finished/i);
    expect(stopped).toMatch(/stopped/i);
  });

  it("names the products it could not turn into a card at all", async () => {
    const running = await started({
      catalogue: async () => ({
        ok: true,
        products: [aProduct({ id: 9, name: "A set of things", type: "grouped" })],
      }),
    });
    await connected(running);

    const imported = await running.post("/woocommerce/import");

    expect(imported.html).toContain("Not imported");
    expect(imported.html).toContain("A set of things");
    expect(imported.html).toContain("grouped");
  });

  it("says what a shop that would not answer said, and publishes nothing", async () => {
    const running = await started({
      catalogue: async () => ({ ok: false, why: "Your shop answered 403: Forbidden" }),
    });
    await connected(running);

    const imported = await running.post("/woocommerce/import");

    expect(imported.status).toBe(502);
    expect(imported.html).toContain("Forbidden");
  });

  /**
   * The header links to settings on every page, so only the body says anything
   * by linking there.
   */
  const bodyOf = (html: string): string =>
    html.slice(html.indexOf("</header>"), html.indexOf("<footer"));

  /** In the lower case a wallet accepts. */
  const A_WALLET = "0x0123456789abcdef0123456789abcdef01234567";

  it("reads nothing and publishes nothing for a merchant with nowhere to be paid, and sends them to Settings", async () => {
    // Where money settles, the gateway refuses every card of a merchant with no
    // wallet, in a sentence for an engineer. A WooCommerce merchant learns
    // where to set it before their shop is read product by product for nothing.
    const running = await started({
      channel: "test",
      fresh: "named",
      catalogue: async () => ({ ok: true, products: [aProduct()] }),
    });
    await connected(running);

    const imported = await running.post("/woocommerce/import");
    const form = importFormOf(imported.html);

    expect(imported.status).toBe(409);
    expect(readable(form)).toMatch(/wallet/i);
    expect(form).toContain('href="/settings"');
    expect(readable(imported.html)).not.toContain("/v0/");
    expect(running.read).toEqual([]);
    expect(await cardsOf(running)).toEqual([]);
  });

  it("imports once the merchant has set a wallet in Settings", async () => {
    // The way past the refusal, walked through the screen it links to.
    const running = await started({
      channel: "test",
      fresh: "named",
      catalogue: async () => ({ ok: true, products: [aProduct()] }),
    });
    await connected(running);
    await running.post("/woocommerce/import");

    const saved = await running.post("/settings/payout-wallet", { payout_wallet: A_WALLET });
    const imported = await running.post("/woocommerce/import");

    expect(saved.status).toBe(303);
    expect(imported.status).toBe(200);
    expect(await cardsOf(running)).toHaveLength(1);
  });

  it("asks for no wallet in the sandbox, where the door takes a card without one", async () => {
    // Nothing settles in the sandbox and the wallet is optional there; refusing
    // an import for it would make the dashboard stricter than its gateway.
    const running = await started({
      channel: "sandbox",
      fresh: "named",
      catalogue: async () => ({ ok: true, products: [aProduct()] }),
    });
    await connected(running);

    const imported = await running.post("/woocommerce/import");

    expect(imported.status).toBe(200);
    expect(await cardsOf(running)).toHaveLength(1);
  });

  it("reads nothing for a merchant with no seller name, and sends them to Settings", async () => {
    // The rule about the merchant that holds on every channel, the sandbox
    // included.
    const running = await started({
      channel: "sandbox",
      fresh: "unnamed",
      catalogue: async () => ({ ok: true, products: [aProduct()] }),
    });
    await connected(running);

    const imported = await running.post("/woocommerce/import");
    const form = importFormOf(imported.html);

    expect(imported.status).toBe(409);
    expect(readable(form)).toMatch(/\bname\b/i);
    expect(form).toContain('href="/settings"');
    expect(readable(imported.html)).not.toContain("/v0/");
    expect(running.read).toEqual([]);
  });

  it("is not offered on the live channel, where it does not work", async () => {
    // The connector works in test mode only, and offering it on live would
    // leave an owner to infer the limit.
    const running = await started({ channel: "live" });
    await running.signIn();

    const shopScreen = await running.get("/woocommerce");
    const integrations = await running.get("/integrations");

    expect(shopScreen.status).toBe(404);
    expect(integrations.status).toBe(200);
    expect(integrations.html).not.toContain("/woocommerce");
    // Nothing on live can have started a grant for these to finish.
    const keys = await running.postJson("/woocommerce/callback", {
      key_id: 2,
      user_id: "a-token-nobody-issued",
      consumer_key: "ck_a-key-from-the-shop",
      consumer_secret: "cs_a-secret-from-the-shop",
      key_permissions: "read_write",
    });
    expect(keys.status).toBe(404);
    expect((await running.get("/woocommerce/return?success=1")).status).toBe(404);
  });

  it("answers its pages on the live channel as any address the dashboard does not have", async () => {
    // Somebody signed in is told in the dashboard's frame, with its menu and a
    // way back, and somebody with no session is sent to the sign-in, as from
    // any other address that is no page.
    const running = await started({ channel: "live" });
    await running.signIn();
    await running.get("/cards");

    for (const [method, path] of [
      ["GET", "/woocommerce"],
      ["GET", "/woocommerce/connect"],
      ["POST", "/woocommerce/connect"],
      ["POST", "/woocommerce/import"],
      ["GET", "/woocommerce/return?success=1"],
    ] as const) {
      const answered =
        method === "GET"
          ? await running.get(path)
          : await running.post(path, { shop_url: "https://shop.example.com" });
      expect(answered.status, `${method} ${path}`).toBe(404);
      expect(readable(answered.html), `${method} ${path}`).toContain("There is no such page");
      expect(readable(answered.html), `${method} ${path}`).toContain(PERSON);
    }
    expect(running.asked).toEqual([]);

    const stranger = await running.getWithoutCookie("/woocommerce");
    expect(stranger.status).toBe(303);
    expect(new URL(stranger.to ?? "", "http://dashboard.test").pathname).toBe("/sign-in");
  });

  it("says a wallet is needed before Import is pressed in the banner, and not again at the button", async () => {
    const running = await started({ channel: "test", fresh: "named" });
    await connected(running);

    const screen = await running.get("/woocommerce");

    expect(screen.status).toBe(200);
    expect(bannerIn(screen.html)).toMatch(/no payout wallet/i);
    expect(screen.html).toContain('href="/settings"');
    expect(readable(importFormOf(screen.html))).not.toMatch(/wallet/i);
  });

  it("answers a refused press with an alert the screen before the press does not carry", async () => {
    // Both pages name what is missing beside the same button; only the answer
    // to the press carries the alert that says the press was refused.
    const running = await started({
      channel: "test",
      fresh: "named",
      catalogue: async () => ({ ok: true, products: [aProduct()] }),
    });
    await connected(running);

    const before = await running.get("/woocommerce");
    const pressed = await running.post("/woocommerce/import");

    expect(importFormOf(before.html)).not.toContain('role="alert"');
    expect(importFormOf(pressed.html)).toContain('role="alert"');
  });

  it("says nothing about a wallet on the shop screen once one is set", async () => {
    const running = await started({ channel: "test" });
    await connected(running);

    const screen = await running.get("/woocommerce");

    expect(screen.status).toBe(200);
    expect(readable(bodyOf(screen.html))).not.toMatch(/wallet/i);
  });

  it("does not read the shop when the gateway cannot say what the merchant has set", async () => {
    // Nothing could be published through a missing gateway, so reading the shop
    // first would be work for nothing.
    const running = await started({
      catalogue: async () => ({ ok: true, products: [aProduct()] }),
      silent: "everything",
    });
    await running.signIn();
    // Connected the way Connect leaves a merchant, without pressing it: a
    // gateway that does not answer cannot switch them to the shop either.
    await running.harnessed.gateway.sellThrough(running.harnessed.merchant.id, "woocommerce");
    const startedAt = new Date();
    await running.shops.beginGrant({
      token: "a-token-that-came-back",
      accountId: running.accountId,
      shopUrl: SHOP,
      currency: null,
      startedAt,
      expiresAt: new Date(startedAt.getTime() + 15 * 60_000),
    });
    await running.shops.connectFromGrant(
      "a-token-that-came-back",
      { consumerKey: "ck_a", consumerSecret: "cs_b", permissions: "read_write" },
      startedAt,
    );

    const imported = await running.post("/woocommerce/import", { [DRAWN_FOR]: PERSON });

    expect(imported.status).toBe(504);
    expect(readable(imported.html)).toContain("did not answer");
    expect(running.read).toEqual([]);
  });

  /**
   * The real product check against an in-process shop that stores each `wc/v3`
   * price as typed, with the given number of decimals.
   */
  const shopStoring =
    (typed: Readonly<Record<string, string>>, decimals = "2"): WooRequest =>
    async (url) => {
      const path = new URL(url).pathname;
      if (path === "/protected/guide.txt") return new Response(null, { status: 403 });
      const setting = /\/settings\/\w+\/(\w+)$/.exec(path)?.[1];
      if (setting !== undefined) {
        const safe: Readonly<Record<string, string>> = {
          woocommerce_currency: "USD",
          woocommerce_calc_taxes: "no",
          woocommerce_file_download_method: "force",
          woocommerce_downloads_require_login: "no",
          woocommerce_downloads_grant_access_after_payment: "yes",
          woocommerce_downloads_redirect_fallback_allowed: "no",
          woocommerce_price_num_decimals: decimals,
        };
        return Response.json({ id: setting, value: safe[setting] });
      }
      const id = /\/products\/(\d+)$/.exec(path)?.[1] ?? "";
      return Response.json({
        id: Number(id),
        type: "simple",
        status: "publish",
        purchasable: true,
        stock_status: "instock",
        manage_stock: false,
        sold_individually: false,
        virtual: true,
        downloadable: true,
        download_limit: -1,
        download_expiry: -1,
        price: typed[id],
        downloads: [{ id: "dl_guide", name: "Guide", file: `${SHOP}/protected/guide.txt` }],
      });
    };

  /** Each product left in the shop by its number in the shop, with the reason given. */
  const leftInTheShop = (html: string): Record<string, string> =>
    Object.fromEntries(
      [
        ...(/<ul[^>]*aria-label="Not imported"[^>]*>[\s\S]*?<\/ul>/.exec(html)?.[0] ?? "").matchAll(
          /<li class="list-row[^"]*">([\s\S]*?)<\/li>/g,
        ),
      ]
        .map((item) => readable(item[1] ?? ""))
        .flatMap((line) => {
          const found = /^(.*?) Product (\d+) in your shop (.*)$/.exec(line);
          return found === null ? [] : [[found[2], found[3]]];
        }),
    );

  it("imports a price typed without cents, or with one decimal, at the amount the shop charges", async () => {
    // `wc/v3` says "25" or "19.9" where the Store API says 2500 or 1990 cents:
    // the same money, typed this way in ordinary shops.
    const usd = (cents: string) => ({ price: cents, currency_code: "USD", currency_minor_unit: 2 });
    const running = await started({
      catalogue: async () => ({
        ok: true,
        products: [
          aProduct({ id: 11, name: "Whole dollars", prices: usd("2500") }),
          aProduct({ id: 12, name: "One decimal", prices: usd("1990") }),
          aProduct({ id: 13, name: "Two decimals", prices: usd("2500") }),
        ],
      }),
      inspectProduct: (keys, item) =>
        inspectProductInTheShop(keys, item, shopStoring({ 11: "25", 12: "19.9", 13: "25.00" })),
    });
    await connected(running);

    const imported = await running.post("/woocommerce/import");

    expect(imported.status).toBe(200);
    expect(leftInTheShop(imported.html)).toEqual({});
    const priced = Object.fromEntries(
      (await cardsOf(running)).map((held) => [held.card.title, held.card.price.amount]),
    );
    expect(priced).toEqual({
      "Whole dollars": "25.00",
      "One decimal": "19.90",
      "Two decimals": "25.00",
    });
  });

  it("still refuses a public price that differs, and a price it would have to round", async () => {
    const usd = (cents: string) => ({ price: cents, currency_code: "USD", currency_minor_unit: 2 });
    const running = await started({
      catalogue: async () => ({
        ok: true,
        products: [
          aProduct({ id: 11, name: "Changed price", prices: usd("2600") }),
          aProduct({ id: 12, name: "Fraction of a cent", prices: usd("2500") }),
        ],
      }),
      inspectProduct: (keys, item) =>
        inspectProductInTheShop(keys, item, shopStoring({ 11: "25", 12: "25.001" })),
    });
    await connected(running);

    const imported = await running.post("/woocommerce/import");
    const left = leftInTheShop(imported.html);

    expect(await cardsOf(running)).toHaveLength(0);
    expect(left["11"]).toContain("does not match");
    // Not "does not match": the Store API rounded it to 2500 cents, so the
    // prices look equal on screen. Nor the decimals setting: the price is what
    // to change.
    expect(left["12"]).toContain("25.001");
    expect(left["12"]).not.toContain("Number of decimals");
  });

  it("tells a shop set to another number of decimals about the setting, not about a mismatch", async () => {
    // With Number of decimals at 0, the Store API writes $25 as "25" at scale
    // 0. The import sells at two decimals and names the setting; retyping
    // prices would change nothing.
    const noCents = (whole: string) => ({
      price: whole,
      currency_code: "USD",
      currency_minor_unit: 0,
    });
    const running = await started({
      catalogue: async () => ({
        ok: true,
        products: [
          aProduct({ id: 11, name: "Typed without cents", prices: noCents("25") }),
          aProduct({ id: 12, name: "Typed with cents", prices: noCents("25") }),
        ],
      }),
      inspectProduct: (keys, item) =>
        inspectProductInTheShop(keys, item, shopStoring({ 11: "25", 12: "25.00" }, "0")),
    });
    await connected(running);

    const imported = await running.post("/woocommerce/import");
    const left = leftInTheShop(imported.html);

    expect(await cardsOf(running)).toHaveLength(0);
    expect(left["11"]).toContain("Number of decimals");
    expect(left["12"]).toContain("Number of decimals");
  });

  it("names the setting when the catalogue is written at another scale than the setting says", async () => {
    // The setting reads 2 while the catalogue writes scale 0, as when a plugin
    // changes the shop's decimals; the refusal is about the decimals, not a
    // mismatch.
    const running = await started({
      catalogue: async () => ({
        ok: true,
        products: [
          aProduct({
            id: 11,
            name: "Written without cents",
            prices: { price: "25", currency_code: "USD", currency_minor_unit: 0 },
          }),
        ],
      }),
      inspectProduct: (keys, item) =>
        inspectProductInTheShop(keys, item, shopStoring({ 11: "25" }, "2")),
    });
    await connected(running);

    const imported = await running.post("/woocommerce/import");
    const left = leftInTheShop(imported.html);

    expect(await cardsOf(running)).toHaveLength(0);
    expect(left["11"]).toContain("Number of decimals");
    expect(left["11"]).not.toContain("does not match");
  });

  describe("agrees with the publish door about what the merchant lacks", () => {
    // The dashboard stops an import before reading the shop for exactly the
    // settings the gateway would refuse every card for, names them, and names
    // nothing else, on every channel the connector is offered on (so never
    // live's operator approval).
    const A_CARD = {
      merchant_item_id: "a-guide",
      title: "A guide",
      description: "A guide sold by the merchant who published this card",
      price: { amount: "25.00", currency: "USD" },
      result: { download_url: { type: "string" } },
      fulfillment: "sync",
    };

    /**
     * As a program would pick it out, asked as the shop, which is what the
     * merchant sells through once Connect is pressed.
     */
    const theDoorSays = async (running: Running): Promise<readonly string[]> => {
      const key = await running.harnessed.gateway.keyBehind(running.ownKey);
      if (key === null) throw new Error("the merchant's own key does not open the door");
      const answered = await running.harnessed.gateway.publishCard(
        key.merchantId,
        A_CARD,
        "woocommerce",
      );
      if (answered.ok) {
        return [];
      }
      const aboutTheMerchant: ReadonlySet<string> = new Set(Object.values(MERCHANT_FINDINGS));
      return answered.error.problems
        .map((finding) => finding.code)
        .filter((code) => aboutTheMerchant.has(code));
    };

    /** Read the way a merchant reads it. */
    const lineIn = (html: string): string =>
      readable(/<p class="problem"[^>]*>[\s\S]*?<\/p>/.exec(importFormOf(html))?.[0] ?? "");

    /** In the gateway's words for the same things. */
    const named = (line: string): readonly string[] => [
      ...(/\bname\b/i.test(line) ? [MERCHANT_FINDINGS.NO_SELLER_NAME] : []),
      ...(/wallet/i.test(line) ? [MERCHANT_FINDINGS.NO_PAYOUT_WALLET] : []),
    ];

    for (const channel of ["sandbox", "test"] as const) {
      for (const [hasName, hasWallet] of [
        [false, false],
        [true, false],
        [false, true],
        [true, true],
      ] as const) {
        const who = `${hasName ? "a" : "no"} seller name and ${hasWallet ? "a" : "no"} wallet`;
        it(`on ${channel}, for a merchant with ${who}`, async () => {
          const running = await started({ channel, fresh: hasName ? "named" : "unnamed" });
          await connected(running);
          if (hasWallet) {
            // Set in Settings by the signed-in person, since no key of the
            // merchant's code may set one.
            const saved = await running.post("/settings/payout-wallet", {
              payout_wallet: A_WALLET,
            });
            expect(saved.status, saved.html).toBe(303);
          }
          const door = await theDoorSays(running);
          if (hasWallet) {
            // The fixture took: a wallet saved is a wallet the gateway has.
            expect(door).not.toContain(MERCHANT_FINDINGS.NO_PAYOUT_WALLET);
          }
          const screen = (await running.get("/woocommerce")).html;
          const pressed = await running.post("/woocommerce/import");
          const after = lineIn(pressed.html);

          // Before a press the banner says what is missing, and the button
          // says nothing of its own; the answer to a press says it again.
          expect(named(bannerIn(screen))).toStrictEqual(door);
          expect(lineIn(screen)).toBe("");
          expect(pressed.status).toBe(door.length === 0 ? 200 : 409);
          if (door.length > 0) {
            expect(named(after)).toStrictEqual(door);
          }
        });
      }
    }
  });
});

describe("what the integrations screen says about a shop", () => {
  // The integrations screen must tell apart the four things that can have
  // happened; "connect a WooCommerce shop" in any state but none would tell a
  // merchant their Connect failed.
  const approve = async (running: Running, permissions = "read_write"): Promise<void> => {
    const pressed = await running.post("/woocommerce/connect", { shop_url: SHOP });
    await running.postJson("/woocommerce/callback", {
      user_id: tokenIn(pressed.to ?? ""),
      consumer_key: "ck_a-key-nobody-may-read",
      consumer_secret: "cs_a-secret-nobody-may-read",
      key_permissions: permissions,
    });
  };

  const startedMinutesAgo = async (running: Running, minutes: number): Promise<void> => {
    const began = Date.now() - minutes * 60_000;
    await running.shops.beginGrant({
      token: `token-from-${minutes}-minutes-ago`,
      accountId: running.accountId,
      shopUrl: SHOP,
      currency: null,
      startedAt: new Date(began),
      expiresAt: new Date(began + 15 * 60_000),
    });
  };

  const settings = async (running: Running): Promise<string> =>
    readable((await running.get("/integrations")).html);

  it("puts the SDK before the shop, and names the shop once it is connected", async () => {
    const running = await started();
    await running.signIn();
    await approve(running);

    // The screen's own order, under the banner, which leads to the shop the
    // merchant now sells through.
    const html = (await running.get("/integrations")).html.replace(
      /<section class="account-banner"[\s\S]*?<\/section>/,
      "",
    );

    expect(html.indexOf('href="/docs/quickstart"')).toBeGreaterThan(-1);
    expect(html.indexOf('href="/woocommerce"')).toBeGreaterThan(
      html.indexOf('href="/docs/quickstart"'),
    );
    expect(readable(html)).toContain(SHOP);
  });

  it("offers to connect one where nothing was ever started", async () => {
    const running = await started();
    await running.signIn();

    const screen = await running.get("/integrations");

    expect(screen.status).toBe(200);
    expect(readable(screen.html)).toContain("Connect a WooCommerce shop");
    expect(readable(screen.html)).not.toMatch(/acceptance path/i);
    // What a supported product is, is written on the shop screen this block
    // links to, and only there.
    expect(readable(screen.html)).not.toMatch(/one protected download file/i);
    expect(screen.html).toContain(`href="/woocommerce"`);
  });

  it("names the shop and when it was connected once the keys are here", async () => {
    const running = await started();
    await running.signIn();
    await approve(running);

    const text = await settings(running);

    expect(text).toContain(SHOP);
    expect(text).toMatch(/connected 20\d\d-\d\d-\d\d/);
    expect(text).not.toContain("Connect a WooCommerce shop");
  });

  it("says a Connect is still running, and how long it has been", async () => {
    // Approved in the shop, keys not yet here: inside the fifteen minutes the
    // honest answer is "wait".
    const running = await started();
    await running.signIn();
    await startedMinutesAgo(running, 4);

    const text = await settings(running);

    expect(text).toContain("4 minutes ago");
    expect(text).toMatch(/no keys have reached us yet/);
    expect(text).not.toContain("Connect a WooCommerce shop");
  });

  it("counts a Connect pressed moments ago without claiming a whole minute", async () => {
    const running = await started();
    await running.signIn();
    await running.post("/woocommerce/connect", { shop_url: SHOP });

    expect(await settings(running)).toContain("less than a minute ago");
  });

  it("says only that no keys came in the fifteen minutes, and does not guess why", async () => {
    // Past the fifteen minutes the move is another Connect. No cause is named:
    // nothing records whether the merchant approved, declined or closed the
    // shop's screen, and a failed post leaves the same nothing as none.
    const running = await started();
    await running.signIn();
    await startedMinutesAgo(running, 40);

    const screen = await running.get("/integrations");
    const text = readable(screen.html);

    expect(text).toContain(SHOP);
    expect(text).toMatch(/no keys arrived .* 15 minutes/);
    expect(text).toContain("Connect again");
    expect(screen.html).toContain(`href="/woocommerce"`);
    expect(text).not.toMatch(/could not reach us/);
    expect(text).not.toMatch(/firewall/);
    // Not the sentence for a running Connect, which would have the merchant
    // reloading a page that will never change.
    expect(text).not.toContain("Reload this page in a moment");
  });

  it("keeps the previous shop address in the retry form", async () => {
    const running = await started();
    await running.signIn();
    await startedMinutesAgo(running, 40);

    const screen = await running.get("/woocommerce");

    expect(screen.html).toContain(`value="${SHOP}"`);
  });

  it("offers the SDK first and the shop path after it, from an empty catalogue", async () => {
    const running = await started();
    await running.signIn();

    const html = (await running.get("/cards")).html;
    const empty = html.slice(html.indexOf('class="list list-empty"'));

    expect(/<a class="button button-primary" href="([^"]*)"/.exec(empty)?.[1]).toBe(
      "/docs/quickstart",
    );
    expect(empty.indexOf('href="/woocommerce"')).toBeGreaterThan(
      empty.indexOf('href="/docs/quickstart"'),
    );
  });

  it("says a connected shop granted less than it needs to sell anything", async () => {
    // A channel that cannot create an order refuses every sale at delivery;
    // "connected" alone over it would be reassuring about something broken.
    const running = await started();
    await running.signIn();
    await approve(running, "read");

    const text = await settings(running);

    expect(text).toContain(SHOP);
    expect(text).toMatch(/read and write/);
  });

  it("leads to the shop screen from every state", async () => {
    const running = await started();
    await running.signIn();
    const nothing = await running.get("/integrations");
    await startedMinutesAgo(running, 4);
    const waiting = await running.get("/integrations");
    await approve(running);
    const connected = await running.get("/integrations");

    for (const screen of [nothing, waiting, connected]) {
      expect(screen.html).toContain(`href="/woocommerce"`);
    }
  });

  it("carries no key of the shop's onto the settings screen", async () => {
    // The screen is handed only the fields it may know, never the row with the
    // shop's secret.
    const running = await started();
    await running.signIn();
    await approve(running);

    const screen = await running.get("/integrations");

    expect(screen.html).not.toContain("ck_a-key-nobody-may-read");
    expect(screen.html).not.toContain("cs_a-secret-nobody-may-read");
  });

  it("says the WooCommerce state could not be read, rather than nothing, when the shops table is unreachable", async () => {
    // Our shops table being down must not keep a merchant from the payout
    // address box, so settings stays up; the shop's block on integrations says
    // it could not read, because a vanished block would read as "no shop is
    // connected".
    const running = await started({
      breakTheShopsRead: () => {
        throw new Error("the shops table is not answering");
      },
    });
    await running.signIn();

    const settings = await running.get("/settings");
    expect(settings.status).toBe(200);
    expect(readable(settings.html)).toContain("Payout wallet");

    const screen = await running.get("/integrations");

    expect(screen.status).toBe(200);
    expect(readable(screen.html)).toContain("could not be read just now");
    expect(readable(screen.html)).toContain("Reload this page in a moment");
    expect(readable(screen.html)).not.toContain("Connect a WooCommerce shop");
  });
});

describe("coming back from the shop with no session on the request", () => {
  /**
   * The session may have ended while the merchant was in their shop, or the
   * shop was opened in another browser; behind the gate, a flow that worked
   * would end on a sign-in that reads as "it broke".
   */
  const cameBack = (running: Running, query = "?success=1&user_id=whatever"): Promise<Visit> =>
    running.getWithoutCookie(`/woocommerce/return${query}`);

  it("answers a page rather than sending the merchant to a sign-in", async () => {
    const running = await started();
    await running.signIn();

    const stripped = await cameBack(running);
    const seen = await running.getWithoutCookie(stripped.to ?? "/woocommerce/return");

    expect(stripped.to).not.toBe("/sign-in");
    expect(seen.status).toBe(200);
    expect(readable(seen.html)).toContain("Continue to your dashboard");
  });

  it("leads its Continue, through the sign-in, back to the shop screen", async () => {
    // No session, so Continue meets the gate, and the sign-in keeps the shop
    // screen as where the link returns them.
    const running = await started();
    const stripped = await cameBack(running);
    const page = (await running.getWithoutCookie(stripped.to ?? "/woocommerce/return")).html;
    const action = /<form[^>]*action="([^"]+)"/.exec(page)?.[1] ?? "";
    const from = /name="from" value="([^"]+)"/.exec(page)?.[1] ?? "";

    const pressed = await running.getWithoutCookie(`${action}?from=${from}`);

    expect(pressed.to).toBe("/sign-in?destination=woocommerce");
  });

  it("still takes the state token out of the address bar", async () => {
    // A return with no session is the one the return page is drawn for, so it
    // must strip the token too, or an unspent token would stay in the address.
    const running = await started();
    await running.signIn();
    const pressed = await running.post("/woocommerce/connect", { shop_url: SHOP });
    const token = tokenIn(pressed.to ?? "");

    const came = await cameBack(running, `?success=1&user_id=${token}`);

    expect(came.status).toBe(303);
    expect(came.to).toBe("/woocommerce/return");
  });

  it("reads nothing at all, so there is nothing for it to answer differently", async () => {
    // A handler that touches no row cannot vary by one: the store fails every
    // read here and the page still comes out.
    const running = await started({
      breakTheShopsRead: () => {
        throw new Error("nothing on this route may read a row");
      },
    });
    await running.signIn();

    const stripped = await cameBack(running);
    const seen = await running.getWithoutCookie(stripped.to ?? "/woocommerce/return");

    expect(seen.status).toBe(200);
    expect(readable(seen.html)).toContain("Continue to your dashboard");
  });

  it("says the same thing whether or not a shop is connected", async () => {
    // A stranger and an owner are handed the same bytes: one run with a
    // connection, one without.
    const withNothing = await started();
    const before = await withNothing.getWithoutCookie("/woocommerce/return");
    await withNothing.close();

    const withAShop = await started();
    await withAShop.signIn();
    const pressed = await withAShop.post("/woocommerce/connect", { shop_url: SHOP });
    await withAShop.postJson("/woocommerce/callback", {
      user_id: tokenIn(pressed.to ?? ""),
      consumer_key: "ck_a-key-nobody-may-read",
      consumer_secret: "cs_a-secret-nobody-may-read",
      key_permissions: "read_write",
    });
    const after = await withAShop.getWithoutCookie("/woocommerce/return");

    expect(after.status).toBe(before.status);
    expect(after.html).toBe(before.html);
  });

  it("continues into the dashboard with the session the browser already holds", async () => {
    // A click after a cookieless return carries the cookie; asking for another
    // email in between would turn a successful Connect into a loop.
    const running = await started();
    await running.signIn();
    await running.post("/woocommerce/connect", { shop_url: SHOP });

    const stripped = await cameBack(running);
    const landed = await running.getWithoutCookie(stripped.to ?? "/woocommerce/return");
    expect(readable(landed.html)).toContain("Continue to your dashboard");
    expect(landed.html).toContain(`action="/woocommerce"`);
    expect(landed.html).not.toContain("Sign in");

    const text = readable((await running.get("/woocommerce?from=shop")).html);

    expect(text).toMatch(/no keys have reached us yet/);
    expect(text).not.toContain("Connect a WooCommerce shop");
  });

  it("shows the merchant their real state once the cookie does travel", async () => {
    const running = await started();
    await running.signIn();
    const pressed = await running.post("/woocommerce/connect", { shop_url: SHOP });
    await running.postJson("/woocommerce/callback", {
      user_id: tokenIn(pressed.to ?? ""),
      consumer_key: "ck_a",
      consumer_secret: "cs_b",
      key_permissions: "read_write",
    });

    const came = await running.get("/woocommerce/return?success=1");
    const seen = await running.get(came.to ?? "");

    expect(came.to).toBe("/woocommerce?from=shop");
    expect(readable(seen.html)).toContain(`Connected ${SHOP} since`);
  });

  it("does not say the shop approved merely because the browser came through the return address", async () => {
    // `success=0` is what WooCommerce sends when the merchant declined. The
    // page may claim only what our rows hold (a Connect started, no keys yet),
    // and it is the same settings page a plain reload gives.
    const running = await started();
    await running.signIn();
    await running.post("/woocommerce/connect", { shop_url: SHOP });

    const came = await running.get("/woocommerce/return?success=0&user_id=anything");
    const back = await running.get(came.to ?? "");
    const reloaded = await running.get("/woocommerce?from=shop");

    expect(came.to).toBe("/woocommerce?from=shop");
    expect(readable(back.html)).toMatch(/no keys have reached us yet/);
    expect(readable(back.html)).not.toContain("Your shop is connected");
    expect(back.html).toBe(reloaded.html);
  });

  it("offers Connect and adds nothing when the return address is opened by hand", async () => {
    // Nothing was started; a signed-in merchant typed the address. A note that
    // a shop approved something would be about an event that did not happen.
    const running = await started();
    await running.signIn();

    const came = await running.get("/woocommerce/return");
    const back = await running.get(came.to ?? "");
    const reloaded = await running.get("/woocommerce?from=shop");

    expect(came.to).toBe("/woocommerce?from=shop");
    expect(readable(back.html)).toContain("Connect your shop");
    expect(back.html).toBe(reloaded.html);
  });

  it("leaves every other dashboard address behind the sign-in", async () => {
    // The gate is opened for one address and no wider.
    const running = await started();

    for (const path of [
      "/woocommerce",
      "/woocommerce/import",
      "/cards",
      "/orders",
      "/receipts",
      "/keys",
      "/settings",
      "/",
      "/no-such-page",
    ]) {
      const seen = await running.getWithoutCookie(path);
      expect(seen.status, path).toBe(303);
      // Where the sign-in returns the person is in its query, and not this
      // test's question.
      expect(new URL(seen.to ?? "", "http://dashboard.test").pathname, path).toBe("/sign-in");
    }
  });
});

describe("the addresses the shop screen's forms post to", () => {
  // With script, the answer to a press is drawn at the press's address, so a
  // reload reads it there.
  it("leads a read of one to the shop screen, and lets the page's own read of its data through", async () => {
    const running = await started();
    await running.signIn();

    for (const press of ["connect", "import", "switch", "disconnect"]) {
      const read = await running.get(`/woocommerce/${press}`);
      expect({ status: read.status, to: read.to }, press).toStrictEqual({
        status: 303,
        to: "/woocommerce",
      });
    }
    // What the page asks for after an import was answered, to redraw the frame
    // around the answer; sent on to the shop screen, it would take the answer
    // away.
    const data = await running.get("/woocommerce/import.data?_routes=routes%2Fgate");
    expect(data.status).toBe(200);
  });
});

describe("a press that fails inside the dashboard", () => {
  it("is answered with the dashboard's own page saying so, and nothing of the failure", async () => {
    const running = await started({
      breakTheShopsRead: () => {
        throw new Error("the shops table is not answering");
      },
    });
    await running.signIn();

    const pressed = await running.post("/woocommerce/import", { [DRAWN_FOR]: PERSON });
    const said = readable(pressed.html);

    expect(pressed.status).toBe(500);
    expect(said).toContain(
      "Something in the dashboard is broken. Check the page you were on before deciding whether it went through.",
    );
    expect(said).toContain("Back to Cards");
    expect(pressed.html).not.toContain("the shops table is not answering");
  });
});

describe("merchant delivery recovery", () => {
  const sale = async (
    running: Running,
    accountId = running.accountId,
    placed = false,
    neverAsked = false,
  ) => {
    const merchantItemId = merchantItemIdFor(SHOP, "11");
    const published = await running.harnessed.gateway.publishCard(running.harnessed.merchant.id, {
      merchant_item_id: merchantItemId,
      title: "Merchant download",
      description: "The merchant's own downloadable product",
      price: { amount: "25.00", currency: "USD" },
      fulfillment: "async",
      result: {
        download_url: { type: "string" },
        file_name: { type: "string" },
        order_number: { type: "string" },
      },
    });
    if (!published.ok) throw new Error("the recovery test's card was refused");
    const offered = await running.harnessed.gateway.beginPurchase(published.id, {});
    if (offered.step !== "pay") throw new Error("the recovery test's sale was not priced");
    const orderId = offered.order.order.id;
    await running.harnessed.gateway.payPurchase(orderId, "PAYMENT", `payment_${orderId}`);
    const priceId = `prc_${orderId}`;
    await running.harnessed.store.withOrder(orderId, (found) => ({
      save: { ...found, priceId },
      result: null,
    }));
    await running.harnessed.gateway.refuseOrder(running.harnessed.merchant.id, orderId, {
      code: "cannot_fulfill",
      message: "The shop's creation response was not received.",
    });
    const now = new Date(running.harnessed.now());
    const facts = {
      shopOrigin: SHOP,
      connectionRevision: "grant_recovery",
      merchantItemId,
      priceId,
      productId: "11",
      productFingerprint: "accepted-download-fingerprint",
      amount: "25.00",
      currency: "USD",
    };
    await running.shops.recordQuote(
      accountId,
      priceId,
      merchantItemId,
      {
        fingerprint: facts.productFingerprint,
        inTheShop: { amount: facts.amount, currency: "USD" },
        paid: { amount: facts.amount, currency: "USD" },
        rateVersion: null,
      },
      new Date(now.getTime() + 3600000),
      now,
    );
    if (neverAsked) await running.shops.recordPrecreateRefusal(accountId, orderId, facts, now);
    else await running.shops.claimOrder(accountId, orderId, facts, now);
    await running.shops.connect({
      accountId,
      shopUrl: SHOP,
      consumerKey: "ck_recovery",
      consumerSecret: "cs_recovery",
      permissions: "read_write",
      // A shop connected again since the refusal: the one condition under
      // which the operator's command would create the order.
      revision: neverAsked ? "grant_again" : "grant_recovery",
      connectedAt: now,
      currency: null,
    });
    if (placed)
      await running.shops.recordOrder(
        orderId,
        {
          id: "13",
          number: "WOO-13",
          permission: {
            shopOrigin: SHOP,
            productId: "11",
            orderKey: "wc_private_order",
            downloadId: "dl_guide",
            fileName: "Guide",
            emailUid: "a".repeat(64),
            orderNumber: "WOO-13",
          },
          total: "25.00",
        },
        now,
      );
    return { orderId, facts, path: `/integrations/woocommerce/recover/${orderId}` };
  };

  it("leads from own Orders to a saved-delivery retry without admin approval or the shop integration selected", async () => {
    const running = await started();
    await running.signIn();
    const own = await sale(running, running.accountId, true);
    const orders = await running.get("/orders");
    expect(orders.html).toContain(`href="${own.path}"`);
    const page = await running.get(own.path);
    expect(page.status).toBe(200);
    expect(formTo(page.html, "post", own.path)?.fields.has("woo_order_id")).toBe(false);
    expect(page.html).not.toContain("wc_private_order");
    expect(page.html).not.toContain("cs_recovery");

    const recovered = await running.post(own.path);
    expect(recovered.status).toBe(200);
    expect(formTo(recovered.html, "post", own.path)).toBeUndefined();
    expect((await running.harnessed.store.orderById(own.orderId))?.order.state).toBe("delivered");
    expect((await running.get("/orders")).html).not.toContain(`href="${own.path}"`);
  });

  it("turns away a press for a sale its shop was never asked to create, without asking the shop anything", async () => {
    let inspected = 0;
    const running = await started({
      inspectProduct: async (_keys, merchantItemId) => {
        inspected += 1;
        return {
          ok: true,
          product: {
            kind: "download",
            productId: merchantItemId.split("_").at(-1) ?? "",
            downloadId: "dl_guide",
            fileName: "Guide",
            price: { amount: "25.00", currency: "USD" },
            fingerprint: "accepted-download-fingerprint",
            tax: { mode: "off" as const },
          },
        };
      },
    });
    await running.signIn();
    const own = await sale(running, running.accountId, false, true);
    const page = await running.get(own.path);
    expect(formTo(page.html, "post", own.path)).toBeUndefined();

    const pressed = await running.post(own.path);

    expect(pressed.status).toBe(409);
    expect(formTo(pressed.html, "post", own.path)).toBeUndefined();
    expect(inspected).toBe(0);
    expect((await running.shops.recoveryOrder(own.orderId))?.phase).toBe("precreate_refused");
    expect((await running.harnessed.store.orderById(own.orderId))?.order.state).toBe("unfulfilled");
  });

  it("answers another account's exact sale like a missing sale on GET and POST", async () => {
    const running = await started();
    await running.signIn();
    const foreign = await sale(running, "another_account");
    const missingPath = "/integrations/woocommerce/recover/ord_missing";
    const ownOrders = await running.get("/orders");
    expect(ownOrders.html).not.toContain(`href="${foreign.path}"`);
    const foreignPage = await running.get(foreign.path);
    const missingPage = await running.get(missingPath);
    expect(foreignPage.status).toBe(404);
    expect(readable(foreignPage.html)).toBe(readable(missingPage.html));
    const foreignPost = await running.post(foreign.path, { woo_order_id: "13" });
    const missingPost = await running.post(missingPath, { woo_order_id: "13" });
    expect(foreignPost.status).toBe(404);
    expect(readable(foreignPost.html)).toBe(readable(missingPost.html));
    expect((await running.shops.recoveryOrder(foreign.orderId))?.phase).toBe("create_unknown");
  });

  it("keeps the standard drawn-for and origin guards on the new action", async () => {
    const running = await started();
    await running.signIn();
    const own = await sale(running, running.accountId, true);
    const oldForm = await running.post(own.path, { [DRAWN_FOR]: "another@example.com" });
    expect(oldForm.status).toBe(409);
    const crossOrigin = await fetch(`${running.url}${own.path}`, {
      method: "POST",
      headers: {
        origin: "https://elsewhere.example.com",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "",
    });
    expect(crossOrigin.status).toBe(403);
    expect((await running.harnessed.store.orderById(own.orderId))?.order.state).toBe("unfulfilled");
  });

  it("does not offer the recovery route on live", async () => {
    const running = await started({ channel: "live" });
    await running.signIn();
    expect((await running.get("/integrations/woocommerce/recover/ord_missing")).status).toBe(404);
  });
});

describe("one integration at a time", () => {
  // Pressing Connect moves the merchant to the shop before they are sent to
  // it, and Disconnect moves them back to their code. Selling both ways at
  // once would let the code's worker draw a paid order of the shop's.
  const coded = {
    merchant_item_id: "esim-7d",
    title: "A seven day eSIM",
    description: "Seven days of data",
    price: { amount: "12.00", currency: "USD" },
    result: { activation_code: { type: "string" } },
    fulfillment: "async",
  };

  const asTheCode = (running: Running) => ({ authorization: `Bearer ${running.ownKey}` });

  const publishedByTheCode = async (running: Running): Promise<string> => {
    const answered = await running.gateway.call("POST", "/v0/catalog/publish", {
      body: coded,
      headers: asTheCode(running),
    });
    expect(answered.status).toBe(200);
    return (answered.body as { id: string }).id;
  };

  const paidFor = async (running: Running, itemId: string): Promise<string> => {
    const offered = await running.harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    await running.harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");
    return offered.order.order.id;
  };

  const theCodePolls = (running: Running) =>
    running.gateway.call("POST", "/v0/worker/poll", {
      body: { wait_seconds: 0 },
      headers: asTheCode(running),
    });

  const onSale = async (running: Running): Promise<readonly string[]> =>
    (await running.harnessed.gateway.catalog()).items.map((item) => item.id);

  const connectTheShop = async (running: Running): Promise<void> => {
    const pressed = await running.post("/woocommerce/connect", { shop_url: SHOP });
    expect(pressed.status).toBe(303);
    await running.postJson("/woocommerce/callback", {
      user_id: tokenIn(pressed.to ?? ""),
      consumer_key: "ck_a",
      consumer_secret: "cs_b",
      key_permissions: "read_write",
    });
  };

  it("takes the code's cards off sale and its orders away the moment Connect is pressed", async () => {
    const running = await started();
    await running.signIn();
    const card = await publishedByTheCode(running);

    const pressed = await running.post("/woocommerce/connect", { shop_url: SHOP });

    expect(pressed.status).toBe(303);
    expect(await onSale(running)).not.toContain(card);
    expect((await theCodePolls(running)).status).toBe(409);
  });

  it("refuses a shop writing three decimals before sending the merchant to approve keys, and keeps the code's cards on sale", async () => {
    // Every product of such a shop would be refused at import, so switching
    // first would take the code's cards off sale for a shop that can sell
    // nothing, and the shop would hand over write keys for nothing.
    const running = await started({
      sample: async () => ({
        currency: "KWD",
        decimals: 3,
      }),
    });
    await running.signIn();
    const card = await publishedByTheCode(running);

    const pressed = await running.post("/woocommerce/connect", { shop_url: SHOP });

    expect(pressed.to).toBeNull();
    expect(readable(pressed.html)).toContain("KWD with 3 decimals");
    expect(await onSale(running)).toContain(card);
    expect((await theCodePolls(running)).status).toBe(200);
    expect(await running.shops.grantFor(running.accountId)).toBeNull();
  });

  it("says, in refusing a shop writing three decimals, that the setting is what every customer of the shop sees prices with", async () => {
    const running = await started({ sample: async () => ({ currency: "KWD", decimals: 3 }) });
    await running.signIn();

    const pressed = await running.post("/woocommerce/connect", { shop_url: SHOP });

    const said = readable(pressed.html);
    expect(said).toContain("Number of decimals");
    expect(said).toContain("every customer");
    expect(said).not.toMatch(/set (it|WooCommerce|Number of decimals)[^.]* to/i);
  });

  it("sends a shop priced in US dollars to approve keys as before", async () => {
    const running = await started({ sample: async () => IN_DOLLARS });
    await running.signIn();

    const pressed = await running.post("/woocommerce/connect", { shop_url: SHOP });

    expect(pressed.status).toBe(303);
    expect(new URL(pressed.to ?? "").pathname).toBe("/wc-auth/v1/authorize");
  });

  it("sends a shop whose currency could not be read to approve keys, leaving the verdict to the import", async () => {
    // Not knowing the currency is not knowing it is another one: a shop with
    // no products yet, or its Store API turned off, connects as before.
    const running = await started({ sample: async () => null });
    await running.signIn();
    const card = await publishedByTheCode(running);

    const pressed = await running.post("/woocommerce/connect", { shop_url: SHOP });

    expect(pressed.status).toBe(303);
    expect(new URL(pressed.to ?? "").pathname).toBe("/wc-auth/v1/authorize");
    expect(await onSale(running)).not.toContain(card);
  });

  it("refuses Connect while an order still waits on the code, names it, and sends nobody to the shop", async () => {
    const running = await started();
    await running.signIn();
    const orderId = await paidFor(running, await publishedByTheCode(running));

    const pressed = await running.post("/woocommerce/connect", { shop_url: SHOP });

    expect(pressed.status).toBe(409);
    expect(pressed.to).toBeNull();
    expect(readable(pressed.html)).toContain(orderId);
    expect(await running.shops.grantFor(running.accountId)).toBeNull();
    expect((await theCodePolls(running)).status).toBe(200);
  });

  it("refuses to replace or disconnect a shop while an order still waits on it", async () => {
    const running = await started({
      catalogue: async () => ({ ok: true, products: [aProduct()] }),
    });
    await running.signIn();
    await connectTheShop(running);
    await running.post("/woocommerce/import");
    const [imported] = await onSale(running);
    if (imported === undefined) throw new Error("nothing was imported");
    // The shop's card asks its price at purchase, and nothing answers it here,
    // so the order waits on the shop for as long as this test needs.
    const asking = running.harnessed.gateway.beginPurchase(imported, {}).catch(() => undefined);
    const merchantId = running.harnessed.merchant.id;
    await vi.waitFor(async () =>
      expect(await running.harnessed.store.orders(merchantId)).toHaveLength(1),
    );
    const [order] = await running.harnessed.store.orders(merchantId);

    const refused = await running.post("/woocommerce/disconnect");

    expect(refused.status).toBe(409);
    expect(readable(refused.html)).toContain(order?.order.id ?? "no order");
    expect(await running.shops.connectionOf(running.accountId)).not.toBeNull();

    const replaced = await running.post("/woocommerce/connect", {
      shop_url: "https://other.example.com",
    });

    expect(replaced.status).toBe(409);
    expect(replaced.to).toBeNull();
    expect((await running.shops.connectionOf(running.accountId))?.shopUrl).toBe(SHOP);
    expect(await running.shops.grantFor(running.accountId)).toBeNull();
    void asking;
  });

  it("requires disconnecting before connecting a different shop even with no open orders", async () => {
    const running = await started();
    await running.signIn();
    await connectTheShop(running);
    const before = await running.shops.connectionOf(running.accountId);

    const replaced = await running.post("/woocommerce/connect", {
      shop_url: "https://other.example.com",
    });

    expect(replaced.status).toBe(409);
    expect(replaced.to).toBeNull();
    expect(await running.shops.connectionOf(running.accountId)).toStrictEqual(before);
    expect(await running.shops.grantFor(running.accountId)).toBeNull();

    expect((await running.post("/woocommerce/disconnect")).status).toBe(303);
    const connected = await running.post("/woocommerce/connect", {
      shop_url: "https://other.example.com",
    });
    expect(connected.status).toBe(303);
    expect(new URL(connected.to ?? "").origin).toBe("https://other.example.com");
  });

  it("still renews the connected shop's keys when its address is written another way", async () => {
    const running = await started();
    await running.signIn();
    await connectTheShop(running);

    const renewed = await running.post("/woocommerce/connect", {
      shop_url: "https://SHOP.example.com:443/",
    });
    expect(renewed.status).toBe(303);
    const callback = await running.postJson("/woocommerce/callback", {
      ...grantedBody(tokenIn(renewed.to ?? "")),
      consumer_key: "ck_renewed",
    });

    expect(callback.status).toBe(200);
    expect((await running.shops.connectionOf(running.accountId))?.consumerKey).toBe("ck_renewed");
  });

  it("refuses a stale callback for another shop and preserves the connected shop's keys", async () => {
    const running = await started();
    await running.signIn();
    await connectTheShop(running);
    const before = await running.shops.connectionOf(running.accountId);
    await running.shops.beginGrant({
      token: "stale-other-shop",
      accountId: running.accountId,
      shopUrl: "https://other.example.com",
      currency: null,
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });

    const callback = await running.postJson(
      "/woocommerce/callback",
      grantedBody("stale-other-shop"),
    );

    expect(callback.status).toBe(401);
    expect(await running.shops.connectionOf(running.accountId)).toStrictEqual(before);
  });

  it("refuses to sell through a connected shop while an order still waits on the code, and names it to be copied", async () => {
    const running = await started();
    await running.signIn();
    await connectTheShop(running);
    await running.harnessed.gateway.sellThrough(running.harnessed.merchant.id, "api");
    const orderId = await paidFor(running, await publishedByTheCode(running));

    const refused = await running.post("/woocommerce/switch");

    expect(refused.status).toBe(409);
    expect(refused.html).toMatch(/aria-label="Copy the whole order ID [^"]+"/);
    expect(readable(refused.html)).toContain(orderId);
    expect((await theCodePolls(running)).status).toBe(200);
  });

  it("brings the code's cards back with selling stopped, on the screen that starts it", async () => {
    const running = await started();
    await running.signIn();
    const card = await publishedByTheCode(running);
    await connectTheShop(running);

    const left = await running.post("/woocommerce/disconnect");

    expect(left.to).toBe("/cards");
    expect(await running.shops.connectionOf(running.accountId)).toBeNull();
    expect(await onSale(running)).toStrictEqual([]);
    await running.post("/cards?selling=resume");
    expect(await onSale(running)).toStrictEqual([card]);
  });

  it("offers the way back to the code to a merchant on the shop whose shop never connected", async () => {
    const running = await started();
    await running.signIn();
    await running.post("/woocommerce/connect", { shop_url: SHOP });

    const page = await running.get("/woocommerce");
    expect(page.html).toContain('action="/woocommerce/disconnect"');
    await running.post("/woocommerce/disconnect");

    expect((await theCodePolls(running)).status).toBe(200);
  });

  it("offers a merchant on their code with a shop connected the switch to it, and imports nothing until they take it", async () => {
    // Reached when a Disconnect switched the merchant back and was cut off
    // before it forgot the shop, or from two tabs. Without the switch the page
    // would show a connected shop and an Import that reads the whole shop only
    // to refuse every card.
    const running = await started({
      catalogue: async () => ({ ok: true, products: [aProduct()] }),
    });
    await running.signIn();
    await connectTheShop(running);
    const merchantId = running.harnessed.merchant.id;
    await running.harnessed.gateway.sellThrough(merchantId, "api");

    const page = await running.get("/woocommerce");
    const refused = await running.post("/woocommerce/import");

    expect(page.html).toContain('action="/woocommerce/switch"');
    expect(refused.status).toBe(409);
    expect(running.read).toStrictEqual([]);
    await running.post("/woocommerce/switch");
    expect(await running.harnessed.gateway.sellsThrough(merchantId)).toBe("woocommerce");
  });

  it("says once over the cards why the code's cards are off sale while the shop sells", async () => {
    // Said beside every card it would be the same sentence on every row; the
    // row says only that the card is off sale, and offers no switch that would
    // put it back.
    const running = await started();
    await running.signIn();
    await publishedByTheCode(running);
    await connectTheShop(running);

    const html = (await running.get("/cards")).html;
    const rows = [...html.matchAll(/<li class="list-row[^"]*">([\s\S]*?)<\/li>/g)].map(
      ([, row = ""]) => row,
    );

    expect([...html.matchAll(/data-reason="([^"]+)"/g)].map(([, reason]) => reason)).toContain(
      "through_shop",
    );
    expect(rows).not.toHaveLength(0);
    for (const row of rows) {
      expect(readable(row)).toContain("Off sale");
      expect(readable(row)).not.toMatch(/WooCommerce/);
      expect(row).not.toMatch(/<form/);
    }
  });
});

describe("the analytics of a shop's connection and its imports", () => {
  const connectedFor = async (running: Running): Promise<void> => {
    await running.signIn();
    const pressed = await running.post("/woocommerce/connect", {
      shop_url: SHOP,
      [DRAWN_FOR]: PERSON,
    });
    await running.postJson("/woocommerce/callback", grantedBody(tokenIn(pressed.to ?? "")));
  };

  /** The publication results the gateway recorded, as the analytics team reads them. */
  const publications = (running: Running) =>
    running.harnessed.store.recordedAnalytics
      .map(({ event }) => event)
      .filter((event) => event.name === "agc_card_publish_result");

  const imports = (running: Running) =>
    running
      .connectorAnalytics()
      .filter(
        (event): event is SetupResult =>
          event.name === "agc_setup_result" && event.fields.step === "woo_import",
      );

  /** A product the shop's protected check reads as a parcel, so a merchant with no site is refused it. */
  const parcelsAndDownloads: Standing["inspectProduct"] = async (_keys, merchantItemId) => {
    const productId = merchantItemId.split("_").at(-1) ?? "";
    return productId === "12"
      ? {
          ok: true,
          product: {
            kind: "parcel",
            productId,
            price: { amount: "25.00", currency: "USD" },
            fingerprint: "accepted-parcel-fingerprint",
            tax: { mode: "off" },
          },
        }
      : {
          ok: true,
          product: {
            kind: "download",
            productId,
            downloadId: "dl_guide",
            fileName: "Guide",
            price: { amount: "25.00", currency: "USD" },
            fingerprint: "accepted-download-fingerprint",
            tax: { mode: "off" },
          },
        };
  };

  it("records the shop's connection when its keys arrive", async () => {
    const running = await started();
    await connectedFor(running);

    expect(
      running.connectorAnalytics().filter((event) => event.name === "agc_setup_result"),
    ).toMatchObject([
      {
        actor: "human",
        source: "woocommerce",
        refs: { person: running.accountId },
        fields: { step: "woo_connection", integration: "woocommerce", outcome: "completed" },
      },
    ]);
  });

  it("records one result for an import with its three counts, and a publication result per card it published or was refused", async () => {
    const running = await started({
      catalogue: async () => ({
        ok: true,
        products: [
          aProduct({ id: 11 }),
          aProduct({
            id: 12,
            name: "Coffee beans",
            virtual: false,
            downloadable: false,
            downloads: [],
          }),
          aProduct({ id: 13, name: "A set of mugs", type: "grouped" }),
        ],
      }),
      inspectProduct: parcelsAndDownloads,
    });
    await connectedFor(running);

    await running.post("/woocommerce/import");

    const merchant = running.harnessed.merchant.id;
    expect(imports(running)).toStrictEqual([
      {
        name: "agc_setup_result",
        actor: "human",
        source: "dashboard",
        refs: { merchant, person: running.accountId },
        fields: {
          step: "woo_import",
          integration: "woocommerce",
          outcome: "partial",
          imported_count: 1,
          failed_count: 1,
          skipped_count: 1,
        },
      },
    ]);
    const [published] = await running.harnessed.store.cards(merchant);
    expect(publications(running)).toStrictEqual([
      {
        name: "agc_card_publish_result",
        actor: "human",
        source: "dashboard",
        refs: { merchant, item: published?.id },
        fields: { integration: "woocommerce", outcome: "completed" },
      },
      {
        name: "agc_card_publish_result",
        actor: "human",
        source: "dashboard",
        refs: { merchant },
        fields: {
          integration: "woocommerce",
          outcome: "blocked",
          reason_code: "seller_site_missing",
        },
      },
    ]);
  });

  it("records an import again as a run of its own, with no publication for a card already published", async () => {
    const running = await started({
      catalogue: async () => ({ ok: true, products: [aProduct()] }),
    });
    await connectedFor(running);

    await running.post("/woocommerce/import");
    await running.post("/woocommerce/import");

    expect(imports(running).map((event) => event.fields)).toStrictEqual([
      { ...COMPLETED_IMPORT, imported_count: 1 },
      { ...COMPLETED_IMPORT, imported_count: 1 },
    ]);
    expect(publications(running)).toHaveLength(1);
  });

  it("records an import of an empty catalogue as completed with nothing imported", async () => {
    const running = await started();
    await connectedFor(running);

    await running.post("/woocommerce/import");

    expect(imports(running).map((event) => event.fields)).toStrictEqual([COMPLETED_IMPORT]);
  });

  it("records an import with every card refused as blocked by the first card's reason", async () => {
    const running = await started({
      catalogue: async () => ({
        ok: true,
        products: [aProduct({ id: 12, virtual: false, downloadable: false, downloads: [] })],
      }),
      inspectProduct: parcelsAndDownloads,
    });
    await connectedFor(running);

    await running.post("/woocommerce/import");

    expect(imports(running).map((event) => event.fields)).toStrictEqual([
      {
        ...COMPLETED_IMPORT,
        outcome: "blocked",
        reason_code: "seller_site_missing",
        failed_count: 1,
      },
    ]);
  });

  it("records an import that could not start, and why", async () => {
    const unread = await started({
      catalogue: async () => ({ ok: false, why: "The shop did not answer." }),
    });
    await unread.signIn();
    await unread.post("/woocommerce/import");
    await connectedFor(unread);
    await unread.post("/woocommerce/import");
    const reasons = imports(unread).map((event) => event.fields.reason_code);
    await unread.close();
    open = null;

    const walletless = await started({ fresh: "named", channel: "test" });
    await connectedFor(walletless);
    await walletless.post("/woocommerce/import");

    expect([
      ...reasons,
      ...imports(walletless).map((event) => event.fields.reason_code),
    ]).toStrictEqual(["no_connection", "catalogue_unavailable", "wallet_missing"]);
    expect(imports(walletless).map((event) => event.fields)).toMatchObject([
      { outcome: "blocked", imported_count: 0, failed_count: 0, skipped_count: 0 },
    ]);
  });

  it("records an import cut short by a publication that failed as unknown, since that card may have been published", async () => {
    const running = await started({
      catalogue: async () => ({ ok: true, products: [aProduct({ id: 11 }), aProduct({ id: 14 })] }),
      silent: "publishing fails",
    });
    await connectedFor(running);

    await running.post("/woocommerce/import");

    expect(imports(running).map((event) => event.fields)).toStrictEqual([
      {
        ...COMPLETED_IMPORT,
        outcome: "unknown",
        reason_code: "internal_error",
        failed_count: 1,
        skipped_count: 1,
      },
    ]);
  });
});

const COMPLETED_IMPORT = {
  step: "woo_import",
  integration: "woocommerce",
  outcome: "completed",
  imported_count: 0,
  failed_count: 0,
  skipped_count: 0,
} as const;

describe("a shop priced in another currency than US dollars", () => {
  /** The lab's realistic shop: rupiah written with no decimals. */
  const IN_RUPIAH: ShopSample = {
    currency: "IDR",
    decimals: 0,
  };
  const rupiahProduct = aProduct({
    id: 41,
    name: "Rayon Sarong",
    prices: { price: "240000", currency_code: "IDR", currency_minor_unit: 0 },
  });
  const inRupiah: Standing = {
    sample: async () => IN_RUPIAH,
    example: async () => ({ kind: "priced", name: "Rayon Sarong", price: "240000" }),
    catalogue: async () => ({ ok: true, products: [rupiahProduct] }),
    inspectProduct: async (_keys, merchantItemId) => ({
      ok: true,
      product: {
        kind: "download",
        productId: merchantItemId.split("_").at(-1) ?? "",
        downloadId: "dl_sarong",
        fileName: "Sarong pattern.pdf",
        price: { amount: "240000", currency: "IDR" },
        fingerprint: "sarong-in-rupiah",
        tax: { mode: "off" as const },
      },
    }),
  };

  const connectedIn = async (running: Running): Promise<void> => {
    await running.signIn();
    const pressed = await running.post("/woocommerce/connect", { shop_url: SHOP });
    expect(pressed.status).toBe(303);
    await running.postJson("/woocommerce/callback", grantedBody(tokenIn(pressed.to ?? "")));
    await running.get("/woocommerce");
  };

  const pricesOnSale = async (running: Running): Promise<readonly string[]> => {
    const answered = await running.gateway.call("GET", "/v0/cards", {
      headers: { authorization: `Bearer ${running.ownKey}` },
    });
    return (answered.body as { cards: { card: { price: { amount: string } } }[] }).cards.map(
      (one) => one.card.price.amount,
    );
  };

  const rateNotices = (running: Running) =>
    running.messages.filter((message) => message.subject.includes("exchange rate"));

  describe("at Connect", () => {
    it("connects a shop priced in rupiah, a currency Coinbase gives a rate for", async () => {
      const running = await started(inRupiah);
      await connectedIn(running);

      expect((await running.shops.connectionOf(running.accountId))?.currency).toEqual({
        code: "IDR",
        decimals: 0,
      });
    });

    it("refuses a currency Coinbase gives no rate for, in plain words, and changes nothing", async () => {
      const running = await started({
        sample: async () => ({ ...IN_RUPIAH, currency: "XAF" }),
        reference: async () => ({ ok: false, listed: false }),
      });
      await running.signIn();

      const pressed = await running.post("/woocommerce/connect", { shop_url: SHOP });

      expect(pressed.to).toBeNull();
      expect(readable(pressed.html)).toContain("Coinbase gives no rate for XAF");
      expect(await running.shops.grantFor(running.accountId)).toBeNull();
    });

    it("asks for Connect to be pressed again when Coinbase did not answer, without saying there is no rate", async () => {
      const running = await started({
        ...inRupiah,
        reference: async () => ({ ok: false, listed: null }),
      });
      await running.signIn();

      const pressed = await running.post("/woocommerce/connect", { shop_url: SHOP });

      expect(pressed.to).toBeNull();
      const said = readable(pressed.html);
      expect(said).toContain("did not answer");
      expect(said).toContain("press Connect again");
      expect(said).not.toContain("gives no rate");
      expect(await running.shops.grantFor(running.accountId)).toBeNull();
    });

    it("asks Coinbase nothing for a shop priced in US dollars", async () => {
      const asked: string[] = [];
      const running = await started({
        reference: async (currency) => {
          asked.push(currency);
          return { ok: false, listed: null };
        },
      });
      await running.signIn();

      const pressed = await running.post("/woocommerce/connect", { shop_url: SHOP });

      expect(pressed.status).toBe(303);
      expect(asked).toEqual([]);
    });
  });

  describe("on the shop screen", () => {
    it("asks for the rate in units of the shop's currency per dollar, beside Coinbase's open rate and when it was read", async () => {
      const running = await started(inRupiah);
      await connectedIn(running);

      const screen = await running.get("/woocommerce");

      const said = readable(screen.html);
      expect(said).toContain("Indonesian Rupiah (IDR)");
      expect(said).toContain("Nothing is published until you set one");
      expect(said).toContain("open rate, source: Coinbase");
      expect(said).toContain("18035.292596");
      expect(said).toContain("2026-10-21 14:52:48 UTC");
      expect(screen.html).toContain('name="rate"');
    });

    it("shows a shop priced in US dollars no rate at all", async () => {
      const running = await started();
      await connectedIn(running);

      const screen = await running.get("/woocommerce");

      expect(screen.html).not.toContain('name="rate"');
      expect(readable(screen.html)).not.toContain("Coinbase");
    });
  });

  describe("importing before a rate is set", () => {
    it("is counted as an import blocked for a setting the merchant has not made", async () => {
      const running = await started(inRupiah);
      await connectedIn(running);

      await running.post("/woocommerce/import");

      expect(
        running
          .connectorAnalytics()
          .filter(
            (event) => event.name === "agc_setup_result" && event.fields.step === "woo_import",
          ),
      ).toMatchObject([
        { fields: { outcome: "blocked", reason_code: "profile_missing", imported_count: 0 } },
      ]);
    });

    it("publishes nothing and says a rate is wanted first", async () => {
      const running = await started(inRupiah);
      await connectedIn(running);

      const imported = await running.post("/woocommerce/import");

      expect(await pricesOnSale(running)).toEqual([]);
      expect(readable(imported.html)).toContain("Nothing was imported");
      expect(imported.html).toContain('name="rate"');
    });
  });

  describe("saving a rate", () => {
    it("saves a rate near Coinbase's, tells the account's email, and imports the shop at it", async () => {
      const running = await started(inRupiah);
      await connectedIn(running);

      const saved = await running.post("/woocommerce/rate", { currency: "IDR", rate: "18000" });

      expect(saved.status).toBe(200);
      expect(await running.shops.currentRate(running.accountId, SHOP, "IDR")).toMatchObject({
        rate: "18000",
        setBy: PERSON,
        reference: { rate: "18035.292596", source: "Coinbase", readAt: COINBASE_READ_AT },
        confirmed: false,
      });
      // Rp 240.000 at 18000 rupiah to the dollar, rounded up to the cent.
      expect(await pricesOnSale(running)).toEqual(["13.34"]);
      const [notice] = rateNotices(running);
      expect(notice?.to).toBe(PERSON);
      expect(notice?.body).toContain("18000 IDR per US dollar");
      expect(notice?.body).toContain("No rate was set before");
    });

    it("tells, in the notice, when the session that entered the rate signed in, and names no address as who did", async () => {
      const running = await started(inRupiah);
      await connectedIn(running);
      // The owner's own browser signed in two days ago; a second one signs in now.
      for (const row of running.sessions) row.createdAt = new Date("2026-10-20T08:00:00.000Z");
      const before = Math.floor(Date.now() / 1000) * 1000;
      await running.signIn("woocommerce");
      const after = Date.now();

      await running.post("/woocommerce/rate", { currency: "IDR", rate: "18000" });

      const [sent] = rateNotices(running);
      expect(sent?.body).not.toContain(PERSON);
      expect(sent?.body).not.toContain("2026-10-20 08:00:00 UTC");
      const named = /signed in to this account at (\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) UTC/.exec(
        sent?.body ?? "",
      );
      const signedInAt = Date.parse(`${named?.[1]}T${named?.[2]}Z`);
      expect(signedInAt).toBeGreaterThanOrEqual(before);
      expect(signedInAt).toBeLessThanOrEqual(after);
    });

    it("names the previous rate in the notice of the next one", async () => {
      const running = await started(inRupiah);
      await connectedIn(running);
      await running.post("/woocommerce/rate", { currency: "IDR", rate: "18000" });
      await running.get("/woocommerce");

      await running.post("/woocommerce/rate", { currency: "IDR", rate: "17500" });

      expect(rateNotices(running).at(-1)?.body).toContain("The previous rate was 18000 IDR");
      expect(await pricesOnSale(running)).toEqual(["13.72"]);
    });

    it("asks for a rate more than a tenth from Coinbase's to be typed again, showing what a product would cost", async () => {
      const running = await started(inRupiah);
      await connectedIn(running);

      const asked = await running.post("/woocommerce/rate", { currency: "IDR", rate: "1800" });

      const said = readable(asked.html);
      expect(said).toContain("90.0% below");
      expect(said).toContain("Rayon Sarong");
      expect(said).toContain("133.34 USD");
      expect(said).toContain("13.31 USD");
      expect(await running.shops.currentRate(running.accountId, SHOP, "IDR")).toBeNull();
      expect(rateNotices(running)).toEqual([]);
      expect(await pricesOnSale(running)).toEqual([]);
    });

    it("says no product of the catalogue's first page has a price, not that it did not answer, and still asks for the rate again", async () => {
      const running = await started({ ...inRupiah, example: async () => ({ kind: "none" }) });
      await connectedIn(running);

      const asked = await running.post("/woocommerce/rate", { currency: "IDR", rate: "1800" });

      const said = readable(asked.html);
      expect(said).toContain("90.0% below");
      expect(said).toContain(
        "none of the first 10 products in your shop's public catalogue has a price in IDR",
      );
      expect(said).not.toContain("did not answer");
      expect(said).toContain("Type the rate again");
      expect(await running.shops.currentRate(running.accountId, SHOP, "IDR")).toBeNull();
      expect(rateNotices(running)).toEqual([]);
    });

    it("says the catalogue did not answer only when it did not, and still asks for the rate again", async () => {
      const running = await started({
        ...inRupiah,
        example: async () => ({ kind: "unanswered" }),
      });
      await connectedIn(running);

      const asked = await running.post("/woocommerce/rate", { currency: "IDR", rate: "1800" });

      const said = readable(asked.html);
      expect(said).toContain("your shop's public catalogue did not answer just now");
      expect(said).not.toContain("has a price in IDR");
      expect(await running.shops.currentRate(running.accountId, SHOP, "IDR")).toBeNull();

      await running.post("/woocommerce/rate", { currency: "IDR", rate: "1800", again: "1800" });

      expect(await running.shops.currentRate(running.accountId, SHOP, "IDR")).toMatchObject({
        rate: "1800",
        confirmed: true,
      });
    });

    it("saves that rate once it is typed again, and keeps that it was", async () => {
      const running = await started(inRupiah);
      await connectedIn(running);
      await running.post("/woocommerce/rate", { currency: "IDR", rate: "1800" });

      await running.post("/woocommerce/rate", { currency: "IDR", rate: "1800", again: "1800" });

      expect(await running.shops.currentRate(running.accountId, SHOP, "IDR")).toMatchObject({
        rate: "1800",
        confirmed: true,
      });
    });

    it("does not take a second typing that differs from the first", async () => {
      const running = await started(inRupiah);
      await connectedIn(running);

      await running.post("/woocommerce/rate", { currency: "IDR", rate: "1800", again: "18000" });

      expect(await running.shops.currentRate(running.accountId, SHOP, "IDR")).toBeNull();
    });

    it("saves a rate with a note that nothing was compared when Coinbase did not answer", async () => {
      const running = await started({
        ...inRupiah,
        reference: async () => ({ ok: false, listed: null }),
      });
      await running.signIn();
      await running.shops.beginGrant({
        token: "rupiah-token",
        accountId: running.accountId,
        shopUrl: SHOP,
        currency: { code: "IDR", decimals: 0 },
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });
      await running.postJson("/woocommerce/callback", grantedBody("rupiah-token"));
      await running.get("/woocommerce");

      const saved = await running.post("/woocommerce/rate", { currency: "IDR", rate: "1800" });

      expect(readable(saved.html)).toContain("was not compared with anything");
      expect(await running.shops.currentRate(running.accountId, SHOP, "IDR")).toMatchObject({
        rate: "1800",
        reference: null,
      });
    });

    it("saves nothing when its notice cannot be sent, and says so", async () => {
      const running = await started({ ...inRupiah, mailRefused: true });
      await running.signIn();
      await running.shops.beginGrant({
        token: "rupiah-token",
        accountId: running.accountId,
        shopUrl: SHOP,
        currency: { code: "IDR", decimals: 0 },
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });
      await running.postJson("/woocommerce/callback", grantedBody("rupiah-token"));
      await running.get("/woocommerce");

      const saved = await running.post("/woocommerce/rate", { currency: "IDR", rate: "18000" });

      expect(readable(saved.html)).toContain("could not be sent");
      expect(await running.shops.currentRate(running.accountId, SHOP, "IDR")).toBeNull();
    });

    it("saves nothing for a currency the shop no longer sells in", async () => {
      const running = await started(inRupiah);
      await connectedIn(running);
      await running.shops.noteCurrency(running.accountId, { code: "EUR", decimals: 2 });

      const refused = await running.post("/woocommerce/rate", { currency: "IDR", rate: "18000" });

      expect(readable(refused.html)).toContain("EUR");
      expect(await running.shops.currentRate(running.accountId, SHOP, "IDR")).toBeNull();
      expect(await running.shops.currentRate(running.accountId, SHOP, "EUR")).toBeNull();
    });

    it("saves nothing for a rate written with a separator between thousands", async () => {
      const running = await started(inRupiah);
      await connectedIn(running);

      for (const rate of ["18,000", "18 000", "-18000", ""]) {
        await running.post("/woocommerce/rate", { currency: "IDR", rate });
      }

      expect(await running.shops.currentRate(running.accountId, SHOP, "IDR")).toBeNull();
    });

    it("saves nothing for a currency Coinbase answered it gives no rate for", async () => {
      const running = await started({
        ...inRupiah,
        reference: async () => ({ ok: false, listed: false }),
      });
      await running.signIn();
      await running.shops.beginGrant({
        token: "rupiah-token",
        accountId: running.accountId,
        shopUrl: SHOP,
        currency: { code: "IDR", decimals: 0 },
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });
      await running.postJson("/woocommerce/callback", grantedBody("rupiah-token"));
      await running.get("/woocommerce");

      await running.post("/woocommerce/rate", { currency: "IDR", rate: "18000" });

      expect(await running.shops.currentRate(running.accountId, SHOP, "IDR")).toBeNull();
    });

    it("says the rate was saved when the import it runs finds the shop now sells in another currency", async () => {
      const running = await started({
        ...inRupiah,
        catalogue: async () => ({
          ok: true,
          products: [
            aProduct({ prices: { price: "1450", currency_code: "EUR", currency_minor_unit: 2 } }),
          ],
        }),
        inspectProduct: async (_keys, merchantItemId) => ({
          ok: true,
          product: {
            kind: "download",
            productId: merchantItemId.split("_").at(-1) ?? "",
            downloadId: "dl_sarong",
            fileName: "Sarong pattern.pdf",
            price: { amount: "14.50", currency: "EUR" },
            fingerprint: "sarong-in-euros",
            tax: { mode: "off" as const },
          },
        }),
      });
      await connectedIn(running);

      const saved = await running.post("/woocommerce/rate", { currency: "IDR", rate: "18000" });

      const said = readable(saved.html);
      expect(said).toContain("Your rate of 18000 IDR per US dollar was saved");
      expect(said).toContain("your shop sells in EUR");
      expect(await pricesOnSale(running)).toEqual([]);
    });

    it("is refused for a shop priced in US dollars", async () => {
      const running = await started();
      await connectedIn(running);

      await running.post("/woocommerce/rate", { currency: "USD", rate: "1" });

      expect(await running.shops.currentRate(running.accountId, SHOP, "USD")).toBeNull();
    });
  });
});
