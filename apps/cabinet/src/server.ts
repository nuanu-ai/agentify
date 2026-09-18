/**
 * The cabinet's own HTTP surface: the one-field sign-in, its one-time-link
 * landing, the screens with navigation on them, the settings, and the switches
 * that stop and start selling.
 *
 * It is server-rendered with no client framework and no build step, which is
 * ADR-0005 §4. Every page is one GET and every change is one form post
 * followed by a redirect, so the browser's back button, its reload and its
 * find-in-page all work without anything being written to make them. Signing in
 * is a component's job now (ADR-0009) and that did not change: our handlers
 * call its server-side API with a body built out of a form we parsed, and pass
 * on the cookie it produces, so nothing on any of these pages needs JavaScript.
 *
 * Nothing here decides anything about a card, an order or the money. Each
 * handler is a translation between one request and a few calls on the gateway's
 * public API, and the pages are drawn from what those calls answered (ADR-0005
 * §3). A screen that cannot be drawn is API the merchant does not have either.
 *
 * Who is allowed in is one middleware and not a check per handler, and that is
 * ADR-0009 §2. The gate sits above every route below it, so a page added later
 * is guarded because it is a page rather than because somebody remembered — and
 * a visitor with no session is answered identically at every address, including
 * the ones that do not exist, so the cabinet's inventory of pages is not
 * something a stranger can read off it.
 *
 * What stands above the gate is written out in that decision and is short: the
 * sign-in, the page a mailed link lands on, the stylesheet,
 * the health probe, the shop's own callback and the address a shop sends a
 * browser back to. Each is there because a session cannot reach it, and each
 * answers the same thing to everybody — which is the property that makes the
 * list safe to add to, and the one to check before adding to it.
 */

import { readFileSync } from "node:fs";
import express, { type Express, type Request, type Response } from "express";
import type { CabinetDestination, CabinetIdentity, Person } from "./cabinet-entry.js";
import type { CabinetConfig } from "./config.js";
import {
  type Answer,
  type GatewayClient,
  gatewayFor,
  type Registrar,
  registrarFor,
} from "./gateway.js";
import { bare, brandLockup, escaped } from "./html.js";
import { keysScreen, newKeyScreen } from "./keys.js";
import { WALLET_NEEDED, whatIsWrongWithTheWallet } from "./payout-wallet.js";
import { printable } from "./printable.js";
import { cardsScreen, ordersScreen, receiptsScreen, type Viewer } from "./screens.js";
import {
  chooseNameScreen,
  NAME_CANNOT_BE_TAKEN_AWAY,
  NAME_NEEDED,
  settingsScreen,
  whatIsWrongWithTheName,
} from "./seller-name.js";
import {
  linkRequestedScreen,
  mailUnavailableScreen,
  merchantSetupScreen,
  openLinkScreen,
  refusedLinkScreen,
  signInScreen,
} from "./sign-in.js";
import { cardsFromTheShop, decimalOfMinorUnits, merchantItemIdFor } from "./woo-catalog.js";
import {
  APP_NAME,
  authorizeUrlFor,
  GRANT_MINUTES,
  isTheGrantScreen,
  type Preflight,
  shopUrlAs,
  theStateToken,
  whatIsWrongWithTheShopUrl,
} from "./woo-connect.js";
import {
  type ImportOutcome,
  type ShopState,
  type ShopTile,
  wooImportScreen,
  wooReturnScreen,
  wooScreen,
} from "./woo-screens.js";
import {
  type CatalogueRead,
  catalogueOf,
  inspectProductInTheShop,
  PRODUCTS_AT_MOST,
  type ProductInspection,
} from "./woo-shop.js";
import type { WooConnection, WooShops } from "./woo-shops.js";

/** Preserves input order while bounding calls into one merchant's shop. */
const mapAtMost = async <Input, Output>(
  values: readonly Input[],
  atMost: number,
  visit: (value: Input) => Promise<Output>,
): Promise<Output[]> => {
  const results = new Array<Output>(values.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < values.length) {
      const index = next;
      next += 1;
      const value = values[index];
      if (value !== undefined) results[index] = await visit(value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(atMost, values.length) }, worker));
  return results;
};

/**
 * How long the cabinet waits on the gateway for its own key, per call.
 *
 * Shorter than the deadline every screen gets, and that is the whole reason
 * there are two numbers. A screen is worth ten seconds because somebody is
 * looking at it and would rather wait than start again. The two calls that
 * replace this cabinet's key are not a screen: nobody asked for them, nothing
 * on the page depends on them, and a sign-in held open for as long as a
 * catalogue is the same locked door as a gateway that is down, only slower and
 * less honest about it. Two seconds a call, so the worst a silent gateway can
 * add to somebody's sign-in is four — and what it costs is that the key is not
 * replaced this time, which is a thing that can wait until the next sign-in.
 */
const KEY_AT_SIGN_IN_MS = 2_000;

/**
 * What an account with no merchant on it is told, wherever it turns up.
 *
 * There is one such account and it is on a deployed server: it was made before
 * an account named its merchant, so there is no key on its row and not one
 * screen in this cabinet can be drawn for it. The two things it must not be
 * answered with are an empty cabinet, which reads as a catalogue somebody
 * emptied, and an exception, which reads as a broken cabinet.
 *
 * So it is told what it is and what the two ways out are. The person reading it
 * is whoever set the deployment up, because this account is one of ours and not
 * a merchant's, which is why it can name a command at all — and the command is
 * named in full, because half of one is a person at a terminal guessing.
 */
/**
 * A shape an address has to have before a merchant is made for it.
 *
 * Deliberately not an attempt at the real grammar of an address, which is
 * larger than anybody thinks. What it catches is the mistakes somebody actually
 * makes in a form — a missing half, a space in the middle, a bare word. It is
 * the same shape the account command holds an address to, for the same reason.
 */
const LOOKS_LIKE_AN_ADDRESS = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

const cabinetDestinationIn = (value: unknown): CabinetDestination =>
  value === "settings" || value === "woocommerce" ? value : "default";

const cabinetPathFor = (base: string, destination: CabinetDestination): string =>
  destination === "settings"
    ? `${base}/settings`
    : destination === "woocommerce"
      ? `${base}/woocommerce`
      : `${base}/cards`;

/**
 * The stylesheet the cabinet serves: the shared visual language, then the
 * cabinet's own layout. Read once at startup — neither changes while we run.
 *
 * ADR-0005 §6 wants one visual language across the three surfaces, held in one
 * stylesheet rather than repeated per page, and that file is the landing's
 * `styles/tokens.css` — served by Caddy at /styles/tokens.css on the same
 * origin as all three. The cabinet reads it off disk and serves it inside its
 * own response rather than linking that address, for one reason: the cabinet
 * has to render correctly when it is run on its own, without Caddy in front of
 * it, which is how it is developed and how every one of its tests drives it. A
 * link to an absolute path that only exists behind the proxy would leave the
 * pages with no palette at all in exactly the situation somebody is looking at
 * them closely.
 *
 * What matters is that it is one file on disk and not a copy. This branch did
 * carry a copy, with the palette from before the contrast fix, which is how one
 * visual language quietly becomes two that look almost alike.
 */
const TOKENS_AT = new URL("../../landing/public/styles/tokens.css", import.meta.url);
const TOKENS = readTokens();

function readTokens(): string {
  try {
    return readFileSync(TOKENS_AT, "utf8");
  } catch (thrown) {
    // An ENOENT here is a packaging mistake — a workspace pruned to the
    // cabinet's own dependencies, which the landing is not one of — and the
    // bare exception names a path and nothing about why anybody wanted it. The
    // configuration goes to lengths to name every problem at once; this is the
    // same courtesy for the one file it does not read.
    throw new Error(
      `The cabinet cannot start: it serves the shared visual language from ${TOKENS_AT.pathname},` +
        " which is not there. That file is the landing's styles/tokens.css, and ADR-0005 §6 makes" +
        " it the one place the three surfaces take their palette from — so the cabinet ships" +
        ` beside it rather than carrying a copy. ${String(thrown)}`,
    );
  }
}
const STYLESHEET = `${TOKENS}\n${readFileSync(new URL("./agentify.css", import.meta.url), "utf8")}`;

