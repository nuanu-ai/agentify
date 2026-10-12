/**
 * WooCommerce's key grant: the merchant's browser goes to
 * `/wc-auth/v1/authorize`, the shop's administrator approves, and the shop
 * posts a fresh `consumer_key`/`consumer_secret` to our callback.
 *
 * All five parameters are always sent; any one missing is a 401 from the shop.
 * The callback is unauthenticated by nature (the shop's server posts it with no
 * session of ours), so the `user_id` that comes back is the only thing deciding
 * whose account the keys land on: it is an unguessable one-time token bound to
 * the merchant who pressed Connect, spent the moment it arrives. A shop with
 * plain permalinks answers the authorize address with its own front page and a
 * 200, so the shop is asked first ({@link isTheGrantScreen}) and the setting is
 * named rather than sending the merchant there.
 */

import { randomBytes } from "node:crypto";
import { type WooRequest, wooRequest } from "./woo-request.js";

/** The name in the key row the merchant reads in their shop. */
export const APP_NAME = "Agentify";

/**
 * Read and write: a paid order becomes an order in the merchant's shop, which
 * is a write. A read-only grant would fail only at the first sale.
 */
export const SCOPE = "read_write";

export const GRANT_MINUTES = 15;

/**
 * https is required although http would work: WooCommerce then wants an OAuth
 * 1.0a signature instead of HTTP Basic, and we would send the merchant's
 * consumer secret in the clear on every order. WooCommerce also refuses to post
 * keys to a callback that is not https.
 */
export const whatIsWrongWithTheShopUrl = (typed: string): string | null => {
  const trimmed = typed.trim();
  if (trimmed === "") {
    return "Enter the address of your WooCommerce shop.";
  }
  if (!URL.canParse(trimmed)) {
    return (
      "That is not an address of the shape https://shop.example.com. It is the address you open" +
      " your own shop at, with the scheme in front of it."
    );
  }
  const address = new URL(trimmed);
  if (address.protocol === "http:") {
    return "Use the public https address of your WooCommerce shop.";
  }
  if (address.protocol !== "https:") {
    return "That address has to start with https://.";
  }
  if (address.hostname === "") {
    return "That address names no shop.";
  }
  if (address.search !== "" || address.hash !== "") {
    return (
      "Leave off anything after the address of the shop itself — no question mark and no hash." +
      " We add the rest of the address ourselves."
    );
  }
  if (address.pathname !== "/" && address.pathname !== "") {
    return "This connector currently supports a WooCommerce shop at the root of its https address.";
  }
  if (address.username !== "" || address.password !== "") {
    return "Leave the user name and password out of the address.";
  }
  return null;
};

/**
 * No trailing slash, so appending a path never produces a double one. Only
 * called on an address {@link whatIsWrongWithTheShopUrl} has passed.
 */
export const shopUrlAs = (typed: string): string => typed.trim().replace(/\/+$/, "");

export interface GrantRequest {
  readonly appName: string;
  /**
   * WooCommerce calls it `user_id` and hands it straight back. It must not be
   * an identifier of anything of ours: an account identifier would be a value a
   * stranger could guess and post keys against.
   */
  readonly userId: string;
  readonly returnUrl: string;
  /** https, on 443, 80 or 8080. */
  readonly callbackUrl: string;
}

export const authorizeUrlFor = (shopUrl: string, request: GrantRequest): string => {
  const query = new URLSearchParams({
    app_name: request.appName,
    scope: SCOPE,
    user_id: request.userId,
    return_url: request.returnUrl,
    callback_url: request.callbackUrl,
  });
  return `${shopUrlAs(shopUrl)}/wc-auth/v1/authorize?${query.toString()}`;
};

/**
 * Base64url, so it survives a query string and a JSON body unencoded:
 * WooCommerce hands it back in both, and a re-encoded value would not match its
 * row.
 */
export const theStateToken = (): string => randomBytes(32).toString("base64url");

export type Preflight = { readonly ok: true } | { readonly ok: false; readonly why: string };

/**
 * A class name, not the bare word: `wc-auth` appears in the address we asked
 * for, so a theme that echoes the request URI anywhere on its front page would
 * match the bare word and send the merchant to that front page, the trap this
 * check exists to close. WooCommerce's own templates carry it as a class.
 */
