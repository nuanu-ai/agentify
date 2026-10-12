/**
 * The server half of the React pages: what their loaders, actions and gate
 * call. A call takes what the request carried and answers with an `Outcome` —
 * a view to draw, a place to send the browser, or a problem to show — never
 * with a response, so the pages decide nothing a test of this module cannot
 * see. The pages import only the types from here: the build that runs in the
 * browser carries none of this, and the build that runs on the server is handed
 * it by the process that mounts it.
 */

import { SURFACE_MARKER_ATTRIBUTE, SURFACE_WORDS, type SurfaceMode } from "@agentify/core";
import type { DashboardConfig } from "./config.js";
import {
  type DashboardDestination,
  type DashboardIdentity,
  dashboardDestinationIn,
  type LinkDestination,
  type LinkWall,
  type Person,
} from "./dashboard-entry.js";
import { clearingLines, dashboardPathFor, type Gate, gateFor, startOf } from "./gate.js";
import type { Acting, Answer, GatewayClient } from "./gateway.js";
import { SESSION_DAYS } from "./identity.js";
import type { Viewer } from "./screens.js";
import {
  type CardsView,
  cardsView,
  type OrdersView,
  ordersView,
  type ReceiptsView,
  receiptsView,
} from "./views.js";

/** A view to draw, a place to send the browser, or a problem to show instead. */
export type Outcome<View> =
  | Readonly<{
      kind: "view";
      view: View;
      status?: number;
      headers?: Readonly<Record<string, string>>;
      setCookies?: readonly string[];
    }>
  | Readonly<{
      kind: "redirect";
      /** A path on this site, the dashboard's prefix included where it is the dashboard's. */
      location: string;
      headers?: Readonly<Record<string, string>>;
      setCookies?: readonly string[];
    }>
  | Readonly<{ kind: "problem"; problem: Problem }>;

/**
 * A page that could not be drawn or a form that was not done. The page itself
 * adds the way back: its own address where a page failed, so the merchant
 * keeps their place, and the first screen where a form did.
 */
export interface Problem {
  readonly status: number;
  readonly said: string;
}

/** Which stack this is, said on every page; nothing is said on the live one. */
export interface Surface {
  readonly attribute: string;
  readonly mode: SurfaceMode;
  readonly words: string | null;
}

/**
 * A problem is a refusal of something the person did and is drawn under the
 * box; a reason is why they are on the page at all, such as an expired
 * session, and is the card's first line in the ordinary voice.
 */
export type SignInView =
  | Readonly<{
      screen: "ask";
      destination: DashboardDestination;
      problem?: string;
      reason?: string;
    }>
  | Readonly<{
      screen: "requested";
      email: string;
      destination: DashboardDestination;
      answer: LinkAnswer;
    }>
  | Readonly<{ screen: "unavailable" }>;

/**
 * Accepted carries a key of its own rather than the absence of a limit, so a
 * forgotten field cannot read as good news. The limit is named rather than
 * inferred from the seconds, because a minute (a link already sent) and an
 * hour (an allowance spent) need different sentences.
 */
export type LinkAnswer =
  | Readonly<{ sent: true; seconds: number }>
  | Readonly<{ wall: LinkWall; seconds: number }>;

export type OpenLinkView =
  | Readonly<{ screen: "open"; token: string; email: string }>
  | Readonly<{ screen: "refused" }>;

export interface PageServices {
  /** "" when mounted at the root of its origin. */
  readonly base: string;
  readonly surface: Surface;
  readonly gate: Gate;
  readonly signIn: {
    page(cookie: string | undefined, query: URLSearchParams): Promise<Outcome<SignInView>>;
    ask(form: FormData): Promise<Outcome<SignInView>>;
    landing(cookie: string | undefined, query: URLSearchParams): Promise<Outcome<OpenLinkView>>;
    open(cookie: string | undefined, form: FormData): Promise<Outcome<OpenLinkView>>;
    signOut(cookie: string | undefined): Promise<Outcome<never>>;
  };
  /** The screens about a merchant's selling, for a person the gates let through. */
  readonly screens: {
    cards(person: Person): Promise<Outcome<CardsView>>;
    orders(person: Person, query: URLSearchParams): Promise<Outcome<OrdersView>>;
    receipts(person: Person): Promise<Outcome<ReceiptsView>>;
  };
}