/** What the cabinet is built out of, beyond its configuration. */
export interface CabinetParts {
  /**
   * Who is signed in, and everything that follows from that.
   *
   * The component and the store behind it, wrapped in `identity.ts`. A
   * deployment gives it Postgres; the cabinet's own tests give it the
   * component's memory store, so the suite drives the real component offline.
   */
  readonly identity: CabinetIdentity;
  /**
   * How the gateway is reached on behalf of one merchant, with the real client
   * as the default.
   *
   * A function of the key rather than a client, because the key is not the
   * cabinet's any more: it is on the row of whoever is signed in, so a client is
   * built per request and two people signed into one cabinet are two merchants
   * (ADR-0014 §2). Only a test ever passes anything else, and what a deployment
   * runs is the client that speaks the contract's route table.
   *
   * The deadline is the caller's because not every call is made in front of a
   * person: a screen is worth waiting on, and the two calls that replace this
   * cabinet's own key while somebody signs in are not. Left out, the client's
   * own is used.
   */
  readonly gatewayFor?: (key: string, answerWithinMs?: number) => GatewayClient;
  /**
   * How a merchant is made, which is the one call the cabinet makes with no key.
   *
   * Its own part rather than a method on the client above, because somebody
   * opening a first link is not a merchant yet and there is no key to bind a client to.
   */
  readonly registrar?: Registrar;
  /**
   * Where a merchant's connected WooCommerce shop is kept, for the cabinet that
   * has one.
   *
   * Optional, and absent is a cabinet with no WooCommerce screens at all rather
   * than screens that fail: a deployment without the tables has nothing to draw
   * them from, and a page offering to connect a shop it cannot write down would
   * be a button that loses somebody's keys.
   */
  readonly wooShops?: WooShops;
  /**
   * How a merchant's own shop is reached, with the real calls as the default.
   *
   * The same shape as the gateway client above and there for the same reason:
   * only a test ever passes anything else, and what a deployment runs is the
   * two calls in `woo-shop.ts` and `woo-connect.ts`. It is a part rather than a
   * module a test replaces because both of them reach a shop over https, and a
   * shop these tests could stand up on a loopback port would be refused at the
   * door before either of them ran — which is the door working correctly and a
   * fixture that cannot be built.
   */
  readonly shop?: {
    /** Whether an authorize address actually reaches wc-auth. */
    readonly grantScreen: (authorizeUrl: string) => Promise<Preflight>;
    /** Everything a shop offers for sale, off its Store API. */
    readonly catalogue: (shopUrl: string, atMost?: number) => Promise<CatalogueRead>;
    readonly inspectProduct: (
      keys: WooConnection,
      merchantItemId: string,
    ) => Promise<ProductInspection>;
  };
}

/**
 * The most products one import brings over.
 *
 * A number rather than paging, and it is named on the page it refuses rather
 * than being a silent cut. Every product is a separate call to the publish
 * door, made while a merchant is holding a page open, so the honest ceiling is
 * the one a page can carry — and a shop past it is told that its catalogue is
 * larger than this brings over in one go, which is a gap somebody can act on,
 * rather than being handed the first two hundred as though that were all of
 * them.
 */
/**
 * Whose session a request arrived on.
 *
 * A map keyed by the request rather than a field written onto it: express hands
 * every middleware the same object and a property added to it is a property no
 * type knows about, so the next reader of this file would have to take the
 * cabinet's word for who is signed in.
 */
const people = new WeakMap<Request, Person>();

/**
 * The three answers the settings screen is drawn from.
 *
 * The shop is optional and the other two are not, because the first two are
 * always asked for and the third exists only where this cabinet has somewhere
 * to keep a connection. Absent means a cabinet with no store for connections,
 * and no block about a shop. The four states of a shop that is there are
 * `ShopState`, and the fifth, `unread`, is a store that did not answer.
 */
interface Settings {
  readonly sellerName: string | null;
  readonly payoutWallet: string | null;
  readonly shop?: ShopTile;
}