const SERVED_BY_WC_AUTH = /class="[^"]*wc-auth/i;

const SHOP_ANSWERS_WITHIN_MS = 10_000;

/**
 * WordPress redirects an authorize address at most twice in the shapes seen (a
 * trailing-slash canonical, and wc-auth's hand-over to its sign-in page);
 * beyond that we would be following the shop's own redirect chain.
 */
const REDIRECTS_FOLLOWED = 3;

/**
 * Tests for the presence of wc-auth's own markup, not the absence of something:
 * a shop's front page can carry any status, title or content, but wc-auth's
 * template is known. Nothing here is signed in, so the ordinary success is
 * wc-auth's sign-in page, which carries the same marker. A redirect off the
 * shop's own host ends the check rather than asking a stranger's server about
 * this shop.
 */
export const isTheGrantScreen = async (
  authorizeUrl: string,
  request: WooRequest = wooRequest,
): Promise<Preflight> => {
  const started = new URL(authorizeUrl);
  let at = started;

  for (let followed = 0; followed <= REDIRECTS_FOLLOWED; followed += 1) {
    let answered: Response;
    try {
      answered = await request(at, {
        redirect: "manual",
        headers: { accept: "text/html" },
        signal: AbortSignal.timeout(SHOP_ANSWERS_WITHIN_MS),
      });
    } catch {
      return {
        ok: false,
        why: "Our server could not reach this shop. Check the address and shop status, then try again.",
      };
    }

    const body = await answered.text();

    // wc-auth refused the request itself, which is our defect, so the shop's
    // own words come back rather than a sentence about permalinks.
    const complaint = /Error:[^<\n]*/.exec(body);
    if (answered.status === 401 && complaint !== null) {
      return {
        ok: false,
        why: `Your shop refused the request we make: “${complaint[0].trim()}”`,
      };
    }

    if (answered.status >= 300 && answered.status < 400) {
      const next = answered.headers.get("location");
      if (next === null || !URL.canParse(next, at)) {
        return { ok: false, why: notTheGrantScreen(started, body) };
      }
      const to = new URL(next, at);
      if (to.host !== started.host) {
        return {
          ok: false,
          why:
            `Your shop sent us to ${to.origin} instead of answering, so we never reached the` +
            " screen that grants access. Check that the address above is the shop itself.",
        };
      }
      at = to;
      continue;
    }

    if (answered.ok && SERVED_BY_WC_AUTH.test(body)) {
      return { ok: true };
    }

    return { ok: false, why: notTheGrantScreen(started, body) };
  }

  return { ok: false, why: whatAPlainPermalinkShopLooksLike(started) };
};

/**
 * A page with WordPress's asset paths is the shop answering with one of its own
 * pages. Without them it may be another site, or a WordPress server's own 404
 * under plain permalinks; nothing says which, so the owner is asked to check
 * the address first.
 */
const WORDPRESS_TRACES = /\/wp-(?:content|includes)\//;

const notTheGrantScreen = (shop: URL, body: string): string =>
  WORDPRESS_TRACES.test(body)
    ? whatAPlainPermalinkShopLooksLike(shop)
    : `The site at ${shop.origin} did not answer with the screen that grants access, and the page` +
      " it answered with does not look like WordPress, so nothing was connected and your browser" +
      " was not sent anywhere. Check that this is the address of your WooCommerce shop itself." +
      " If it is, the usual cause is the shop's permalink setting: set Settings → Permalinks to" +
      " anything other than Plain, save, and press Connect again.";

/**
 * Names the setting in WordPress's own words, since that is what the merchant
 * can change, without claiming it is certainly the cause.
 */
const whatAPlainPermalinkShopLooksLike = (shop: URL): string =>
  `Your shop answered at ${shop.origin} with one of its own pages rather than with the screen` +
  " that grants access, so nothing was connected and your browser was not sent anywhere." +
  " The usual cause is the shop's permalink setting: WooCommerce serves this screen through a" +
  " rewrite rule, and with Settings → Permalinks set to Plain there is no rule to serve it," +
  " so WordPress falls through to the shop's front page without an error. Set permalinks to" +
  " anything other than Plain, save, and press Connect again.";
