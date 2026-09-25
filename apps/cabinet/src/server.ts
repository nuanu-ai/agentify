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
 * sign-in and the sign-out, the page a mailed link lands on, the stylesheet,
 * the health probe, the shop's own callback and the address a shop sends a
 * browser back to. Each is there because a session cannot reach it, and each
 * answers the same thing to everybody — which is the property that makes the
 * list safe to add to, and the one to check before adding to it.
 */

import { readFileSync } from "node:fs";
import {
  EvmAddressSchema,
  IssueKeyRequestSchema,
  type PayoutWallet as PayoutWalletDocument,
} from "@nuanu-ai/agentify-contracts";
import express, { type Express, type Request, type Response } from "express";
import type {
  CabinetDestination,
  CabinetIdentity,
  LinkDestination,
  Person,
} from "./cabinet-entry.js";
import { keyRenewal, sessionReader } from "./cabinet-key.js";
import type { CabinetConfig } from "./config.js";
import {
  type Answer,
  type GatewayClient,
  gatewayFor,
  type Registrar,
  registrarFor,
} from "./gateway.js";
import { bare, brandLockup, escaped } from "./html.js";
import { SESSION_DAYS } from "./identity.js";
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
  type LinkAnswer,
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
  type Unset,
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
import { moment } from "./words.js";

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
 * How long the cabinet waits on the gateway for a payout wallet change.
 *
 * Longer than a screen's ten seconds, because on the live deployment the
 * gateway does not answer until this cabinet's own announcement listener has
 * handed every message to the mail provider, and it gives that twenty seconds
 * (ADR-0019). A cabinet that stopped waiting first would tell a person the
 * gateway did not answer while their change was being recorded.
 */
const WALLET_CHANGE_MS = 30_000;

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

/**
 * What a person is told when the gate found no session behind their click.
 *
 * The gate cannot tell them why — the session may have gone thirty days
 * without a visit, been signed out in another tab or been revoked — so what it
 * gives is the general rule. Naming the lifetime is what makes being asked for
 * an address again read as the ordinary end of a session rather than as a
 * fault.
 */
const SESSION_ENDED =
  `Your session ended; a session lasts ${SESSION_DAYS} days from your last visit. ` +
  `Send yourself a new link to carry on.`;

const cabinetDestinationIn = (value: unknown): CabinetDestination =>
  value === "settings" || value === "woocommerce" ? value : "default";

/**
 * Where a person who owns no merchant starts (ADR-0026 §1).
 *
 * The scanner's page, because the scanner is what knows whether this person
 * owns a report: it answers with the latest of them, and sends somebody who
 * owns none back to the cabinet, whose first screen offers the one control
 * that makes a merchant. Never that screen for a person with reports, and
 * never the merchant itself, which only the explicit press makes (§4).
 */
export const LATEST_REPORT = "/report/latest";

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
 * ADR-0005 §6 wants one visual language across the surfaces, held in one
 * stylesheet rather than repeated per page, and that file is
 * `packages/visual/tokens.css`. Nothing serves it over HTTP on the deployed
 * origin, so every reader takes it at build time or off disk; the cabinet reads
 * it off disk and serves it inside its own response. That also suits how the
 * cabinet is run: it has to render correctly on its own, without Caddy in front
 * of it, which is how it is developed and how every one of its tests drives it.
 *
 * What matters is that it is one file on disk and not a copy. This branch did
 * carry a copy, with the palette from before the contrast fix, which is how one
 * visual language quietly becomes two that look almost alike.
 */
const TOKENS_AT = new URL("../../../packages/visual/tokens.css", import.meta.url);
const TOKENS = readTokens();