/** The whole cabinet on an express app. */
export function buildApp(config: CabinetConfig, parts: CabinetParts): Express {
  const app = express();
  const base = config.basePath;
  const viewing = (request: Request, pageBase: string, sellerName?: string | null): Viewer =>
    viewingAt(request, pageBase, config.surfaceMode, sellerName);
  const viewingSettings = (
    request: Request,
    pageBase: string,
    settings: Settings,
    walletProblem?: string,
    walletTyped?: string,
  ): Viewer =>
    viewingSettingsAt(request, pageBase, config.surfaceMode, settings, walletProblem, walletTyped);
  const problemPage = (pageBase: string, said: string): string =>
    problemPageAt(pageBase, config.surfaceMode, said);
  const trouble = (response: Response, pageBase: string, answer: Answer<unknown>): void =>
    troubleAt(response, pageBase, config.surfaceMode, answer);
  const identity = parts.identity;
  const clientFor =
    parts.gatewayFor ??
    ((key: string, answerWithinMs?: number) => gatewayFor(config.gatewayUrl, key, answerWithinMs));
  const registrar = parts.registrar ?? registrarFor(config.gatewayUrl);
  const cookiePath = base === "" ? "/" : base;

  /**
   * The gateway as this request's merchant, built from the key on their row.
   *
   * Only ever called below the gate, which is what makes the merchant's absence
   * a defect here rather than a case: the gate refuses an account that has no
   * key on it, with a sentence saying what to do, precisely so that no handler
   * below has to hold an opinion about a cabinet with nothing to draw.
   */
  const gatewayAs = (request: Request): GatewayClient => {
    const merchant = whoIs(request).merchant;
    if (merchant === null) {
      throw new Error(
        "a handler below the gate ran for an account with no merchant on it, which means the" +
          " gate let one through — this is a defect in how the routes are ordered, not a" +
          " visitor's problem",
      );
    }
    return clientFor(merchant.key);
  };

  /**
   * Takes the component's cookies out of the browser.
   *
   * Every name it sets, not the session alone: beside the session itself the
   * component keeps two cookies of its own, and clearing only the first would
   * leave the others in a browser for good.
   */
  const forget = (response: Response): void => {
    for (const name of identity.cookieNames) {
      response.clearCookie(name, { path: cookiePath });
    }
  };

  const carriesIdentityCookie = (header: string | undefined): boolean => {
    const pairs = (header ?? "").split(";");
    return identity.cookieNames.some((name) =>
      pairs.some((pair) => pair.split("=", 1)[0]?.trim() === name),
    );
  };

  /**
   * Puts the session the component just opened into the browser.
   *
   * The lines are the component's own, passed on rather than rebuilt: the four
   * settings a merchant's session rests on are decided in one place
   * (`identity.ts`), and a second copy of them here is a second thing to get
   * wrong — most likely the one that only matters in production.
   */
  const carryCookies = (response: Response, cookies: readonly string[]): void => {
    for (const line of cookies) {
      response.append("set-cookie", line);
    }
  };

  app.disable("x-powered-by");
  // No `trust proxy` here: nothing in the cabinet reads the client's address,
  // and express's own handling of the forwarding headers would put a spoofable
  // value behind `request.ip` and `request.secure` where nobody reading a
  // handler would think to doubt it. The forms are the only thing a browser
  // posts here, and they are small.
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));
  app.use(sameOriginUnder(base, config.surfaceMode));

  // Under one origin the cabinet is reached at BASE_PATH, so that is where a
  // probe looks; at the bare root it is what a container health check asks for.
  // Both, because a probe answering 404 reads as a dead process.
  for (const path of new Set(["/healthz", `${base}/healthz`])) {
    app.get(path, (_request, response) => {
      response.json({ ok: true });
    });
  }

  app.get(`${base}/agentify.css`, (_request, response) => {
    response.type("text/css").send(STYLESHEET);
  });

  /**
   * Where a merchant's WooCommerce shop delivers the keys it just minted.
   *
   * Above the gate, because it has to be: this is a request from the merchant's
   * own web server, carrying no cookie of ours and no key of ours, and a route
   * behind the sign-in would simply never be reached. What stands in for a
   * session is the one-time token the shop hands back as `user_id` — it was
   * written down when the merchant pressed Connect, bound to their account and
   * to the shop they typed, and it is spent by arriving here. Without it this
   * address is a way for anybody to put their own shop's keys on somebody
   * else's account, which is the whole of why the token exists.
   *
   * The status is the answer and the body is not. WooCommerce deletes the key
   * it minted when the post fails (`class-wc-auth.php`, `maybe_delete_key`), so
   * a refusal here is not merely us declining to write a row: it takes the key
   * back out of the merchant's shop. That is the right outcome for a token we
   * do not recognise, and the reason nothing below answers 200 out of
   * politeness.
   *
   * It parses its own body. Everything else in this cabinet is a form and the
   * body parser above reads forms; this one arrives as JSON from WordPress, and
   * a JSON parser mounted at the top would be a second parser on every form
   * post the merchant makes.
   */
  app.post(`${base}/woocommerce/callback`, express.json({ limit: "16kb" }), (request, response) => {
    void (async () => {
      const shops = parts.wooShops;
      if (shops === undefined) {
        response.status(404).json({ ok: false });
        return;
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const token = typeof body.user_id === "string" ? body.user_id : "";
      const consumerKey = typeof body.consumer_key === "string" ? body.consumer_key : "";
      const consumerSecret = typeof body.consumer_secret === "string" ? body.consumer_secret : "";
      const permissions = typeof body.key_permissions === "string" ? body.key_permissions : "";

      if (token === "" || consumerKey === "" || consumerSecret === "") {
        console.log("[cabinet] a WooCommerce callback arrived without the keys it has to carry");
        response.status(400).json({ ok: false });
        return;
      }

      // Consumed together with the connection write. A token that worked twice
      // would let anybody who ever saw one put a second shop's keys on that
      // account; consuming first and connecting later would let an older
      // callback overwrite a newer Connect in between.
      const connectedAt = new Date();
      const connection = await shops.connectFromGrant(
        token,
        { consumerKey, consumerSecret, permissions },
        connectedAt,
      );
      if (connection === null) {
        // One answer for a token nobody issued, one already spent and one whose
        // fifteen minutes are up. Telling them apart here would be answering
        // questions about somebody else's account to whoever asked.
        console.log("[cabinet] a WooCommerce callback arrived with a token we do not hold");
        response.status(401).json({ ok: false });
        return;
      }

      // The address and the scope, never the keys: a log goes places the
      // database does not.
      console.log(
        printable(
          `[cabinet] a WooCommerce shop was connected for an account: ${connection.shopUrl}, ${permissions}`,
        ),
      );
      response.json({ ok: true });
    })().catch((thrown) => {
      // Answered as a failure so the shop takes its key back rather than
      // leaving one nothing here knows about.
      console.error("[cabinet] a WooCommerce callback could not be written down", thrown);
      if (!response.headersSent) {
        response.status(500).json({ ok: false });
      }
    });
  });

  /**
   * The address a merchant's own shop sends their browser back to.
   *
   * Above the gate, and that is the whole of this route's reason for being
   * written out here rather than beside the shop screens. The session cookie is
   * `SameSite=Strict` (ADR-0009): a navigation begun on the merchant's own
   * shop is cross-site, so the request that lands here carries nothing — for a
   * merchant signed in on that very browser, every time. Behind the gate it
   * ended a flow that had worked on a sign-in form, and what a merchant read
   * there was that the connect had failed.
   *
   * Taking the address out from behind the gate costs nothing because there is
   * nothing behind it to take: with no session this route reads no row, asks the
   * gateway nothing and draws a page that is the same page for everybody. A
   * stranger who walks up to it learns that the address exists. That is the only
   * claim on it, and it is true before anybody has connected anything.
   *
   * The token still comes out of the address bar first. WooCommerce hands
   * `user_id` back on this redirect, and in the case the page exists for — the
   * keys never arrived — it is unspent and good for the rest of its fifteen
   * minutes. What the redirect buys is what a redirect can buy: the address bar
   * and the browser's back history hold the stripped address rather than the
   * one with the token in it, and nothing the page then loads carries the token
   * in a `Referer`. What it does not buy is the request that already happened —
   * the token was in the address line of that one, so it is in this process's
   * own log and in the log of anything between the merchant and us, and only
   * spending or expiry ends that. Now that a real return arrives with no
   * session every time, this is the path that has to do the stripping, so it is
   * a redirect to this same address with the query gone rather than the
   * redirect into the cabinet that a signed-in visitor still gets.
   */
  if (parts.wooShops !== undefined) {
    const returnPath = `${base}/woocommerce/return`;
    app.get(returnPath, async (request, response) => {
      if ((await identity.whoIs(request.headers.cookie)) !== null) {
        response.redirect(303, `${base}/woocommerce?from=shop`);
        return;
      }
      if (Object.keys(request.query).length > 0) {
        response.redirect(303, returnPath);
        return;
      }
      response.type("html").send(wooReturnScreen(base, config.surfaceMode));
    });
  }

  app.get(`${base}/sign-in`, async (request, response) => {
    const person = await identity.whoIs(request.headers.cookie);
    if (person !== null) {
      response.redirect(303, person.merchant === null ? `${base}/merchant` : `${base}/cards`);
      return;
    }
    const destination = cabinetDestinationIn(request.query.destination);
    const problem =
      request.query.reason === "session-ended-unsaved"
        ? "Your session ended. Sign in again. The change you submitted was not saved."
        : request.query.reason === "session-ended"
          ? "Your session ended. Sign in again."
          : undefined;
    response.type("html").send(signInScreen(base, config.surfaceMode, destination, problem));
  });

  /**
   * Replaces the key on somebody's row with a fresh one, as they sign in.
   *
   * ADR-0014 §2 asks for it: the key is stored as the gateway issued it, so a
   * copy of this cabinet's database is a set of working keys, and what decides
   * how long they are worth stealing is this. After it, the key that copy holds
   * is one the gateway has forgotten.
   *
   * Three steps, and the order is the substance. Ask for a key with the one
   * already on the row; move the row from that key to the fresh one; then put
   * the key that is now out of use beyond use. Cut the power at any point and a
   * working key is on the row: after the first step the old one, still live;
   * after the second the fresh one, with the old one alive beside it; after the
   * third the fresh one alone. Forgetting before the write is the one
   * arrangement that cannot be interrupted safely, because the row would be
   * left naming a key that no longer exists, and its owner would be locked out
   * of their own cabinet by the act of signing into it.
   *
   * The write is conditional on the row still holding what this sign-in read
   * off it, which is what decides which key this sign-in has finished with.
   * Win, and the row has moved off the old key: no later write can put it back,
   * because every sign-in still expecting it will now lose the same way, so the
   * old key is this one's to forget. Lose, and the row never held the fresh key
   * and never will — nothing but this sign-in could have written it, and this
   * sign-in has lost — so the fresh key is the one to forget. Either way what
   * goes is a key proved to be neither current nor able to become current, and
   * the call that removes it is made with it. Interleave as many sign-ins as
   * you like: no call can reach a key another sign-in wrote after it was sent,
   * because reaching a key means holding it, so the row always names a key that
   * works. If the database answer is lost, neither conclusion is safe: the
   * row may hold either key, so both remain live and the next sign-in retries.
   *
   * What that gives up is the sweeping. Nobody clears anybody else's leavings
   * any more, so a sign-in interrupted between the write and the forgetting
   * leaves one key alive that nothing will ever come back for. That is a row
   * per interrupted sign-in and it is the right trade: the alternative is a
   * call able to take away a key somebody is holding. Clearing them by age, if
   * it is ever worth doing, is counted from this side — the cabinet is the
   * party that knows every key still on a row — and it is not built.
   *
   * None of it may stand between a person and their cabinet. A gateway that is
   * down, one that refuses, one that answers something the contract does not
   * recognise — each costs a line in the log and nothing more, and they are
   * signed in on a key that works. The last of those three arrives as a throw
   * rather than as an answer, which is why the whole of this is caught: the
   * client holds what comes back to the contract's schema, and a document it
   * refuses must not become a person who cannot sign in. Nothing about signing
   * in belongs to the gateway anyway — the proof, the session and the row are
   * this cabinet's own.
   *
   * It runs before the cookies are handed over rather than after the answer,
   * and that is not tidiness. The key is read off the row on every request, so
   * a first request racing an unfinished replacement could read the old key and
   * be refused with it. What is left is a narrower window: a request already in
   * flight from another device, which read the row before the write, is made
   * with the key this sign-in is about to forget and is refused. It is
   * milliseconds wide, it costs a page reload, and the only way to buy it off
   * would be to leave the old key alive for a while — which is the thing this
   * exists to stop.
   */
  const replaceTheKeyOf = async (person: Person): Promise<void> => {
    const holding = person.merchant?.key;
    if (holding === undefined) {
      return;
    }

    /** Puts one key beyond use, with itself, and never fails a sign-in. */
    const forget = async (key: string, which: string): Promise<void> => {
      const gone = await clientFor(key, KEY_AT_SIGN_IN_MS).forgetCabinetKey();
      if (!gone.ok) {
        console.error(`[cabinet] a person signed in and ${which} is still working: ${gone.why}`);
      }
    };

    try {
      const made = await clientFor(holding, KEY_AT_SIGN_IN_MS).issueCabinetKey();
      if (!made.ok) {
        console.error(
          "[cabinet] a person is signed in on the key their account already held:" +
            ` no fresh one was made — ${made.why}`,
        );
        return;
      }

      // Conditional on the row still holding what was read off it, which is
      // what makes the write and the choice of which key to forget one act
      // rather than two moments with a gap between them.
      const replaced = await identity.replaceMerchantKey(person.id, holding, made.document);
      if (replaced === "replaced") {
        // The row has moved off the key this sign-in arrived with, and no later
        // write can put it back. It is this sign-in's to forget, and this is
        // the only party holding it.
        await forget(holding, "the key it replaced");
        return;
      }

      if (replaced === "unknown") {
        // The write may have committed before its answer was lost. Revoking
        // either key could therefore revoke the one now on the row.
        console.error(
          "[cabinet] the database could not establish whether the account key was replaced;" +
            " neither key was revoked",
        );
        return;
      }

      // Somebody else moved the row first. The fresh key was never on it and
      // never will be — only this sign-in could have written it, and it has
      // lost — so this is what this sign-in has to clear up, and the key on the
      // row is left alone because it belongs to whoever won.
      console.error(
        "[cabinet] a person is signed in on the key their account holds:" +
          " a fresh one was made and the row had already moved on from what this sign-in read",
      );
      await forget(made.document, "the key it made and did not use");
    } catch {
      // Which step it was is in the exception and not worth unpacking into
      // three sentences: whichever it was, the row names a key the gateway
      // takes, because the only write here is conditional on the row and the
      // only key ever removed is one this sign-in had finished with.
      console.error(
        "[cabinet] a person is signed in and the key on their account was not replaced",
      );
    }
  };

  app.post(`${base}/sign-in`, async (request, response) => {
    const form = (request.body ?? {}) as { email?: unknown; destination?: unknown };
    const email = typeof form.email === "string" ? form.email.trim() : "";
    const destination = cabinetDestinationIn(form.destination);
    if (!LOOKS_LIKE_AN_ADDRESS.test(email)) {
      response
        .status(400)
        .type("html")
        .send(
          signInScreen(
            base,
            config.surfaceMode,
            destination,
            "Enter an address of the shape someone@example.com.",
          ),
        );
      return;
    }

    const requested = await identity.requestLink(email, destination);
    if (requested.status === "unavailable") {
      response.status(503).type("html").send(mailUnavailableScreen(base, config.surfaceMode));
      return;
    }
    const retryAfterSeconds =
      requested.status === "cooldown"
        ? Math.max(1, Math.ceil((requested.retryAt.getTime() - Date.now()) / 1_000))
        : undefined;
    if (retryAfterSeconds !== undefined) {
      response.setHeader("retry-after", String(retryAfterSeconds));
    }
    response
      .status(202)
      .type("html")
      .send(linkRequestedScreen(base, config.surfaceMode, email, destination, retryAfterSeconds));
  });

  const registerMerchant = async (): Promise<{ id: string; key: string } | null> => {
    const made = await registrar.register(config.gatewayInvitation);
    if (!made.ok) {
      console.error(`[cabinet] merchant registration unavailable (${made.status})`);
      return null;
    }
    return { id: made.document.merchant_id, key: made.document.secret };
  };

  const attachMerchant = async (person: Person) =>
    await identity.attachMerchant(person.id, registerMerchant);

  const sendOpenedPerson = async (
    response: Response,
    person: Person,
    destination: CabinetDestination,
  ): Promise<void> => {
    if (person.merchant !== null) {
      await replaceTheKeyOf(person);
      response.redirect(303, cabinetPathFor(base, destination));
      return;
    }

    const attached = await attachMerchant(person);
    if (attached.status === "attached") {
      response.redirect(303, `${base}/choose-name`);
      return;
    }
    if (attached.status === "already-attached") {
      response.redirect(303, cabinetPathFor(base, destination));
      return;
    }
    if (attached.status === "person-missing") {
      response.status(401).type("html").send(refusedLinkScreen(base, config.surfaceMode));
      return;
    }
    response
      .status(503)
      .type("html")
      .send(merchantSetupScreen(base, config.surfaceMode, true));
  };

  const linkResponseHeaders = (_request: Request, response: Response, next: () => void): void => {
    response.setHeader("cache-control", "private, no-store");
    // no-referrer makes Chromium send Origin:null on the native POST, which the
    // strict origin gate must refuse. strict-origin keeps the exact origin and
    // sends no query token in Referer.
    response.setHeader("referrer-policy", "strict-origin");
    next();
  };

  app.get(`${base}/sign-in/open`, linkResponseHeaders, (request, response) => {
    const token = typeof request.query.token === "string" ? request.query.token : "";
    if (token === "") {
      response.status(400).type("html").send(refusedLinkScreen(base, config.surfaceMode));
      return;
    }
    response.type("html").send(openLinkScreen(base, token, config.surfaceMode));
  });
  app.post(`${base}/sign-in/open`, linkResponseHeaders, async (request, response) => {
    const form = (request.body ?? {}) as { token?: unknown };
    const token = typeof form.token === "string" ? form.token : "";
    if (token === "") {
      response.status(400).type("html").send(refusedLinkScreen(base, config.surfaceMode));
      return;
    }
    const opened = await identity.openLink(token);
    if (opened.status === "refused") {
      const signedIn = await identity.whoIs(request.headers.cookie);
      response
        .status(401)
        .type("html")
        .send(
          refusedLinkScreen(
            base,
            config.surfaceMode,
            signedIn === null
              ? undefined
              : {
                  email: signedIn.email,
                  destination: signedIn.merchant === null ? "merchant" : "cards",
                },
          ),
        );
      return;
    }
    carryCookies(response, opened.setCookies);
    await sendOpenedPerson(response, opened.person, opened.destination);
  });

  /**
   * The gate. Everything below this line needs a session; everything above it
   * is the sign-in, the page a link lands on, the stylesheet,
   * the health probe, the shop's callback and the address a shop sends a browser
   * back to.
   *
   * A visitor without one is answered the same way at every address, which is
   * why this is a middleware and not a check inside each handler: a page added
   * below is guarded by being below, and a stranger cannot tell which addresses
   * this cabinet serves from which it does not.
   */
  app.use((request, response, next) => {
    void (async () => {
      try {
        const person = await identity.whoIs(request.headers.cookie);
        if (person === null) {
          // The cookies are cleared on the way out, so somebody whose session
          // was ended lands on a sign-in they can use rather than being bounced
          // through this gate again on every click.
          const hadIdentityCookie = carriesIdentityCookie(request.headers.cookie);
          forget(response);
          const reason =
            request.method === "GET" || request.method === "HEAD"
              ? "session-ended"
              : "session-ended-unsaved";
          const destination =
            hadIdentityCookie &&
            (request.method === "GET" || request.method === "HEAD") &&
            request.path === `${base}/woocommerce`
              ? "&destination=woocommerce"
              : "";
          response.redirect(
            303,
            hadIdentityCookie
              ? `${base}/sign-in?reason=${reason}${destination}`
              : `${base}/sign-in${destination === "" ? "" : "?destination=woocommerce"}`,
          );
          return;
        }
        people.set(request, person);
        next();
      } catch (thrown) {
        next(thrown);
      }
    })();
  });

  app.get(`${base}/`, (request, response) => {
    response.redirect(303, whoIs(request).merchant === null ? `${base}/merchant` : `${base}/cards`);
  });

  app.post(`${base}/sign-out`, async (request, response) => {
    // The rows go, not merely the cookies. Clearing a cookie asks the browser
    // to forget something; anybody who copied the value still holds a session.
    // Every identifier the request carried, not one of them: a browser sends
    // cookies of one name longest-path first and then oldest first, so the one
    // this person is signed in on is not necessarily the first.
    await identity.signOut(request.headers.cookie);
    console.log("[cabinet] a session was signed out");
    forget(response);
    response.redirect(303, `${base}/sign-in`);
  });

  app.get(`${base}/merchant`, (request, response) => {
    if (whoIs(request).merchant !== null) {
      response.redirect(303, `${base}/cards`);
      return;
    }
    response.type("html").send(merchantSetupScreen(base, config.surfaceMode));
  });

  app.post(`${base}/merchant`, async (request, response) => {
    const person = whoIs(request);
    if (person.merchant !== null) {
      response.redirect(303, `${base}/cards`);
      return;
    }
    const attached = await attachMerchant(person);
    if (attached.status === "attached") {
      response.redirect(303, `${base}/choose-name`);
      return;
    }
    if (attached.status === "already-attached") {
      response.redirect(303, `${base}/cards`);
      return;
    }
    if (attached.status === "person-missing") {
      forget(response);
      response.redirect(303, `${base}/sign-in`);
      return;
    }
    response
      .status(503)
      .type("html")
      .send(merchantSetupScreen(base, config.surfaceMode, true));
  });
  // P1 may reach only the retry and sign-out routes above. Every commerce
  // route below requires the complete merchant pair.
  app.use((request, response, next) => {
    if (whoIs(request).merchant === null) {
      response.status(503).type("html").send(merchantSetupScreen(base, config.surfaceMode));
      return;
    }
    next();
  });

  /**
   * The screen a newly attached merchant lands on.
   *
   * It asks the gateway for nothing. A merchant arrives here in the second
   * after their merchant was attached, so there is no name to draw, and a call whose
   * answer is known would be one more thing between opening the cabinet and the box
   * they came here to fill in. Somebody who comes back to this address later
   * gets the same form, and using it sets the name the same way the settings
   * page does.
   */
  app.get(`${base}/choose-name`, (_request, response) => {
    response.type("html").send(chooseNameScreen(base, config.surfaceMode));
  });

  app.post(`${base}/choose-name`, async (request, response) => {
    const typed = nameIn(request);
    // Empty is somebody who pressed the button with nothing in the box, and
    // they are told so rather than sent to read the catalogue's rule — the
    // rule is not what they broke, and the way past this screen is on it.
    const wrong = typed === "" ? NAME_NEEDED : whatIsWrongWithTheName(typed);
    if (wrong !== null) {
      response
        .status(400)
        .type("html")
        .send(chooseNameScreen(base, config.surfaceMode, wrong, typed));
      return;
    }

    const set = await gatewayAs(request).setSellerName(typed);
    if (!set.ok) {
      return trouble(response, base, set);
    }
    noted(whoIs(request), "chose the name their products are sold under");
    response.redirect(303, `${base}/cards`);
  });

  /**
   * Where one account's WooCommerce channel has got to, for the two screens
   * that draw it.
   *
   * One function and not two, because the settings block and the shop screen
   * are the same four states and a merchant reads both about one row. It is the
   * only place the clock is held against a Connect: the screens are handed a
   * state that has already been decided, so neither of them can decide it
   * differently.
   *
   * The connection wins over a Connect still on the table. A merchant who is
   * connected and pressed Connect again for a second shop is connected until
   * the new keys arrive, and saying otherwise would tell them their working
   * channel had stopped.
   *
   * `undefined` is a cabinet with nowhere to keep a connection, which draws no
   * block at all rather than an empty one.
   */
  const shopStateFor = async (accountId: string): Promise<ShopState | undefined> => {
    const shops = parts.wooShops;
    if (shops === undefined) {
      return undefined;
    }
    const connection = await shops.connectionOf(accountId);
    if (connection !== null) {
      return {
        kind: "connected",
        // The three fields a screen may know, never the row: the key and the
        // secret are a stranger's credential at rest (ADR-0023), and the rule
        // that they never reach a page is held by the screens having no way to
        // draw them rather than by whoever writes the next one remembering.
        shop: {
          shopUrl: connection.shopUrl,
          permissions: connection.permissions,
          connectedAt: connection.connectedAt,
        },
      };
    }
    const waiting = await shops.grantFor(accountId);
    if (waiting === null) {
      return { kind: "none" };
    }
    const now = Date.now();
    if (waiting.expiresAt.getTime() <= now) {
      return { kind: "unanswered", shopUrl: waiting.shopUrl };
    }
    return {
      kind: "waiting",
      shopUrl: waiting.shopUrl,
      // Rounded down, so a Connect pressed forty seconds ago is "less than a
      // minute" rather than "one minute": a number a merchant can watch climb
      // is worth more than one that is right on average.
      startedMinutesAgo: Math.floor((now - waiting.startedAt.getTime()) / 60_000),
    };
  };

  /**
   * Everything the settings screen is drawn from, asked for in one place.
   *
   * The screen shows three things a merchant has set, and it is reached three
   * ways: opened, and redrawn after either of its two forms was refused. Asking
   * for each of them in each of those by hand is how one comes to be forgotten
   * in one — and the page that results does not look broken, it looks like a
   * merchant who has set nothing.
   *
   * The calls go out together rather than one after another, because a merchant
   * waiting for a page should wait for the slowest of them rather than for their
   * sum. Either of the gateway's failing is the whole page failing: a settings
   * screen drawn without one of its answers would be claiming something about a
   * field nobody asked about.
   *
   * The shop is the exception and does not take the page down with it. It is our
   * own table, it holds one block on a page whose other three subjects are the
   * merchant's name, their money and their account, and a merchant whose payout
   * address is wrong must be able to reach the box for it while our shops table
   * is unreachable. So a read that throws is logged and drawn as the block
   * saying it could not be read, rather than as no block: a block that vanishes
   * reads as no connection to a merchant who has one, and "we could not read
   * it" has a different next move from "there is none".
   */
  const settingsOf = async (request: Request): Promise<Answer<Settings>> => {
    const gateway = gatewayAs(request);
    const person = whoIs(request);
    const [name, wallet, shop] = await Promise.all([
      gateway.sellerName(),
      gateway.payoutWallet(),
      shopStateFor(person.id).catch((thrown: unknown): ShopTile => {
        console.error(
          "[cabinet] the WooCommerce connection could not be read for a settings screen",
          thrown,
        );
        return { kind: "unread" };
      }),
    ]);
    if (!name.ok) {
      return name;
    }
    if (!wallet.ok) {
      return wallet;
    }
    return {
      ok: true,
      document: {
        sellerName: name.document,
        payoutWallet: wallet.document,
        ...(shop === undefined ? {} : { shop }),
      },
    };
  };

  app.get(`${base}/settings`, async (request, response) => {
    const settings = await settingsOf(request);
    if (!settings.ok) {
      return trouble(response, base, settings);
    }
    response.type("html").send(settingsScreen(viewingSettings(request, base, settings.document)));
  });

  app.post(`${base}/settings`, async (request, response) => {
    const typed = nameIn(request);
    // Empty is a merchant trying to stop being listed, and the sentence names
    // the control that actually does that. The route below would refuse it
    // anyway; refused here, the answer is about what they were trying to do
    // rather than about a document the gateway would not take.
    const wrong = typed === "" ? NAME_CANNOT_BE_TAKEN_AWAY : whatIsWrongWithTheName(typed);
    if (wrong !== null) {
      // The page is drawn from what the gateway has rather than from what was
      // typed, the way the keys screen redraws its list after a refusal: a
      // merchant reading a refused name in the box under "the name buyers read"
      // is reading something they are not listed under.
      const settings = await settingsOf(request);
      if (!settings.ok) {
        return trouble(response, base, settings);
      }
      response
        .status(400)
        .type("html")
        .send(settingsScreen(viewingSettings(request, base, settings.document), wrong, typed));
      return;
    }

    const set = await gatewayAs(request).setSellerName(typed);
    if (!set.ok) {
      return trouble(response, base, set);
    }
    noted(whoIs(request), "changed the name their products are sold under");
    // Back to the page rather than answered with one, so that a reload does not
    // send the name again.
    response.redirect(303, `${base}/settings`);
  });

  /**
   * Where a merchant's money arrives.
   *
   * Its own route rather than a second field on the one above, because they are
   * two forms with two buttons and a merchant presses one of them. Sharing a
   * route would mean every save of a name also rewriting an address, which is
   * the shape that turns a typo in one box into a payment sent somewhere else.
   *
   * The address is checked here as well as at the gateway so that a refusal
   * reads as a page rather than as an API answer, and so that an address of the
   * wrong shape never leaves this process at all.
   */
  app.post(`${base}/settings/payout-wallet`, async (request, response) => {
    const typed = walletIn(request);
    const wrong = typed === "" ? WALLET_NEEDED : whatIsWrongWithTheWallet(typed);
    if (wrong !== null) {
      const settings = await settingsOf(request);
      if (!settings.ok) {
        return trouble(response, base, settings);
      }
      // The block is redrawn from the address the gateway has, so a merchant
      // who was refused is still looking at where their money actually goes
      // rather than at what they just mistyped.
      response
        .status(400)
        .type("html")
        .send(settingsScreen(viewingSettings(request, base, settings.document, wrong, typed)));
      return;
    }

    const set = await gatewayAs(request).setPayoutWallet(typed);
    if (!set.ok) {
      return trouble(response, base, set);
    }
    // The address itself stays out of the line. It is not a secret, but this
    // log is a process log and the record of who changed it is what it is for.
    noted(whoIs(request), "changed the address their money arrives at");
    response.redirect(303, `${base}/settings`);
  });

  /**
   * The shop screens, and the one thing they all need.
   *
   * A cabinet built without a place to keep connections has no WooCommerce
   * screens at all: the routes below are mounted only where there is a store,
   * so a deployment whose tables are not there answers "there is no such page"
   * rather than drawing a form whose button loses somebody's keys.
   */
  const shops = parts.wooShops;
  if (shops !== undefined) {
    /** The address a shop is told to send a merchant back to, and the keys to. */
    const whereWeAre = `${config.publicBaseUrl}${base}`;
    const grantScreen = parts.shop?.grantScreen ?? isTheGrantScreen;
    const catalogue = parts.shop?.catalogue ?? catalogueOf;
    const inspectProduct = parts.shop?.inspectProduct ?? inspectProductInTheShop;

    /** The page, drawn from where the channel is and from what buyers read. */
    const drawTheShop = async (
      request: Request,
      response: Response,
      view: { problem?: string; typed?: string; cameBack?: boolean },
      status = 200,
    ): Promise<void> => {
      const person = whoIs(request);
      const [state, name] = await Promise.all([
        shopStateFor(person.id),
        gatewayAs(request).sellerName(),
      ]);
      if (!name.ok) {
        return trouble(response, base, name);
      }
      if (state === undefined) {
        // Unreachable: these routes are mounted only where there is a store,
        // and that is the one thing `shopStateFor` answers `undefined` for.
        throw new Error(
          "the shop screens ran on a cabinet with no store for connections, which means the" +
            " routes were mounted where they should not have been",
        );
      }
      response
        .status(status)
        .type("html")
        .send(wooScreen(viewing(request, base, name.document), { ...view, state }));
    };

    app.get(`${base}/woocommerce`, async (request, response) => {
      // Where the redirect from the return address lands, and the only route
      // that reads this. It is spent by being drawn: a merchant who opens this
      // page again tomorrow is not told their browser has just come back from
      // anywhere. The flag and not the token, which is the whole point of the
      // redirect that set it.
      const typed = typeof request.query.shop_url === "string" ? request.query.shop_url : undefined;
      await drawTheShop(request, response, {
        cameBack: request.query.from === "shop",
        ...(typed === undefined ? {} : { typed }),
      });
    });

    app.post(`${base}/woocommerce/connect`, async (request, response) => {
      const form = (request.body ?? {}) as { shop_url?: unknown };
      const typed = typeof form.shop_url === "string" ? form.shop_url.trim() : "";

      const wrong = whatIsWrongWithTheShopUrl(typed);
      if (wrong !== null) {
        return await drawTheShop(request, response, { problem: wrong, typed }, 400);
      }
      const shopUrl = shopUrlAs(typed);

      // Our own address, checked before the merchant's. WooCommerce refuses a
      // callback_url that is not https, so on a deployment whose public address
      // is http every Connect ends at the shop's own 401 about SSL — a merchant
      // reading a refusal about their shop for something that is ours. Said
      // here, at the door, before anybody is sent anywhere.
      if (!whereWeAre.startsWith("https://")) {
        return await drawTheShop(
          request,
          response,
          {
            problem:
              `This Agentify deployment is reachable at ${whereWeAre}, which is not https, and WooCommerce` +
              " will not send a shop's keys to an address that is not. Nothing here can connect a" +
              " shop until whoever runs this deployment puts it behind https.",
            typed,
          },
          400,
        );
      }

      // The token is minted before the shop is asked anything, so the address
      // we check is character for character the address the browser is sent to.
      const token = theStateToken();
      const authorize = authorizeUrlFor(shopUrl, {
        appName: APP_NAME,
        userId: token,
        returnUrl: `${whereWeAre}/woocommerce/return`,
        callbackUrl: `${whereWeAre}/woocommerce/callback`,
      });

      // Asked before anybody is sent anywhere. A shop with plain permalinks
      // answers this address with its own front page and a 200, so a merchant
      // sent there lands on their own shop with nothing to report.
      const looked = await grantScreen(authorize);
      if (!looked.ok) {
        return await drawTheShop(request, response, { problem: looked.why, typed }, 400);
      }

      // Written down only now: a Connect nobody could have completed is a row
      // nobody comes back for.
      const person = whoIs(request);
      // One reading of the clock for both fields, so that "started four minutes
      // ago" and "the fifteen minutes are up" can never disagree by the width
      // of the statement between them.
      const startedAt = new Date();
      await shops.beginGrant({
        token,
        accountId: person.id,
        shopUrl,
        startedAt,
        expiresAt: new Date(startedAt.getTime() + GRANT_MINUTES * 60_000),
      });
      noted(person, `started connecting the WooCommerce shop at ${shopUrl}`);
      response.redirect(303, authorize);
    });

    app.post(`${base}/woocommerce/import`, async (request, response) => {
      const person = whoIs(request);
      const connection = await shops.connectionOf(person.id);
      if (connection === null) {
        response.redirect(303, `${base}/woocommerce`);
        return;
      }

      // The ceiling goes in rather than being checked on the way out, so that a
      // catalogue too large to bring over is refused after three round trips to
      // somebody else's shop rather than after fifty.
      const read = await catalogue(connection.shopUrl, PRODUCTS_AT_MOST);
      if (!read.ok) {
        return await drawTheShop(request, response, { problem: read.why }, 502);
      }

      const qualified = await mapAtMost(read.products, 4, async (product) => {
        const inspected = await inspectProduct(
          connection,
          merchantItemIdFor(connection.shopUrl, String(product.id)),
        );
        if (!inspected.ok) {
          return { ...product, qualification_problem: inspected.why };
        }
        const publicPrice = decimalOfMinorUnits(
          product.prices.price,
          product.prices.currency_minor_unit,
        );
        if (
          publicPrice !== inspected.product.price.amount ||
          product.prices.currency_code !== inspected.product.price.currency
        ) {
          return {
            ...product,
            qualification_problem:
              "The public catalogue price does not match the protected WooCommerce product price.",
          };
        }
        return {
          ...product,
          status: "publish",
          virtual: true,
          downloadable: true,
          manage_stock: false,
          download_limit: -1,
          download_expiry: -1,
          downloads: [
            {
              id: inspected.product.downloadId,
              name: inspected.product.fileName,
              file: "protected-by-woo",
            },
          ],
          qualification_problem: null,
        };
      });
      const { cards, skipped } = cardsFromTheShop(qualified, connection.shopUrl);
      const gateway = gatewayAs(request);
      const outcomes: ImportOutcome[] = [];
      for (const [index, one] of cards.entries()) {
        const published = await gateway.publishCard(one.card);
        if (!published.ok) {
          // The gateway did not answer, or answered something that is not this
          // route's document. Not a refused card, and said as what it is.
          outcomes.push({ id: one.id, title: one.title, failed: published.why });
          outcomes.push(
            ...cards
              .slice(index + 1)
              .map((later) => ({ id: later.id, title: later.title, notAttempted: true as const })),
          );
          break;
        }
        if (published.document.ok) {
          outcomes.push({ id: one.id, title: one.title, published: published.document.id });
          continue;
        }
        // The door's own findings, word for word. They are what tells the
        // merchant which field of which product to change in their shop.
        outcomes.push({
          id: one.id,
          title: one.title,
          problems: published.document.error.problems.map((problem) =>
            problem.path.length === 0
              ? problem.message
              : `${problem.path.join(".")}: ${problem.message}`,
          ),
        });
      }

      noted(
        person,
        `imported ${outcomes.filter((one) => "published" in one).length} of` +
          ` ${read.products.length} products from ${connection.shopUrl}`,
      );
      // Answered with a page rather than a redirect: a redirect carries a flag
      // and this has to carry the door's findings, one per card.
      response.type("html").send(
        wooImportScreen(viewing(request, base), {
          shopUrl: connection.shopUrl,
          outcomes,
          skipped,
        }),
      );
    });

    app.post(`${base}/woocommerce/disconnect`, async (request, response) => {
      const person = whoIs(request);
      const shopUrl = await shops.forget(person.id);
      noted(person, "forgot the keys their WooCommerce shop had given");
      const query = shopUrl === null ? "" : `?${new URLSearchParams({ shop_url: shopUrl })}`;
      response.redirect(303, `${base}/woocommerce${query}`);
    });
  }

  app.get(`${base}/cards`, async (request, response) => {
    const gateway = gatewayAs(request);
    const [cards, name] = await Promise.all([gateway.cards(), gateway.sellerName()]);
    if (!cards.ok) {
      return trouble(response, base, cards);
    }
    if (!name.ok) {
      return trouble(response, base, name);
    }
    response
      .type("html")
      .send(
        cardsScreen(
          viewing(request, base, name.document),
          cards.document,
          config.publicBaseUrl,
          shops !== undefined,
        ),
      );
  });

  app.get(`${base}/orders`, async (request, response) => {
    // Only the exact word narrows the list, which is what the contract says
    // and what a merchant reconciling their books relies on.
    const open = request.query.open === "true";
    const gateway = gatewayAs(request);
    const [cards, orders, name] = await Promise.all([
      gateway.cards(),
      gateway.orders(open),
      gateway.sellerName(),
    ]);
    if (!cards.ok) {
      return trouble(response, base, cards);
    }
    if (!orders.ok) {
      return trouble(response, base, orders);
    }
    if (!name.ok) {
      return trouble(response, base, name);
    }
    response
      .type("html")
      .send(
        ordersScreen(viewing(request, base, name.document), cards.document, orders.document, open),
      );
  });

  app.get(`${base}/receipts`, async (request, response) => {
    const gateway = gatewayAs(request);
    const [cards, receipts, name] = await Promise.all([
      gateway.cards(),
      gateway.receipts(),
      gateway.sellerName(),
    ]);
    if (!cards.ok) {
      return trouble(response, base, cards);
    }
    if (!receipts.ok) {
      return trouble(response, base, receipts);
    }
    if (!name.ok) {
      return trouble(response, base, name);
    }
    response
      .type("html")
      .send(
        receiptsScreen(viewing(request, base, name.document), cards.document, receipts.document),
      );
  });

  for (const [verb, paused] of [
    ["pause", true],
    ["resume", false],
  ] as const) {
    app.post(`${base}/cards/:item_id/${verb}`, async (request, response) => {
      const itemId = request.params.item_id ?? "";
      const switched = await gatewayAs(request).pauseCard(itemId, paused);
      if (!switched.ok) {
        return trouble(response, base, switched);
      }
      noted(whoIs(request), `${paused ? "paused" : "resumed"} the card ${itemId}`);
      // Back to the list rather than answering the post with a page: a
      // merchant who then reloads must not press the switch again.
      response.redirect(303, `${base}/cards`);
    });

    app.post(`${base}/selling/${verb}`, async (request, response) => {
      const switched = await gatewayAs(request).setSelling(!paused);
      if (!switched.ok) {
        return trouble(response, base, switched);
      }
      noted(whoIs(request), paused ? "stopped all selling" : "started selling again");
      response.redirect(303, `${base}/cards`);
    });
  }

  app.get(`${base}/keys`, async (request, response) => {
    const keys = await gatewayAs(request).keys();
    if (!keys.ok) {
      return trouble(response, base, keys);
    }
    response.type("html").send(keysScreen(viewing(request, base), keys.document));
  });

  // The key page rewrites its POST history entry to this target. Reloading can
  // therefore return to the list without issuing a second key or storing the
  // first key's secret anywhere for another request.
  app.get(`${base}/keys/new`, (_request, response) => {
    response.redirect(303, `${base}/keys`);
  });

  app.post(`${base}/keys`, async (request, response) => {
    const form = (request.body ?? {}) as { label?: unknown };
    const label = typeof form.label === "string" ? form.label.trim() : "";
    const gateway = gatewayAs(request);

    if (label === "") {
      // Refused here rather than sent on, because a key with no name is a key
      // nobody can tell from another on the very screen whose job is telling
      // them apart before revoking one. The list is fetched again so the
      // refusal lands on the page they were looking at.
      const keys = await gateway.keys();
      if (!keys.ok) {
        return trouble(response, base, keys);
      }
      response
        .status(400)
        .type("html")
        .send(
          keysScreen(
            viewing(request, base),
            keys.document,
            "Give the key a name, so that you can tell it from the others when you come to revoke one.",
          ),
        );
      return;
    }

    const issued = await gateway.issueKey(label);
    if (!issued.ok) {
      return trouble(response, base, issued);
    }
    // The name and the identifier, never the secret. A log goes places the
    // database does not, and this is the one moment the secret exists outside
    // the merchant's own hands.
    noted(whoIs(request), `issued a key, ${issued.document.key.id}, named "${label}"`);
    // Answered with a page rather than a redirect, which is the one place this
    // cabinet does that. `keys.ts` says why: a redirect cannot carry the secret
    // anywhere it would be safe to read it back from.
    response.type("html").send(newKeyScreen(viewing(request, base), label, issued.document.secret));
  });

  app.post(`${base}/keys/:key_id/disable`, async (request, response) => {
    const keyId = request.params.key_id ?? "";
    const stopped = await gatewayAs(request).disableKey(keyId);
    if (!stopped.ok) {
      // Including the one refusal the screen tries not to provoke: the gateway
      // will not disable the key its caller is holding. The screen offers no
      // control for it, and somebody who reaches this address anyway is told
      // what the gateway said rather than shown a page implying it worked.
      return trouble(response, base, stopped);
    }
    noted(whoIs(request), `revoked the key ${keyId}`);
    response.redirect(303, `${base}/keys`);
  });

  app.use((_request, response) => {
    response.status(404).type("html").send(problemPage(base, "There is no such page."));
  });

  app.use(
    (thrown: unknown, _request: Request, response: Response, next: (error?: unknown) => void) => {
      if (response.headersSent) {
        next(thrown);
        return;
      }
      // A body larger than any of these forms. It arrives from a visitor and
      // not from a defect, so it is answered as what it is rather than as a
      // broken cabinet — and without a stack, because a stranger who can post
      // at this address must not be able to fill the log with them. The body
      // parser runs above the gate, which is why a visitor with no session
      // reaches this at all.
      if (tooLarge(thrown)) {
        response
          .status(413)
          .type("html")
          .send(problemPage(base, "That was larger than any form on this page sends."));
        return;
      }
      // A defect. The merchant is told that something here is broken and
      // nothing about what: an error text assembled out of an exception makes
      // claims about our internals to somebody who cannot act on them.
      // What is not said here: whether anything was changed. A call that
      // reached the gateway, did what it was asked and then answered in a shape
      // the contract does not recognise lands in this handler, and the change
      // has already happened — so "nothing was changed" would be a claim this
      // handler has no way to check, made to somebody about their own catalog.
      // Driver and provider exceptions can carry bound values, including
      // session tokens and merchant keys. The response already tells an
      // operator where the failure occurred; the exception is not logged.
      console.error("[cabinet] a request failed");
      response
        .status(500)
        .type("html")
        .send(
          problemPage(
            base,
            "Something in the cabinet is broken. Check the page you were on before deciding whether it went through.",
          ),
        );
    },
  );

  return app;
}

