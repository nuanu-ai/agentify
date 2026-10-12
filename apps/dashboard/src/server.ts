/**
 * The dashboard's HTTP surface, server-rendered with no client framework and no
 * build step: every page is one GET and every change is one form post followed
 * by a redirect, so back, reload and find-in-page work and no page needs
 * JavaScript. Sign-in is the component's job; handlers call its server-side API
 * with a body built from a parsed form and pass on the cookie it produces.
 * Nothing here decides anything about a card, an order or money: each handler
 * translates one request into calls on the gateway's application, as the
 * merchant on the signed-in account's row.
 *
 * Access is one middleware, not a check per handler, so a page added below the
 * gate is guarded by being below it. A visitor with no session is sent to the
 * sign-in from every address; the sign-in names the section the address belongs
 * to, which reveals only section names already in the open repository. What
 * stands above the gate is short and a test holds the list: the stylesheet, the
 * health probe, the shop's callback and the shop's return address here, and the
 * sign-in pages, which React Router draws in front of the same gate. Each
 * answers the same thing to everybody, which is the property to check before
 * adding to it.
 */

import { readFileSync } from "node:fs";
import { readinessOf, UNKNOWN } from "@agentify/core";
import type { Gateway } from "@agentify/gateway";
import {
  type CardInput,
  EvmAddressSchema,
  IssueKeyRequestSchema,
  MERCHANT_FINDINGS,
  type PayoutWallet as PayoutWalletDocument,
  type PublishResult,
} from "@nuanu-ai/agentify-contracts";
import express, { type Express, type Request, type Response } from "express";
import type { DashboardConfig } from "./config.js";
import type { DashboardIdentity, Person } from "./dashboard-entry.js";
import { DRAWN_FOR } from "./drawn-for.js";
import { gateFor } from "./gate.js";
import {
  type Acting,
  type Answer,
  type GatewayClient,
  gatewayFor,
  type Registrar,
  registrarFor,
} from "./gateway.js";
import { bare, brandLockup, escaped } from "./html.js";
import { keysScreen, newKeyScreen } from "./keys.js";
import { pageServicesFor } from "./page-services.js";
import { type Pages, pagesHandler } from "./pages.js";
import { WALLET_NEEDED, whatIsWrongWithTheWallet } from "./payout-wallet.js";
import { printable } from "./printable.js";
import { notDrawnForYouScreen, notFoundScreen, unsetIn, type Viewer } from "./screens.js";
import {
  integrationsScreen,
  NAME_CANNOT_BE_TAKEN_AWAY,
  SITE_CANNOT_BE_TAKEN_AWAY,
  settingsScreen,
  whatIsWrongWithTheName,
  whatIsWrongWithTheSite,
} from "./seller-name.js";
import {
  cardsFromTheShop,
  decimalOfMinorUnits,
  merchantItemIdFor,
  USD_SCALE,
} from "./woo-catalog.js";
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
import { type WooConnection, type WooShops, wooOfferedOn } from "./woo-shops.js";
import { moment, SITE_IN_SETTINGS, type Unset } from "./words.js";

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
 * Longer than a screen's ten seconds: on live the gateway answers only after
 * this dashboard has handed every announcement to the mail provider, which may
 * take twenty seconds (`ANNOUNCEMENT_ANSWER_MS` in the gateway). Stopping
 * sooner would tell a person the gateway did not answer while their change was
 * being recorded.
 */
const WALLET_CHANGE_MS = 30_000;

/**
 * The shared visual language, then the dashboard's own layout, read once at
 * startup. The shared file is read off disk rather than served separately, so
 * the dashboard renders correctly on its own, without Caddy, as in development
 * and in every test; it must stay one file, never a copy.
 */
const TOKENS_AT = new URL("../../../packages/visual/tokens.css", import.meta.url);
const TOKENS = readTokens();

function readTokens(): string {
  try {
    return readFileSync(TOKENS_AT, "utf8");
  } catch (thrown) {
    // A missing file is a packaging mistake (an image built without
    // `packages/visual`), so the error says why the file is wanted.
    throw new Error(
      `The dashboard cannot start: it serves the shared visual language from ${TOKENS_AT.pathname},` +
        " which is not there. That file is packages/visual/tokens.css, the one place every" +
        " surface takes its palette from — so the dashboard ships" +
        ` beside it rather than carrying a copy. ${String(thrown)}`,
    );
  }
}
const STYLESHEET = `${TOKENS}\n${readFileSync(new URL("./agentify.css", import.meta.url), "utf8")}`;

export interface DashboardParts {
  /** The pages drawn by React Router, which answer in front of the string ones. */
  readonly pages: Pages;
  /**
   * `identity.ts` over Postgres in a deployment, over the component's memory
   * store in tests, so the suite drives the real component offline.
   */
  readonly identity: DashboardIdentity;
  /** Called in-process as the merchant on the signed-in account's row. */
  readonly gateway: Gateway;
  /**
   * Built per request from whoever is signed in, so two people signed into one
   * dashboard are two merchants. Only tests pass another, to get a refusal or a
   * call that never finishes. The deadline is the caller's because a wallet
   * change waits longer than a screen does (`WALLET_CHANGE_MS`).
   */
  readonly clientFor?: (acting: Acting, answerWithinMs?: number) => GatewayClient;
  /**
   * Not a client method, because the person has no merchant yet to bind a
   * client to.
   */
  readonly registrar?: Registrar;
  /**
   * Absent means no WooCommerce screens at all rather than screens that fail: a
   * page offering to connect a shop it cannot write down would lose somebody's
   * keys.
   */
  readonly wooShops?: WooShops;
  /**
   * Only tests pass another. Both real calls reach a shop over https, and a
   * loopback shop would be refused before either ran, so the calls are handed
   * in rather than the shop stood up.
   */
  readonly shop?: {
    readonly grantScreen: (authorizeUrl: string) => Promise<Preflight>;
    readonly catalogue: (shopUrl: string, atMost?: number) => Promise<CatalogueRead>;
    readonly inspectProduct: (
      keys: WooConnection,
      merchantItemId: string,
    ) => Promise<ProductInspection>;
  };
}

