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
import { z } from "zod";
import { plainTextOfHtml } from "./html-text.js";
import { DECIMALS_ARE_EVERY_CUSTOMERS, decimalOfMinorUnits } from "./woo-catalog.js";
import { type WooRequest, wooRequest } from "./woo-request.js";

/** The name in the key row the merchant reads in their shop. */
export const APP_NAME = "Agentify";

/**
 * Read and write: a paid order becomes an order in the merchant's shop, which
 * is a write. A read-only grant would fail only at the first sale.
 */
const SCOPE = "read_write";

export const GRANT_MINUTES = 15;

/** The example every refusal of an address shows, where nothing typed suggests a better one. */
const AN_ADDRESS = "Enter your shop's address, like https://shop.example.com.";

/**
 * The https root of what was typed, where it names a host at all: what a
 * merchant who pasted an address from their shop's admin, or left the scheme
 * off, most likely meant. It only words a refusal; nothing typed is accepted
 * in its place.
 */
const likelyMeant = (typed: string): string | null => {
  const written = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`;
  if (!URL.canParse(written)) return null;
  const { host, hostname } = new URL(written);
  return hostname.includes(".") ? `https://${host}` : null;
};

/**
 * https is required although http would work: WooCommerce then wants an OAuth
 * 1.0a signature instead of HTTP Basic, and we would send the merchant's
 * consumer secret in the clear on every order. WooCommerce also refuses to post
 * keys to a callback that is not https. A refusal ends with the address the
 * merchant most likely meant, to be copied as it stands, so it carries no
 * full stop after it.
 */