/**
 * Turns away a form post that came from somewhere else.
 *
 * The forms this protects include "stop all selling" and the sign-in itself, so
 * a page on another site must not be able to make a browser submit one — not
 * the switches, because that is a merchant's selling, and not the sign-in,
 * because signing somebody into an account of the attacker's choosing is a way
 * of getting them to do their work in a session somebody else can read.
 * SameSite=Strict on the cookie is the first answer and the main one; this is
 * the second, and it exists because SameSite is scoped to the registrable
 * domain rather than to the origin — the day anything at all is served from a
 * sibling subdomain, that page is "same site" and can forge every switch here.
 *
 * The component that signs people in brings a check of its own, and it does not
 * replace this one. What it brings is the same idea — compare the `Origin`
 * against a list the deployment configures — and it brings it only for its own
 * endpoints, which are not mounted here at all: every call the cabinet makes is
 * from a handler, with no request behind it, so the component's middleware has
 * nothing to inspect and returns at once. Nothing in it puts a value in our
 * forms that a page on another site could not guess, so the switches, the keys
 * and the one-time-link consumption are covered by this and by nothing else.
 *
 * A missing Origin is allowed through. Browsers send it on every cross-origin
 * form post, which is the case being refused; what they historically omit it
 * on is same-origin navigation, and refusing an absent header would turn away
 * the merchant's own browser and every command-line client along with it. This
 * is a cheap second lock, not the lock.
 *
 * What is compared is the host and not the whole origin, and the scheme is
 * deliberately not part of it any more. The earlier version took the scheme out
 * of `X-Forwarded-Proto` and refused an origin that disagreed, and its own
 * comment said what that would cost: over https with a terminator that sets
 * nothing, every form post on the site is refused. On the first real
 * deployment that is what happened — a browser signing in at the public HTTPS
 * origin was told its form came from somewhere else, while
 * the identical request from a command line was let through. That difference
 * was never explained; what it showed is that the scheme half of this check
 * turns a header set by whatever is in front into a merchant who cannot reach
 * the control that stops their selling.
 *
 * Dropping it costs the distinction between a page served over http and one
 * served over https on the same host, and that distinction is already made
 * where it can be made without trusting anybody: the session cookie is
 * `Secure` wherever the cabinet is served over https (ADR-0009 §6), so a page
 * on the http origin has no session to forge a post with. A guard cannot be
 * the reason a merchant is locked out.
 */