export interface PageParts {
  readonly identity: DashboardIdentity;
  /**
   * The gateway's application called as the merchant on the signed-in
   * account's row, built per request so two people are two merchants.
   */
  readonly clientFor: (acting: Acting) => GatewayClient;
  /** Whether this dashboard offers the WooCommerce connector at all. */
  readonly wooOffered: boolean;
}

/**
 * The gateway writes refusals in lower case for a program's log; a person reads
 * the page. Nothing answered in time is not a refusal and is said under its own
 * status, because a merchant told the wrong one checks something that works; a
 * refusal keeps the gateway's status, and nothing is claimed beyond what it
 * said.
 */
const problemOf = (answer: Answer<unknown> & { ok: false }): Outcome<never> => ({
  kind: "problem",
  problem: {
    status: answer.status === 0 ? 504 : answer.status,
    said: `${answer.why.slice(0, 1).toUpperCase()}${answer.why.slice(1)}`,
  },
});

/**
 * Not the real grammar of an address: it catches the mistakes made in a form (a
 * missing half, a space, a bare word), as the account command does.
 */
const LOOKS_LIKE_AN_ADDRESS = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/**
 * The gate cannot say why the session ended (thirty days without a visit, or
 * ended from another device), so it gives the rule; naming the lifetime makes
 * the request for an address read as an ordinary end rather than a fault.
 */
const SESSION_ENDED =
  `Your session ended; a session lasts ${SESSION_DAYS} days from your last visit. ` +
  `Send yourself a new link to carry on.`;

/**
 * Signing out clears the cookie in every tab, so a form pressed in another one
 * arrives with no sign a session existed. The person is told it was not kept,
 * or they might take a pause for done.
 */
const UNSAVED = "You are not signed in, so the change you submitted was not saved.";

/**
 * The page a mailed link lands on and its press answer with these, and with no
 * cache, which every page here has. The policy keeps the token out of
 * `Referer`: `no-referrer` would make Chromium post the form with
 * `Origin: null`, which the origin check must refuse, while `strict-origin`
 * keeps the exact origin and sends no query.
 */
const LINK_HEADERS = { "referrer-policy": "strict-origin" } as const;

/**
 * A value named once, as a form or an address names it; named twice it is
 * nobody's choice, and is read as not named at all.
 */
const once = (values: readonly unknown[]): unknown => (values.length === 1 ? values[0] : undefined);