export const whatIsWrongWithTheShopUrl = (typed: string): string | null => {
  const trimmed = typed.trim();
  if (trimmed === "") {
    return AN_ADDRESS;
  }
  const meant = likelyMeant(trimmed);
  if (!URL.canParse(trimmed)) {
    return meant === null ? AN_ADDRESS : `Start the address with https://, like this: ${meant}`;
  }
  const address = new URL(trimmed);
  if (address.protocol !== "https:") {
    return meant === null ? AN_ADDRESS : `Use the https address: ${meant}`;
  }
  if (address.hostname === "" || meant === null) {
    return AN_ADDRESS;
  }
  if (address.username !== "" || address.password !== "") {
    return `Leave out the user name and password: ${meant}`;
  }
  // A query or a fragment would be swallowed once a path is appended, reaching
  // an address nobody meant; a path is not supported, the shop being at the
  // root of its address.
  if (
    address.search !== "" ||
    address.hash !== "" ||
    (address.pathname !== "/" && address.pathname !== "")
  ) {
    return `Enter your site's root address: ${meant}`;
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

/** Loose, as the import's own read is: only the name, the currency and the price are asked of it. */
const PricedProductSchema = z.looseObject({
  name: z.string().default(""),
  prices: z.looseObject({
    price: z.string(),
    currency_code: z.string().regex(/^[A-Z]{3}$/),
    currency_minor_unit: z.number().int(),
  }),
});

/** What one product of the shop's public catalogue says: the currency it prices in and the decimals it writes. */
export interface ShopSample {
  readonly currency: string;
  readonly decimals: number;
}

/**
 * One product of the shop's keyless Store API, or null where the shop did not
 * clearly say: no products, the API off or blocked, a redirect, an answer too
 * slow or not a product list. Null means not known, never "not dollars", so a
 * caller goes on and the import judges every product. Redirects are not
 * followed: an answer from another host would be another site's prices.
 */
export const sampleOfTheShop = async (
  shopUrl: string,
  request: WooRequest = wooRequest,
): Promise<ShopSample | null> => {
  try {
    const answered = await request(
      `${shopUrlAs(shopUrl)}/wp-json/wc/store/v1/products?per_page=1`,
      {
        redirect: "manual",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(SHOP_ANSWERS_WITHIN_MS),
      },
    );
    if (answered.status !== 200) return null;
    const listed: unknown = JSON.parse(await answered.text());
    if (!Array.isArray(listed)) return null;
    const read = PricedProductSchema.safeParse(listed[0]);
    if (!read.success) return null;
    const { prices } = read.data;
    return { currency: prices.currency_code, decimals: prices.currency_minor_unit };
  } catch {
    return null;
  }
};

/** How many products of the public catalogue the rate screen looks through for an example. */
export const EXAMPLE_PAGE = 10;

/**
 * What the rate screen can show of one of the shop's products: the first one
 * on the catalogue's first page with a name and a price above zero in the
 * shop's currency at its decimals; `none` where the page answered without one,
 * which a made-to-order product listed with no price makes common; and
 * `unanswered` where the catalogue did not clearly answer at all.
 */
export type PricedExample =
  | { readonly kind: "priced"; readonly name: string; readonly price: string }
  | { readonly kind: "none" }
  | { readonly kind: "unanswered" };

/** Read as `sampleOfTheShop` reads, a page instead of one product; never throws. */
export const pricedExampleOfTheShop = async (
  shopUrl: string,
  currency: { readonly code: string; readonly decimals: number },
  request: WooRequest = wooRequest,
): Promise<PricedExample> => {
  try {
    const answered = await request(
      `${shopUrlAs(shopUrl)}/wp-json/wc/store/v1/products?per_page=${EXAMPLE_PAGE}`,
      {
        redirect: "manual",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(SHOP_ANSWERS_WITHIN_MS),
      },
    );
    if (answered.status !== 200) return { kind: "unanswered" };
    const listed: unknown = JSON.parse(await answered.text());
    if (!Array.isArray(listed)) return { kind: "unanswered" };
    for (const one of listed) {
      const read = PricedProductSchema.safeParse(one);
      if (!read.success) continue;
      const { prices } = read.data;
      if (prices.currency_code !== currency.code) continue;
      if (prices.currency_minor_unit !== currency.decimals) continue;
      const price = decimalOfMinorUnits(prices.price, prices.currency_minor_unit);
      const name = plainTextOfHtml(read.data.name).text;
      if (price !== null && /[1-9]/.test(price) && name !== "") {
        return { kind: "priced", name, price };
      }
    }
    return { kind: "none" };
  } catch {
    return { kind: "unanswered" };
  }
};

/**
 * Said beside the Connect button, as what was seen: one product, asked
 * anonymously from our server, which a currency switcher answering by visitor
 * would also have shown. Nothing was switched, so each sentence promises only
 * that, true whether the merchant sold through their code or the shop.
 */
const NOTHING_CHANGED =
  " Nothing was changed: you sell as you did before pressing Connect, and your shop was not" +
  " asked for keys.";

export const writesOtherDecimals = (currency: string, decimals: number): string =>
  `When we asked your shop's public catalogue just now, it wrote its prices in ${currency} with` +
  ` ${decimals} decimals. Agentify sells from a shop priced in another currency than US dollars` +
  " only where the shop writes its prices with no decimals or with two (WooCommerce → Settings →" +
  ` General → Number of decimals), so Connect stopped here. ${DECIMALS_ARE_EVERY_CUSTOMERS}` +
  NOTHING_CHANGED;

export const noReferenceFor = (currency: string): string =>
  `When we asked your shop's public catalogue just now, it priced its products in ${currency},` +
  ` and Coinbase gives no rate for ${currency}. You set the rate your shop's prices are converted` +
  " at yourself, and Agentify sells from a shop in another currency than US dollars only where it" +
  ` can show you Coinbase's rate beside yours, so Connect stopped here.${NOTHING_CHANGED}`;

export const referenceUnanswered = (currency: string): string =>
  `When we asked your shop's public catalogue just now, it priced its products in ${currency}.` +
  " Before connecting such a shop, Agentify checks that Coinbase gives a rate for its currency, to" +
  " show beside the rate you set, and Coinbase did not answer just now, so whether it gives one" +
  ` is not known.${NOTHING_CHANGED} Wait a moment and press Connect again.`;