/**
 * Whether an `Origin` names the same host the request was addressed to.
 *
 * Both sides are parsed rather than compared as text, because both can be
 * written more than one way and only one of those ways is the same string. A
 * host header can carry a port, an origin drops the port that is default for
 * its scheme, and an IPv6 literal is full of colons that a hand-written split
 * would cut in the wrong place. `URL` settles all three, and the port is left
 * out of the comparison on purpose: it is not a boundary a browser enforces
 * — a page on another port of the same host is same-site to SameSite — so
 * requiring it to match would only produce refusals a merchant cannot act on.
 *
 * Anything unparseable is not the same host. An `Origin` of `null`, which a
 * sandboxed document sends, lands there and is refused.
 */
const sameHost = (origin: string, host: string): boolean => {
  const hostOf = (value: string): string | null => {
    try {
      return new URL(value).hostname || null;
    } catch {
      return null;
    }
  };
  // The host header is not a URL, so it is made into one before it is read.
  // The scheme in front of it is arbitrary and never compared against anything.
  const here = hostOf(`http://${host}`);
  return here !== null && hostOf(origin) === here;
};

function sameOriginUnder(base: string, mode: CabinetConfig["surfaceMode"]) {
  return (request: Request, response: Response, next: () => void): void => {
    const origin = request.headers.origin;
    if (request.method !== "POST" || origin === undefined) {
      next();
      return;
    }

    const asked = request.headers.host;

    if (asked !== undefined && sameHost(origin, asked)) {
      next();
      return;
    }
    // The page says nothing about which origin would have worked, because that
    // is an answer to somebody who is guessing. The log says everything,
    // because the other person this refusal reaches is a merchant who did
    // nothing wrong, and until this line existed there was no way to tell the
    // two apart: the check refused an honest browser on the live site and the
    // only evidence anywhere was a screenshot. What is written down is what was
    // compared and nothing else — an origin and a host are not secrets, and
    // both arrive from outside, so both go through the same rendering that
    // strips what a terminal would obey instead of show.
    console.log(
      `[cabinet] a form post was refused: its origin is ${printable(origin)},` +
        ` and it was addressed to ${printable(asked ?? "nothing at all")}`,
    );
    response
      .status(403)
      .type("html")
      .send(problemPageAt(base, mode, "This form did not come from the cabinet."));
  };
}