/**
 * A map keyed by the request rather than a property added to it, so the type
 * system knows who is signed in.
 */
const people = new WeakMap<Request, Person>();

/**
 * The shop is present only where this dashboard has somewhere to keep a
 * connection; absent draws no block about a shop. `unread` is a store that did
 * not answer.
 */
interface Settings {
  readonly sellerName: string | null;
  readonly sellerSite: string | null;
  readonly payoutWallet: PayoutWalletDocument;
  /** Read on the live channel only. */
  readonly liveApproval?: boolean;
}

export function buildApp(config: DashboardConfig, parts: DashboardParts): Express {
  const app = express();
  const base = config.basePath;
  // Where the connector is not offered none of its screens is mounted, so
  // nothing invites an owner into what does not work there.
  const wooShops = wooOfferedOn(config.surfaceMode) ? parts.wooShops : undefined;
  const viewing = (request: Request, pageBase: string, sellerName?: string | null): Viewer =>
    viewingAt(request, pageBase, config.surfaceMode, sellerName);
  /**
   * Read only on live, the one place publishing needs it; elsewhere nothing is
   * read or said about it.
   */
  const approvalOn = async (gateway: GatewayClient): Promise<Answer<boolean | undefined>> =>
    config.surfaceMode === "live"
      ? await gateway.liveApproval()
      : { ok: true, document: undefined };
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
    parts.clientFor ??
    ((acting: Acting, answerWithinMs?: number) =>
      gatewayFor(parts.gateway, acting, answerWithinMs));
  /**
   * Only called below the gate, which sends an account with no merchant to the
   * control that makes one, so a missing merchant here is a defect, not a case.
   */
  const gatewayAs = (request: Request, answerWithinMs?: number): GatewayClient => {
    const person = whoIs(request);
    const merchant = person.merchant;
    if (merchant === null) {
      throw new Error(
        "a handler below the gate ran for an account with no merchant on it, which means the" +
          " gate let one through — this is a defect in how the routes are ordered, not a" +
          " visitor's problem",
      );
    }
    return clientFor({ merchantId: merchant.id, email: person.email }, answerWithinMs);
  };

  const gate = gateFor(base, identity, config.cookieSecure);

  /**
   * The component's own lines, passed on rather than rebuilt: the cookie's
   * settings are decided once, in `identity.ts`, and a second copy would be a
   * second thing to get wrong where it matters most, in production.
   */
  const carryCookies = (response: Response, cookies: readonly string[]): void => {
    for (const line of cookies) {
      response.append("set-cookie", line);
    }
  };

  app.disable("x-powered-by");
  // No `trust proxy`: nothing reads the client's address, and express would put
  // a spoofable value behind `request.ip` and `request.secure` where nobody
  // reading a handler would doubt it.
  app.use(sameOriginUnder(base, config.surfaceMode));
  if (parts.pages.assets !== null) {
    app.use(parts.pages.assets.path, parts.pages.assets.handle);
  }
  // Ahead of the body parser, because React Router reads a form itself.
  app.use(
    pagesHandler(
      parts.pages,
      pageServicesFor(config, {
        identity,
        clientFor: (acting) => clientFor(acting),
        registrar: parts.registrar ?? registrarFor(parts.gateway),
        wooOffered: wooShops !== undefined,
      }),
    ),
  );
  // Only small forms are posted here.
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));

  // At BASE_PATH behind the shared origin, and at the root for a container
  // health check: a probe answering 404 reads as a dead process.
  for (const path of new Set(["/healthz", `${base}/healthz`])) {
    app.get(path, (_request, response) => {
      response.json({ ok: true });
    });
  }

  app.get(`${base}/agentify.css`, (_request, response) => {
    response.type("text/css").send(STYLESHEET);
  });

  /**
   * Above the gate because it must be: the shop's own server posts here with no
   * cookie or key of ours. What stands in for a session is the one-time token
   * the shop hands back as `user_id`, written when the merchant pressed
   * Connect, bound to their account and the shop they typed, and spent on
   * arrival. Without it anybody could put their own shop's keys on somebody
   * else's account.
   *
   * The status is the answer: WooCommerce deletes the key it minted when the
   * post fails (`class-wc-auth.php`, `maybe_delete_key`), so a refusal takes
   * the key back out of the shop, which is right for a token we do not
   * recognise. Nothing below answers 200 out of politeness. It parses its own
   * JSON body so a JSON parser is not run on every form post.
   */
  app.post(`${base}/woocommerce/callback`, express.json({ limit: "16kb" }), (request, response) => {
    void (async () => {
      const shops = wooShops;
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
        console.log("[dashboard] a WooCommerce callback arrived without the keys it has to carry");
        response.status(400).json({ ok: false });
        return;
      }

      // Consumed together with the connection write: a token that worked twice
      // would let anybody who saw one put a second shop's keys on the account,
      // and consuming first would let an older callback overwrite a newer
      // Connect in between.
      const connectedAt = new Date();
      const connection = await shops.connectFromGrant(
        token,
        { consumerKey, consumerSecret, permissions },
        connectedAt,
      );
      if (connection === null) {
        // One answer for a token nobody issued, one spent and one expired:
        // telling them apart would answer questions about somebody else's
        // account.
        console.log("[dashboard] a WooCommerce callback arrived with a token we do not hold");
        response.status(401).json({ ok: false });
        return;
      }

      // The address and the scope, never the keys: a log goes places the
      // database does not.
      console.log(
        printable(
          `[dashboard] a WooCommerce shop was connected for an account: ${connection.shopUrl}, ${permissions}`,
        ),
      );
      response.json({ ok: true });
    })().catch((thrown) => {
      // A failure, so the shop takes its key back rather than keeping one
      // nothing here knows about.
      console.error("[dashboard] a WooCommerce callback could not be written down", thrown);
      if (!response.headersSent) {
        response.status(500).json({ ok: false });
      }
    });
  });

  /**
   * Above the gate: a browser can come back from the shop without a session (it
   * ended meanwhile, or the shop was opened in another browser), and a sign-in
   * form at the end of a working Connect reads as failure. A browser with a
   * session, the ordinary case under `Lax`, is sent on into the dashboard.
   * Without a session this route reads no row, asks the gateway nothing and
   * draws the same page for everybody, so a stranger learns only that the
   * address exists.
   *
   * The token comes out of the address bar first: WooCommerce hands `user_id`
   * back here, and when the keys never arrived it is unspent for the rest of
   * its fifteen minutes. Redirecting to the same address without the query
   * keeps it out of the address bar, history and any `Referer`; it cannot
   * remove it from the logs of the request that already happened, which only
   * spending or expiry ends.
   */
  if (wooShops !== undefined) {
    const returnPath = `${base}/woocommerce/return`;
    app.get(returnPath, async (request, response) => {
      const signedIn = await identity.whoIs(request.headers.cookie);
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

  /**
   * The gate: everything below needs a session; everything above is on the list
   * a test holds.
   */
  app.use((request, response, next) => {
    void (async () => {
      try {
        const answer = await gate({
          cookie: request.headers.cookie,
          method: request.method,
          path: request.path,
          drawnFor: (request.body as Record<string, unknown> | undefined)?.[DRAWN_FOR],
        });
        carryCookies(response, answer.setCookies);
        if (answer.kind === "signed-out") {
          response.redirect(303, answer.location);
          return;
        }
        // Every page behind the gate shows the signed-in address, so no shared
        // cache may store it.
        response.setHeader("cache-control", "private, no-store");
        if (answer.kind === "not-drawn-for-you") {
          response
            .status(409)
            .type("html")
            .send(notDrawnForYouScreen(base, config.surfaceMode, answer.who, answer.start));
          return;
        }
        people.set(request, answer.person);
        next();
      } catch (thrown) {
        next(thrown);
      }
    })();
  });

  // A person without a merchant reaches only the screen that makes one, its
  // press and the sign-out, all drawn by React Router; every commerce route
  // below needs the complete merchant and sends anybody else to that screen.
  app.use((request, response, next) => {
    if (whoIs(request).merchant === null) {
      response.redirect(303, `${base}/merchant`);
      return;
    }
    next();
  });

  /**
   * One function for both screens, so they cannot decide a state differently,
   * and the only place the clock is held against a Connect. A connection wins
   * over a pending Connect for a second shop: the merchant stays connected
   * until new keys arrive. `undefined` means nowhere to keep a connection,
   * which draws no block.
   */
  const shopStateFor = async (accountId: string): Promise<ShopState | undefined> => {
    const shops = wooShops;
    if (shops === undefined) {
      return undefined;
    }
    const connection = await shops.connectionOf(accountId);
    if (connection !== null) {
      return {
        kind: "connected",
        // The fields a screen may know, never the row: the key and secret are a
        // stranger's credential at rest, and screens that cannot reach them
        // cannot draw them.
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
      // Rounded down, so forty seconds reads "less than a minute": a number a
      // merchant can watch climb is worth more than one right on average.
      startedMinutesAgo: Math.floor((now - waiting.startedAt.getTime()) / 60_000),
    };
  };

  /**
   * In one place because the screen is reached three ways (opened, and redrawn
   * after either form is refused), and a forgotten answer in one of them would
   * look like a merchant who has set nothing. The calls go out together. Either
   * gateway call failing fails the page: drawn without an answer, it would
   * claim something about a field nobody asked about.
   */
  const settingsOf = async (request: Request): Promise<Answer<Settings>> => {
    const gateway = gatewayAs(request);
    const [seller, wallet, approval] = await Promise.all([
      gateway.seller(),
      gateway.payoutWallet(),
      approvalOn(gateway),
    ]);
    if (!seller.ok) {
      return seller;
    }
    if (!wallet.ok) {
      return wallet;
    }
    if (!approval.ok) {
      return approval;
    }
    return {
      ok: true,
      document: {
        sellerName: seller.document.name,
        sellerSite: seller.document.site,
        payoutWallet: wallet.document,
        ...(approval.document === undefined ? {} : { liveApproval: approval.document }),
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

  // Nothing on this page comes from the gateway, so the gateway cannot take it
  // down. A shops read that throws is logged and drawn as "could not be read",
  // not as no block: a vanished block reads as no connection to a merchant who
  // has one.
  app.get(`${base}/integrations`, async (request, response) => {
    const shop = await shopStateFor(whoIs(request).id).catch((thrown: unknown): ShopTile => {
      console.error(
        "[dashboard] the WooCommerce connection could not be read for the integrations screen",
        thrown,
      );
      return { kind: "unread" };
    });
    response
      .type("html")
      .send(
        integrationsScreen({ ...viewing(request, base), ...(shop === undefined ? {} : { shop }) }),
      );
  });

  // Opened from history or the address bar after a refusal; it leads to the
  // page the form lives on.
  app.get(`${base}/settings/payout-wallet`, (_request, response) => {
    response.redirect(303, `${base}/settings`);
  });

  app.post(`${base}/settings`, async (request, response) => {
    const typed = nameIn(request);
    // Empty is a merchant trying to stop being listed, and the sentence names
    // the control that does that; refused here, the answer is about what they
    // meant.
    const wrong = typed === "" ? NAME_CANNOT_BE_TAKEN_AWAY : whatIsWrongWithTheName(typed);
    if (wrong !== null) {
      // Drawn from what the gateway has rather than what was typed: a refused
      // name in the box under "the name buyers read" would be a name they are
      // not listed under.
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
    // A redirect, so a reload does not send the name again.
    response.redirect(303, `${base}/settings`);
  });

  app.post(`${base}/settings/site`, async (request, response) => {
    const typed = siteIn(request);
    // Empty is a merchant trying to remove the site, which the gateway refuses;
    // the sentence says what to do instead.
    const wrong = typed === "" ? SITE_CANNOT_BE_TAKEN_AWAY : whatIsWrongWithTheSite(typed);
    if (wrong !== null) {
      // Drawn from what the gateway has, with the typed value kept in the box
      // to be corrected.
      const settings = await settingsOf(request);
      if (!settings.ok) {
        return trouble(response, base, settings);
      }
      response
        .status(400)
        .type("html")
        .send(
          settingsScreen(viewingSettings(request, base, settings.document), undefined, undefined, {
            problem: wrong,
            typed,
          }),
        );
      return;
    }

    const set = await gatewayAs(request).setSellerSite(typed);
    if (!set.ok) {
      return trouble(response, base, set);
    }
    noted(whoIs(request), "changed the site of their shop");
    response.redirect(303, `${base}/settings`);
  });

  /**
   * Ends every other session of this account and keeps this one: the answer to
   * a session left open somewhere or held by somebody else. It ends no other
   * account's sessions and touches no key. The page says how many it ended, the
   * one thing the person could not otherwise see.
   */
  app.post(`${base}/settings/sign-out-others`, async (request, response) => {
    const person = whoIs(request);
    const ended = await identity.endOtherSessionsOfPerson(person.id, request.headers.cookie);
    noted(person, `signed out every other device of their account, ${ended} sessions in all`);
    const settings = await settingsOf(request);
    if (!settings.ok) {
      return trouble(response, base, settings);
    }
    response.type("html").send(
      settingsScreen({
        ...viewingSettings(request, base, settings.document),
        accountNotice:
          ended === 0
            ? "No other session of this account was signed in, so none was signed out."
            : ended === 1
              ? "1 other session of this account was signed out."
              : `${ended} other sessions of this account were signed out.`,
      }),
    );
  });

  const signOutTheOthers = async (request: Request): Promise<number> => {
    const person = whoIs(request);
    return person.merchant === null
      ? 0
      : await identity.endOtherSessionsOfMerchant(person.merchant.id, request.headers.cookie);
  };

  /** With one sentence above the wallet. */
  const withNotice = async (
    request: Request,
    response: Response,
    notice: string,
    status = 200,
  ): Promise<void> => {
    const settings = await settingsOf(request);
    if (!settings.ok) {
      return trouble(response, base, settings);
    }
    const viewer = viewingSettings(request, base, settings.document);
    response
      .status(status)
      .type("html")
      .send(
        settingsScreen(
          viewer.payout === undefined
            ? viewer
            : { ...viewer, payout: { ...viewer.payout, notice } },
        ),
      );
  };

  /**
   * Cancelling is asking the gateway for the address that applies now. Reached
   * by the Cancel control or by typing that address while a change waits;
   * typed, the person may not know they cancelled, so the screen says so. Other
   * sessions end, or the one that asked for the change could ask again. A
   * change that took effect between the read and the request is not cancelled:
   * the old address is then a change back, which waits and is announced, and
   * the page and log say so.
   */
  const cancelWaiting = async (
    request: Request,
    response: Response,
    gateway: GatewayClient,
    applies: string,
    pending: { readonly payout_wallet: string; readonly takes_effect_at: string },
    typedIn: boolean,
  ): Promise<void> => {
    const person = whoIs(request);
    const cancelled = await gateway.setPayoutWallet(applies);
    if (!cancelled.ok) {
      return trouble(response, base, cancelled);
    }
    const ended = await signOutTheOthers(request);
    if (cancelled.document.pending === null) {
      noted(
        person,
        `cancelled a waiting change of the address their money arrives at, and ${ended} other sessions of the merchant were ended`,
      );
      if (typedIn) {
        return await withNotice(
          request,
          response,
          `${applies} is the address your sales are paid into now, so the waiting change to ${pending.payout_wallet} was cancelled. ` +
            "Every other session of your merchant was signed out.",
        );
      }
      response.redirect(303, `${base}/settings`);
      return;
    }
    noted(
      person,
      `asked for the address their money arrives at back as a change of it took effect; that now waits, and ${ended} other sessions of the merchant were ended`,
    );
    return await withNotice(
      request,
      response,
      `The change to ${pending.payout_wallet} took effect at ${moment(pending.takes_effect_at)}, just before your request reached it. ` +
        `Asking for ${applies} back is a change like any other: it waits forty-eight hours and every account of your merchant was sent a message about it. ` +
        "Every other session of your merchant was signed out.",
    );
  };

  /**
   * A press from a page drawn while a change waited, arriving after it took
   * effect. Nothing takes the change back at once, so the gateway is not asked;
   * the page says when it took effect and how the old address comes back, and
   * the other sessions end, since an unwanted change has just landed.
   */
  const tookEffectBeforePress = async (
    request: Request,
    response: Response,
    shown: { readonly waiting: string; readonly from: string | null; readonly paid: string | null },
    how: string,
  ): Promise<void> => {
    const ended = await signOutTheOthers(request);
    noted(
      whoIs(request),
      `${how} after a change of the address their money arrives at had taken effect, and ${ended} other sessions of the merchant were ended`,
    );
    return await withNotice(
      request,
      response,
      `The change to ${shown.waiting} took effect at ${shown.from === null ? "its moment" : moment(shown.from)}, before you pressed, and your sales are now paid into it. ` +
        (shown.paid === null
          ? "Setting another address back is a change like any other: it waits forty-eight hours and is announced. "
          : `Setting ${shown.paid} back is a change like any other: it waits forty-eight hours and is announced. `) +
        "Every other session of your merchant was signed out.",
    );
  };

  /**
   * Its own route rather than a second field on the name's: sharing one would
   * make every name save also rewrite the address, which turns a typo in one
   * box into a payment sent elsewhere. Checked here as well as at the gateway,
   * so an address of the wrong shape never leaves this process.
   */
  app.post(`${base}/settings/payout-wallet`, async (request, response) => {
    const typed = walletIn(request);
    const wrong = typed === "" ? WALLET_NEEDED : whatIsWrongWithTheWallet(typed);
    if (wrong !== null) {
      const settings = await settingsOf(request);
      if (!settings.ok) {
        return trouble(response, base, settings);
      }
      // Redrawn from the address the gateway has, so a refused merchant still
      // sees where their money actually goes.
      response
        .status(400)
        .type("html")
        .send(settingsScreen(viewingSettings(request, base, settings.document, wrong, typed)));
      return;
    }

    const gateway = gatewayAs(request, WALLET_CHANGE_MS);
    // With a change waiting, the current address is a cancel at the gateway,
    // and is treated as one here.
    const read = await gateway.payoutWallet();
    if (!read.ok) {
      return trouble(response, base, read);
    }
    const { payout_wallet: applies, pending } = read.document;
    if (pending !== null && applies !== null && typed.toLowerCase() === applies.toLowerCase()) {
      return await cancelWaiting(request, response, gateway, applies, pending, true);
    }
    // The same act as pressing Cancel on that page, answered the same way.
    const shown = shownIn(request);
    if (
      pending === null &&
      shown !== null &&
      applies === shown.waiting &&
      shown.paid !== null &&
      typed.toLowerCase() === shown.paid.toLowerCase()
    ) {
      return await tookEffectBeforePress(
        request,
        response,
        shown,
        "typed the previous address back",
      );
    }

    const set = await gateway.setPayoutWallet(typed);
    if (!set.ok) {
      return trouble(response, base, set);
    }
    // The address stays out of the line: not a secret, but this log records who
    // changed it, not what to.
    noted(
      whoIs(request),
      set.document.pending === null
        ? "changed the address their money arrives at"
        : "asked for a change of the address their money arrives at, which now waits",
    );
    response.redirect(303, `${base}/settings`);
  });

  /**
   * Asked as the signed-in person (a key of the merchant's code cannot set the
   * wallet), after reading the wallet fresh rather than trusting a page that
   * may be a day old. Other sessions end because the change may have come from
   * one of them, but only once the press achieved something: a refused cancel
   * leaves the change waiting, and signing people out then would take away
   * sessions that might press again.
   *
   * The form carries the change it showed, so a press arriving after that
   * change took effect is recognised and not called a cancel: the money already
   * goes to the new address, and the old one comes back only through a change
   * that waits and is announced. A change taking effect between the read and
   * the press turns the request into exactly such a change back, and the page
   * says so.
   */
  app.post(`${base}/settings/payout-wallet/cancel`, async (request, response) => {
    const gateway = gatewayAs(request, WALLET_CHANGE_MS);
    const read = await gateway.payoutWallet();
    if (!read.ok) {
      return trouble(response, base, read);
    }
    const shown = shownIn(request);
    const { payout_wallet: applies, pending } = read.document;

    if (pending !== null && applies !== null) {
      return await cancelWaiting(request, response, gateway, applies, pending, false);
    }

    if (shown !== null && applies === shown.waiting) {
      return await tookEffectBeforePress(request, response, shown, "pressed cancel");
    }

    response.redirect(303, `${base}/settings`);
  });

  /**
   * Mounted only where there is a store, so a deployment without the tables
   * answers "no such page" rather than drawing a form whose button loses
   * somebody's keys.
   */
  const shops = wooShops;
  if (shops !== undefined) {
    /** Where a shop sends the merchant back to, and posts the keys to. */
    const whereWeAre = `${config.publicBaseUrl}${base}`;
    const grantScreen = parts.shop?.grantScreen ?? isTheGrantScreen;
    const catalogue = parts.shop?.catalogue ?? catalogueOf;
    const inspectProduct = parts.shop?.inspectProduct ?? inspectProductInTheShop;

    /**
     * The rule is the gateway's own (`readinessOf` in the core). This dashboard
     * has its gateway's chain and facilitator, so its surface mode is the
     * gateway's. The operator's approval goes in as unknown: the connector is
     * not offered on live, the only place it is asked for.
     */
    const standingOf = async (
      request: Request,
    ): Promise<
      Answer<{
        readonly sellerName: string | null;
        readonly unset: readonly Unset[];
      }>
    > => {
      const gateway = gatewayAs(request);
      const [name, wallet] = await Promise.all([gateway.sellerName(), gateway.payoutWallet()]);
      if (!name.ok) {
        return name;
      }
      if (!wallet.ok) {
        return wallet;
      }
      const door = readinessOf(
        {
          sellerName: name.document,
          payoutWallet: wallet.document.payout_wallet,
          liveApproval: UNKNOWN,
        },
        config.surfaceMode,
      );
      return {
        ok: true,
        document: {
          sellerName: name.document,
          unset: unsetIn(door),
        },
      };
    };

    const drawTheShop = async (
      request: Request,
      response: Response,
      view: {
        problem?: string;
        leaving?: string;
        switching?: string;
        typed?: string;
        cameBack?: boolean;
        refused?: readonly Unset[];
      },
      status = 200,
    ): Promise<void> => {
      const person = whoIs(request);
      const [state, standing, integration] = await Promise.all([
        shopStateFor(person.id),
        standingOf(request),
        gatewayAs(request).integration(),
      ]);
      if (!standing.ok) {
        return trouble(response, base, standing);
      }
      if (!integration.ok) {
        return trouble(response, base, integration);
      }
      if (state === undefined) {
        // Unreachable: these routes are mounted only where there is a store.
        throw new Error(
          "the shop screens ran on a dashboard with no store for connections, which means the" +
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
            through: integration.document.through,
            stopped: integration.document.selling !== "open",
          }),
        );
    };

    app.get(`${base}/woocommerce`, async (request, response) => {
      // The only route that reads the flag the return address's redirect set,
      // and it is spent by being drawn, so a merchant opening this page
      // tomorrow is not told they just came back. The flag, never the token.
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

      // Our own address first: WooCommerce refuses a `callback_url` that is not
      // https, so on an http deployment every Connect would end at the shop's
      // own SSL refusal for something that is ours.
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

      // Minted first, so the address checked is character for character the
      // address the browser is sent to.
      const token = theStateToken();
      const authorize = authorizeUrlFor(shopUrl, {
        appName: APP_NAME,
        userId: token,
        returnUrl: `${whereWeAre}/woocommerce/return`,
        callbackUrl: `${whereWeAre}/woocommerce/callback`,
      });

      // A shop with plain permalinks answers this address with its own front
      // page and a 200, so a merchant sent there would land on their shop with
      // nothing to report.
      const looked = await grantScreen(authorize);
      if (!looked.ok) {
        return await drawTheShop(request, response, { problem: looked.why, typed }, 400);
      }

      // The merchant moves to the shop here, before they are sent to it, and
      // not when the keys arrive: refused at the callback, the switch could
      // only be told to the shop's server; refused here, it is told to the
      // merchant beside the button. One who goes and never approves sells
      // through a shop with none connected, and the page offers the way back.
      const switched = await gatewayAs(request).sellThrough("woocommerce");
      if (!switched.ok) {
        return await drawTheShop(request, response, { problem: switched.why, typed }, 409);
      }

      // Written only now: a Connect nobody could complete is a row nobody comes
      // back for.
      const person = whoIs(request);
      // One clock reading for both fields, so "started four minutes ago" and
      // "the fifteen minutes are up" can never disagree.
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

      // Asked before the shop is read, like the settings below: a merchant
      // selling through their code would have every imported card refused, so
      // the shop screen offers them the switch instead.
      const integration = await gatewayAs(request).integration();
      if (!integration.ok) {
        return trouble(response, base, integration);
      }
      if (integration.document.through !== "woocommerce") {
        return await drawTheShop(
          request,
          response,
          {
            switching:
              "Nothing was imported: you sell through your own code, so nothing imported would sell. Sell through this shop first.",
          },
          409,
        );
      }

      // Asked before the shop: the gateway refuses every card of a merchant
      // missing any of these, so importing would inspect every product for
      // nothing and repeat the refusal per product in words naming an API
      // route. A gateway that cannot answer this would not take a card either.
      const standing = await standingOf(request);
      if (!standing.ok) {
        return trouble(response, base, standing);
      }
      if (standing.document.unset.length > 0) {
        noted(
          person,
          `pressed Import while the publish door would refuse every card with ${standing.document.unset.join(" and ")}, so the shop at` +
            ` ${connection.shopUrl} was not read and nothing was published`,
        );
        return await drawTheShop(request, response, { refused: standing.document.unset }, 409);
      }

      // The ceiling goes in, so a catalogue too large is refused after three
      // round trips to somebody else's shop rather than fifty.
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
        // Compared only at the scale the connector sells at; a catalogue at
        // another scale is refused by `cardsFromTheShop` in words naming the
        // shop's Number of decimals, whereas comparing "25" with "25.00" here
        // would call two equal prices different.
        if (
          product.prices.currency_minor_unit === USD_SCALE &&
          (publicPrice !== inspected.product.price.amount ||
            product.prices.currency_code !== inspected.product.price.currency)
        ) {
          return {
            ...product,
            qualification_problem:
              "The public catalog price does not match the protected WooCommerce product price.",
          };
        }
        // The Store API's list does not say whether a product is virtual or a
        // download, so the class the protected check found is written in.
        const checked = inspected.product;
        return {
          ...product,
          status: "publish",
          virtual: checked.kind === "download",
          downloadable: checked.kind === "download",
          manage_stock: false,
          download_limit: -1,
          download_expiry: -1,
          downloads:
            checked.kind === "download"
              ? [{ id: checked.downloadId, name: checked.fileName, file: "protected-by-woo" }]
              : [],
          qualification_problem: null,
        };
      });
      const { cards, skipped } = cardsFromTheShop(qualified, connection.shopUrl);
      const gateway = gatewayAs(request);
      const outcomes: ImportOutcome[] = [];
      for (const [index, one] of cards.entries()) {
        const published = await publishedOrNot(gateway, one.card);
        if (!published.ok) {
          // The gateway did not answer, or answered with something else: not a
          // refused card, and said as what it is.
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
        // The gateway's findings word for word, telling the merchant which
        // field to change in their shop; the shop's site is the exception, set
        // in Settings by the person here rather than through the API.
        outcomes.push({
          id: one.id,
          title: one.title,
          problems: published.document.error.problems.map((problem) =>
            problem.code === MERCHANT_FINDINGS.NO_SELLER_SITE
              ? SITE_IN_SETTINGS
              : problem.path.length === 0
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
      // A page rather than a redirect: it carries a finding per card.
      response.type("html").send(
        wooImportScreen(viewing(request, base), {
          shopUrl: connection.shopUrl,
          outcomes,
          skipped,
        }),
      );
    });

    app.post(`${base}/woocommerce/switch`, async (request, response) => {
      // The switch for a merchant whose shop is connected while they sell
      // through their code: what Connect does before sending them to the shop,
      // for one whose shop is already here.
      const switched = await gatewayAs(request).sellThrough("woocommerce");
      if (!switched.ok) {
        return await drawTheShop(request, response, { switching: switched.why }, 409);
      }
      noted(whoIs(request), "switched to selling through their connected WooCommerce shop");
      response.redirect(303, `${base}/woocommerce`);
    });

    app.post(`${base}/woocommerce/disconnect`, async (request, response) => {
      // Back to the merchant's own code first, and the keys forgotten only
      // once that held: a shop forgotten while one of its orders still waits
      // would leave that order to nobody, since a parcel's shipment is read
      // off the shop, and only while it is connected.
      const switched = await gatewayAs(request).sellThrough("api");
      if (!switched.ok) {
        return await drawTheShop(request, response, { leaving: switched.why }, 409);
      }
      const person = whoIs(request);
      const shopUrl = await shops.forget(person.id);
      noted(person, "forgot the keys their WooCommerce shop had given");
      // Where the code's cards came back with selling stopped, the merchant is
      // sent to the screen that starts it again, which says it is stopped.
      if (switched.document.sellingPaused) {
        response.redirect(303, `${base}/cards`);
        return;
      }
      const query = shopUrl === null ? "" : `?${new URLSearchParams({ shop_url: shopUrl })}`;
      response.redirect(303, `${base}/woocommerce${query}`);
    });
  }

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
      // A redirect, so a reload does not press the switch again.
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
    response
      .type("html")
      .send(
        keysScreen(viewing(request, base), keys.document, undefined, request.query.new === "key"),
      );
  });

  // The new-key page replaces its POST history entry with this, so a reload
  // returns to the list without issuing a second key or storing the secret for
  // another request.
  app.get(`${base}/keys/new`, (_request, response) => {
    response.redirect(303, `${base}/keys`);
  });

  app.post(`${base}/keys`, async (request, response) => {
    const form = (request.body ?? {}) as { label?: unknown };
    const label = typeof form.label === "string" ? form.label.trim() : "";
    const gateway = gatewayAs(request);

    if (label === "") {
      // A key with no name cannot be told apart from another on the screen
      // meant for telling them apart before revoking one. The list is fetched
      // again so the refusal lands on the page they were looking at.
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

    // The rest of the rule is the contract's: one line, at most the length the
    // gateway takes, which also keeps the live announcement naming it to one
    // line.
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
    // The name and identifier, never the secret: a log goes places the database
    // does not, and this is the one moment the secret exists outside the
    // merchant's hands.
    noted(whoIs(request), `issued a key, ${issued.document.key.id}, named "${label}"`);
    // A page rather than a redirect; `keys.ts` says why.
    response.type("html").send(newKeyScreen(viewing(request, base), label, issued.document.secret));
  });

  app.post(`${base}/keys/:key_id/disable`, async (request, response) => {
    const keyId = request.params.key_id ?? "";
    const stopped = await gatewayAs(request).disableKey(keyId);
    if (!stopped.ok) {
      // Including the refusal the screen never offers a control for: the
      // gateway will not disable the key its caller holds. Whoever reaches this
      // anyway is told what the gateway said.
      return trouble(response, base, stopped);
    }
    noted(whoIs(request), `revoked the key ${keyId}`);
    response.redirect(303, `${base}/keys`);
  });

  app.use((request, response) => {
    response
      .status(404)
      .type("html")
      .send(notFoundScreen(viewing(request, base)));
  });

  app.use(
    (thrown: unknown, _request: Request, response: Response, next: (error?: unknown) => void) => {
      if (response.headersSent) {
        next(thrown);
        return;
      }
      // A body larger than any form comes from a visitor, not a defect, so it
      // is answered as such and without a stack, so a stranger cannot fill the
      // log. The body parser runs above the gate, which is why a visitor with
      // no session reaches this.
      if (tooLarge(thrown)) {
        response
          .status(413)
          .type("html")
          .send(problemPage(base, "That was larger than any form on this page sends."));
        return;
      }
      // A defect. The merchant is told something is broken and nothing about
      // what. It does not say whether anything changed: a call that did its
      // work and then answered in a shape the contract does not recognise lands
      // here too. The exception is not logged, because driver and provider
      // exceptions can carry bound values, session tokens and merchant keys
      // among them.
      console.error("[dashboard] a request failed");
      response
        .status(500)
        .type("html")
        .send(
          problemPage(
            base,
            "Something in the dashboard is broken. Check the page you were on before deciding whether it went through.",
          ),
        );
    },
  );

  return app;
}

/**
 * Both sides are parsed rather than compared as text: a host header can carry a
 * port, an origin drops its scheme's default port, and an IPv6 literal is full
 * of colons. The port is left out on purpose, since a browser does not treat it
 * as a boundary. Anything unparseable, including the `null` a sandboxed
 * document sends, is not the same host.
 */
const sameHost = (origin: string, host: string): boolean => {
  const hostOf = (value: string): string | null => {
    try {
      return new URL(value).hostname || null;
    } catch {
      return null;
    }
  };
  // The host header is not a URL, so it is made into one; the scheme is
  // arbitrary and never compared.
  const here = hostOf(`http://${host}`);
  return here !== null && hostOf(origin) === here;
};

/**
 * Turns away a form post from another origin. The forms include "stop all
 * selling" and the sign-in itself, and signing somebody into an attacker's
 * account is a way to read their work. `SameSite=Lax` is the main defence; this
 * is the second, because SameSite is scoped to the registrable domain, so a page
 * on `test.agentify.ad` is same-site with `agentify.ad`. The sign-in component's
 * own origin check covers only its endpoints, which are not mounted here, so the
 * switches, the keys and link consumption are covered by this alone.
 *
 * A missing `Origin` is let through: browsers send it on every cross-origin form
 * post, and refusing its absence would turn away same-origin navigations and
 * command-line clients. Only the host is compared, never the scheme: a scheme
 * taken from `X-Forwarded-Proto` refuses every honest post behind a terminator
 * that does not set it, locking merchants out of the control that stops their
 * selling. An http page on the same host has no session to forge with anyway,
 * because the session cookie is `Secure` wherever the dashboard is on https.
 */
function sameOriginUnder(base: string, mode: DashboardConfig["surfaceMode"]) {
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
    // The page does not say which origin would have worked, an answer only to
    // somebody guessing. The log records what was compared, so an honest
    // browser refused can be told from an attacker; both values come from
    // outside and go through `printable`.
    console.log(
      `[dashboard] a form post was refused: its origin is ${printable(origin)},` +
        ` and it was addressed to ${printable(asked ?? "nothing at all")}`,
    );
    response
      .status(403)
      .type("html")
      .send(problemPageAt(base, mode, "This form did not come from the dashboard."));
  };
}

/**
 * Only called below the gate, so a missing person is a defect and the handler
 * stops rather than draws.
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
 * The name is passed only by screens that asked the gateway for it: a screen
 * that did not ask must not draw a line either way about it.
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
 * Separate from `viewing`, so screens that did not ask the gateway for the
 * address have no way to say anything about it.
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
  sellerSite: settings.sellerSite,
  ...(settings.liveApproval === undefined ? {} : { liveApproval: settings.liveApproval }),
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
});

/**
 * Trimmed rather than refused, because a leading space is a typing accident and
 * the catalogue's rule would make a padded name a second spelling. A missing
 * field reads as an empty one.
 */
const nameIn = (request: Request): string => {
  const form = (request.body ?? {}) as { seller_name?: unknown };
  return typeof form.seller_name === "string" ? form.seller_name.trim() : "";
};

/** Trimmed, as the name is. */
const siteIn = (request: Request): string => {
  const form = (request.body ?? {}) as { seller_site?: unknown };
  return typeof form.seller_site === "string" ? form.seller_site.trim() : "";
};

/**
 * Each value is held to its shape before anything reads it: the post can carry
 * anything, and these values are shown back on the page.
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
 * Trimmed, because a wallet often hands an address over with a trailing
 * newline. The case is untouched: the capitals are the address's own checksum.
 */
const walletIn = (request: Request): string => {
  const form = (request.body ?? {}) as { payout_wallet?: unknown };
  return typeof form.payout_wallet === "string" ? form.payout_wallet.trim() : "";
};

/**
 * A process log, not an audit trail: it rotates, goes with the container, and
 * is written by the process it records. Never a one-time token, a link, a
 * session identifier or a merchant key.
 *
 * The whole line goes through `printable`, not only the field that first needed
 * it (a key's label, open to any alphabet and unbounded): a label with a
 * newline and a plausible sentence would forge a second line in the record of
 * who stopped the selling. Doing it here covers whatever is interpolated next.
 */
const noted = (person: Person, did: string): void => {
  console.log(printable(`[dashboard] ${person.email} ${did}`));
};

/**
 * A throw may come after the card was written, so it is neither a refusal nor a
 * publication: the import records no verdict, says whether it was published is
 * unknown, and stops, leaving the rest not attempted. Thrown out of the loop,
 * it would lose the record of every card already published.
 */
async function publishedOrNot(
  gateway: GatewayClient,
  card: CardInput,
): Promise<Answer<PublishResult>> {
  try {
    return await gateway.publishCard(card);
  } catch (thrown) {
    console.error("[dashboard] publishing a card failed", thrown);
    return {
      ok: false,
      status: 500,
      why: "something failed inside Agentify while this product was being published, so whether it was published is not known; import again later, which does not double cards",
    };
  }
}

function troubleAt(
  response: Response,
  base: string,
  mode: DashboardConfig["surfaceMode"],
  answer: Answer<unknown>,
): void {
  if (answer.ok) {
    return;
  }
  if (answer.status === 0) {
    // Nothing answered in time, which is not a refusal: a merchant told the
    // wrong one checks something that works. What was asked may still have been
    // done.
    response
      .status(504)
      .type("html")
      .send(problemPageAt(base, mode, answer.why, again(response)));
    return;
  }
  // A refusal, under its own status; nothing is claimed beyond what it said.
  response
    .status(answer.status)
    .type("html")
    .send(problemPageAt(base, mode, answer.why, again(response)));
}

/**
 * `body-parser` marks its own refusals with a `type`; a status alone is not
 * enough, since any exception can carry one.
 */
function tooLarge(thrown: unknown): boolean {
  return (
    typeof thrown === "object" &&
    thrown !== null &&
    "type" in thrown &&
    (thrown as { type: unknown }).type === "entity.too.large"
  );
}

/**
 * The gateway writes refusals in lower case for a program's log; a person reads
 * this page.
 */
const asSentence = (said: string): string => `${said.slice(0, 1).toUpperCase()}${said.slice(1)}`;

/**
 * The address to try again at: the page itself where it was a page that
 * failed, and only as a path of this site, never one a browser would read as
 * another host's.
 */
const again = (response: Response): string | undefined => {
  const url = response.req.originalUrl;
  return response.req.method === "GET" && url.startsWith("/") && !url.startsWith("//")
    ? url
    : undefined;
};

function problemPageAt(
  base: string,
  mode: DashboardConfig["surfaceMode"],
  said: string,
  again?: string,
): string {
  // A page that failed to draw is tried again at its own address, so the
  // merchant keeps their place; a form that failed cannot be sent again from
  // here, so its way on is the dashboard's first screen, named as that.
  const onward =
    again === undefined
      ? `<a class="button button-primary" href="${escaped(base)}/cards">Back to Cards</a>`
      : `<a class="button button-primary" href="${escaped(again)}">Try again</a>`;
  return bare(
    base,
    "Something went wrong",
    `<div class="gate">
${brandLockup("/")}
<div class="gate-card">
<h1>Something went wrong</h1>
<p>${escaped(asSentence(said))}</p>
${onward}
</div>
</div>`,
    mode,
    null,
  );
}
