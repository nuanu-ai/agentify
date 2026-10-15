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
import { PARTNER_CLICK_ID_PATTERN } from "@agentify/scanner-contracts/click-id";
import {
  EvmAddressSchema,
  IssueKeyRequestSchema,
  type PendingPayoutWallet,
} from "@nuanu-ai/agentify-contracts";
import { ADS_CONSENT } from "./ads-consent.js";
import type { DashboardConfig } from "./config.js";
import {
  type ConsentedClick,
  type DashboardDestination,
  type DashboardIdentity,
  dashboardDestinationIn,
  type LinkDestination,
  type LinkWall,
  type Person,
} from "./dashboard-entry.js";
import { clearingLines, dashboardPathFor, type Gate, gateFor, startOf } from "./gate.js";
import type { Acting, Answer, GatewayClient, Registrar } from "./gateway.js";
import { SESSION_DAYS } from "./identity.js";
import { type IntegrationsView, integrationsView } from "./integrations-view.js";
import { type KeysView, keysView, type NewKeyView, newKeyView } from "./keys.js";
import { noted } from "./noted.js";
import { WALLET_CHANGE_MS, WALLET_NEEDED, whatIsWrongWithTheWallet } from "./payout-wallet.js";
import {
  NAME_CANNOT_BE_TAKEN_AWAY,
  NAME_NEEDED,
  NAME_REFUSED,
  NAME_RULE,
  SITE_CANNOT_BE_TAKEN_AWAY,
  whatIsWrongWithTheName,
  whatIsWrongWithTheSite,
} from "./seller-name.js";
import { type SettingsPress, type SettingsView, settingsView } from "./settings-view.js";
import type { Viewer } from "./viewer.js";
import {
  type CardsView,
  cardsView,
  type OrdersView,
  ordersView,
  type ReceiptsView,
  receiptsView,
} from "./views.js";
import type { WooPages } from "./woo-pages.js";
import type { ShopTile } from "./woo-views.js";
import { moment } from "./words.js";

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
      /**
       * A path on this site, the dashboard's prefix included where it is the
       * dashboard's; or a whole address on another site, such as a shop's.
       */
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
interface Problem {
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
      click?: OfferedClick;
    }>
  | Readonly<{
      screen: "requested";
      email: string;
      destination: DashboardDestination;
      answer: LinkAnswer;
      click?: OfferedClick;
    }>
  | Readonly<{ screen: "unavailable"; click?: OfferedClick }>;

/**
 * The ad click a visitor arrived with, which the sign-in forms carry from page
 * to page, and whether they ticked the box that lets the tracker hear they
 * signed up. Present only where the report is switched on.
 */
export type OfferedClick = Readonly<{ id: string; consented: boolean }>;

/**
 * Accepted carries a key of its own rather than the absence of a limit, so a
 * forgotten field cannot read as good news. The limit is named rather than
 * inferred from the seconds, because a minute (a link already sent) and an
 * hour (an allowance spent) need different sentences.
 */
export type LinkAnswer =
  | Readonly<{ sent: true; seconds: number }>
  | Readonly<{ wall: LinkWall; seconds: number }>;

/**
 * `tellsTracker` is whether the press would tell the ad tracker of a
 * registration, which the page then says and offers to sign in without.
 */
export type OpenLinkView =
  | Readonly<{ screen: "open"; token: string; email: string; tellsTracker: boolean }>
  | Readonly<{ screen: "refused" }>;

/**
 * The one control that makes a merchant. `unavailable` is a press that did
 * not make one, which leaves the person signed in to press again.
 */
export interface MerchantView {
  readonly unavailable: boolean;
}