/**
 * The person this request belongs to.
 *
 * Only ever called below the gate, which is what makes the absence a defect
 * rather than a case: a handler running without a person behind it would be a
 * page reachable by nobody in particular, and it should stop rather than draw
 * something.
 */
function whoIs(request: Request): Person {
  const person = people.get(request);
  if (person === undefined) {
    throw new Error(
      "a handler below the gate ran with no session behind it, which means the gate was" +
        " bypassed — this is a defect in how the routes are ordered, not a visitor's problem",
    );
  }
  return person;
}

/**
 * Who is looking at this page, where the cabinet is mounted, and what buyers
 * are told this merchant is called.
 *
 * The name is passed by the screens that asked the gateway for it and left out
 * by the ones that did not. That difference is the point: a screen drawing the
 * line about an unset name has to have asked, and a screen that has not asked
 * must not draw a line either way about it.
 */
const viewingAt = (
  request: Request,
  base: string,
  mode: Viewer["mode"],
  sellerName?: string | null,
): Viewer => {
  const person = whoIs(request);
  return { base, mode, who: person.email, confirmed: person.confirmed, sellerName };
};

/**
 * The same, for the one screen that also draws the payout address.
 *
 * Separate from `viewing` rather than a fourth argument to it, because every
 * other screen would then be passing an absence: a screen that has not asked
 * the gateway for the address must not be able to say anything about it, and
 * the cheapest way to hold that is for those screens to have no way to.
 */
