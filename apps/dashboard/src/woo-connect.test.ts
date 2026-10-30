/**
 * A shop with plain permalinks answers `/wc-auth/v1/authorize` with one
 * redirect and its ordinary front page with a 200, so the only way to tell it
 * from a working shop is to ask before redirecting anybody.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXAMPLE_PAGE,
  isTheGrantScreen as inspectGrantScreen,
  pricedExampleOfTheShop,
  publicShopOf,
  theStateToken,
  whatIsWrongWithTheShopUrl,
} from "./woo-connect.js";

const isTheGrantScreen = (url: string) => inspectGrantScreen(url, fetch);

const shopAnswering = async (
  answer: (
    path: string,
    method: string,
  ) => {
    status: number;
    body?: string;
    location?: string;
    type?: string;
    headers?: Record<string, string>;
  },
): Promise<{ url: string; close: () => Promise<void> }> => {
  const server: Server = createServer((request, response) => {
    const said = answer(request.url ?? "/", request.method ?? "");
    response.writeHead(said.status, {
      "content-type": said.type ?? "text/html; charset=UTF-8",
      ...said.headers,
      ...(said.location === undefined ? {} : { location: said.location }),
    });
    response.end(said.body ?? "");
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
};

let shop: { url: string; close: () => Promise<void> } | null = null;

afterEach(async () => {
  await shop?.close();
  shop = null;
});

describe("the address a merchant types", () => {
  it("accepts ordinary shop addresses without guessing a path or removing www", () => {
    for (const typed of ["shop.example.com", "www.shop.example.com/", "http://shop.example.com/"]) {
      expect(whatIsWrongWithTheShopUrl(typed), typed).toBeNull();
    }
  });

  it("takes an https shop", () => {
    expect(whatIsWrongWithTheShopUrl("https://shop.example.com")).toBeNull();
    expect(whatIsWrongWithTheShopUrl("https://shop.example.com/")).toBeNull();
  });

  it("suggests the site's root for an address copied from one of its own shop or admin pages", () => {
    for (const typed of [
      "https://example.com/shop/",
      "https://example.com/product/silk-scarf/",
      "https://example.com/my-account",
      "https://example.com/index.php",
      "example.com/checkout",
    ]) {
      expect(whatIsWrongWithTheShopUrl(typed), typed).toMatch(/: https:\/\/example\.com$/);
    }
  });

  it("suggests no root for any other path, which may be a WordPress of its own", () => {
    for (const [typed, folder] of [
      ["https://example.com/store", "/store"],
      ["https://example.com/store/", "/store"],
      ["example.com/store", "/store"],
      ["http://example.com/store/wp-admin/", "/store"],
    ] as const) {
      const wrong = whatIsWrongWithTheShopUrl(typed);
      expect(wrong, typed).toContain(`installed in ${folder}`);
      expect(wrong, typed).not.toMatch(/https:\/\/example\.com\b(?!\/)/);
    }
  });

  it("names, in a refusal, the address the merchant most likely meant", () => {
    for (const typed of [
      "shop.example.com/wp-admin/admin.php?page=wc-settings",
      "https://shop.example.com/wp-admin/",
      "https://owner:secret@shop.example.com",
    ]) {
      const wrong = whatIsWrongWithTheShopUrl(typed);
      expect(wrong, typed).toMatch(/: https:\/\/shop\.example\.com$/);
      expect(wrong, typed).not.toContain("secret");
    }
  });

  it("offers no corrected address where what was typed names no host", () => {
    for (const typed of ["", "shop", "https://"]) {
      expect(whatIsWrongWithTheShopUrl(typed), typed).toContain("https://shop.example.com.");
    }
  });

  it("refuses what is not an address at all", () => {
    for (const typed of ["", "   ", "ftp://shop.example.com", "https://"]) {
      expect(whatIsWrongWithTheShopUrl(typed)).not.toBeNull();
    }
  });

  it("refuses an address carrying a query or a fragment", () => {
    // Both would be swallowed when an endpoint's path is appended, reaching an
    // address nobody meant.
    expect(whatIsWrongWithTheShopUrl("https://shop.example.com/?a=1")).not.toBeNull();
    expect(whatIsWrongWithTheShopUrl("https://shop.example.com/#x")).not.toBeNull();
  });
});

describe("the state token", () => {
  it("is a different one every time", () => {
    const tokens = Array.from({ length: 200 }, () => theStateToken());
    for (const token of tokens) {
      expect(token.length).toBeGreaterThanOrEqual(32);
      expect(encodeURIComponent(token)).toBe(token);
    }
    const minted = new Set(tokens);
    expect(minted.size).toBe(200);
  });
});

describe("the preflight", () => {
  it("passes a shop whose wc-auth answers", async () => {
    // Pretty permalinks with nobody signed in send the browser to wc-auth's
    // sign-in page, which must be accepted.
    shop = await shopAnswering((path) =>
      path.startsWith("/wc-auth/v1/login")
        ? { status: 200, body: '<body class="wc-auth wp-core-ui"><form>Sign in</form></body>' }
        : { status: 302, location: "/wc-auth/v1/login/?x=1" },
    );
    const looked = await isTheGrantScreen(`${shop.url}/wc-auth/v1/authorize?x=1`);
    expect(looked.ok).toBe(true);
  });

  it("refuses a shop that served its front page instead", async () => {
    // Plain permalinks: one redirect, then the shop's home page with a 200.
    // Matched on the path rather than the whole address, or the query string
    // would keep it from ending in a slash and the stand-in would redirect
    // forever, failing on the redirect limit instead of on what the shop
    // served.
    shop = await shopAnswering((url) =>
      new URL(url, "http://shop").pathname.endsWith("/")
        ? {
            status: 200,
            body: '<html><title>My lovely shop</title><link rel="stylesheet" href="/wp-content/themes/storefront/style.css"><body>Welcome</body></html>',
          }
        : { status: 301, location: `${url.split("?")[0]}/?x=1` },
    );
    const looked = await isTheGrantScreen(`${shop.url}/wc-auth/v1/authorize?x=1`);
    expect(looked.ok).toBe(false);
    // The merchant can act on this only if it names the setting in WordPress's
    // words.
    expect(looked.ok === false && looked.why).toMatch(/permalink/i);
  });

  it("asks first whether the address is the shop where nothing on the page looks like WordPress", async () => {
    // Another site and a WordPress server's own 404 under plain permalinks look
    // the same, so the owner is asked to check the address first.
    for (const answer of [
      { status: 200, body: "<html><title>A landing page</title><body>Hello</body></html>" },
      { status: 404, body: "<html><body>Not found</body></html>" },
    ]) {
      shop = await shopAnswering(() => answer);
      const looked = await isTheGrantScreen(`${shop.url}/wc-auth/v1/authorize?x=1`);
      await shop.close();
      shop = null;

      expect(looked.ok).toBe(false);
      expect(looked.ok === false && looked.why).toMatch(/Check that this is the address/);
      expect(looked.ok === false && looked.why).toMatch(/permalink/i);
    }
  });

  it("goes straight to the permalink setting where the page is plainly WordPress", async () => {
    // A theme's files or WordPress's own: the shop answering with one of its
    // pages.
    for (const asset of [
      "/wp-content/themes/storefront/style.css",
      "/wp-includes/js/jquery/jquery.min.js",
    ]) {
      shop = await shopAnswering(() => ({
        status: 200,
        body: `<html><head><script src="${asset}"></script></head><body>Welcome</body></html>`,
      }));
      const looked = await isTheGrantScreen(`${shop.url}/wc-auth/v1/authorize?x=1`);
      await shop.close();
      shop = null;

      expect(looked.ok === false && looked.why, asset).toMatch(/permalink/i);
      expect(looked.ok === false && looked.why, asset).not.toMatch(
        /Check that this is the address/,
      );
    }
  });

  it("refuses a front page that happens to quote the address we asked for", async () => {
    // A theme echoing the request URI puts "wc-auth" on the shop's front page;
    // checked for the bare word, the shop passes and the merchant is sent to
    // their own front page.
    shop = await shopAnswering((url) => ({
      status: 200,
      body: `<html><head><link rel="canonical" href="https://shop.example.com${url}"></head><body><h1>Nothing found for ${url}</h1></body></html>`,
    }));
    const looked = await isTheGrantScreen(`${shop.url}/wc-auth/v1/authorize?x=1`);
    expect(looked.ok).toBe(false);
  });

  it("carries back what wc-auth said when it refused the request itself", async () => {
    // A missing parameter is our defect, so the shop's own sentence comes back.
    shop = await shopAnswering(() => ({
      status: 401,
      body: "<p>Error: Missing parameter callback_url.</p>",
    }));
    const looked = await isTheGrantScreen(`${shop.url}/wc-auth/v1/authorize?x=1`);
    expect(looked.ok).toBe(false);
    expect(looked.ok === false && looked.why).toContain("Missing parameter callback_url");
  });

  it("refuses a shop that is not there at all, without throwing", async () => {
    const looked = await inspectGrantScreen("https://127.0.0.1:1/wc-auth/v1/authorize");
    expect(looked.ok).toBe(false);
  });

  it("does not follow a redirect off the shop", async () => {
    let elsewhereAsked = 0;
    const elsewhere = await shopAnswering(() => {
      elsewhereAsked += 1;
      return { status: 200, body: '<body class="wc-auth"><form>Sign in</form></body>' };
    });
    try {
      shop = await shopAnswering(() => ({
        status: 302,
        location: `${elsewhere.url}/wc-auth/v1/login/`,
      }));
      const looked = await isTheGrantScreen(`${shop.url}/wc-auth/v1/authorize?x=1`);
      expect(looked.ok).toBe(false);
      expect(looked.ok === false && looked.why).toContain(elsewhere.url);
      expect(looked.ok === false && looked.why).toMatch(/instead of answering/i);
      expect(elsewhereAsked).toBe(0);
    } finally {
      await elsewhere.close();
    }
  });
});

describe("the currency a shop prices in, asked before Connect", () => {
  // Only a clear answer counts: null is "not known", and Connect then goes on
  // as before, so every case here that is not a product priced in a currency
  // must come back null rather than as a guess.
  const pricedIn = async (url: string) => {
    const read = await publicShopOf(url, fetch);
    return read.kind === "read" ? (read.sample?.currency ?? null) : null;
  };
  const storeProduct = (currency: unknown, minorUnit = 2) => ({
    id: 7,
    name: "Batik scarf",
    type: "simple",
    is_purchasable: true,
    is_in_stock: true,
    is_on_backorder: false,
    stock_availability: { text: "" },
    low_stock_remaining: null,
    prices: { price: "15000000", currency_code: currency, currency_minor_unit: minorUnit },
  });

  it("reads the currency of the shop's public catalogue", async () => {
    // Routed as a WooCommerce shop routes it: the keyless Store API answers,
    // and an address it does not serve is a 404.
    for (const [currency, minorUnit] of [
      ["IDR", 2],
      ["IDR", 0],
      ["USD", 2],
      ["USD", 0],
    ] as const) {
      shop = await shopAnswering((path) =>
        new URL(path, "http://shop").pathname === "/wp-json/wc/store/v1/products"
          ? {
              status: 200,
              type: "application/json",
              body: JSON.stringify([storeProduct(currency, minorUnit)]),
            }
          : { status: 404, type: "application/json", body: '{"code":"rest_no_route"}' },
      );
      expect(await publicShopOf(shop.url, fetch), `${currency} ${minorUnit}`).toMatchObject({
        kind: "read",
        sample: { currency, decimals: minorUnit },
      });
      await shop.close();
      shop = null;
    }
  });

  it("does not know the currency of a shop that did not clearly say", async () => {
    const unclear = [
      { status: 200, type: "application/json", body: "[]" },
      { status: 404, type: "application/json", body: '{"code":"rest_no_route"}' },
      { status: 401, type: "application/json", body: '{"code":"rest_forbidden"}' },
      { status: 200, body: "<html><body>Welcome to my shop</body></html>" },
      { status: 200, type: "application/json", body: '{"products":[]}' },
      { status: 200, type: "application/json", body: JSON.stringify([{ id: 7 }]) },
      { status: 200, type: "application/json", body: JSON.stringify([storeProduct("")]) },
      { status: 200, type: "application/json", body: JSON.stringify([storeProduct("Rp")]) },
      { status: 200, type: "application/json", body: JSON.stringify([storeProduct(360)]) },
      { status: 503, type: "application/json", body: JSON.stringify([storeProduct("IDR")]) },
    ];
    for (const answer of unclear) {
      shop = await shopAnswering(() => answer);
      expect(await pricedIn(shop.url), answer.body).toBeNull();
      await shop.close();
      shop = null;
    }
  });

  it("does not follow a redirect off the shop, and does not know the currency", async () => {
    let elsewhereAsked = 0;
    const elsewhere = await shopAnswering(() => {
      elsewhereAsked += 1;
      return {
        status: 200,
        type: "application/json",
        body: JSON.stringify([storeProduct("IDR")]),
      };
    });
    shop = await shopAnswering((path) => ({ status: 302, location: `${elsewhere.url}${path}` }));

    const read = await pricedIn(shop.url);
    await elsewhere.close();

    expect(read).toBeNull();
    expect(elsewhereAsked).toBe(0);
  });

  it("does not know the currency of a shop that never answered, without throwing", async () => {
    const failing = async (): Promise<Response> => {
      throw new Error("the operation was aborted due to timeout");
    };
    expect(await publicShopOf("https://shop.example.com", failing)).toEqual({ kind: "unread" });
  });
});

describe("the anonymous catalogue estimate", () => {
  const product = (changed: Record<string, unknown> = {}) => ({
    type: "simple",
    is_purchasable: true,
    is_in_stock: true,
    is_on_backorder: false,
    stock_availability: { text: "" },
    low_stock_remaining: null,
    prices: { price: "2500", currency_code: "USD", currency_minor_unit: 2 },
    ...changed,
  });
  const read = async (products: unknown, total?: string) => {
    shop = await shopAnswering(() => ({
      status: 200,
      type: "application/json",
      body: JSON.stringify(products),
      ...(total === undefined ? {} : { headers: { "x-wp-total": total } }),
    }));
    return await publicShopOf(shop.url, fetch);
  };

  it("reads only the first hundred products and keeps the shop's larger total separate", async () => {
    const asked: string[] = [];
    shop = await shopAnswering((path) => {
      asked.push(path);
      return {
        status: 200,
        type: "application/json",
        body: JSON.stringify(Array.from({ length: 100 }, () => product())),
        headers: { "x-wp-total": "1240" },
      };
    });
    expect(await publicShopOf(shop.url, fetch)).toMatchObject({
      kind: "read",
      estimate: { read: 100, total: 1240, ready: 100 },
    });
    expect(asked).toEqual(["/wp-json/wc/store/v1/products?per_page=100"]);
  });

  it.each([undefined, "bad", "-1", "0", "9007199254740992"])(
    "does not invent a total from an absent or invalid count: %s",
    async (total) => {
      expect(await read([product()], total)).toMatchObject({
        kind: "read",
        estimate: { read: 1, total: null, ready: 1 },
      });
    },
  );

  it("distinguishes a known empty catalogue from an unread one", async () => {
    expect(await read([], "0")).toEqual({
      kind: "read",
      sample: null,
      estimate: { read: 0, total: 0, ready: 0, options: 0, stock: 0, unavailable: 0 },
    });
  });

  it("uses disjoint stock, options and unavailable counts, never the private-field defaults", async () => {
    expect(
      await read(
        [
          product(),
          product({ type: "variable" }),
          product({ type: "variable", is_in_stock: false }),
          product({ type: "grouped" }),
          product({ type: "external" }),
          product({ is_purchasable: false }),
          product({ stock_availability: { text: "Only 2 left in stock" } }),
          product({ low_stock_remaining: 0 }),
          product({
            stock_availability: { text: "Available on backorder" },
            is_on_backorder: true,
          }),
        ],
        "9",
      ),
    ).toMatchObject({
      kind: "read",
      estimate: { read: 9, ready: 2, options: 1, stock: 2, unavailable: 4 },
    });
  });

  it.each([
    "type",
    "is_purchasable",
    "is_in_stock",
    "is_on_backorder",
    "stock_availability",
    "low_stock_remaining",
    "prices",
  ])("keeps missing %s unknown rather than counting a product as ready", async (field) => {
    const one: Record<string, unknown> = product();
    delete one[field];
    expect(await read([one], "1")).toMatchObject({ kind: "unread" });
  });

  it("retains independently known size and prices when readiness fields are unreadable", async () => {
    expect(
      await read(
        [{ prices: { price: "2500", currency_code: "IRT", currency_minor_unit: 2 } }],
        "2001",
      ),
    ).toEqual({ kind: "unread", total: 2001, sample: { currency: "IRT", decimals: 2 } });
  });

  it("does not claim a single currency where the public prices disagree", async () => {
    expect(
      await read(
        [
          product(),
          product({ prices: { price: "240000", currency_code: "IDR", currency_minor_unit: 0 } }),
        ],
        "2",
      ),
    ).toMatchObject({ kind: "read", sample: null });
  });

  it.each([
    ["<html><script src='/wp-content/theme.js'></script></html>", /permalink.*Check my shop again/],
    ["<html><body>A different site</body></html>", /does not look like WordPress/],
  ])("refuses a successful page response instead of estimating zero: %s", async (body, refusal) => {
    shop = await shopAnswering(() => ({ status: 200, body: String(body) }));
    expect(await publicShopOf(shop.url, fetch)).toMatchObject({
      kind: "refused",
      why: expect.stringMatching(refusal),
    });
  });
});

describe("public list refusal status", () => {
  it.each([200, 404])("recognizes a WordPress own page at status %s", async (status) => {
    shop = await shopAnswering(() => ({
      status,
      body: "<html><script src='/wp-includes/wp.js'></script></html>",
    }));
    expect(await publicShopOf(shop.url, fetch)).toMatchObject({
      kind: "refused",
      why: expect.stringMatching(/permalink/),
    });
  });
  it("keeps a forbidden page unknown even when a firewall includes WordPress assets", async () => {
    shop = await shopAnswering(() => ({
      status: 403,
      body: "<html><script src='/wp-content/theme.js'></script>Forbidden</html>",
    }));
    expect(await publicShopOf(shop.url, fetch)).toEqual({ kind: "unread" });
  });
});

describe("the product the rate guard shows as an example", () => {
  const RUPIAH = { code: "IDR", decimals: 0 } as const;
  const aProduct = (name: string, price: string, currency = "IDR", minorUnit = 0) => ({
    id: 7,
    name,
    prices: { price, currency_code: currency, currency_minor_unit: minorUnit },
  });
  // A made-to-order product with no price, as the Store API lists one.
  const unpriced = (name: string) => aProduct(name, "0");
  const asked: { method: string; path: string }[] = [];
  const answering = async (products: unknown) => {
    asked.length = 0;
    shop = await shopAnswering((path, method) => {
      asked.push({ method, path });
      return { status: 200, type: "application/json", body: JSON.stringify(products) };
    });
    return shop.url;
  };

  it("is the first product with a price in the shop's currency, past unpriced ones listed before it", async () => {
    const url = await answering([
      unpriced("Made-to-Order Teak Wardrobe"),
      unpriced("Made-to-Order Rattan Sofa Set"),
      aProduct("Rayon Sarong", "240000"),
      aProduct("Batik Scarf", "150000"),
    ]);

    expect(await pricedExampleOfTheShop(url, RUPIAH, fetch)).toEqual({
      kind: "priced",
      name: "Rayon Sarong",
      price: "240000",
    });
  });

  it("is read from one small first page of the public catalogue", async () => {
    const url = await answering([aProduct("Rayon Sarong", "240000")]);

    await pricedExampleOfTheShop(url, RUPIAH, fetch);

    expect(asked).toHaveLength(1);
    expect(asked[0]?.method).toBe("GET");
    const read = new URL(asked[0]?.path ?? "", "https://shop");
    expect(read.pathname).toBe("/wp-json/wc/store/v1/products");
    expect(read.searchParams.get("per_page")).toBe(String(EXAMPLE_PAGE));
  });

  it("says the page holds no priced product, rather than that the catalogue did not answer", async () => {
    const pages = [
      [],
      [unpriced("Made-to-Order Teak Wardrobe"), unpriced("Made-to-Order Teak Gazebo")],
      [aProduct("Rayon Sarong", "1450", "EUR", 2)],
      [aProduct("Rayon Sarong", "1800", "JPY", 0)],
      [aProduct("Rayon Sarong", "24000000", "IDR", 2)],
      [aProduct("", "240000")],
    ];
    for (const page of pages) {
      const url = await answering(page);
      expect(await pricedExampleOfTheShop(url, RUPIAH, fetch), JSON.stringify(page)).toEqual({
        kind: "none",
      });
      await shop?.close();
      shop = null;
    }
  });

  it("is not known where the catalogue did not answer, without throwing", async () => {
    const unanswered = [
      {
        status: 503,
        type: "application/json",
        body: JSON.stringify([aProduct("Sarong", "240000")]),
      },
      { status: 404, type: "application/json", body: '{"code":"rest_no_route"}' },
      { status: 200, body: "<html><body>Welcome to my shop</body></html>" },
      { status: 200, type: "application/json", body: '{"products":[]}' },
      { status: 302, location: "https://example.invalid/wp-json/wc/store/v1/products" },
    ];
    for (const answer of unanswered) {
      shop = await shopAnswering(() => answer);
      expect(await pricedExampleOfTheShop(shop.url, RUPIAH, fetch), answer.body).toEqual({
        kind: "unanswered",
      });
      await shop.close();
      shop = null;
    }
    const failing = async (): Promise<Response> => {
      throw new Error("the operation was aborted due to timeout");
    };
    expect(await pricedExampleOfTheShop("https://shop.example.com", RUPIAH, failing)).toEqual({
      kind: "unanswered",
    });
  });
});
