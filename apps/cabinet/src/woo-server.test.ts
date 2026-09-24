/**
 * The Connect flow as a merchant walks it, over HTTP, against a real gateway.
 *
 * Nothing between the browser and the catalogue is stubbed except the merchant's
 * own shop, which is the one party these tests cannot stand up: a shop is
 * refused at the door unless it is https, and a server on a loopback port is
 * not. So the two calls that reach a shop are handed in, and everything else —
 * the routes, the sign-in, the publish door, the cards that come out — is the
 * real thing.
 *
 * The assertions this file exists for are the two that decide whether a
 * stranger can plant keys on somebody's account: a callback carrying a token
 * nobody issued writes nothing, and a token that already worked does not work
 * again.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type Harness,
  harness,
  type Served,
  serve,
  theMerchantKey,
} from "@agentify/gateway/testing";
import type { Express } from "express";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { type Identity, identityFor } from "./identity.js";
import type { Message } from "./mail.js";
import { buildApp } from "./server.js";
import { readable } from "./testing/html.js";
import { rewindLinkSends } from "./testing/link-sends.js";
import type { StoreProduct } from "./woo-catalog.js";
import type { Preflight } from "./woo-connect.js";
import type { CatalogueRead, inspectProductInTheShop, ProductInspection } from "./woo-shop.js";
import { memoryWooShops, type WooShops } from "./woo-shops.js";

const KEY = theMerchantKey("test");
const PERSON = "dmitry@example.com";
const SHOP = "https://shop.example.com";
const PUBLIC = "https://cabinet.example.com";

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
  /**
   * The account the tests sign in as, for the two that put a Connect in the
   * past rather than waiting a quarter of an hour for one to expire.
   */
  readonly accountId: string;
  readonly url: string;
  /** Every authorize address the preflight was asked about. */
  readonly asked: string[];
  get(path: string): Promise<Visit>;
  /**
   * A GET carrying no cookie, which is what the browser sends on the way back
   * from a merchant's own shop.
   *
   * The session cookie is `SameSite=Strict` (ADR-0009), so a navigation that
   * starts on somebody else's site arrives here with nothing on it — even for a
   * merchant who is signed in on that very browser. Sent with a cookie, a test
   * of the return page would be testing the one case that never happens.
   */
  getWithoutCookie(path: string): Promise<Visit>;
  post(path: string, form?: Record<string, string>): Promise<Visit>;
  /**
   * A JSON post carrying no cookie, which is what a WooCommerce shop sends.
   *
   * The absence is the point: the callback comes from the merchant's own web
   * server, with no session of ours on it, and the route being above the
   * sign-in gate is what makes it reachable at all.
   */
  postJson(path: string, body: unknown): Promise<Visit>;
  signIn(destination?: "default" | "woocommerce"): Promise<Visit>;
  /** Ends the session, so the next visit is a stranger's until they sign in. */
  signOut(): Promise<void>;
  close(): Promise<void>;
}

let open: Running | null = null;

afterEach(async () => {
  await open?.close();
  open = null;
});

interface Standing {
  readonly grantScreen?: (authorizeUrl: string) => Promise<Preflight>;
  readonly catalogue?: (shopUrl: string) => Promise<CatalogueRead>;
  readonly inspectProduct?: (
    keys: Parameters<typeof inspectProductInTheShop>[0],
    merchantItemId: string,
  ) => Promise<ProductInspection>;
  /**
   * Makes every read of the connections table fail, the way an unreachable
   * Postgres does.
   *
   * The real store and the memory one both answer from somewhere that can stop
   * answering, and nothing else in this suite can produce that. Only the reads
   * the screens make are broken: the writes on the Connect path are left alone,
   * so a test can still put a row there to be read.
   */
  readonly breakTheShopsRead?: () => never;
  /**
   * Where the cabinet is told the gateway is, instead of the one this harness
   * serves. Pointed at an address nothing answers at, it is the one way this
   * suite can ask what an import says when the publish door is not there.
   */
  readonly gatewayAt?: string;
}