const viewingSettingsAt = (
  request: Request,
  base: string,
  mode: Viewer["mode"],
  settings: Settings,
  walletProblem?: string,
  walletTyped?: string,
): Viewer => ({
  ...viewingAt(request, base, mode, settings.sellerName),
  payout: {
    wallet: settings.payoutWallet,
    ...(walletProblem === undefined ? {} : { problem: walletProblem }),
    ...(walletTyped === undefined ? {} : { typed: walletTyped }),
  },
  // Carried straight through, absence included: a cabinet with no store for
  // connections hands no shop here and the screen draws no block about one.
  ...(settings.shop === undefined ? {} : { shop: settings.shop }),
});

/**
 * The name in a form post, with the space at either end taken off.
 *
 * Trimmed rather than refused for a space, because the catalogue's rule turns a
 * padded name into two spellings of one word and a space at the front of a form
 * field is a typing accident. A field that never arrived reads the same as one
 * left empty: both are somebody who typed no name.
 */
const nameIn = (request: Request): string => {
  const form = (request.body ?? {}) as { seller_name?: unknown };
  return typeof form.seller_name === "string" ? form.seller_name.trim() : "";
};

/**
 * The payout address in a form post, with the space at either end taken off.
 *
 * Trimmed rather than refused, because an address is copied out of a wallet and
 * a wallet hands it over with a newline on the end about as often as not. What
 * is inside is untouched: the capitals in an address are a check the address
 * carries on itself, and correcting the case of what somebody pasted would
 * throw that away before their own wallet could use it.
 */
