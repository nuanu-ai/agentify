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
} from "@coinslot/gateway/testing";
import type { Express } from "express";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { type Identity, identityFor } from "./identity.js";
import { buildApp } from "./server.js";
import { readable } from "./testing/html.js";
import type { StoreProduct } from "./woo-catalog.js";
import type { Preflight } from "./woo-connect.js";
import type { CatalogueRead } from "./woo-shop.js";
import { memoryWooShops, type WooShops } from "./woo-shops.js";

const KEY = theMerchantKey("test");
const PERSON = "dmitry@example.com";
const PASSWORD = "a-password-nobody-guesses";
const SHOP = "https://shop.example.com";
const PUBLIC = "https://cabinet.example.com";

const aProduct = (overrides: Partial<StoreProduct> = {}): StoreProduct => ({
  id: 11,
  name: "Canvas tote bag",
  sku: "coinslot-tote",
  type: "simple",
  description: "<p>A physical item that has to be shipped somewhere.</p>",
  short_description: "",
  is_purchasable: true,
  is_in_stock: true,
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
  readonly url: string;
  /** Every authorize address the preflight was asked about. */
  readonly asked: string[];
  get(path: string): Promise<Visit>;
  post(path: string, form?: Record<string, string>): Promise<Visit>;
  /**
   * A JSON post carrying no cookie, which is what a WooCommerce shop sends.
   *
   * The absence is the point: the callback comes from the merchant's own web
   * server, with no session of ours on it, and the route being above the
   * sign-in gate is what makes it reachable at all.
   */
  postJson(path: string, body: unknown): Promise<Visit>;
  signIn(): Promise<void>;
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
}

const started = async (standing: Standing = {}): Promise<Running> => {
  const harnessed = await harness();
  const gateway = await serve(harnessed);
  const config = loadConfig({
    GATEWAY_URL: gateway.url,
    DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
    AUTH_SECRET: "a-secret-that-is-at-least-32-characters-long",
    PAYMENT_NETWORK: "eip155:84532",
    FACILITATOR_URL: "sandbox:scripted",
    PUBLIC_BASE_URL: PUBLIC,
  });
  const identity = identityFor(config, {
    rows: {
      cabinet_accounts: [],
      cabinet_sessions: [],
      cabinet_credentials: [],
      cabinet_verifications: [],
    },
  });
  await identity.make(PERSON, PASSWORD, { id: harnessed.merchant.id, key: KEY });

  const shops = memoryWooShops();
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
    url,
    asked,
    get: (path) => visit("GET", path),
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
    async signIn() {
      await visit("POST", "/sign-in", {
        body: new URLSearchParams({ email: PERSON, password: PASSWORD }).toString(),
      });
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

describe("the shop screens are behind the sign-in", () => {
  it("sends a stranger to the sign-in", async () => {
    const running = await started();
    const seen = await running.get("/woocommerce");
    expect(seen.status).toBe(303);
    expect(seen.to).toBe("/sign-in");
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
    expect(to.searchParams.get("app_name")).toBe("Coinslot");
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

describe("the page the shop sends the browser back to", () => {
  it("takes the state token out of the address bar", async () => {
    // WooCommerce hands user_id back on this redirect, and in the case this
    // page exists for — the keys never arrived — that token is unspent and good
    // for the rest of its fifteen minutes. Left in the address it is in the
    // browser's history and in the log of everything between the merchant and
    // us.
    const running = await started();
    await running.signIn();
    const pressed = await running.post("/woocommerce/connect", { shop_url: SHOP });
    const token = tokenIn(pressed.to ?? "");

    const came = await running.get(`/woocommerce/return?success=1&user_id=${token}`);

    expect(came.status).toBe(303);
    expect(came.to).not.toContain(token);
  });

  it("says the keys have not arrived where they have not", async () => {
    // `success=1` is the shop telling the browser what it did. The keys travel
    // separately, and a page that read the redirect would be announcing
    // something it has never seen.
    const running = await started();
    await running.signIn();
    await running.post("/woocommerce/connect", { shop_url: SHOP });

    const came = await running.get("/woocommerce/return?success=1&user_id=whatever");
    const seen = await running.get(came.to ?? "");

    expect(seen.status).toBe(200);
    expect(seen.html).toContain("no keys have reached us yet");
  });

  it("says the shop is connected where the keys did arrive", async () => {
    const running = await started();
    await running.signIn();
    const pressed = await running.post("/woocommerce/connect", { shop_url: SHOP });
    const token = tokenIn(pressed.to ?? "");
    await running.postJson("/woocommerce/callback", {
      user_id: token,
      consumer_key: "ck_a",
      consumer_secret: "cs_b",
      key_permissions: "read_write",
    });

    const came = await running.get("/woocommerce/return?success=1");
    const seen = await running.get(came.to ?? "");

    // The sentence the connected page draws, with the shop in it — and not the
    // address on its own, which the disconnected form carries as the
    // placeholder in its box and would answer this assertion either way.
    expect(seen.html).toContain(`${SHOP}, connected`);
    expect(seen.html).toContain("Your shop is connected");
  });

  it("carries no key of the shop's onto the page", async () => {
    // The screen is handed three fields rather than the row, and this is the
    // promise that shape exists to keep.
    const running = await started();
    await running.signIn();
    const pressed = await running.post("/woocommerce/connect", { shop_url: SHOP });
    await running.postJson("/woocommerce/callback", {
      user_id: tokenIn(pressed.to ?? ""),
      consumer_key: "ck_a-key-nobody-may-read",
      consumer_secret: "cs_a-secret-nobody-may-read",
      key_permissions: "read_write",
    });

    const seen = await running.get("/woocommerce");

    expect(seen.html).not.toContain("ck_a-key-nobody-may-read");
    expect(seen.html).not.toContain("cs_a-secret-nobody-may-read");
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

  it("publishes what it found, through the door every card goes through", async () => {
    const running = await started({
      catalogue: async () => ({ ok: true, products: [aProduct()] }),
    });
    await connected(running);

    const imported = await running.post("/woocommerce/import");

    expect(imported.status).toBe(200);
    expect(imported.html).toContain("Canvas tote bag");
    // And the card is really in the merchant's catalogue, priced at the scale
    // the shop sent rather than at a hundred times it.
    const cards = await running.gateway.call("GET", "/v0/cards", {
      headers: { authorization: `Bearer ${KEY}` },
    });
    const listed = (cards.body as { cards: { card: { price: { amount: string } } }[] }).cards;
    expect(listed).toHaveLength(1);
    expect(listed[0]?.card.price.amount).toBe("25.00");
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

    expect(imported.html).toContain("Not published");
    // Both halves of the door's sentence reach the merchant: the ceiling, and
    // the length of the text they wrote in their own shop. The second is what
    // tells them how much to cut, and it is the half a summary would lose.
    expect(readable(imported.html)).toContain("at most 500");
    expect(readable(imported.html)).toContain("900 characters");
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
