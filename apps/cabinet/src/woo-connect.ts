/**
 * Connecting a WooCommerce shop: what a merchant may type, where their browser
 * is sent, and the question we ask the shop before sending anybody anywhere.
 *
 * WooCommerce has carried a one-click key grant since 2015. The merchant's
 * browser goes to `/wc-auth/v1/authorize` with five parameters, the signed-in
 * administrator approves, and the shop posts a freshly minted
 * `consumer_key`/`consumer_secret` to a callback address we supplied
 * (`docs/research/27-woo-connect-probe.md`). Three facts out of that probe are
 * load-bearing here and each one is a refusal in this file.
 *
 * **All five parameters, always.** `app_name`, `user_id`, `return_url`,
 * `callback_url` and `scope`. Any one of them missing is a 401 from the shop,
 * so there is one function that builds the address and it names all five.
 *
 * **`user_id` is ours to fill, and it is the only thing standing between a
 * stranger and somebody else's shop.** The callback is unauthenticated by
 * nature — WooCommerce posts it from the shop's own server, carrying no session
 * of ours — so anybody who can reach our callback address can post a key pair
 * at it. What decides whose account those keys land on is the value that comes
 * back in `user_id`, which is why it is an unguessable one-time token bound to
 * the merchant who pressed Connect, and why it is spent the moment it arrives.
 *
 * **Plain permalinks break the flow in silence.** A shop with
 * `permalink_structure` empty does not answer the authorize address with an
 * error: it redirects once and serves its own front page with a 200. A merchant
 * sent there presses Connect, lands on their shop, and has nothing to report.
 * So we ask first — {@link isTheGrantScreen} — and refuse with the name of the
 * setting rather than sending them.
 */

import { randomBytes } from "node:crypto";

/** What the shop calls us in the key row a merchant reads afterwards. */
export const APP_NAME = "Coinslot";

/**
 * The access we ask for.
 *
 * Read and write, because reading the catalogue is only half of it: the point
 * of connecting is that a paid order becomes an order in the merchant's shop,
 * and creating one is a write. A read-only grant would let a merchant connect,
 * import their catalogue, sell something, and discover at the first sale that
 * nothing can be delivered.
 */
export const SCOPE = "read_write";

/** How long a Connect a merchant started is worth finishing. */
export const GRANT_MINUTES = 15;

/**
 * What is wrong with the address a merchant typed, in a sentence, or null.
 *
 * The https rule is the one worth arguing for, because it is a refusal of
 * something that would otherwise work. WooCommerce picks its REST
 * authentication scheme from the shop's own `is_ssl()`: over https the granted
 * key and secret go in as HTTP Basic, and over plain http they are refused and
 * a one-legged OAuth 1.0a signature is required instead. Both were proved to
 * work on the probe stand, so this is not a limitation we ran into. It is a
 * refusal: over http we would send the merchant's own consumer secret in the
 * clear, on every order, forever — and WooCommerce will not post the keys to a
 * callback that is not https either, so half of the flow is already refused by
 * the shop. Saying so at the door is cheaper than a merchant finding out from a
 * packet capture.
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
    return (
      "That address is http. Your shop has to be reachable over https, and not only because" +
      " WooCommerce refuses to send us your keys otherwise: over plain http your shop refuses" +
      " the keys as ordinary authentication, so every order we place would carry your own" +
      " secret in the clear where anybody on the path can read it."
    );
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
  if (address.username !== "" || address.password !== "") {
    return "Leave the user name and password out of the address.";
  }
  return null;
};

/**
 * The shop address as we keep it: no trailing slash, so that appending a path
 * never produces a double one.
 *
 * Only ever called on an address {@link whatIsWrongWithTheShopUrl} has passed.
 */
export const shopUrlAs = (typed: string): string => typed.trim().replace(/\/+$/, "");

/** Everything the authorize address carries beyond the shop and the scope. */
export interface GrantRequest {
  readonly appName: string;
  /**
   * The one-time token that says whose Connect this is.
   *
   * WooCommerce calls it `user_id` and treats it as an opaque string it hands
   * straight back, in the callback and in the return redirect. It is not an
   * identifier of anything of ours: an account identifier here would be a value
   * a stranger could guess and post keys against.
   */
  readonly userId: string;
  /** Where the merchant's browser comes back to. */
  readonly returnUrl: string;
  /** Where the shop's own server posts the keys. https, on 443, 80 or 8080. */
  readonly callbackUrl: string;
}