export function pageServicesFor(config: DashboardConfig, parts: PageParts): PageServices {
  const base = config.basePath;
  const { identity } = parts;

  /**
   * The name is passed only by screens that asked the gateway for it: a screen
   * that did not ask must not draw a line either way about it.
   */
  const viewing = (person: Person, sellerName?: string | null): Viewer => ({
    base,
    mode: config.surfaceMode,
    who: person.email,
    confirmed: person.confirmed,
    sellerName,
  });

  /**
   * Only called behind the gate that sends an account with no merchant to the
   * control that makes one, so a missing merchant here is a defect, not a case.
   */
  const gatewayAs = (person: Person): GatewayClient => {
    if (person.merchant === null) {
      throw new Error(
        "a screen that needs a merchant ran for an account with none, which means the merchant" +
          " gate let one through — this is a defect in how the routes are nested",
      );
    }
    return parts.clientFor({ merchantId: person.merchant.id, email: person.email });
  };

  /**
   * A browser with a live session goes to its own start, so the answer depends
   * on who the browser is and never on whose the link was. Anybody else gets
   * one refusal for a spent, expired or unknown link.
   */
  const refuseLink = async (cookie: string | undefined): Promise<Outcome<OpenLinkView>> => {
    const signedIn = await identity.whoIs(cookie);
    if (signedIn !== null) {
      return {
        kind: "redirect",
        location: startOf(base, signedIn.person),
        headers: LINK_HEADERS,
        setCookies: signedIn.setCookies,
      };
    }
    return { kind: "view", view: { screen: "refused" }, status: 401, headers: LINK_HEADERS };
  };

  /**
   * Opening a link makes nothing: under Lax a link from another site arrives
   * signed in, so a navigation that made a merchant could be started by
   * anybody. A link the scanner asked for goes to its report, where the scanner
   * finishes the request the session now names; a link from a dashboard screen
   * goes to that screen, or to the control that makes a merchant for somebody
   * with none; any other to the start.
   */
  const whereOpened = (person: Person, destination: LinkDestination): string =>
    typeof destination !== "string"
      ? `/report/${encodeURIComponent(destination.report)}`
      : destination === "default"
        ? startOf(base, person)
        : person.merchant === null
          ? `${base}/merchant`
          : dashboardPathFor(base, destination);

  return {
    base,
    surface: {
      attribute: SURFACE_MARKER_ATTRIBUTE,
      mode: config.surfaceMode,
      words: SURFACE_WORDS[config.surfaceMode],
    },
    gate: gateFor(base, identity, config.cookieSecure),

    signIn: {
      async page(cookie, query) {
        const destination = dashboardDestinationIn(once(query.getAll("destination")));
        const signedIn = await identity.whoIs(cookie);
        if (signedIn !== null) {
          return {
            kind: "redirect",
            location:
              signedIn.person.merchant === null
                ? `${base}/merchant`
                : dashboardPathFor(base, destination),
            setCookies: signedIn.setCookies,
          };
        }
        // An expired session is why the person is here, so it is the page's
        // first line; a change lost with it is a refusal.
        const said = once(query.getAll("reason"));
        const problem =
          said === "session-ended-unsaved"
            ? `${SESSION_ENDED} The change you submitted was not saved.`
            : said === "unsaved"
              ? UNSAVED
              : undefined;
        const reason = said === "session-ended" ? SESSION_ENDED : undefined;
        return {
          kind: "view",
          view: {
            screen: "ask",
            destination,
            ...(problem === undefined ? {} : { problem }),
            ...(reason === undefined ? {} : { reason }),
          },
        };
      },

      async ask(form) {
        const typed = once(form.getAll("email"));
        const email = typeof typed === "string" ? typed.trim() : "";
        const destination = dashboardDestinationIn(once(form.getAll("destination")));
        if (!LOOKS_LIKE_AN_ADDRESS.test(email)) {
          return {
            kind: "view",
            status: 400,
            view: {
              screen: "ask",
              destination,
              problem: "Enter an address of the shape someone@example.com.",
            },
          };
        }
        const requested = await identity.requestLink(email, destination);
        if (requested.status === "unavailable") {
          return { kind: "view", status: 503, view: { screen: "unavailable" } };
        }
        // Both waits come from the reading of the same rows; this page never
        // works one out, because the only wait it could guess is the minute,
        // which is wrong for the link that spent the hour.
        const seconds = Math.max(1, Math.ceil((requested.retryAt.getTime() - Date.now()) / 1_000));
        const answer: LinkAnswer =
          requested.status === "cooldown"
            ? { wall: requested.wall, seconds }
            : { sent: true, seconds };
        return {
          kind: "view",
          status: 202,
          ...("wall" in answer ? { headers: { "retry-after": String(answer.seconds) } } : {}),
          view: { screen: "requested", email, destination, answer },
        };
      },

      /**
       * Opening spends nothing, so a mail client's preview signs nobody in; only
       * the same-origin press does. It names the address, so a link for
       * somebody else's address sent to a victim cannot sign them in as that
       * somebody unnoticed.
       */
      async landing(cookie, query) {
        const named = once(query.getAll("token"));
        const token = typeof named === "string" ? named : "";
        const email = token === "" ? null : await identity.addressOfLink(token);
        if (email === null) {
          return await refuseLink(cookie);
        }
        return { kind: "view", view: { screen: "open", token, email }, headers: LINK_HEADERS };
      },

      async open(cookie, form) {
        const named = once(form.getAll("token"));
        const token = typeof named === "string" ? named : "";
        const opened =
          token === "" ? { status: "refused" as const } : await identity.openLink(token);
        if (opened.status === "refused") {
          return await refuseLink(cookie);
        }
        // The new session replaces the old one rather than sitting beside it;
        // otherwise the old row would live on with nothing holding its cookie
        // and count as another place this account is signed in.
        await identity.signOut(cookie);
        return {
          kind: "redirect",
          location: whereOpened(opened.person, opened.destination),
          headers: LINK_HEADERS,
          setCookies: opened.setCookies,
        };
      },

      // The rows go, not only the cookies: anybody who copied a value would
      // still hold a session. Every identifier the request carried, because a
      // browser orders cookies of one name by path and age, so the live one need
      // not be first. It signs this browser out of the whole site and leaves
      // other devices alone, and it stands in front of the gate so a tab whose
      // session is gone can still clear its cookie.
      async signOut(cookie) {
        await identity.signOut(cookie);
        console.log("[dashboard] a session was signed out");
        return {
          kind: "redirect",
          location: `${base}/sign-in`,
          setCookies: clearingLines(identity, config.cookieSecure),
        };
      },
    },

    screens: {
      async cards(person) {
        const gateway = gatewayAs(person);
        // A card can read paused for want of any of these, and the control
        // beside it says which. The operator's approval is read only on live,
        // the one place publishing needs it.
        const [cards, name, wallet, approval, integration] = await Promise.all([
          gateway.cards(),
          gateway.sellerName(),
          gateway.payoutWallet(),
          config.surfaceMode === "live"
            ? gateway.liveApproval()
            : Promise.resolve({ ok: true as const, document: undefined }),
          gateway.integration(),
        ]);
        if (!cards.ok) return problemOf(cards);
        if (!integration.ok) return problemOf(integration);
        if (!name.ok) return problemOf(name);
        if (!wallet.ok) return problemOf(wallet);
        if (!approval.ok) return problemOf(approval);
        return {
          kind: "view",
          view: cardsView(
            {
              ...viewing(person, name.document),
              payout: { wallet: wallet.document.payout_wallet },
              ...(approval.document === undefined ? {} : { liveApproval: approval.document }),
            },
            cards.document,
            config.publicBaseUrl,
            parts.wooOffered,
            integration.document,
          ),
        };
      },

      async orders(person, query) {
        // Only the exact word narrows the list, as the contract says.
        const open = once(query.getAll("open")) === "true";
        const gateway = gatewayAs(person);
        const [cards, orders, name, owed] = await Promise.all([
          gateway.cards(),
          gateway.orders(open),
          gateway.sellerName(),
          gateway.refundsOwed(),
        ]);
        if (!cards.ok) return problemOf(cards);
        if (!orders.ok) return problemOf(orders);
        if (!name.ok) return problemOf(name);
        if (!owed.ok) return problemOf(owed);
        return {
          kind: "view",
          view: ordersView(
            viewing(person, name.document),
            cards.document,
            orders.document,
            open,
            owed.document,
          ),
        };
      },

      async receipts(person) {
        const gateway = gatewayAs(person);
        const [cards, receipts, name] = await Promise.all([
          gateway.cards(),
          gateway.receipts(),
          gateway.sellerName(),
        ]);
        if (!cards.ok) return problemOf(cards);
        if (!receipts.ok) return problemOf(receipts);
        if (!name.ok) return problemOf(name);
        return {
          kind: "view",
          view: receiptsView(
            viewing(person, name.document),
            cards.document,
            receipts.document,
            config.transactionPage,
          ),
        };
      },
    },
  };
}