function readTokens(): string {
  try {
    return readFileSync(TOKENS_AT, "utf8");
  } catch (thrown) {
    // An ENOENT here is a packaging mistake — an image built from a context
    // that leaves `packages/visual` out — and the bare exception names a path
    // and nothing about why anybody wanted it. The configuration goes to
    // lengths to name every problem at once; this is the same courtesy for the
    // one file it does not read.
    throw new Error(
      `The cabinet cannot start: it serves the shared visual language from ${TOKENS_AT.pathname},` +
        " which is not there. That file is packages/visual/tokens.css, and ADR-0005 §6 makes" +
        " it the one place every surface takes its palette from — so the cabinet ships" +
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
  readonly payoutWallet: PayoutWalletDocument;
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
  const replaceTheKeyOf = keyRenewal(identity, clientFor);
  /**
   * Who a request's session belongs to. The first reading of a session's day
   * also renews the key on the account (ADR-0014 §2), so every door below that
   * reads a session goes through here and none reads the component directly.
   */
  const sessionIn = sessionReader(identity, replaceTheKeyOf);

  /**
   * The gateway as this request's merchant, built from the key on their row.
   *
   * Only ever called below the gate, which is what makes the merchant's absence
   * a defect here rather than a case: the gate refuses an account that has no
   * key on it, with a sentence saying what to do, precisely so that no handler
   * below has to hold an opinion about a cabinet with nothing to draw.
   */
  const gatewayAs = (request: Request, answerWithinMs?: number): GatewayClient => {
    const merchant = whoIs(request).merchant;
    if (merchant === null) {
      throw new Error(
        "a handler below the gate ran for an account with no merchant on it, which means the" +
          " gate let one through — this is a defect in how the routes are ordered, not a" +
          " visitor's problem",
      );
    }
    return clientFor(merchant.key, answerWithinMs);
  };

  /**
   * Takes the component's cookies out of the browser.
   *
   * Every name it sets, not the session alone: beside the session itself the
   * component keeps two cookies of its own, and clearing only the first would
   * leave the others in a browser for good. The clearing line carries the
   * attributes the session was set with, because a browser replaces a cookie
   * only with a line for the same path, and replaces a `__Host-` one only with
   * a line that is Secure and for the whole origin (ADR-0009 §6).
   */
  const forget = (response: Response): void => {
    for (const name of identity.cookieNames) {
      response.clearCookie(name, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: config.cookieSecure,
      });
    }
  };

  /**
   * Where this person starts when nothing else says where to go: the cabinet
   * for somebody who owns a merchant, and the scanner's latest-report page
   * for anybody else (ADR-0026 §1).
   */
  const startOf = (person: Person): string =>
    person.merchant !== null ? `${base}/cards` : LATEST_REPORT;

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
   * written out here rather than beside the shop screens. A browser can come
   * back from the shop without a live session — the session ended while the
   * merchant was in their shop, or the shop was opened in another browser than
   * the one signed in here — and behind the gate a connection that worked would
   * then end on a sign-in form, which a merchant reads as the connect having
   * failed. It did, twice, when this flow was walked by hand, back when the
   * cookie was `Strict` and no return carried it (ADR-0009 §2). A browser that
   * does carry a session, which under `Lax` is the ordinary case, is sent on
   * into the cabinet.
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
   * spending or expiry ends that. A return that arrives with no session is
   * the one this page is drawn for, so it is the path that has to do the
   * stripping: a redirect to this same address with the query gone, rather
   * than the redirect into the cabinet that a signed-in visitor gets.
   */
  if (parts.wooShops !== undefined) {
    const returnPath = `${base}/woocommerce/return`;
    app.get(returnPath, async (request, response) => {
      const signedIn = await sessionIn(request.headers.cookie);
      if (signedIn !== null) {
        carryCookies(response, signedIn.setCookies);
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
    const signedIn = await sessionIn(request.headers.cookie);
    if (signedIn !== null) {
      carryCookies(response, signedIn.setCookies);
      response.redirect(
        303,
        signedIn.person.merchant === null ? `${base}/merchant` : `${base}/cards`,
      );
      return;
    }
    const destination = cabinetDestinationIn(request.query.destination);
    // A session that ran its course is why the person is here, not something
    // they got wrong, so it is the page's first line rather than a refusal.
    // A change lost with it is a refusal: something they did was not kept.
    const problem =
      request.query.reason === "session-ended-unsaved"
        ? `${SESSION_ENDED} The change you submitted was not saved.`
        : undefined;
    const reason = request.query.reason === "session-ended" ? SESSION_ENDED : undefined;
    response
      .type("html")
      .send(signInScreen(base, config.surfaceMode, destination, problem, "", reason));
  });

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
    // Every answer leaves a wait behind it and the page draws it on the
    // resend. Both waits come from the door, which read them off the same
    // rows: this page never works one out for itself, because the only wait it
    // could guess is the minute, and the minute is wrong on exactly the answer
    // it would be guessing for — the link that spent this address's hour.
    const seconds = Math.max(1, Math.ceil((requested.retryAt.getTime() - Date.now()) / 1_000));
    const answer: LinkAnswer =
      requested.status === "cooldown" ? { wall: requested.wall, seconds } : { sent: true, seconds };
    if ("wall" in answer) {
      response.setHeader("retry-after", String(answer.seconds));
    }
    response
      .status(202)
      .type("html")
      .send(linkRequestedScreen(base, config.surfaceMode, email, destination, answer));
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

  /**
   * Sends a person whose link has just opened on to where it was asked for.
   *
   * Opening a link makes nothing (ADR-0026 §4): under Lax a link from another
   * site arrives signed in, so a navigation that could make a merchant is one
   * anybody could start. What a sign-in does do is renew the cabinet's key
   * for somebody who owns a merchant (ADR-0014 §2), before the cookie is
   * handed over. A link the scanner asked for goes to the report it was asked
   * for, where the scanner finishes the request the session now names. A link
   * with no destination of its own goes to the person's start; one asked for
   * from a cabinet screen goes to that screen, or, for somebody with no
   * merchant yet, to the one control that makes it.
   */
  const sendOpenedPerson = async (
    response: Response,
    person: Person,
    destination: LinkDestination,
  ): Promise<void> => {
    if (person.merchant !== null) {
      await replaceTheKeyOf(person);
    }
    response.redirect(
      303,
      typeof destination !== "string"
        ? `/report/${encodeURIComponent(destination.report)}`
        : destination === "default"
          ? startOf(person)
          : person.merchant === null
            ? `${base}/merchant`
            : cabinetPathFor(base, destination),
    );
  };

  /**
   * The one answer to a link that no longer opens anything.
   *
   * A browser with a live session goes to that session's person's start, so
   * what decides the answer is who the browser is and never whose the link
   * was: it says nothing about the link's address (ADR-0026 §1). Anybody else
   * gets the same refusal for a link pressed twice, one that ran out and one
   * nobody issued.
   */
  const refuseLink = async (request: Request, response: Response): Promise<void> => {
    const signedIn = await sessionIn(request.headers.cookie);
    if (signedIn !== null) {
      carryCookies(response, signedIn.setCookies);
      response.redirect(303, startOf(signedIn.person));
      return;
    }
    response.status(401).type("html").send(refusedLinkScreen(base, config.surfaceMode));
  };

  const linkResponseHeaders = (_request: Request, response: Response, next: () => void): void => {
    response.setHeader("cache-control", "private, no-store");
    // no-referrer makes Chromium send Origin:null on the native POST, which the
    // strict origin gate must refuse. strict-origin keeps the exact origin and
    // sends no query token in Referer.
    response.setHeader("referrer-policy", "strict-origin");
    next();
  };

  /**
   * The page every mailed link lands on: one control, and the address it signs
   * in.
   *
   * Opening it spends nothing, so a mail client that previews the link signs
   * nobody in; only the same-origin press below does. It reads the link to
   * name the address, which is what stops a link for somebody else's address,
   * sent to a victim, from signing them in as that somebody unnoticed
   * (ADR-0026 §1). A link that no longer opens anything is answered here the
   * way the press would answer it.
   */
  app.get(`${base}/sign-in/open`, linkResponseHeaders, async (request, response) => {
    const token = typeof request.query.token === "string" ? request.query.token : "";
    const email = token === "" ? null : await identity.addressOfLink(token);
    if (email === null) {
      await refuseLink(request, response);
      return;
    }
    response.type("html").send(openLinkScreen(base, token, email, config.surfaceMode));
  });
  app.post(`${base}/sign-in/open`, linkResponseHeaders, async (request, response) => {
    const form = (request.body ?? {}) as { token?: unknown };
    const token = typeof form.token === "string" ? form.token : "";
    const opened = token === "" ? { status: "refused" as const } : await identity.openLink(token);
    if (opened.status === "refused") {
      await refuseLink(request, response);
      return;
    }
    carryCookies(response, opened.setCookies);
    await sendOpenedPerson(response, opened.person, opened.destination);
  });

  // The rows go, not merely the cookies. Clearing a cookie asks the browser to
  // forget something; anybody who copied the value still holds a session.
  // Every identifier the request carried, not one of them: a browser sends
  // cookies of one name longest-path first and then oldest first, so the one
  // this person is signed in on is not necessarily the first. It signs this
  // browser out of the whole site and leaves other devices alone, and it ends
  // on the sign-in page with an empty field, because people mostly sign out to
  // come back as another address (ADR-0026 §3). It stands above the gate so a
  // tab whose session has already gone can still clear its cookie.
  app.post(`${base}/sign-out`, async (request, response) => {
    await identity.signOut(request.headers.cookie);
    console.log("[cabinet] a session was signed out");
    forget(response);
    response.redirect(303, `${base}/sign-in`);
  });

  /**
   * The gate. Everything below this line needs a session; everything above it
   * is the sign-in and the sign-out, the page a link lands on, the stylesheet,
   * the health probe, the shop's callback and the address a shop sends a
   * browser back to — ADR-0009 §2's list, which a test holds.
   *
   * A visitor without one is answered the same way at every address, which is
   * why this is a middleware and not a check inside each handler: a page added
   * below is guarded by being below, and a stranger cannot tell which addresses
   * this cabinet serves from which it does not.
   */
  app.use((request, response, next) => {
    void (async () => {
      try {
        const session = await sessionIn(request.headers.cookie);
        if (session === null) {
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
          // The wallet screen is where a message about a payout wallet change
          // sends a person, with no token in it (ADR-0019), so a signed-out
          // visit there comes back there after an ordinary sign-in, cookie or
          // none.
          const toTheWallet =
            (request.method === "GET" || request.method === "HEAD") &&
            request.path === `${base}/settings`;
          response.redirect(
            303,
            hadIdentityCookie
              ? `${base}/sign-in?reason=${reason}${destination}${toTheWallet ? "&destination=settings" : ""}`
              : `${base}/sign-in${
                  toTheWallet
                    ? "?destination=settings"
                    : destination === ""
                      ? ""
                      : "?destination=woocommerce"
                }`,
          );
          return;
        }
        // Once a day the reading moves the session's end, and the browser has
        // to be told or its cookie runs out thirty days after sign-in however
        // often its person came back.
        carryCookies(response, session.setCookies);
        // Every page behind the gate carries the signed-in address in its
        // header, and a page carrying an address is never stored by a shared
        // cache (ADR-0026 §3).
        response.setHeader("cache-control", "private, no-store");
        people.set(request, session.person);
        next();
      } catch (thrown) {
        next(thrown);
      }
    })();
  });

  app.get(`${base}/`, (request, response) => {
    response.redirect(303, whoIs(request).merchant === null ? `${base}/merchant` : `${base}/cards`);
  });

  /**
   * The screen a signed-in person without a merchant is offered, with the one
   * control that makes it (ADR-0026 §4). Drawing it makes nothing: only the
   * same-origin press below asks the gateway for the merchant and its key.
   */
  app.get(`${base}/merchant`, (request, response) => {
    const person = whoIs(request);
    if (person.merchant !== null) {
      response.redirect(303, `${base}/cards`);
      return;
    }
    response.type("html").send(merchantSetupScreen(base, config.surfaceMode, person.email));
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
    // A gateway that did not answer leaves the person signed in to press
    // again, rather than spending another link.
    response
      .status(503)
      .type("html")
      .send(merchantSetupScreen(base, config.surfaceMode, person.email, true));
  });
  // A person without a merchant reaches only the screen above, its press and
  // the sign-out. Every commerce route below requires the complete merchant
  // pair, and sends anybody else to the one control that makes it.
  app.use((request, response, next) => {
    if (whoIs(request).merchant === null) {
      response.redirect(303, `${base}/merchant`);
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

    const set = await gatewayAs(request, WALLET_CHANGE_MS).setPayoutWallet(typed);
    if (!set.ok) {
      return trouble(response, base, set);
    }
    // The address itself stays out of the line. It is not a secret, but this
    // log is a process log and the record of who changed it is what it is for.
    noted(
      whoIs(request),
      set.document.pending === null
        ? "changed the address their money arrives at"
        : "asked for a change of the address their money arrives at, which now waits",
    );
    response.redirect(303, `${base}/settings`);
  });

  /**
   * Cancels a replacement wallet that waits, and signs out every session of
   * the merchant but the one that pressed (ADR-0019).
   *
   * Cancelling is asking the gateway for the address that applies now, which
   * is what the gateway reads as a cancel — so the cabinet holds no power over
   * the wallet that a merchant's own code does not. It reads the wallet first
   * rather than trusting a page that may be a day old.
   *
   * The sessions go because the change may have been asked for from one of
   * them — a device left signed in, somebody else at the merchant — and the
   * person pressing here is the one known to be looking. Only once something
   * came of the press: a cancel the gateway refused leaves the change waiting,
   * and signing people out over it would take away the sessions that might
   * press again; a press on a stale page with nothing waiting does nothing.
   *
   * Two presses are not cancels, and neither is called one, on the page or in
   * the log. The form carries the change it showed, so a press arriving after
   * that change took effect is recognised: the money is already going to the
   * new address, nothing takes that back at once, and the page says when it
   * took effect and that the old address comes back only through a change
   * that waits and is announced — and the other sessions still end, since this
   * is the moment an unwanted change has just landed. And a change that takes
   * effect between the read and the press turns the request for the old
   * address into exactly such a change back, which the gateway announces and
   * records as waiting; the page says so.
   */
  app.post(`${base}/settings/payout-wallet/cancel`, async (request, response) => {
    const gateway = gatewayAs(request, WALLET_CHANGE_MS);
    const read = await gateway.payoutWallet();
    if (!read.ok) {
      return trouble(response, base, read);
    }
    const shown = shownIn(request);
    const { payout_wallet: applies, pending } = read.document;
    const person = whoIs(request);
    const signOutTheOthers = async (): Promise<number> =>
      person.merchant === null
        ? 0
        : await identity.endOtherSessionsOfMerchant(person.merchant.id, request.headers.cookie);
    const withNotice = async (notice: string): Promise<void> => {
      const settings = await settingsOf(request);
      if (!settings.ok) {
        return trouble(response, base, settings);
      }
      const viewer = viewingSettings(request, base, settings.document);
      response
        .type("html")
        .send(
          settingsScreen(
            viewer.payout === undefined
              ? viewer
              : { ...viewer, payout: { ...viewer.payout, notice } },
          ),
        );
    };

    if (pending !== null && applies !== null) {
      const cancelled = await gateway.setPayoutWallet(applies);
      if (!cancelled.ok) {
        return trouble(response, base, cancelled);
      }
      const ended = await signOutTheOthers();
      if (cancelled.document.pending === null) {
        noted(
          person,
          `cancelled a waiting change of the address their money arrives at, and ${ended} other sessions of the merchant were ended`,
        );
        response.redirect(303, `${base}/settings`);
        return;
      }
      noted(
        person,
        `pressed cancel as a change of the address their money arrives at took effect; the previous address was asked for back, which now waits, and ${ended} other sessions of the merchant were ended`,
      );
      return await withNotice(
        `The change to ${pending.payout_wallet} took effect at ${moment(pending.takes_effect_at)}, as you pressed. ` +
          `Asking for ${applies} back is a change like any other: it waits forty-eight hours and every account of your merchant was sent a message about it. ` +
          "Every other session of your merchant was signed out.",
      );
    }

    if (shown !== null && applies === shown.waiting) {
      const ended = await signOutTheOthers();
      noted(
        person,
        `pressed cancel after a change of the address their money arrives at had taken effect, and ${ended} other sessions of the merchant were ended`,
      );
      return await withNotice(
        `The change to ${shown.waiting} took effect at ${shown.from === null ? "its moment" : moment(shown.from)}, before you pressed, and your sales are now paid into it. ` +
          (shown.paid === null
            ? "Setting another address back is a change like any other: it waits forty-eight hours and is announced. "
            : `Setting ${shown.paid} back is a change like any other: it waits forty-eight hours and is announced. `) +
          "Every other session of your merchant was signed out.",
      );
    }

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

    /**
     * The merchant as the publish door will judge them before it looks at any
     * card: the name they are listed under, and which of the things the door
     * asks of a merchant are still unset.
     *
     * The door asks for a seller name on every channel and for a wallet on
     * every channel but the sandbox (`payableTo` in the gateway). This cabinet
     * is given the same chain and facilitator as its gateway, so its own
     * surface mode answers the second question the way the door does. The
     * door's third rule about a merchant, the operator's approval on the live
     * channel, is not here: no route tells a merchant's key whether it holds
     * one, so on that channel the door's own sentence still carries it.
     */
    const standingOf = async (
      request: Request,
    ): Promise<
      Answer<{ readonly sellerName: string | null; readonly unset: readonly Unset[] }>
    > => {
      const gateway = gatewayAs(request);
      const [name, wallet] = await Promise.all([gateway.sellerName(), gateway.payoutWallet()]);
      if (!name.ok) {
        return name;
      }
      if (!wallet.ok) {
        return wallet;
      }
      const unset: Unset[] = [];
      if (name.document === null) {
        unset.push("seller_name");
      }
      if (config.surfaceMode !== "sandbox" && wallet.document.payout_wallet === null) {
        unset.push("payout_wallet");
      }
      return { ok: true, document: { sellerName: name.document, unset } };
    };

    /** The page, drawn from where the channel is and from what buyers read. */
    const drawTheShop = async (
      request: Request,
      response: Response,
      view: { problem?: string; typed?: string; cameBack?: boolean; refused?: readonly Unset[] },
      status = 200,
    ): Promise<void> => {
      const person = whoIs(request);
      const [state, standing] = await Promise.all([shopStateFor(person.id), standingOf(request)]);
      if (!standing.ok) {
        return trouble(response, base, standing);
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
        .send(
          wooScreen(viewing(request, base, standing.document.sellerName), {
            ...view,
            state,
            unset: standing.document.unset,
          }),
        );
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

      // Asked before the shop is. The door refuses every card of a merchant
      // missing any of these, whatever the card says, so an import that went
      // ahead would read the shop and inspect every product for nothing, and
      // then show the door's refusal once per product in words that name an
      // API route. A gateway that cannot answer this would not take a card
      // either, so that too is said before the shop is read.
      const standing = await standingOf(request);
      if (!standing.ok) {
        return trouble(response, base, standing);
      }
      if (standing.document.unset.length > 0) {
        noted(
          person,
          `pressed Import with ${standing.document.unset.join(" and ")} unset, so the shop at` +
            ` ${connection.shopUrl} was not read and nothing was published`,
        );
        return await drawTheShop(request, response, { refused: standing.document.unset }, 409);
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

    // The rest of the rule is the contract's, asked of it rather than written
    // out again: one line, at most the length the gateway takes, which is
    // also how the live site's message about the key names it (ADR-0019).
    const unfit = IssueKeyRequestSchema.shape.label.safeParse(label);
    if (!unfit.success) {
      const keys = await gateway.keys();
      if (!keys.ok) {
        return trouble(response, base, keys);
      }
      const said = unfit.error.issues[0]?.message ?? "that name cannot be given to a key";
      response
        .status(400)
        .type("html")
        .send(
          keysScreen(
            viewing(request, base),
            keys.document,
            `${said.slice(0, 1).toUpperCase()}${said.slice(1)}. No key was issued.`,
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
 * SameSite=Lax on the cookie is the first answer and the main one: a cross-site
 * POST carries no Lax cookie, exactly as it carried no Strict one (ADR-0009
 * §6). This is the second, and it exists because SameSite is scoped to the
 * registrable domain rather than to the origin — `test.agentify.ad` beside
 * `agentify.ad` is "same site", and a page there could otherwise forge every
 * switch here.
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
    wallet: settings.payoutWallet.payout_wallet,
    pending:
      settings.payoutWallet.pending === null
        ? null
        : {
            wallet: settings.payoutWallet.pending.payout_wallet,
            takesEffectAt: settings.payoutWallet.pending.takes_effect_at,
          },
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
 * The change a cancel form showed, as it posted it, or null where it carried
 * none a cancel can be read against.
 *
 * Each value is held to the shape it was drawn in before anything reads it:
 * an address to the address rule and the moment to one a date can be made
 * of. The form is the person's own page, but a post can carry anything, and
 * these values are shown back on the page.
 */
const shownIn = (
  request: Request,
): { waiting: string; from: string | null; paid: string | null } | null => {
  const form = (request.body ?? {}) as Record<string, unknown>;
  const address = (value: unknown): string | null =>
    typeof value === "string" && EvmAddressSchema.safeParse(value).success ? value : null;
  const waiting = address(form.waiting);
  if (waiting === null) return null;
  const from =
    typeof form.waiting_from === "string" && !Number.isNaN(Date.parse(form.waiting_from))
      ? form.waiting_from
      : null;
  return { waiting, from, paid: address(form.paid) };
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
    `<div class="gate">
${brandLockup("/")}
<form class="gate-card" method="get" action="${escaped(base)}/cards">
<h1>Something went wrong</h1>
<p>${escaped(said)}</p>
<button class="button button-primary" type="submit">Try again</button>
</form>
</div>`,
    mode,
  );
}
