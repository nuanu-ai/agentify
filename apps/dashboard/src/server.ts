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
 * health probe and the shop's callback here, and the sign-in pages and the
 * shop's return address, which React Router draws in front of the same gate.
 * Each answers the same thing to everybody, which is the property to check
 * before adding to it.
 */

import { readFileSync } from "node:fs";
import type { Gateway } from "@agentify/gateway";
import express, { type Express, type Request, type Response } from "express";
import type { DashboardConfig } from "./config.js";
import type { DashboardIdentity, Person } from "./dashboard-entry.js";
import { DRAWN_FOR } from "./drawn-for.js";
import { gateFor } from "./gate.js";
import {
  type Acting,
  type GatewayClient,
  gatewayFor,
  type Registrar,
  registrarFor,
} from "./gateway.js";
import { bare, brandLockup, escaped } from "./html.js";
import { pageServicesFor } from "./page-services.js";
import { type Pages, pagesHandler } from "./pages.js";
import { printable } from "./printable.js";
import { notDrawnForYouScreen, notFoundScreen, type Viewer } from "./screens.js";
import { type ShopCalls, shopStateOf, wooPagesFor } from "./woo-pages.js";
import { type WooShops, wooOfferedOn } from "./woo-shops.js";
import type { ShopState } from "./woo-views.js";

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
   * change waits longer than a screen does (`WALLET_CHANGE_MS` in
   * `payout-wallet.ts`).
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
  /** Only tests pass another. */
  readonly shop?: ShopCalls;
}

/**
 * A map keyed by the request rather than a property added to it, so the type
 * system knows who is signed in.
 */
const people = new WeakMap<Request, Person>();

export function buildApp(config: DashboardConfig, parts: DashboardParts): Express {
  const app = express();
  const base = config.basePath;
  // Where the connector is not offered none of its screens is mounted, so
  // nothing invites an owner into what does not work there.
  const wooShops = wooOfferedOn(config.surfaceMode) ? parts.wooShops : undefined;
  const viewing = (request: Request, pageBase: string, sellerName?: string | null): Viewer =>
    viewingAt(request, pageBase, config.surfaceMode, sellerName);
  const problemPage = (pageBase: string, said: string): string =>
    problemPageAt(pageBase, config.surfaceMode, said);
  const identity = parts.identity;
  const clientFor =
    parts.clientFor ??
    ((acting: Acting, answerWithinMs?: number) =>
      gatewayFor(parts.gateway, acting, answerWithinMs));
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
        clientFor,
        registrar: parts.registrar ?? registrarFor(parts.gateway),
        woo:
          wooShops === undefined
            ? null
            : wooPagesFor(config, {
                identity,
                clientFor: (acting) => clientFor(acting),
                shops: wooShops,
                ...(parts.shop === undefined ? {} : { shop: parts.shop }),
              }),
        // Asked per request, by which time the function below is defined.
        shopState: (accountId) => shopStateFor(accountId),
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

  /** `undefined` means nowhere to keep a connection, which draws no block. */
  const shopStateFor = async (accountId: string): Promise<ShopState | undefined> =>
    wooShops === undefined ? undefined : await shopStateOf(wooShops, accountId);

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