/** The address a merchant's browser is sent to, with all five parameters. */
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
 * A token nobody can guess and nothing else has issued.
 *
 * Base64url rather than hex so that it is short enough to read in a log line
 * without being short enough to search for, and so that it survives a query
 * string with nothing encoded: WooCommerce puts this value back into a
 * redirect and into a JSON body, and a value that came back re-encoded would
 * not match the row it was written from.
 */
export const theStateToken = (): string => randomBytes(32).toString("base64url");

/** What the preflight came to. */
export type Preflight = { readonly ok: true } | { readonly ok: false; readonly why: string };

/** How long we wait on a shop before deciding it is not answering. */
const SHOP_ANSWERS_WITHIN_MS = 10_000;

/**
 * How many redirects we follow before deciding the shop is not taking us to
 * wc-auth.
 *
 * WordPress redirects an authorize address at most twice in the shapes the
 * probe saw — a trailing-slash canonical, and wc-auth's own hand-over to its
 * sign-in page — and following more than that would be following a shop's own
 * redirect chain to somewhere with no bearing on the question.
 */
const REDIRECTS_FOLLOWED = 3;

/**
 * Whether this address actually reaches WooCommerce's grant screen.
 *
 * The test is the presence of wc-auth's own markup, and it is the presence of
 * something rather than the absence of something on purpose. A shop's front
 * page is a page we know nothing about: it can carry any status, any title and
 * any content, and every rule of the form "it is wrong if it says X" is a rule
 * one shop's theme breaks. What we do know is what wc-auth renders, because it
 * is WooCommerce's own template and the class name is in it.
 *
 * Nothing here is logged in, so the ordinary success is wc-auth's sign-in page
 * rather than the approval screen itself — the merchant meets that one in their
 * own browser, with their own session. Both carry the same marker.
 *
 * A redirect off the shop's own host ends it. A shop that sends us to another
 * origin has not shown us its grant screen, and following it would be asking a
 * stranger's server whether this merchant's shop is set up correctly.
 */
export const isTheGrantScreen = async (authorizeUrl: string): Promise<Preflight> => {
  const started = new URL(authorizeUrl);
  let at = started;

  for (let followed = 0; followed <= REDIRECTS_FOLLOWED; followed += 1) {
    let answered: Response;
    try {
      answered = await fetch(at, {
        redirect: "manual",
        headers: { accept: "text/html" },
        signal: AbortSignal.timeout(SHOP_ANSWERS_WITHIN_MS),
      });
    } catch (thrown) {
      return {
        ok: false,
        why:
          `Your shop did not answer at ${at.origin}. Check the address, and that the shop is` +
          ` reachable from the internet rather than only from your own network. (${String(thrown)})`,
      };
    }

    const body = await answered.text();

    // wc-auth answered and refused the request itself. That is our defect and
    // not the merchant's shop, so their shop's own words come back rather than
    // a sentence about permalinks they cannot act on.
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
        return { ok: false, why: whatAPlainPermalinkShopLooksLike(started) };
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

    if (answered.ok && /wc-auth/i.test(body)) {
      return { ok: true };
    }

    return { ok: false, why: whatAPlainPermalinkShopLooksLike(started) };
  }

  return { ok: false, why: whatAPlainPermalinkShopLooksLike(started) };
};

/**
 * What a merchant is told when the authorize address served something that is
 * not wc-auth.
 *
 * It names the setting, in WordPress's own words, because that is the one thing
 * the merchant can go and change. It does not claim that permalinks are
 * certainly the cause: the honest sentence is that the shop answered with
 * something else and this is what makes that happen.
 */
const whatAPlainPermalinkShopLooksLike = (shop: URL): string =>
  `Your shop answered at ${shop.origin} with one of its own pages rather than with the screen` +
  " that grants access, so nothing was connected and your browser was not sent anywhere." +
  " The usual cause is the shop's permalink setting: WooCommerce serves this screen through a" +
  " rewrite rule, and with Settings → Permalinks set to Plain there is no rule to serve it," +
  " so WordPress falls through to the shop's front page without an error. Set permalinks to" +
  " anything other than Plain, save, and press Connect again.";
