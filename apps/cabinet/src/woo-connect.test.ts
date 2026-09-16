/**
 * The half of Connect that happens before any key exists: what a shop address
 * has to be, what the authorize URL carries, and the preflight that stops a
 * merchant being sent to their own front page.
 *
 * The preflight is here because of the sharpest edge the probe found. A shop
 * with plain permalinks does not answer `/wc-auth/v1/authorize` with a 404 or
 * an error — it redirects once and serves its ordinary front page with a 200,
 * so a merchant presses Connect, lands on their own shop, and has nothing to
 * report except that it did not work
 * (`docs/research/27-woo-connect-probe.md`). The only way to tell that apart
 * from a working shop is to ask before redirecting anybody.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  authorizeUrlFor,
  isTheGrantScreen,
  theStateToken,
  whatIsWrongWithTheShopUrl,
} from "./woo-connect.js";

/** A stand-in shop, answering one scripted response at every address. */
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
    expect(whatIsWrongWithTheShopUrl("https://shop.example.com/store")).toBeNull();
  });

  it("refuses a shop on plain http, and says what that would cost them", () => {
    const wrong = whatIsWrongWithTheShopUrl("http://shop.example.com");
    expect(wrong).not.toBeNull();
    // The reason is the merchant's own secret in the clear on every order, and
    // it is said rather than left as "https only": a merchant who reads only
    // the rule goes looking for a way round it.
    expect(wrong).toMatch(/https/);
  });

  it("refuses what is not an address at all", () => {
    for (const typed of ["", "   ", "shop.example.com", "ftp://shop.example.com", "https://"]) {
      expect(whatIsWrongWithTheShopUrl(typed)).not.toBeNull();
    }
  });

  it("refuses an address carrying a query or a fragment", () => {
    // Both would be swallowed when the path of an endpoint is appended, so a
    // shop typed this way would be reached at an address nobody meant.
    expect(whatIsWrongWithTheShopUrl("https://shop.example.com/?a=1")).not.toBeNull();
    expect(whatIsWrongWithTheShopUrl("https://shop.example.com/#x")).not.toBeNull();
  });
});

describe("the authorize URL", () => {
  const url = () =>
    new URL(
      authorizeUrlFor("https://shop.example.com/store", {
        appName: "Agentify",
        userId: "a-state-token",
        returnUrl: "https://agentify.example/cabinet/woocommerce/return",
        callbackUrl: "https://agentify.example/cabinet/woocommerce/callback",
      }),
    );

  it("hangs off the shop's own address", () => {
    expect(url().pathname).toBe("/store/wc-auth/v1/authorize");
  });

  it("carries all five parameters WooCommerce requires", () => {
    // Any one of them missing is a 401 from the shop, so this is the list and
    // not a subset of it.
    const query = url().searchParams;
    expect(query.get("app_name")).toBe("Agentify");
    expect(query.get("user_id")).toBe("a-state-token");
    expect(query.get("return_url")).toBe("https://agentify.example/cabinet/woocommerce/return");
    expect(query.get("callback_url")).toBe("https://agentify.example/cabinet/woocommerce/callback");
    expect(query.get("scope")).toBe("read_write");
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
    // A shop with pretty permalinks and nobody signed in sends the browser on
    // to wc-auth's own sign-in page, which is the shape this has to accept.
    shop = await shopAnswering((path) =>
      path.startsWith("/wc-auth/v1/login")
        ? { status: 200, body: '<body class="wc-auth wp-core-ui"><form>Sign in</form></body>' }
        : { status: 302, location: "/wc-auth/v1/login/?x=1" },
    );
    const looked = await isTheGrantScreen(`${shop.url}/wc-auth/v1/authorize?x=1`);
    expect(looked.ok).toBe(true);
  });

  it("refuses a shop that served its front page instead", async () => {
    // Plain permalinks: one redirect, then the shop's own home page with a
    // 200. Nothing about it says it went wrong.
    // The path and not the whole address: written against the address, the
    // query string kept it from ever ending in a slash, and this shop
    // redirected forever instead of serving the front page once. The probe
    // that mutates the check found that — the refusal was coming from the
    // redirect ceiling rather than from reading what the shop served.
    shop = await shopAnswering((url) =>
      new URL(url, "http://shop").pathname.endsWith("/")
        ? { status: 200, body: "<html><title>My lovely shop</title><body>Welcome</body></html>" }
        : { status: 301, location: `${url.split("?")[0]}/?x=1` },
    );
    const looked = await isTheGrantScreen(`${shop.url}/wc-auth/v1/authorize?x=1`);
    expect(looked.ok).toBe(false);
    // The merchant can only act on this if it names the setting, in the words
    // WordPress uses for it.
    expect(looked.ok === false && looked.why).toMatch(/permalink/i);
  });

  it("refuses a front page that happens to quote the address we asked for", async () => {
    // A WordPress theme echoing the request URI — a canonical link, a search
    // heading, an admin-bar edit link — puts the words "wc-auth" on the shop's
    // own front page. Checked for the bare word, such a shop passes and its
    // merchant is sent to their own front page: the trap, with the guard
    // against it satisfied by the trap itself.
    shop = await shopAnswering((url) => ({
      status: 200,
      body: `<html><head><link rel="canonical" href="https://shop.example.com${url}"></head><body><h1>Nothing found for ${url}</h1></body></html>`,
    }));
    const looked = await isTheGrantScreen(`${shop.url}/wc-auth/v1/authorize?x=1`);
    expect(looked.ok).toBe(false);
  });

  it("carries back what wc-auth said when it refused the request itself", async () => {
    // A missing parameter is our defect and not the merchant's shop, so the
    // shop's own sentence is what comes back rather than a lecture about
    // permalinks.
    shop = await shopAnswering(() => ({
      status: 401,
      body: "<p>Error: Missing parameter callback_url.</p>",
    }));
    const looked = await isTheGrantScreen(`${shop.url}/wc-auth/v1/authorize?x=1`);
    expect(looked.ok).toBe(false);
    expect(looked.ok === false && looked.why).toContain("Missing parameter callback_url");
  });

  it("refuses a shop that is not there at all, without throwing", async () => {
    const looked = await isTheGrantScreen("https://127.0.0.1:1/wc-auth/v1/authorize");
    expect(looked.ok).toBe(false);
  });

  it("does not follow a redirect off the shop", async () => {
    // A shop that sends us somewhere else entirely is not a shop whose grant
    // screen we reached, however friendly the page at the other end is.
    shop = await shopAnswering(() => ({
      status: 302,
      location: "https://example.invalid/wc-auth/v1/login/",
    }));
    const looked = await isTheGrantScreen(`${shop.url}/wc-auth/v1/authorize?x=1`);
    expect(looked.ok).toBe(false);
  });
});