const walletIn = (request: Request): string => {
  const form = (request.body ?? {}) as { payout_wallet?: unknown };
  return typeof form.payout_wallet === "string" ? form.payout_wallet.trim() : "";
};

/**
 * One line saying who changed something.
 *
 * Be honest about what this is: a process log, not an audit trail. It rotates,
 * it goes with the container, and it is written by the same process it is a
 * record of. What it answers is "who stopped the selling", which before
 * there was a person in the system could not be answered at all.
 *
 * What never goes in: a one-time token or action URL, a session identifier, or
 * the merchant key. A log goes places the environment does not.
 *
 * The whole line goes through `printable` rather than the one field that
 * needed it, and that is on purpose. What made it necessary was the name a
 * merchant gives a key, which the contract deliberately leaves unbounded and
 * open to any alphabet — a name carrying a newline and a plausible sentence
 * would write a second line into the one record of who stopped the selling,
 * in this cabinet's voice and under a name of the writer's choosing. Doing it
 * here rather than at that call site means the next thing somebody
 * interpolates is covered by being here, which is the failure the account
 * command's own rendering was written against.
 */
const noted = (person: Person, did: string): void => {
  console.log(printable(`[cabinet] ${person.email} ${did}`));
};

/** What a merchant is shown when the gateway would not answer. */
function troubleAt(
  response: Response,
  base: string,
  mode: CabinetConfig["surfaceMode"],
  answer: Answer<unknown>,
): void {
  if (answer.ok) {
    return;
  }
  if (answer.status === 401) {
    // The key is on the row of whoever is signed in (ADR-0014 §2), so this is
    // still not a person who should sign in again: their session is valid and
    // opening another cannot make the gateway accept a key it has stopped
    // accepting. Signing them out here would send them to do exactly that and
    // land them straight back on this page, with nothing said about the fault.
    //
    // What is said instead is the whole truth, including the part that is
    // uncomfortable. The cabinet does replace this key, at every sign-in — and
    // it asks for the replacement with the key it is already holding, which is
    // the one being refused here. So signing in again is not the way out
    // either, and saying "try signing in again" would be sending somebody
    // around a loop we know the shape of.
    response
      .status(502)
      .type("html")
      .send(
        problemPageAt(
          base,
          mode,
          "The gateway will not accept the key stored for this account, so none of these" +
            " screens can be drawn. Signing in again does not help: the cabinet asks for a" +
            " fresh key with the one it is holding, and that is the key being refused. A new" +
            " account has to be made for this merchant, by somebody holding a key the gateway" +
            " still accepts. Your sign-in itself is unaffected.",
        ),
      );
    return;
  }
  if (answer.status === 0) {
    // Nothing answered at all. This is the only case in which "the gateway did
    // not answer" is true, and it is a different thing from a gateway that
    // answered and said no — a merchant told the wrong one of those goes and
    // checks a service that is running.
    response
      .status(502)
      .type("html")
      .send(problemPageAt(base, mode, `The gateway did not answer: ${answer.why}`));
    return;
  }
  // The gateway answered and refused. Its own sentence, under its own status:
  // nothing is claimed about what did or did not happen beyond what it said.
  response
    .status(answer.status)
    .type("html")
    .send(problemPageAt(base, mode, answer.why));
}

/**
 * Whether this is the body parser refusing a body, rather than a defect.
 *
 * `body-parser` marks its own refusals with a `type`, which is what this reads;
 * the status it carries is not enough on its own, because an exception from
 * anywhere else can have one too.
 */
function tooLarge(thrown: unknown): boolean {
  return (
    typeof thrown === "object" &&
    thrown !== null &&
    "type" in thrown &&
    (thrown as { type: unknown }).type === "entity.too.large"
  );
}

function problemPageAt(base: string, mode: CabinetConfig["surfaceMode"], said: string): string {
  return bare(
    base,
    "Something went wrong",
    `<div class="gate"><form method="get" action="${escaped(base)}/cards">
<h1>${brandLockup("/")}</h1>
<p>${escaped(said)}</p>
<button type="submit">Try again</button>
</form></div>`,
    mode,
  );
}
