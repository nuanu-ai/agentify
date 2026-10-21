/**
 * A shop with plain permalinks answers `/wc-auth/v1/authorize` with one
 * redirect and its ordinary front page with a 200, so the only way to tell it
 * from a working shop is to ask before redirecting anybody.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  currencyOfTheShop,
  isTheGrantScreen as inspectGrantScreen,
  theStateToken,
  whatIsWrongWithTheShopUrl,
} from "./woo-connect.js";

const isTheGrantScreen = (url: string) => inspectGrantScreen(url, fetch);

const shopAnswering = async (
  answer: (path: string) => {
    status: number;
    body?: string;
    location?: string;
    type?: string;
  },
): Promise<{ url: string; close: () => Promise<void> }> => {
  const server: Server = createServer((request, response) => {
    const said = answer(request.url ?? "/");
    response.writeHead(said.status, {
      "content-type": said.type ?? "text/html; charset=UTF-8",
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
  it("takes an https shop", () => {
    expect(whatIsWrongWithTheShopUrl("https://shop.example.com")).toBeNull();
    expect(whatIsWrongWithTheShopUrl("https://shop.example.com/")).toBeNull();
    expect(whatIsWrongWithTheShopUrl("https://shop.example.com/store")).toMatch(/root/i);
  });

  it("refuses a shop on plain http, and says what that would cost them", () => {
    const wrong = whatIsWrongWithTheShopUrl("http://shop.example.com");
    expect(wrong).not.toBeNull();
    // The reason is said, not only the rule: a merchant who reads only "https
    // only" goes looking for a way round it.
    expect(wrong).toMatch(/https/);
  });

  it("refuses what is not an address at all", () => {
    for (const typed of ["", "   ", "shop.example.com", "ftp://shop.example.com", "https://"]) {
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
  it("is long enough that nobody guesses one", () => {
    expect(theStateToken().length).toBeGreaterThanOrEqual(32);
  });

  it("is a different one every time", () => {
    const minted = new Set(Array.from({ length: 200 }, () => theStateToken()));
    expect(minted.size).toBe(200);
  });

  it("survives a URL without being encoded into something else", () => {
    for (let i = 0; i < 200; i += 1) {
      const token = theStateToken();
      expect(encodeURIComponent(token)).toBe(token);
    }
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
    // A shop that sends us elsewhere is not a shop whose grant screen we
    // reached.
    shop = await shopAnswering(() => ({
      status: 302,
      location: "https://example.invalid/wc-auth/v1/login/",
    }));
    const looked = await isTheGrantScreen(`${shop.url}/wc-auth/v1/authorize?x=1`);
    expect(looked.ok).toBe(false);
  });
});

describe("the currency a shop prices in, asked before Connect", () => {
  // Only a clear answer counts: null is "not known", and Connect then goes on
  // as before, so every case here that is not a product priced in a currency
  // must come back null rather than as a guess.
  const pricedIn = (url: string) => currencyOfTheShop(url, fetch);
  const storeProduct = (currency: unknown) => ({
    id: 7,
    name: "Batik scarf",
    prices: { price: "15000000", currency_code: currency, currency_minor_unit: 2 },
  });

  it("reads the currency of the shop's public catalogue", async () => {
    for (const currency of ["IDR", "USD"]) {
      shop = await shopAnswering(() => ({
        status: 200,
        type: "application/json",
        body: JSON.stringify([storeProduct(currency)]),
      }));
      expect(await pricedIn(shop.url)).toBe(currency);
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
    expect(await currencyOfTheShop("https://shop.example.com", failing)).toBeNull();
  });
});