/** The screen where a new merchant chooses the name buyers read. */
export interface ChooseNameView {
  /** What was typed, given back with its refusal so it can be corrected. */
  readonly typed: string;
  readonly problem?: string;
  /** The catalogue's rule in words; null where the refusal already says it. */
  readonly rule: string | null;
}

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
  /**
   * The way in for a person the gate let through: where the dashboard's own
   * address leads, and the control that makes a merchant for a person with
   * none.
   */
  readonly start: {
    where(person: Person): Outcome<never>;
    merchant(person: Person): Outcome<MerchantView>;
    openMerchant(person: Person): Promise<Outcome<MerchantView>>;
  };
  /** Choosing the name buyers read, the last step of a new merchant's setup. */
  readonly sellerName: {
    page(): Outcome<ChooseNameView>;
    choose(person: Person, form: FormData): Promise<Outcome<ChooseNameView>>;
  };
  /**
   * A switch pressed on the cards, named in the address the press is posted
   * to: `pause` or `resume` with a card, or `selling` with either way.
   */
  readonly selling: {
    press(person: Person, query: URLSearchParams): Promise<Outcome<never>>;
  };
  /** The screens about a merchant's selling, for a person the gates let through. */
  readonly screens: {
    cards(person: Person): Promise<Outcome<CardsView>>;
    orders(person: Person, query: URLSearchParams): Promise<Outcome<OrdersView>>;
    receipts(person: Person): Promise<Outcome<ReceiptsView>>;
  };
  /** The ways a merchant's catalogue reaches Agentify. */
  readonly integrations: {
    page(person: Person): Promise<Outcome<IntegrationsView>>;
  };
  /**
   * The settings with the payout wallet, and each press on that page. A press
   * answers with a redirect, a problem, or the page drawn from a read made after
   * its work, saying what it did. `cookie` is the presser's Cookie header, whose
   * session is the one a press that signs others out keeps.
   */
  readonly settings: {
    page(person: Person): Promise<Outcome<SettingsView>>;
    name(person: Person, form: FormData): Promise<Outcome<SettingsView>>;
    site(person: Person, form: FormData): Promise<Outcome<SettingsView>>;
    signOutOthers(person: Person, cookie: string | undefined): Promise<Outcome<SettingsView>>;
    wallet(
      person: Person,
      form: FormData,
      cookie: string | undefined,
    ): Promise<Outcome<SettingsView>>;
    cancel(
      person: Person,
      form: FormData,
      cookie: string | undefined,
    ): Promise<Outcome<SettingsView>>;
  };
  /** The merchant's keys, for a person the gates let through. */
  readonly keys: {
    list(person: Person, query: URLSearchParams): Promise<Outcome<KeysView>>;
    /**
     * Answered with the page that shows the new key's secret rather than a
     * redirect: a redirect cannot carry the secret without writing it into
     * history and logs, or storing it for the next request.
     */
    issue(person: Person, form: FormData): Promise<Outcome<KeysView | NewKeyView>>;
    disable(person: Person, keyId: string): Promise<Outcome<never>>;
  };
  /** The WooCommerce connector's screens where it is offered; null elsewhere. */
  readonly woo: WooPages | null;
}

export interface PageParts {
  readonly identity: DashboardIdentity;
  /**
   * The gateway's application called as the merchant on the signed-in
   * account's row, built per request so two people are two merchants, within
   * the caller's deadline where it passes one.
   */
  readonly clientFor: (acting: Acting, answerWithinMs?: number) => GatewayClient;
  /**
   * Makes a merchant; not a client method, because the person has no merchant
   * yet to bind a client to.
   */
  readonly registrar: Registrar;
  /**
   * The WooCommerce connector's screens where this dashboard offers it; null
   * elsewhere, where no screen offers it and none of its pages is answered.
   */
  readonly woo: WooPages | null;
}

/**
 * The gateway writes refusals in lower case for a program's log; a person reads
 * the page. Nothing answered in time is not a refusal and is said under its own
 * status, because a merchant told the wrong one checks something that works; a
 * refusal keeps the gateway's status, and nothing is claimed beyond what it
 * said.
 */