const started = async (standing: Standing = {}): Promise<Running> => {
  const harnessed = await harness();
  const gateway = await serve(harnessed);
  const config = loadConfig({
    GATEWAY_URL: standing.gatewayAt ?? gateway.url,
    DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
    AUTH_SECRET: "a-secret-that-is-at-least-32-characters-long",
    PAYMENT_NETWORK: "eip155:84532",
    FACILITATOR_URL: "sandbox:scripted",
    PUBLIC_BASE_URL: PUBLIC,
    REGISTRATION_INVITATION: "the-existing-gateway-process-secret",
  });
  const messages: Message[] = [];
  const rows: Record<string, Record<string, unknown>[]> = {
    cabinet_accounts: [],
    cabinet_sessions: [],
    cabinet_credentials: [],
    cabinet_verifications: [],
    cabinet_link_sends: [],
  };
  const identity = identityFor(config, {
    rows,
    postman: async (message) => {
      messages.push(message);
      return "accepted";
    },
  });
  const person = await identity.make(PERSON, { id: harnessed.merchant.id, key: KEY });
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
  const app: Express = buildApp(config, {
    identity,
    wooShops: shops,
    shop: {
      grantScreen: async (authorizeUrl) => {
        asked.push(authorizeUrl);
        return standing.grantScreen === undefined
          ? { ok: true }
          : await standing.grantScreen(authorizeUrl);
      },
      catalogue: standing.catalogue ?? (async () => ({ ok: true, products: [] })),
      inspectProduct:
        standing.inspectProduct ??
        (async (_keys, merchantItemId) => ({
          ok: true,
          product: {
            productId: merchantItemId.split("_").at(-1) ?? "",
            downloadId: "dl_guide",
            fileName: "Guide",
            price: { amount: "25.00", currency: "USD" },
            fingerprint: "accepted-download-fingerprint",
          },
        })),
    },
  });

  const server: Server = createServer(app);
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  const jar = new Map<string, string>();

  const visit = async (
    method: string,
    path: string,
    options: { body?: string; type?: string; noCookie?: boolean } = {},
  ): Promise<Visit> => {
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
    return {
      status: answered.status,
      html: await answered.text(),
      to: answered.headers.get("location"),
    };
  };

  open = {
    gateway,
    harnessed,
    identity,
    shops,
    accountId: person.id,
    url,
    asked,
    get: (path) => visit("GET", path),
    getWithoutCookie: (path) => visit("GET", path, { noCookie: true }),
    post: (path, form = {}) => visit("POST", path, { body: new URLSearchParams(form).toString() }),
    postJson: (path, body) =>
      // No cookie, which is the whole shape of this request: WooCommerce posts
      // the keys from the shop's own web server, carrying no session of ours.
      // Sent with one, every callback test would pass with the route mounted
      // below the sign-in — and every real Connect would break in silence.
      visit("POST", path, {
        body: JSON.stringify(body),
        type: "application/json;charset=UTF-8",
        noCookie: true,
      }),
    async signIn(destination = "default") {
      // The door keeps a minute between two links to one address. A test here
      // that signs in twice — once to lose the session, once to come back — is
      // about where WooCommerce sends a merchant, so the minute is moved out
      // of the way rather than waited out.
      rewindLinkSends(rows);
      await visit("POST", "/sign-in", {
        body: new URLSearchParams({
          email: PERSON,
          ...(destination === "default" ? {} : { destination }),
        }).toString(),
      });
      const found = /(https?:\/\/\S+)/.exec(messages.at(-1)?.body ?? "")?.[1];
      if (found === undefined) throw new Error("the sign-in message carried no action URL");
      const action = new URL(found);
      return await visit("POST", action.pathname, {
        body: new URLSearchParams({ token: action.searchParams.get("token") ?? "" }).toString(),
      });
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

/** The token in the authorize address the preflight was asked about. */
const tokenIn = (authorizeUrl: string): string =>
  new URL(authorizeUrl).searchParams.get("user_id") ?? "";

/**
 * An address on this machine that nothing answers at: a port taken and given
 * back, so that a connection to it is refused rather than left hanging.
 */
const nowhere = async (): Promise<string> => {
  const taken = createServer();
  taken.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => taken.once("listening", resolve));
  const { port } = taken.address() as AddressInfo;
  await new Promise<void>((resolve) => taken.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
};

describe("the shop screens are behind the sign-in", () => {
  it("sends a stranger to the sign-in", async () => {
    const running = await started();
    const seen = await running.get("/woocommerce");
    expect(seen.status).toBe(303);
    // 24.09: the sign-in now carries the screen the stranger opened (П11).
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

  it("asks the shop about the very address the browser is sent to", async () => {
    // Not a similar one. A preflight that checked a differently built address
    // would be measuring something nobody is about to visit.
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
    // The plain-permalink trap: the shop answers with its own front page and a
    // 200, so a merchant sent there lands on their shop with nothing to report.
    const running = await started({
      grantScreen: async () => ({ ok: false, why: "…the shop's permalink setting…" }),
    });
    await running.signIn();

    const pressed = await running.post("/woocommerce/connect", { shop_url: SHOP });

    expect(pressed.status).toBe(400);
    expect(pressed.html).toContain("permalink");
    // And nothing was written down: a Connect nobody could complete leaves no
    // token behind for anybody to post against.
    expect(await running.shops.spendGrant(tokenIn(running.asked[0] ?? ""), new Date())).toBeNull();
  });
});

describe("the keys arriving from the shop", () => {
  const grantedBody = (token: string, permissions = "read_write") => ({
    key_id: 2,
    user_id: token,
    consumer_key: "ck_a-key-from-the-shop",
    consumer_secret: "cs_a-secret-from-the-shop",
    key_permissions: permissions,
  });

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

  it("refuses a token nobody issued, and writes nothing", async () => {
    // The callback carries no session and no key of ours, so this is the whole
    // of what stops a stranger putting their own shop's keys on this account.
    // The refusal is a status and not a page: WooCommerce takes the key it
    // minted back out of the shop when the post fails.
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
    });
    await running.shops.beginGrant({
      token: "old-unanswered-token",
      accountId: running.accountId,
      shopUrl: SHOP,
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
    // And the merchant is told, rather than finding out from a refunded buyer.
    const seen = await running.get("/woocommerce");
    expect(seen.html).toContain("read and write");
  });
});

describe("the page the shop sends the browser back to, with a session on the request", () => {
  // One test, and one is right. A real return carries no session — the cookie
  // is SameSite=Strict and the navigation begins on the merchant's own shop —
  // so this describe covers the branch a merchant reaches only by typing the
  // address into a cabinet they are already signed into. What that branch owes
  // is the redirect, and what it redirects to is covered where a merchant
  // actually lands: on the settings screen and on the shop screen.
  it("takes the state token out of the address bar", async () => {
    // WooCommerce hands user_id back on this redirect, and in the case this
    // page exists for — the keys never arrived — that token is unspent and good
    // for the rest of its fifteen minutes. Left in the address it is in the
    // browser's history, in the Referer of everything the page then loads, and
    // in the address bar of a laptop somebody else can walk up to.
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
    const pressed = await running.post("/woocommerce/connect", { shop_url: SHOP });
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

  /** The merchant's own cards as the gateway holds them, read with their key. */
  const cardsOf = async (running: Running): Promise<readonly Held[]> => {
    const answered = await running.gateway.call("GET", "/v0/cards", {
      headers: { authorization: `Bearer ${KEY}` },
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
    // An import the door answered in full claims no other kind of outcome.
    expect(readable(imported.html)).not.toContain("no verdict");
    // And the card is really in the merchant's catalogue, priced at the scale
    // the shop sent rather than at a hundred times it.
    const listed = await cardsOf(running);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.card.price.amount).toBe("25.00");
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
            productId: merchantItemId.split("_").at(-1) ?? "",
            downloadId: "dl_guide",
            fileName: "Guide",
            price: { amount: "25.00", currency: "USD" },
            fingerprint: "accepted-download-fingerprint",
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
    // Publishing a paused card again changes the card and leaves it paused —
    // a merchant editing a price in their shop is not asking for a product
    // they took off sale to go back on it — and the door's answer says nothing
    // about selling either way. A page that reads "on sale" over that card
    // tells the merchant that agents can buy it, and they cannot. Two products
    // and one pause, which is the list a merchant actually reads: the paused
    // card beside one that is not, with nothing on this page to tell them
    // apart, and the count in the plural the demo runbook shows.
    const running = await started({
      catalogue: async () => ({
        ok: true,
        products: [aProduct(), aProduct({ id: 10, name: "Access code", sku: "agentify-code" })],
      }),
    });
    await connected(running);
    await running.post("/woocommerce/import");
    const tote = (await cardsOf(running)).find((one) => one.card.title === "Canvas tote bag");
    await running.post(`/cards/${encodeURIComponent(tote?.id ?? "")}/pause`);

    const imported = await running.post("/woocommerce/import");
    const text = readable(imported.html);

    expect(imported.status).toBe(200);
    expect(text).toContain("2 products published");
    expect(text).toContain("Canvas tote bag");
    expect(text).not.toMatch(/on sale/i);
    expect((await cardsOf(running)).find((one) => one.id === tote?.id)?.paused).toBe(true);
  });

  it("shows the door's own refusal word for word", async () => {
    // The description a shop wrote is longer than our catalogue carries. The
    // merchant's move is to shorten it in their shop, and the only thing that
    // tells them so is the sentence the door gave.
    const running = await started({
      catalogue: async () => ({
        ok: true,
        products: [aProduct({ description: `<p>${"a".repeat(900)}</p>` })],
      }),
    });
    await connected(running);

    const imported = await running.post("/woocommerce/import");

    expect(imported.html).toContain("Refused");
    // Both halves of the door's sentence reach the merchant: the ceiling, and
    // the length of the text they wrote in their own shop. The second is what
    // tells them how much to cut, and it is the half a summary would lose.
    expect(readable(imported.html)).toContain("at most 500");
    expect(readable(imported.html)).toContain("900 characters");
  });

  it("says the door did not answer, and does not send the merchant to their shop to fix it", async () => {
    // A valid product and a gateway that is not there. Nothing about the
    // product is wrong and nothing in the shop can repair it, so a page that
    // puts it under "change what they name in your shop" sends the merchant
    // to edit a product nobody read. What the page can say is what came back
    // instead of an answer, and what to do about that.
    const running = await started({
      catalogue: async () => ({ ok: true, products: [aProduct()] }),
      gatewayAt: await nowhere(),
    });
    await connected(running);

    const imported = await running.post("/woocommerce/import");
    const text = readable(imported.html);

    expect(imported.status).toBe(200);
    expect(text).toContain("1 got no verdict");
    expect(text).toContain("Canvas tote bag");
    expect(text).toContain("the gateway could not be reached");
    // Not under the door's rules: neither their heading nor their count.
    expect(text).not.toContain("Refused");
    expect(text).not.toContain("publishing rules");
  });

  it("stops after the first unknown publish and names the products it did not attempt", async () => {
    const running = await started({
      catalogue: async () => ({
        ok: true,
        products: [aProduct(), aProduct({ id: 10, name: "Access code" })],
      }),
      gatewayAt: await nowhere(),
    });
    await connected(running);

    const imported = await running.post("/woocommerce/import");
    const text = readable(imported.html);

    expect(text).toContain("1 got no verdict");
    expect(text).toContain("1 not attempted");
    expect(text).toContain("Canvas tote bag");
    expect(text).toContain("Access code");
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

    expect(imported.html).toContain("Left in the shop");
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
});

describe("what the integrations screen says about a shop", () => {
  // 24.09 (П2): the block moved from the settings to the Integrations tab.
  // The promise, and it is the whole reason this block reads rows at all: the
  // settings screen is where a merchant lands after their shop sends them back,
  // and it has to be able to tell them apart the four things that can have
  // happened. Three of them are not "connected", and a merchant told "connect a
  // WooCommerce shop" in any of the other three is being told their Connect
  // failed when two of those are not a failure and one has a different cure.
  const approve = async (running: Running, permissions = "read_write"): Promise<void> => {
    const pressed = await running.post("/woocommerce/connect", { shop_url: SHOP });
    await running.postJson("/woocommerce/callback", {
      user_id: tokenIn(pressed.to ?? ""),
      consumer_key: "ck_a-key-nobody-may-read",
      consumer_secret: "cs_a-secret-nobody-may-read",
      key_permissions: permissions,
    });
  };

  /** A Connect that was pressed this long ago and never answered. */
  const startedMinutesAgo = async (running: Running, minutes: number): Promise<void> => {
    const began = Date.now() - minutes * 60_000;
    await running.shops.beginGrant({
      token: `token-from-${minutes}-minutes-ago`,
      accountId: running.accountId,
      shopUrl: SHOP,
      startedAt: new Date(began),
      expiresAt: new Date(began + 15 * 60_000),
    });
  };

  const settings = async (running: Running): Promise<string> =>
    readable((await running.get("/integrations")).html);

  it("offers to connect one where nothing was ever started", async () => {
    const running = await started();
    await running.signIn();

    const screen = await running.get("/integrations");

    expect(screen.status).toBe(200);
    expect(readable(screen.html)).toContain("Connect a WooCommerce shop");
    expect(readable(screen.html)).toMatch(/experimental/i);
    expect(readable(screen.html)).not.toMatch(/acceptance path/i);
    // What a supported product is, is written on the shop screen this block
    // links to, and nowhere else. It used to be here as well and in the import
    // form beside it: three copies of one rule, two of them free to go stale
    // against a connector whose rule is the only reason a card is refused.
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
    // The state the whole finding was about. The merchant approved in their own
    // shop and their shop's keys have not arrived; the honest answer inside the
    // fifteen minutes is "wait", and a page that said "connect a shop" here
    // sends them round the loop for nothing.
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
    // The other half of the same state, and a different sentence because it
    // is a different move: the request is not coming on this Connect, and the
    // one move that fits every way it can have gone is another Connect.
    //
    // What the page may not do is name a cause. Nothing here records whether
    // the merchant approved, declined or closed their shop's screen, and a
    // post that never got through leaves the same nothing as a post never
    // made. "Your shop could not reach us", which this page once said, was one
    // of three guesses presented as the fact, and it sent a merchant who had
    // declined off to repair a firewall that was fine.
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
    // And not the sentence for a Connect still running, which would have the
    // merchant sitting and reloading a page that will never change.
    expect(text).not.toContain("Reload this page in a moment");
  });

  it("keeps the previous shop address in the retry form", async () => {
    const running = await started();
    await running.signIn();
    await startedMinutesAgo(running, 40);

    const screen = await running.get("/woocommerce");

    expect(screen.html).toContain(`value="${SHOP}"`);
  });

  it("offers the experimental shop path from an empty catalogue", async () => {
    const running = await started();
    await running.signIn();

    const screen = await running.get("/cards");

    expect(screen.html).toContain(`href="/woocommerce"`);
  });

  it("says a connected shop granted less than it needs to sell anything", async () => {
    // A channel that cannot create an order is broken, and a settings line
    // reading only "connected" over it is this page being reassuring about
    // something that refuses every sale at delivery.
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
    // The screen is handed the fields it may know rather than the row, and this
    // is the promise that shape exists to keep (ADR-0023).
    const running = await started();
    await running.signIn();
    await approve(running);

    const screen = await running.get("/integrations");

    expect(screen.html).not.toContain("ck_a-key-nobody-may-read");
    expect(screen.html).not.toContain("cs_a-secret-nobody-may-read");
  });

  it("says the WooCommerce state could not be read, rather than nothing, when the shops table is unreachable", async () => {
    // A settings screen is where a merchant fixes the address their money
    // arrives at. Our own shops table being down must not stand between them
    // and that box, so the page stays. The block stays too, saying what
    // happened, because a block that simply vanishes reads as "no shop is
    // connected" to a merchant who connected one yesterday — and that is a
    // different sentence with a different next move from "we could not read
    // it". The two must be told apart on the page, not in our logs.
    const running = await started({
      breakTheShopsRead: () => {
        throw new Error("the shops table is not answering");
      },
    });
    await running.signIn();

    // 24.09 (П2): the wallet box stayed on the settings, the shop block moved
    // to the Integrations tab; each page is checked for its own half.
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
   * The shape of the real return, and the reason this describe exists.
   *
   * The cabinet's session cookie is `SameSite=Strict` (ADR-0009), so the
   * navigation a merchant's own shop starts arrives here carrying nothing —
   * whether or not they are signed in on that browser. Behind the gate, that
   * lands the merchant on a sign-in at the end of a flow that worked, and what
   * they read is "it broke".
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
    expect(readable(seen.html)).toContain("Continue to your cabinet");
  });

  it("still takes the state token out of the address bar", async () => {
    // The property the redirect was written for, and the one this change could
    // silently have dropped: with the cookie held back by SameSite, the visit
    // with no session is now the only visit a real merchant makes, so an
    // unspent token left in the address would be left there every time.
    const running = await started();
    await running.signIn();
    const pressed = await running.post("/woocommerce/connect", { shop_url: SHOP });
    const token = tokenIn(pressed.to ?? "");

    const came = await cameBack(running, `?success=1&user_id=${token}`);

    expect(came.status).toBe(303);
    expect(came.to).toBe("/woocommerce/return");
  });

  it("reads nothing at all, so there is nothing for it to answer differently", async () => {
    // The narrow property this route rests on, and it is stronger than "the two
    // pages happen to match": a handler that touches no row cannot vary by one.
    // The store here fails every read, and the page still comes out — which it
    // could not do if the route consulted anything.
    const running = await started({
      breakTheShopsRead: () => {
        throw new Error("nothing on this route may read a row");
      },
    });
    await running.signIn();

    const stripped = await cameBack(running);
    const seen = await running.getWithoutCookie(stripped.to ?? "/woocommerce/return");

    expect(seen.status).toBe(200);
    expect(readable(seen.html)).toContain("Continue to your cabinet");
  });

  it("says the same thing whether or not a shop is connected", async () => {
    // The other half: not merely that it reads nothing, but that a stranger and
    // an owner are handed the same bytes. Two runs, one with a connection and
    // one without.
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

  it("continues into the cabinet with the session the browser already holds", async () => {
    // The cross-site return omits a Strict cookie, but the next same-site click
    // carries it. Asking for another email in between turned a successful
    // Connect into a loop even though the browser was still signed in.
    const running = await started();
    await running.signIn();
    await running.post("/woocommerce/connect", { shop_url: SHOP });

    const stripped = await cameBack(running);
    const landed = await running.getWithoutCookie(stripped.to ?? "/woocommerce/return");
    expect(readable(landed.html)).toContain("Continue to your cabinet");
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
    expect(readable(seen.html)).toContain(`${SHOP}, connected`);
  });

  it("does not say the shop approved merely because the browser came through the return address", async () => {
    // The return route reads nothing off the redirect on purpose, so the page
    // it lands on has nothing to add for the arrival — and until now it added
    // "your shop says it approved", the redirect's claim presented as read.
    // Here the redirect says the opposite, `success=0`, the shape WooCommerce
    // sends when the merchant declined. What the page may claim about approval
    // and keys is what our rows hold, a Connect started and no keys yet, and
    // the check is that it is the very settings page a plain reload gives.
    const running = await started();
    await running.signIn();
    await running.post("/woocommerce/connect", { shop_url: SHOP });

    const came = await running.get("/woocommerce/return?success=0&user_id=anything");
    const back = await running.get(came.to ?? "");
    const reloaded = await running.get("/woocommerce?from=shop");

    expect(came.to).toBe("/woocommerce?from=shop");
    expect(readable(back.html)).toMatch(/no keys have reached us yet/);
    expect(back.html).toBe(reloaded.html);
  });

  it("offers Connect and adds nothing when the return address is opened by hand", async () => {
    // Nothing was started and no shop sent this browser anywhere: a merchant
    // signed in on it typed the address in. What they land on is settings in
    // its ordinary empty state — a note that a shop approved
    // something, or that the browser came back from one, would be a note about
    // an event that did not happen.
    const running = await started();
    await running.signIn();

    const came = await running.get("/woocommerce/return");
    const back = await running.get(came.to ?? "");
    const reloaded = await running.get("/woocommerce?from=shop");

    expect(came.to).toBe("/woocommerce?from=shop");
    expect(readable(back.html)).toContain("Connect your shop");
    expect(back.html).toBe(reloaded.html);
  });

  it("leaves every other cabinet address behind the sign-in", async () => {
    // The narrowing is one address. A gate that had been opened a crack wider
    // than that is the defect this test exists to catch.
    const running = await started();

    for (const path of [
      "/woocommerce",
      "/woocommerce/import",
      "/cards",
      "/orders",
      "/receipts",
      "/keys",
      "/settings",
      "/integrations",
      "/",
      "/no-such-page",
    ]) {
      const seen = await running.getWithoutCookie(path);
      expect(seen.status, path).toBe(303);
      // 24.09: a screen of the cabinet's own is carried to the sign-in (П11);
      // everything else, the shop's import included, lands on the bare form.
      const screen = path.slice(1);
      expect(seen.to, path).toBe(
        ["woocommerce", "orders", "receipts", "integrations", "keys", "settings"].includes(screen)
          ? `/sign-in?destination=${screen}`
          : "/sign-in",
      );
    }
  });
});