export const problemOf = (answer: Answer<unknown> & { ok: false }): Outcome<never> => ({
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
 * A value named once, as a form or an address names it; named twice it is
 * nobody's choice, and is read as not named at all.
 */
const once = (values: readonly unknown[]): unknown => (values.length === 1 ? values[0] : undefined);

/**
 * The click an address or a form names once, in the tracker's form; null for
 * anything else, which leaves the page as it is without one.
 */
const clickIdIn = (named: URLSearchParams | FormData): string | null => {
  const id = once(named.getAll("clickid"));
  return typeof id === "string" && PARTNER_CLICK_ID_PATTERN.test(id) ? id : null;
};

/** What a link is asked for with: a click only where its box was ticked. */
const consentedClickOf = (click: OfferedClick | undefined): ConsentedClick | undefined =>
  click?.consented === true
    ? { id: click.id, consentedAt: new Date().toISOString(), wording: ADS_CONSENT.version }
    : undefined;

/**
 * The sign-in form for a browser with no session, as its address asks for it:
 * where the person was going, and why they are here. An expired session is
 * the reason, said as the page's first line; a change lost with it is a
 * refusal, drawn under the box.
 */
export const askViewOf = (query: URLSearchParams): Extract<SignInView, { screen: "ask" }> => {
  const said = once(query.getAll("reason"));
  const problem =
    said === "session-ended-unsaved"
      ? `${SESSION_ENDED} The change you submitted was not saved.`
      : said === "unsaved"
        ? UNSAVED
        : undefined;
  const reason = said === "session-ended" ? SESSION_ENDED : undefined;
  return {
    screen: "ask",
    destination: dashboardDestinationIn(once(query.getAll("destination"))),
    ...(problem === undefined ? {} : { problem }),
    ...(reason === undefined ? {} : { reason }),
  };
};

export const NOT_AN_ADDRESS = "Enter an address of the shape someone@example.com.";

/**
 * The page a mailed link lands on and its press answer with these, and with no
 * cache, which every page here has. The policy keeps the token out of
 * `Referer`: `no-referrer` would make Chromium post the form with
 * `Origin: null`, which the origin check must refuse, while `strict-origin`
 * keeps the exact origin and sends no query.
 */
const LINK_HEADERS = { "referrer-policy": "strict-origin" } as const;

/**
 * Which switch a press on the cards names: one card's, or all selling's when
 * no card is named. A press naming anything else, or anything twice, names no
 * switch at all rather than whichever was read first.
 */
const switchIn = (query: URLSearchParams): Readonly<{ card?: string; paused: boolean }> | null => {
  const named = [...new Set(query.keys())];
  const [key] = named;
  const value = key === undefined ? undefined : once(query.getAll(key));
  if (named.length !== 1 || typeof value !== "string" || value === "") return null;
  if (key === "selling") {
    return value === "pause" || value === "resume" ? { paused: value === "pause" } : null;
  }
  return key === "pause" || key === "resume" ? { card: value, paused: key === "pause" } : null;
};

const NO_SUCH_SWITCH = "There is no such switch on the cards.";

/**
 * What was typed into a box, trimmed: a space at either end is a typing
 * accident, and a wallet often hands an address over with a trailing newline.
 * The case is untouched, since an address's capitals are its checksum. A box
 * named twice or not at all reads as an empty one.
 */
const typedIn = (form: FormData, box: string): string => {
  const value = once(form.getAll(box));
  return typeof value === "string" ? value.trim() : "";
};

/** The waiting change a settings page showed, which its wallet forms carry back. */
export interface Shown {
  readonly waiting: string;
  readonly from: string | null;
  readonly paid: string | null;
}

/** How many other sessions of the account a press ended, the one thing its presser cannot see. */
export const signedOutOthers = (ended: number): string =>
  ended === 0
    ? "No other session of this account was signed in, so none was signed out."
    : ended === 1
      ? "1 other session of this account was signed out."
      : `${ended} other sessions of this account were signed out.`;

/** Typed while a change waited, the address paid into now cancels it, and the person may not know. */
export const cancelledByTyping = (applies: string, waiting: string): string =>
  `${applies} is the address your sales are paid into now, so the waiting change to ${waiting} was cancelled. ` +
  "Every other session of your merchant was signed out.";

/** A press from a page drawn while a change waited, arriving after it took effect. */
export const landedBeforePress = (shown: Shown): string =>
  `The change to ${shown.waiting} took effect at ${shown.from === null ? "its moment" : moment(shown.from)}, before you pressed, and your sales are now paid into it. ` +
  (shown.paid === null
    ? "Setting another address back is a change like any other: it waits forty-eight hours and is announced. "
    : `Setting ${shown.paid} back is a change like any other: it waits forty-eight hours and is announced. `) +
  "Every other session of your merchant was signed out.";

/**
 * Each value is held to its shape before anything reads it: the post can carry
 * anything, and these values are shown back on the page.
 */
const shownIn = (form: FormData): Shown | null => {
  const address = (value: unknown): string | null =>
    typeof value === "string" && EvmAddressSchema.safeParse(value).success ? value : null;
  const waiting = address(once(form.getAll("waiting")));
  if (waiting === null) return null;
  const from = once(form.getAll("waiting_from"));
  return {
    waiting,
    from: typeof from === "string" && !Number.isNaN(Date.parse(from)) ? from : null,
    paid: address(once(form.getAll("paid"))),
  };
};

/**
 * A key with no name cannot be told apart from another on the screen meant for
 * telling them apart before revoking one. The rest of the rule is the
 * contract's: one line, at most the length the gateway takes, which also keeps
 * the live announcement naming it to one line.
 */
export const whatIsWrongWithTheLabel = (label: string): string | null => {
  if (label === "") {
    return "Give the key a name, so that you can tell it from the others when you come to revoke one.";
  }
  const unfit = IssueKeyRequestSchema.shape.label.safeParse(label);
  if (unfit.success) return null;
  const said = unfit.error.issues[0]?.message ?? "that name cannot be given to a key";
  return `${said.slice(0, 1).toUpperCase()}${said.slice(1)}. No key was issued.`;
};

export function pageServicesFor(config: DashboardConfig, parts: PageParts): PageServices {
  const base = config.basePath;
  const { identity } = parts;

  /**
   * Read only where the report is switched on, so a dashboard that reports
   * nothing draws every sign-in page exactly as it would with no click.
   */
  const offeredIn = (named: URLSearchParams | FormData): Readonly<{ click?: OfferedClick }> => {
    if (config.registrationPostback === null) return {};
    const id = clickIdIn(named);
    if (id === null) return {};
    return { click: { id, consented: once(named.getAll("ads_consent")) === "yes" } };
  };

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
  const gatewayAs = (person: Person, answerWithinMs?: number): GatewayClient => {
    if (person.merchant === null) {
      throw new Error(
        "a screen that needs a merchant ran for an account with none, which means the merchant" +
          " gate let one through — this is a defect in how the routes are nested",
      );
    }
    return parts.clientFor({ merchantId: person.merchant.id, email: person.email }, answerWithinMs);
  };

  /**
   * One read of everything the settings page says, made after a press's work,
   * so the page shows what the press left. Any of the three failing fails the
   * page: drawn without an answer, it would claim something about a field
   * nobody asked about. The approval is read only on live, the one place
   * publishing needs it.
   */
  const settingsDrawn = async (
    person: Person,
    press?: SettingsPress,
    status?: number,
  ): Promise<Outcome<SettingsView>> => {
    const gateway = gatewayAs(person);
    const [seller, wallet, approval] = await Promise.all([
      gateway.seller(),
      gateway.payoutWallet(),
      config.surfaceMode === "live"
        ? gateway.liveApproval()
        : Promise.resolve({ ok: true as const, document: undefined }),
    ]);
    if (!seller.ok) return problemOf(seller);
    if (!wallet.ok) return problemOf(wallet);
    if (!approval.ok) return problemOf(approval);
    return {
      kind: "view",
      ...(status === undefined ? {} : { status }),
      view: settingsView(
        config.surfaceMode,
        person.email,
        {
          sellerName: seller.document.name,
          sellerSite: seller.document.site,
          payoutWallet: wallet.document,
          ...(approval.document === undefined ? {} : { liveApproval: approval.document }),
        },
        press,
      ),
    };
  };

  const toSettings: Outcome<never> = { kind: "redirect", location: `${base}/settings` };

  /**
   * Every other session of every account at the merchant ends but the one the
   * presser's cookie names, since the change may have come from any of them.
   */
  const signOutTheOthers = async (person: Person, cookie: string | undefined): Promise<number> =>
    person.merchant === null
      ? 0
      : await identity.endOtherSessionsOfMerchant(person.merchant.id, cookie);

  /**
   * Cancelling is asking the gateway for the address that applies now. Reached
   * by the Cancel control or by typing that address while a change waits;
   * typed, the person may not know they cancelled, so the page says so. Other
   * sessions end, or the one that asked for the change could ask again. A
   * change that took effect between the read and the request is not
   * cancelled: the old address is then a change back, which waits and is
   * announced, and the page and log say so.
   */
  const cancelWaiting = async (
    person: Person,
    cookie: string | undefined,
    gateway: GatewayClient,
    applies: string,
    pending: PendingPayoutWallet,
    byTyping: boolean,
  ): Promise<Outcome<SettingsView>> => {
    const cancelled = await gateway.setPayoutWallet(applies);
    if (!cancelled.ok) return problemOf(cancelled);
    const ended = await signOutTheOthers(person, cookie);
    if (cancelled.document.pending === null) {
      noted(
        person,
        `cancelled a waiting change of the address their money arrives at, and ${ended} other sessions of the merchant were ended`,
      );
      if (!byTyping) return toSettings;
      return await settingsDrawn(person, {
        kind: "wallet-notice",
        notice: cancelledByTyping(applies, pending.payout_wallet),
      });
    }
    noted(
      person,
      `asked for the address their money arrives at back as a change of it took effect; that now waits, and ${ended} other sessions of the merchant were ended`,
    );
    return await settingsDrawn(person, {
      kind: "wallet-notice",
      notice:
        `The change to ${pending.payout_wallet} took effect at ${moment(pending.takes_effect_at)}, just before your request reached it. ` +
        `Asking for ${applies} back is a change like any other: it waits forty-eight hours and every account of your merchant was sent a message about it. ` +
        "Every other session of your merchant was signed out.",
    });
  };

  /**
   * A press from a page drawn while a change waited, arriving after it took
   * effect. Nothing takes the change back at once, so the gateway is not
   * asked; the page says when it took effect and how the old address comes
   * back, and the other sessions end, since an unwanted change has just landed.
   */
  const tookEffectBeforePress = async (
    person: Person,
    cookie: string | undefined,
    shown: Shown,
    how: string,
  ): Promise<Outcome<SettingsView>> => {
    const ended = await signOutTheOthers(person, cookie);
    noted(
      person,
      `${how} after a change of the address their money arrives at had taken effect, and ${ended} other sessions of the merchant were ended`,
    );
    return await settingsDrawn(person, { kind: "wallet-notice", notice: landedBeforePress(shown) });
  };

  const registerMerchant = async (): Promise<string | null> => {
    const made = await parts.registrar.register();
    if (!made.ok) {
      console.error(`[dashboard] no merchant was made: ${made.why}`);
      return null;
    }
    return made.document;
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
    woo: parts.woo,

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
        // The box is drawn unticked whatever the address says: only a press
        // on it is a consent.
        const { click } = offeredIn(query);
        return {
          kind: "view",
          view: {
            ...askViewOf(query),
            ...(click === undefined ? {} : { click: { id: click.id, consented: false } }),
          },
        };
      },

      async ask(form) {
        const typed = once(form.getAll("email"));
        const email = typeof typed === "string" ? typed.trim() : "";
        const destination = dashboardDestinationIn(once(form.getAll("destination")));
        const offered = offeredIn(form);
        if (!LOOKS_LIKE_AN_ADDRESS.test(email)) {
          return {
            kind: "view",
            status: 400,
            view: {
              screen: "ask",
              destination,
              problem: NOT_AN_ADDRESS,
              ...offered,
            },
          };
        }
        const requested = await identity.requestLink(
          email,
          destination,
          consentedClickOf(offered.click),
        );
        if (requested.status === "unavailable") {
          return { kind: "view", status: 503, view: { screen: "unavailable", ...offered } };
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
          view: { screen: "requested", email, destination, answer, ...offered },
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
        const link = token === "" ? null : await identity.landingOf(token);
        if (link === null) {
          return await refuseLink(cookie);
        }
        return {
          kind: "view",
          view: { screen: "open", token, email: link.email, tellsTracker: link.tellsTracker },
          headers: LINK_HEADERS,
        };
      },

      // Only the yes the page's own button sends, named once, tells the
      // tracker; anything else signs in and tells it nothing.
      async open(cookie, form) {
        const named = once(form.getAll("token"));
        const token = typeof named === "string" ? named : "";
        const tellTracker = once(form.getAll("report")) === "yes";
        const opened =
          token === ""
            ? { status: "refused" as const }
            : await identity.openLink(token, { tellTracker });
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

    start: {
      where: (person) => ({
        kind: "redirect",
        location: person.merchant === null ? `${base}/merchant` : `${base}/cards`,
      }),

      // Drawing it makes nothing; only the same-origin press asks the gateway
      // for the merchant.
      merchant: (person) =>
        person.merchant === null
          ? { kind: "view", view: { unavailable: false } }
          : { kind: "redirect", location: `${base}/cards` },

      async openMerchant(person) {
        if (person.merchant !== null) {
          return { kind: "redirect", location: `${base}/cards` };
        }
        const attached = await identity.attachMerchant(person.id, registerMerchant);
        if (attached.status === "attached") {
          return { kind: "redirect", location: `${base}/choose-name` };
        }
        if (attached.status === "already-attached") {
          return { kind: "redirect", location: `${base}/cards` };
        }
        if (attached.status === "person-missing") {
          return {
            kind: "redirect",
            location: `${base}/sign-in`,
            setCookies: clearingLines(identity, config.cookieSecure),
          };
        }
        // A press that did not make a merchant leaves the person signed in to
        // press again rather than spending another link.
        return { kind: "view", status: 503, view: { unavailable: true } };
      },
    },

    sellerName: {
      // Asks the gateway for nothing: a merchant arrives here a second after
      // creation, with no name to draw. Coming back later gives the same form,
      // which sets the name as settings does.
      page: () => ({ kind: "view", view: { typed: "", rule: NAME_RULE } }),

      async choose(person, form) {
        // Trimmed rather than refused, because a leading space is a typing
        // accident and the catalogue's rule would make a padded name a second
        // spelling. A missing field reads as an empty one.
        const named = once(form.getAll("seller_name"));
        const typed = typeof named === "string" ? named.trim() : "";
        // Empty means the button was pressed with nothing in the box; the
        // catalogue's rule is not what they broke.
        const problem = typed === "" ? NAME_NEEDED : whatIsWrongWithTheName(typed);
        if (problem !== null) {
          return {
            kind: "view",
            status: 400,
            view: { typed, problem, rule: problem === NAME_REFUSED ? null : NAME_RULE },
          };
        }
        const set = await gatewayAs(person).setSellerName(typed);
        if (!set.ok) return problemOf(set);
        noted(person, "chose the name their products are sold under");
        return { kind: "redirect", location: `${base}/cards` };
      },
    },

    selling: {
      async press(person, query) {
        const pressed = switchIn(query);
        if (pressed === null) {
          return { kind: "problem", problem: { status: 404, said: NO_SUCH_SWITCH } };
        }
        const gateway = gatewayAs(person);
        const switched =
          pressed.card === undefined
            ? await gateway.setSelling(!pressed.paused)
            : await gateway.pauseCard(pressed.card, pressed.paused);
        if (!switched.ok) return problemOf(switched);
        noted(
          person,
          pressed.card === undefined
            ? pressed.paused
              ? "stopped all selling"
              : "started selling again"
            : `${pressed.paused ? "paused" : "resumed"} the card ${pressed.card}`,
        );
        // A redirect, so a reload does not press the switch again.
        return { kind: "redirect", location: `${base}/cards` };
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
            parts.woo !== null,
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

    settings: {
      page: (person) => settingsDrawn(person),

      async name(person, form) {
        const typed = typedIn(form, "seller_name");
        // Empty is a merchant trying to stop being listed, and the sentence
        // names the control that does that.
        const wrong = typed === "" ? NAME_CANNOT_BE_TAKEN_AWAY : whatIsWrongWithTheName(typed);
        if (wrong !== null) {
          return await settingsDrawn(person, { kind: "name", problem: wrong, typed }, 400);
        }
        const set = await gatewayAs(person).setSellerName(typed);
        if (!set.ok) return problemOf(set);
        noted(person, "changed the name their products are sold under");
        return toSettings;
      },

      async site(person, form) {
        const typed = typedIn(form, "seller_site");
        // Empty is a merchant trying to remove the site, which the gateway
        // refuses; the sentence says what to do instead.
        const wrong = typed === "" ? SITE_CANNOT_BE_TAKEN_AWAY : whatIsWrongWithTheSite(typed);
        if (wrong !== null) {
          return await settingsDrawn(person, { kind: "site", problem: wrong, typed }, 400);
        }
        const set = await gatewayAs(person).setSellerSite(typed);
        if (!set.ok) return problemOf(set);
        noted(person, "changed the site of their shop");
        return toSettings;
      },

      // The answer to a session left open somewhere or held by somebody else.
      // It ends no other account's sessions and touches no key, and says how
      // many it ended, the one thing the person could not otherwise see.
      async signOutOthers(person, cookie) {
        const ended = await identity.endOtherSessionsOfPerson(person.id, cookie);
        noted(person, `signed out every other device of their account, ${ended} sessions in all`);
        return await settingsDrawn(person, { kind: "account", notice: signedOutOthers(ended) });
      },

      // A press of its own rather than a second field on the name's: sharing
      // one would make every name save also rewrite the address, which turns a
      // typo in one box into a payment sent elsewhere. Checked here as well as
      // at the gateway, so an address of the wrong shape never leaves this
      // process.
      async wallet(person, form, cookie) {
        const typed = typedIn(form, "payout_wallet");
        const wrong = typed === "" ? WALLET_NEEDED : whatIsWrongWithTheWallet(typed);
        if (wrong !== null) {
          return await settingsDrawn(person, { kind: "wallet", problem: wrong, typed }, 400);
        }
        const gateway = gatewayAs(person, WALLET_CHANGE_MS);
        // With a change waiting, the current address is a cancel at the
        // gateway, and is treated as one here.
        const read = await gateway.payoutWallet();
        if (!read.ok) return problemOf(read);
        const { payout_wallet: applies, pending } = read.document;
        if (pending !== null && applies !== null && typed.toLowerCase() === applies.toLowerCase()) {
          return await cancelWaiting(person, cookie, gateway, applies, pending, true);
        }
        // The same act as pressing Cancel on that page, answered the same way.
        const shown = shownIn(form);
        if (
          pending === null &&
          shown !== null &&
          applies === shown.waiting &&
          shown.paid !== null &&
          typed.toLowerCase() === shown.paid.toLowerCase()
        ) {
          return await tookEffectBeforePress(
            person,
            cookie,
            shown,
            "typed the previous address back",
          );
        }
        const set = await gateway.setPayoutWallet(typed);
        if (!set.ok) return problemOf(set);
        // The address stays out of the line: not a secret, but this log records
        // who changed it, not what to.
        noted(
          person,
          set.document.pending === null
            ? "changed the address their money arrives at"
            : "asked for a change of the address their money arrives at, which now waits",
        );
        return toSettings;
      },

      // Asked as the signed-in person, after reading the wallet fresh rather
      // than trusting a page that may be a day old. Other sessions end only once
      // the press achieved something: a refused cancel leaves the change
      // waiting, and signing people out then would take away sessions that
      // might press again. The form carries the change it showed, so a press
      // arriving after that change took effect is not called a cancel.
      async cancel(person, form, cookie) {
        const gateway = gatewayAs(person, WALLET_CHANGE_MS);
        const read = await gateway.payoutWallet();
        if (!read.ok) return problemOf(read);
        const shown = shownIn(form);
        const { payout_wallet: applies, pending } = read.document;
        if (pending !== null && applies !== null) {
          return await cancelWaiting(person, cookie, gateway, applies, pending, false);
        }
        if (shown !== null && applies === shown.waiting) {
          return await tookEffectBeforePress(person, cookie, shown, "pressed cancel");
        }
        return toSettings;
      },
    },

    integrations: {
      // A shops read that fails is drawn as one that could not be read, never as
      // no block, which would tell a merchant who connected a shop that none is.
      // The failure is logged as a line: a store's exception can carry a shop's
      // key.
      async page(person) {
        if (parts.woo === null) return { kind: "view", view: integrationsView(undefined) };
        const shop = await parts.woo.stateOf(person.id).catch((): ShopTile => {
          console.error(
            "[dashboard] the WooCommerce connection could not be read for the integrations screen",
          );
          return { kind: "unread" };
        });
        return { kind: "view", view: integrationsView(shop) };
      },
    },

    keys: {
      async list(person, query) {
        const keys = await gatewayAs(person).keys();
        if (!keys.ok) return problemOf(keys);
        return {
          kind: "view",
          view: keysView(keys.document, { startNew: once(query.getAll("new")) === "key" }),
        };
      },

      async issue(person, form) {
        const named = once(form.getAll("label"));
        const label = typeof named === "string" ? named.trim() : "";
        const gateway = gatewayAs(person);
        const problem = whatIsWrongWithTheLabel(label);
        if (problem !== null) {
          // The list is read again so the refusal lands on the page they were
          // looking at.
          const keys = await gateway.keys();
          if (!keys.ok) return problemOf(keys);
          return { kind: "view", status: 400, view: keysView(keys.document, { problem }) };
        }
        const issued = await gateway.issueKey(label);
        if (!issued.ok) return problemOf(issued);
        // The name and identifier, never the secret: a log goes places the
        // database does not, and this is the one moment the secret exists
        // outside the merchant's hands.
        noted(person, `issued a key, ${issued.document.key.id}, named "${label}"`);
        return { kind: "view", view: newKeyView(label, issued.document.secret) };
      },

      async disable(person, keyId) {
        const stopped = await gatewayAs(person).disableKey(keyId);
        // Including the refusal the screen never offers a control for: the
        // gateway will not disable the key its caller holds. Whoever reaches
        // this anyway is told what the gateway said.
        if (!stopped.ok) return problemOf(stopped);
        noted(person, `revoked the key ${keyId}`);
        // A redirect, so a reload does not press it again.
        return { kind: "redirect", location: `${base}/keys` };
      },
    },
  };
}
