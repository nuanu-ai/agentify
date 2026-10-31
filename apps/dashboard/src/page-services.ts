/**
 * The server half of the React pages: what their loaders, actions and gate
 * call. A call takes what the request carried and answers with an `Outcome` —
 * a view to draw, a place to send the browser, or a problem to show — never
 * with a response, so the pages decide nothing a test of this module cannot
 * see. The pages import only the types from here: the build that runs in the
 * browser carries none of this, and the build that runs on the server is handed
 * it by the process that mounts it.
 */

import type { SurfaceMode } from "@agentify/core";
import { NewKeyLabelSchema } from "@agentify/gateway";
import type {
  AnalyticsEvent,
  AuthResult,
  DashboardViewed,
  UiBlocked,
} from "@agentify/gateway/analytics";
import { failureNamed } from "@agentify/gateway/failure-named";
import { PARTNER_CLICK_ID_PATTERN } from "@agentify/scanner-contracts/click-id";
import { SURFACE_MARKER_ATTRIBUTE, SURFACE_WORDS } from "@agentify/ui/surface";
import {
  EvmAddressSchema,
  IdentifierSchema,
  OrderCloseRequestSchema,
  type PendingPayoutWallet,
} from "@nuanu-ai/agentify-contracts";
import { accountOf } from "./account-banner.js";
import type { WorkspaceDoor } from "./admin/index.js";
import { FailedAfterSettingCookies } from "./carried-cookies.js";
import type { DashboardConfig } from "./config.js";
import {
  asksForSellerDashboard,
  type DashboardDestination,
  type DashboardIdentity,
  dashboardDestinationIn,
  type LinkDestination,
  type LinkWall,
  type Person,
} from "./dashboard-entry.js";
import { WALLET_CHANGE_MS } from "./deadlines.js";
import { clearingLines, type Gate, gateFor, pathAfterSignIn, startOf } from "./gate.js";
import {
  type Acting,
  type Answer,
  type GatewayClient,
  NOT_A_PAYOUT_WALLET_CODE,
  type Registrar,
} from "./gateway.js";
import { type IntegrationsView, integrationsView } from "./integrations-view.js";
import { type KeysView, keysView, type NewKeyView, newKeyView } from "./keys.js";
import { nextStepOf, type Platform } from "./next-step.js";
import { noted } from "./noted.js";
import { type OnboardingPress, type OnboardingView, onboardingAccountView } from "./onboarding.js";
import { WALLET_NEEDED, whatIsWrongWithTheWallet } from "./payout-wallet.js";
import {
  NAME_CANNOT_BE_TAKEN_AWAY,
  NAME_NEEDED,
  NAME_RULE,
  SITE_CANNOT_BE_TAKEN_AWAY,
  whatIsWrongWithTheName,
  whatIsWrongWithTheSite,
} from "./seller-name.js";
import {
  type SettingsPress,
  type SettingsView,
  settingsView,
  type WalletNotice,
  walletEntryView,
} from "./settings-view.js";
import type { Viewer } from "./viewer.js";
import {
  type CardsView,
  CLOSURE_NOTES,
  type ClosurePressed,
  type ClosureUnlisted,
  cardsPlace,
  cardsView,
  closable,
  closedForGood,
  drawnClosedForGood,
  type FrameView,
  momentView,
  type OrdersView,
  ordersPlace,
  ordersView,
  type ReceiptsView,
  receiptsView,
} from "./views.js";
import type { WooPages } from "./woo-pages.js";
import type { ShopTile, WooShopView } from "./woo-views.js";

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
  | Readonly<{ kind: "problem"; problem: Problem; setCookies?: readonly string[] }>;

/**
 * A page that could not be drawn or a form that was not done. The page itself
 * adds the way back: its own address where a page failed, so the merchant
 * keeps their place, and the first screen where a form did.
 */
interface Problem {
  readonly status: number;
  readonly said: string;
  /**
   * Refused where the press is known to have done nothing; left out where
   * nothing says, which a page words as possibly done.
   */
  readonly outcome?: "refused";
}

/** A screen of the cabinet, as product analytics names it. */
export type Screen = DashboardViewed["fields"]["screen"];

/** What a problem shown on a screen came to, as product analytics counts it. */
type Blocked = Pick<UiBlocked["fields"], "outcome" | "reason_code">;

/**
 * A screen's read that failed, by the status its problem page was sent with:
 * nothing answered in time is a 504, a service the read needs that is away a
 * 503. A refusal of a read says nothing about which rule refused it.
 */
const loadFailedAs = (status: number): Blocked =>
  status === 504
    ? { outcome: "failed", reason_code: "timeout" }
    : status === 503
      ? { outcome: "failed", reason_code: "dependency_unavailable" }
      : status >= 500
        ? { outcome: "failed", reason_code: "internal_error" }
        : { outcome: "blocked", reason_code: "unknown" };

/**
 * A press the gateway did not do, by its answer. Nothing answered in time may
 * still have been done, so its outcome is unknown; a refusal is named by its
 * status.
 */
const refusedAs = (answer: Answer<unknown> & { ok: false }): Blocked =>
  answer.status === 0
    ? { outcome: "unknown", reason_code: "timeout" }
    : answer.status === 400 || answer.status === 404
      ? { outcome: "blocked", reason_code: "invalid_input" }
      : answer.status === 409
        ? { outcome: "blocked", reason_code: "operation_closed" }
        : answer.status === 503
          ? { outcome: "failed", reason_code: "dependency_unavailable" }
          : answer.status >= 500
            ? { outcome: "failed", reason_code: "internal_error" }
            : { outcome: "blocked", reason_code: "unknown" };

const INVALID_INPUT: Blocked = { outcome: "blocked", reason_code: "invalid_input" };

/**
 * What a crawler, a link preview, an uptime monitor, our own public probe or a
 * script calls itself by. A browser always names itself, so saying nothing is
 * a program too.
 */
const PROGRAM_NAMES = /bot|crawl|spider|preview|monitor|probe|curl|wget|python-requests|headless/i;
const fetchedByAProgram = (userAgent: string | null): boolean =>
  userAgent === null || userAgent.trim() === "" || PROGRAM_NAMES.test(userAgent);

/** A sign-in link that is unknown, expired, spent or missing. */
const LINK_REFUSED: AuthResult = {
  name: "agc_auth_result",
  actor: "human",
  source: "dashboard",
  fields: {
    method: "email_link",
    stage: "verify",
    outcome: "blocked",
    reason_code: "invalid_link",
  },
};

/** Which stack this is, said on every page; nothing is said on the live one. */
export interface Surface {
  readonly attribute: string;
  readonly mode: SurfaceMode;
  readonly words: string | null;
}

/**
 * A problem is a refusal of something the person did and is drawn under the
 * box; a reason is why they are on the page at all, such as an expired
 * session, and is the card's first line in the ordinary voice. `clickId` is
 * the ad click a visitor arrived with, which the sign-in forms carry from page
 * to page, present only where the report is switched on.
 */
export type SignInView =
  | Readonly<{
      screen: "ask";
      destination: DashboardDestination;
      googleEnabled: boolean;
      email?: string;
      problem?: string;
      reason?: string;
      clickId?: string;
    }>
  | Readonly<{
      screen: "requested";
      email: string;
      destination: DashboardDestination;
      answer: LinkAnswer;
      /** Offered where a limit that no other address escapes refused the link. */
      googleEnabled: boolean;
      clickId?: string;
    }>
  | Readonly<{ screen: "unavailable"; destination: DashboardDestination; clickId?: string }>;

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
  | Readonly<{ screen: "open"; token: string; email: string; destination: DashboardDestination }>
  | Readonly<{ screen: "refused"; destination: DashboardDestination }>;

/**
 * The one control that makes a merchant. `unavailable` is a press, or a
 * sign-in on the dashboard's own page, that did not make one, which leaves the
 * person signed in to press again.
 */
export interface MerchantView {
  readonly unavailable: boolean;
}

export interface PageServices {
  /**
   * Records for product analytics that a visit was answered with this screen,
   * at this status, and a failed load where the status is a problem's; a
   * visit by nobody signed in from a program fetching pages is not recorded.
   * It neither waits for the database nor fails with it.
   */
  readonly shown: (
    screen: Screen,
    person: Person | null,
    status: number,
    userAgent: string | null,
  ) => void;
  /**
   * The door to the operator's workspace, which only its layout opens, or null
   * where the workspace is not built, which answers every page of it as one
   * that is not there.
   */
  readonly workspace: WorkspaceDoor | null;
  /** "" when mounted at the root of its origin. */
  readonly base: string;
  practice(person: Person): Promise<void>;
  readonly onboarding: {
    press(
      person: Person,
      form: FormData,
    ): Promise<Outcome<{ problem: string; platform?: Platform }>>;
    account(person: Person, form: FormData): Promise<Outcome<OnboardingPress | WooShopView>>;
    shopPress(
      person: Person,
      operation: string,
      form: FormData,
      cookie: string | undefined,
    ): Promise<Outcome<WooShopView>>;
  };
  readonly surface: Surface;
  readonly gate: Gate;
  readonly signIn: {
    page(cookie: string | undefined, query: URLSearchParams): Promise<Outcome<SignInView>>;
    /** `client` is the address the press came from, as `clientAddressOf` reads it. */
    ask(form: FormData, client: string): Promise<Outcome<SignInView>>;
    landing(cookie: string | undefined, query: URLSearchParams): Promise<Outcome<OpenLinkView>>;
    open(cookie: string | undefined, form: FormData): Promise<Outcome<OpenLinkView>>;
    googleStart(form: FormData): Promise<Outcome<Extract<SignInView, { screen: "ask" }>>>;
    googleFinish(
      cookie: string | undefined,
      query: URLSearchParams,
    ): Promise<Outcome<Extract<SignInView, { screen: "ask" }>>>;
    signOut(cookie: string | undefined): Promise<Outcome<never>>;
  };
  /**
   * The way in for a person the gate let through: where the dashboard's own
   * address leads, and the control that makes a merchant for a person with
   * none.
   */
  readonly start: {
    where(person: Person): Outcome<never>;
    /** `cookie` says whether a sign-in just failed to make this person's merchant. */
    merchant(person: Person, cookie: string | undefined): Outcome<MerchantView>;
    openMerchant(person: Person): Promise<Outcome<MerchantView>>;
  };
  /** Stops this merchant's future Agentify fulfillment for one order. */
  readonly fulfillment: {
    close(person: Person, form: FormData): Promise<Outcome<OrdersView | ClosureUnlisted>>;
  };
  /** The card switches; each form carries the list it was drawn on. */
  readonly selling: {
    press(person: Person, query: URLSearchParams, form: FormData): Promise<Outcome<never>>;
  };
  /** The screens about a merchant's selling, for a person the gates let through. */
  readonly screens: {
    /** As the address asks: the words searched for, the segment and the page. */
    cards(person: Person, query: URLSearchParams): Promise<Outcome<CardsView>>;
    orders(person: Person, query: URLSearchParams): Promise<Outcome<OrdersView>>;
    receipts(person: Person, query: URLSearchParams): Promise<Outcome<ReceiptsView>>;
    /** The banner the frame draws over every page about the merchant's selling. */
    frame(person: Person): Promise<FrameView>;
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
    /** Ends every session of the account, the presser's own included, and leads to the sign-in. */
    signOutEverywhere(person: Person): Promise<Outcome<never>>;
    /** The account's own choice about product analytics, never another account's. */
    analytics(person: Person, form: FormData): Promise<Outcome<SettingsView>>;
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
  /** The WooCommerce connector's screens; null on a dashboard given no shop store. */
  readonly woo: WooPages | null;
}

export interface PageParts {
  readonly livePublicationPending?: (merchantId: string) => Promise<boolean>;
  readonly workspace?: WorkspaceDoor;
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
   * The WooCommerce connector's screens; null on a dashboard given no shop
   * store, where no screen offers it and none of its pages is answered.
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
const saidOf = (answer: Answer<unknown> & { ok: false }): string =>
  `${answer.why.slice(0, 1).toUpperCase()}${answer.why.slice(1)}`;

/**
 * A refusal that says nothing was written, or one the route gives before it
 * writes (a 4xx), did nothing. A call that ran out never reaches a page as a
 * problem: `answer` words it as unknown by the request's method.
 */
const outcomeOf = (answer: Answer<unknown> & { ok: false }): Problem["outcome"] =>
  answer.nothingRecorded === true || (answer.status >= 400 && answer.status < 500)
    ? "refused"
    : undefined;

export const problemOf = (answer: Answer<unknown> & { ok: false }): Outcome<never> => {
  const outcome = outcomeOf(answer);
  return {
    kind: "problem",
    problem: {
      status: answer.status === 0 ? 504 : answer.status,
      said: saidOf(answer),
      ...(outcome === undefined ? {} : { outcome }),
    },
  };
};

/**
 * Not the real grammar of an address: it catches the mistakes made in a form (a
 * missing half, a space, a bare word), as the account command does.
 */
const LOOKS_LIKE_AN_ADDRESS = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/**
 * The gate cannot say why the session ended (thirty days without a visit, or
 * ended from another device), so it says neither.
 */
const SESSION_ENDED = "Your session ended. Sign in again to carry on.";

/**
 * Signing out clears the cookie in every tab, so a form pressed in another one
 * arrives with no sign a session existed. The person is told it was not kept,
 * or they might take a pause for done.
 */
const UNSAVED = "You are not signed in, so the change you submitted was not saved.";

const SIGNED_OUT_EVERYWHERE_REASON = "signed-out-everywhere";

/**
 * Set by a sign-in that should have made the person's merchant and could not,
 * so the window it leads to says why it is there; read once. A browser takes a
 * `__Host-` cookie only from this origin, so no other site can make the window
 * claim a fault.
 */
const unopenedCookie = (secure: boolean): string =>
  `${secure ? "__Host-" : ""}agentify.merchant_unopened`;

const UNOPENED_SECONDS = 60;

const SIGNED_OUT_EVERYWHERE = "You signed out on every device, this one included.";

/**
 * A value named once, as a form or an address names it; named twice it is
 * nobody's choice, and is read as not named at all.
 */
const once = (values: readonly unknown[]): unknown => (values.length === 1 ? values[0] : undefined);

const textOf = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * The page a link's address names, so the next link asked for from there goes
 * to the same place. It can only keep a merchant from being made, as a section
 * or nothing named makes one alike; the link's own record decides whether its
 * press makes one.
 */
const readingIn = (named: URLSearchParams | FormData): DashboardDestination =>
  dashboardDestinationIn(once(named.getAll("destination")));

/**
 * The click an address or a form names once, in the tracker's form; null for
 * anything else, which leaves the page as it is without one.
 */
const clickIdIn = (named: URLSearchParams | FormData): string | null => {
  const id = once(named.getAll("clickid"));
  return typeof id === "string" && PARTNER_CLICK_ID_PATTERN.test(id) ? id : null;
};

/**
 * The sign-in form for a browser with no session, as its address asks for it:
 * where the person was going, and why they are here. An expired session is
 * the reason, said as the page's first line; a change lost with it is a
 * refusal, drawn under the box.
 */
export const askViewOf = (
  query: URLSearchParams,
  googleEnabled: boolean,
): Extract<SignInView, { screen: "ask" }> => {
  const said = once(query.getAll("reason"));
  const problem =
    said === "session-ended-unsaved"
      ? "Your session ended, so the change you submitted was not saved."
      : said === "unsaved"
        ? UNSAVED
        : undefined;
  const reason =
    said === "session-ended"
      ? SESSION_ENDED
      : said === SIGNED_OUT_EVERYWHERE_REASON
        ? SIGNED_OUT_EVERYWHERE
        : undefined;
  return {
    screen: "ask",
    destination: dashboardDestinationIn(once(query.getAll("destination"))),
    googleEnabled,
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

const GOOGLE_REFUSALS = {
  "email-unverified":
    "Google cannot confirm who owns this email address. Use a sign-in link to confirm it instead.",
  "email-changed":
    "This Google account's email address has changed. Use a sign-in link to your original Agentify email address.",
  cancelled: "Google sign-in was cancelled. Try again or use a sign-in link.",
  invalid: "Google sign-in could not be completed. Start again or use a sign-in link.",
  unavailable: "Google sign-in is not working right now. Use an email link instead.",
} as const;

/** The email comes from the identity's refusal, never from the callback's query. */
export const googleRefusalView = (
  googleEnabled: boolean,
  reason: keyof typeof GOOGLE_REFUSALS,
  destination: DashboardDestination,
  email: string | null = null,
): Extract<SignInView, { screen: "ask" }> => ({
  screen: "ask",
  destination,
  googleEnabled,
  reason: GOOGLE_REFUSALS[reason],
  ...(email === null || reason !== "email-unverified" ? {} : { email }),
});

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

const NO_SUCH_SWITCH = "There is no such switch on Products.";

/** A form's text fields as an address's query; a file a program posted is no field here. */
const fieldsIn = (form: FormData): URLSearchParams =>
  new URLSearchParams(
    [...form].flatMap(([name, value]) => (typeof value === "string" ? [[name, value]] : [])),
  );

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

/** Typed while a change waited, the wallet paid out to now cancels it, and the person may not know. */
export const cancelledByTyping = (applies: string): WalletNotice => ({
  kind: "cancelled",
  paid: applies,
});

/** A press from a page drawn while a change waited, arriving after it took effect. */
export const landedBeforePress = (shown: Shown): WalletNotice => ({
  kind: "landed",
  wallet: shown.waiting,
  at: shown.from,
  before: shown.paid,
  askedBack: false,
});

/** Stands for this dashboard's own origin while a page's own path is read. */
const HERE = "http://dashboard.invalid";

/**
 * The page a cancel pressed from the banner returns to: a path of this
 * dashboard with its query, or null for anything else, another site included,
 * since the form can carry anything and a redirect elsewhere would hand the
 * person to whoever wrote it.
 */
const pageToReturnTo = (form: FormData): string | null => {
  const back = once(form.getAll("back"));
  if (typeof back !== "string" || !back.startsWith("/")) return null;
  let read: URL;
  try {
    read = new URL(back, HERE);
  } catch {
    return null;
  }
  // Taken only as written: a path whose dots or doubled slashes resolve to
  // something else can resolve to `//`, which a browser reads as another site.
  const page = `${read.pathname}${read.search}`;
  return read.origin === HERE && page === back && !page.startsWith("//") ? page : null;
};

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
 * gateway's: one line, at most the length it takes, which also keeps the live
 * announcement naming it to one line.
 */
export const whatIsWrongWithTheLabel = (label: string): string | null => {
  if (label === "") {
    return "Enter a name for the key.";
  }
  const unfit = NewKeyLabelSchema.safeParse(label);
  if (unfit.success) return null;
  const said = unfit.error.issues[0]?.message ?? "that name cannot be given to a key";
  return `${said.slice(0, 1).toUpperCase()}${said.slice(1)}. No key was issued.`;
};

/**
 * How long the frame's read may take: a page is answered whole, so a slow one
 * would hold every page the frame is drawn on.
 */
const FRAME_WITHIN_MS = 2_000;

/** A gateway answer as the frame takes it: the document, or that it failed. */
type Read<T> = Readonly<{ read: true; value: T }> | Readonly<{ read: false }>;

const readOf = async <T>(
  ask: () => Promise<Answer<T>>,
  withinMs = FRAME_WITHIN_MS,
): Promise<Read<T>> => {
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answered = await Promise.race([
      ask(),
      new Promise<Answer<T>>((resolve) => {
        timer = setTimeout(
          () => resolve({ ok: false, status: 0, why: "the frame read did not answer in time" }),
          withinMs,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    return answered.ok ? { read: true, value: answered.document } : { read: false };
  } catch {
    console.error("[dashboard] a read for the frame failed");
    return { read: false };
  }
};

export function pageServicesFor(config: DashboardConfig, parts: PageParts): PageServices {
  const base = config.basePath;
  const { identity } = parts;

  // The identity's observe never rejects; caught anyway, because a rejection
  // nobody waits for would end the process.
  const observe = (event: AnalyticsEvent): void => {
    identity.observe(event).catch(() => undefined);
  };
  const whoIn = (person: Person): Readonly<{ person: string; merchant?: string }> => ({
    person: person.id,
    ...(person.merchant === null ? {} : { merchant: person.merchant.id }),
  });
  /** A problem a press of one of these operations was answered with, shown on its screen. */
  const blocked = (
    person: Person,
    screen: Screen,
    operation: "create_merchant" | "change_selling" | "close_order",
    came: Blocked,
  ): void => {
    observe({
      name: "agc_ui_blocked",
      actor: "human",
      source: "dashboard",
      refs: whoIn(person),
      fields: { screen, operation, ...came },
    });
  };

  /**
   * Read only where the report is switched on, so a dashboard that reports
   * nothing draws every sign-in page exactly as it would with no click, and
   * keeps none.
   */
  const carriedIn = (named: URLSearchParams | FormData): Readonly<{ clickId?: string }> => {
    if (config.registrationPostback === null) return {};
    const clickId = clickIdIn(named);
    return clickId === null ? {} : { clickId };
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
   * A setup value refused here, before the gateway was asked; what the gateway
   * answers it records itself. The step is recorded with the integration the
   * merchant sells through, read without holding the page, and not at all
   * where that cannot be read, since no integration is a claim of its own.
   */
  const setupRefused = (
    person: Person,
    step: "seller_name" | "seller_site" | "payout_wallet",
    reason: UiBlocked["fields"]["reason_code"],
  ): void => {
    void (async () => {
      const read = await gatewayAs(person)
        .integration()
        .catch(() => null);
      if (read?.ok !== true) {
        console.error(
          "[dashboard] a refused setup step went unrecorded: its integration was not read",
        );
        return;
      }
      const blocked = {
        integration: read.document.through,
        outcome: "blocked",
        reason_code: reason,
      } as const;
      const envelope = {
        name: "agc_setup_result",
        actor: "human",
        source: "dashboard",
        refs: whoIn(person),
      } as const;
      // Written twice so each branch is held to its own step's shape: a
      // wallet's step is the one that may also wait.
      observe(
        step === "payout_wallet"
          ? { ...envelope, fields: { step, ...blocked } }
          : { ...envelope, fields: { step, ...blocked } },
      );
    })().catch((thrown: unknown) => {
      // Nobody waits for this, so a throw left uncaught would end the process.
      console.error(`[dashboard] a refused setup step went unrecorded: ${failureNamed(thrown)}`);
    });
  };

  /**
   * One read of everything the settings page says, made after a press's work,
   * so the page shows what the press left. Any of the reads failing fails the
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
    const [seller, wallet, splits, approval, analyticsOptedOut] = await Promise.all([
      gateway.seller(),
      gateway.payoutWallet(),
      gateway.payoutSplits(),
      config.surfaceMode === "live"
        ? gateway.liveApproval()
        : Promise.resolve({ ok: true as const, document: undefined }),
      identity.analyticsOptedOut(person.id),
    ]);
    if (!seller.ok) return problemOf(seller);
    if (!wallet.ok) return problemOf(wallet);
    if (!splits.ok) return problemOf(splits);
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
          payoutSplits: splits.document,
          addressPage: config.addressPage,
          walletChain: config.walletChain,
          analyticsOptedOut,
          ...(approval.document === undefined ? {} : { liveApproval: approval.document }),
        },
        press,
      ),
    };
  };

  const toSettings: Outcome<never> = { kind: "redirect", location: `${base}/settings` };

  /** The page a cancel was pressed on, or Settings where it named none of the dashboard's. */
  const backTo = (back: string | null): Outcome<never> =>
    back === null ? toSettings : { kind: "redirect", location: `${base}${back}` };

  /**
   * Every session of every account at the merchant ends, the presser's own
   * included, since the change may have come from any of them, a copy of the
   * presser's cookie among them; the presser's browser is given a new session
   * in the same answer, which `renewing` puts on it.
   */
  const signOutAllButThisBrowser = async (
    person: Person,
    cookie: string | undefined,
  ): Promise<{
    ended: number;
    renewing: <View>(answering: () => Promise<Outcome<View>>) => Promise<Outcome<View>>;
  }> => {
    const { ended, setCookies } =
      person.merchant === null
        ? { ended: 0, setCookies: [] }
        : await identity.endMerchantSessionsAndRenew(person.merchant.id, cookie);
    return {
      ended,
      // The old session has ended by now, so whatever the answer, a failure
      // among them, it carries the new one.
      renewing: async (answering) => {
        let outcome: Awaited<ReturnType<typeof answering>>;
        try {
          outcome = await answering();
        } catch (thrown) {
          if (setCookies.length === 0) throw thrown;
          throw new FailedAfterSettingCookies(setCookies);
        }
        return setCookies.length === 0
          ? outcome
          : { ...outcome, setCookies: [...(outcome.setCookies ?? []), ...setCookies] };
      },
    };
  };

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
    back: string | null = null,
  ): Promise<Outcome<SettingsView>> => {
    const cancelled = await gateway.setPayoutWallet(applies);
    if (!cancelled.ok) return problemOf(cancelled);
    const { ended, renewing } = await signOutAllButThisBrowser(person, cookie);
    if (cancelled.document.pending === null) {
      noted(
        person,
        `cancelled a waiting change of the wallet their share is paid out to; ${ended} sessions of the merchant were ended and this browser was given a new one`,
      );
      if (!byTyping) return await renewing(async () => backTo(back));
      return await renewing(
        async () =>
          await settingsDrawn(person, {
            kind: "wallet-notice",
            notice: cancelledByTyping(applies),
          }),
      );
    }
    noted(
      person,
      `asked for the wallet their share is paid out to back as a change of it took effect; that now waits, ${ended} sessions of the merchant were ended and this browser was given a new one`,
    );
    return await renewing(
      async () =>
        await settingsDrawn(person, {
          kind: "wallet-notice",
          notice: {
            kind: "landed",
            wallet: pending.payout_wallet,
            at: pending.takes_effect_at,
            before: applies,
            askedBack: true,
          },
        }),
    );
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
    const { ended, renewing } = await signOutAllButThisBrowser(person, cookie);
    noted(
      person,
      `${how} after a change of the wallet their share is paid out to had taken effect; ${ended} sessions of the merchant were ended and this browser was given a new one`,
    );
    return await renewing(
      async () =>
        await settingsDrawn(person, { kind: "wallet-notice", notice: landedBeforePress(shown) }),
    );
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
   * Makes the merchant of a person who has none: where they go next, or null
   * where none was made, which leaves them signed in on the window to press
   * again rather than spending another link.
   */
  const merchantMadeFor = async (
    person: Person,
  ): Promise<Readonly<{ location: string; setCookies: readonly string[] }> | null> => {
    const attached = await identity.attachMerchant(person.id, registerMerchant);
    if (attached.status === "attached" || attached.status === "already-attached")
      return { location: `${base}/products`, setCookies: [] };
    if (attached.status === "person-missing") {
      return {
        location: `${base}/sign-in`,
        setCookies: clearingLines(identity, config.cookieSecure),
      };
    }
    blocked(person, "merchant", "create_merchant", {
      outcome: "failed",
      reason_code: "dependency_unavailable",
    });
    return null;
  };

  const unopenedName = unopenedCookie(config.cookieSecure);
  const unopenedLine = (set: boolean): string =>
    `${unopenedName}=${set ? "1" : ""}; Path=/; Max-Age=${set ? UNOPENED_SECONDS : 0}; HttpOnly;${config.cookieSecure ? " Secure;" : ""} SameSite=Lax`;
  const carriesUnopened = (cookie: string | undefined): boolean =>
    (cookie ?? "").split(";").some((pair) => pair.trim() === `${unopenedName}=1`);

  /**
   * A browser with a live session goes to its own start, so the answer depends
   * on who the browser is and never on whose the link was. Anybody else gets
   * one refusal for a spent, expired or unknown link.
   */
  const refuseLink = async (
    cookie: string | undefined,
    destination: DashboardDestination,
  ): Promise<Outcome<OpenLinkView>> => {
    const signedIn = await identity.whoIs(cookie);
    if (signedIn !== null) {
      return {
        kind: "redirect",
        location: startOf(base, signedIn.person),
        headers: LINK_HEADERS,
        setCookies: signedIn.setCookies,
      };
    }
    return {
      kind: "view",
      view: { screen: "refused", destination },
      status: 401,
      headers: LINK_HEADERS,
    };
  };

  /**
   * Where a sign-in that opened leads, with its new session's cookies. One
   * asked for on the dashboard's own sign-in page is itself the request for a
   * seller dashboard, so it makes the merchant of a person who has none; where
   * that fails the person stays signed in, on the window that says so. Only
   * what was recorded when the sign-in was asked for decides this, never the
   * request that ends it, so no link from another site can make anybody a
   * merchant. A link the scanner asked for goes to its report, where the
   * scanner finishes the request the session now names; a sign-in from a
   * scanner's door goes to the start; any other to its screen.
   */
  const signedInTo = async (
    person: Person,
    destination: LinkDestination,
    setCookies: readonly string[],
  ): Promise<Readonly<{ location: string; setCookies: readonly string[] }>> => {
    // A note left by an earlier sign-in in this browser, perhaps somebody
    // else's, is not this one's to show.
    const signedIn = [...setCookies, unopenedLine(false)];
    if (typeof destination !== "string") {
      return {
        location: `/report/${encodeURIComponent(destination.report)}`,
        setCookies: signedIn,
      };
    }
    if (person.merchant !== null || !asksForSellerDashboard(destination)) {
      return { location: pathAfterSignIn(base, person, destination), setCookies: signedIn };
    }
    // The session is already written, so a failure here must not take its
    // cookie away: the link that made it is spent.
    const made = await merchantMadeFor(person).catch(() => {
      console.error("[dashboard] no merchant was made at sign-in");
      return null;
    });
    return made === null
      ? { location: `${base}/merchant`, setCookies: [...setCookies, unopenedLine(true)] }
      : { location: made.location, setCookies: [...signedIn, ...made.setCookies] };
  };

  const ordersScreen = async (
    person: Person,
    query: URLSearchParams,
  ): Promise<Outcome<OrdersView>> => {
    const gateway = gatewayAs(person);
    // The open list is read beside the whole one, never after it, since
    // which orders are open is the gateway's to say.
    const [cards, read, open, paidInto] = await Promise.all([
      gateway.cards(),
      gateway.ordersWithRecords(),
      gateway.orders(true),
      gateway.paidIntoSplits(),
    ]);
    if (!cards.ok) return problemOf(cards);
    if (!read.ok) return problemOf(read);
    if (!open.ok) return problemOf(open);
    if (!paidInto.ok) return problemOf(paidInto);
    const { orders, records } = read.document;
    // How a late delivery can still reach each unfulfilled order depends on
    // whether the shop connector holds its sale, whatever the merchant sells
    // through now.
    const unfulfilled = orders.orders
      .filter((order) => order.status === "unfulfilled")
      .map((order) => order.id);
    const [shopTotals, connector] =
      parts.woo === null
        ? [{}, {}]
        : await Promise.all([
            parts.woo.shopTotals(
              person,
              orders.orders.map((order) => order.id),
            ),
            unfulfilled.length === 0 ? {} : parts.woo.connectorSales(person, unfulfilled),
          ]);
    const view = ordersView(
      cards.document,
      orders,
      open.document,
      query,
      records,
      paidInto.document,
      shopTotals,
      connector,
      new Set(
        Object.entries(records)
          .filter(([, record]) => record.counts)
          .map(([id]) => id),
      ),
      config.transactionPage,
    );
    return { kind: "view", view };
  };

  return {
    onboarding: {
      async account(person, form) {
        const gateway = gatewayAs(person, WALLET_CHANGE_MS);
        const intent = typedIn(form, "intent");
        const sellerName = typedIn(form, "seller_name");
        const wallet = typedIn(form, "payout_wallet");
        const refused = (
          problem: string | null,
          status = 400,
          fields: Partial<OnboardingPress> = {},
        ): Outcome<OnboardingPress> => ({
          kind: "view",
          status,
          view: { screen: "onboarding", problem, sellerName, wallet, ...fields },
        });
        if (intent === "request-live-sales") {
          const previous = await gateway.liveSalesRequest().catch(() => null);
          if (previous === null || !previous.ok)
            return refused("We couldn't read your request. Check again before asking.", 503, {
              requestNeedsCheck: true,
              requestResolvedProblem:
                "We checked again and found no pending request. You can ask again.",
            });
          if (previous.document?.state === "pending")
            return { kind: "redirect", location: `${base}/products` };
          const wrong = sellerName === "" ? NAME_NEEDED : whatIsWrongWithTheName(sellerName);
          if (wrong !== null) return refused(null, 400, { nameProblem: wrong });
          const standing = await gateway.standing();
          if (!standing.ok) return refused("We couldn't check your connection. Try again.", 503);
          const evidence =
            standing.document.through === "woocommerce"
              ? ((await parts.woo?.onboardingFacts(person))?.evidence ?? null)
              : standing.document.contactAlive && standing.document.lastContact !== null
                ? { integration: "api" as const, connectedAt: standing.document.lastContact }
                : null;
          if (evidence === null)
            return refused(
              "Check your shop products or reconnect your code before asking for live sales.",
              409,
            );
          const asked = await gateway.askForLiveSales(person.id, sellerName, evidence).catch(() => {
            console.error("[dashboard] a live-sales request result could not be confirmed");
            return null;
          });
          if (asked === null || (!asked.ok && outcomeOf(asked) === undefined))
            return refused("We couldn't confirm your request. Check again before asking.", 503, {
              requestNeedsCheck: true,
              requestResolvedProblem:
                "We checked again and found no pending request. You can ask again.",
            });
          if (!asked.ok) return refused(saidOf(asked), asked.status);
          if (asked.document.kind === "moved" || asked.document.kind === "missing")
            return refused(
              "Your account changed while you asked, so the request wasn't sent. Check again before asking.",
              409,
            );
          return { kind: "redirect", location: `${base}/products` };
        }
        if (intent !== "save-onboarding-profile" && intent !== "save-onboarding-wallet")
          return refused("There is no such setup action.", 404);
        const profile = intent === "save-onboarding-profile";
        const nameWrong = profile
          ? sellerName === ""
            ? NAME_NEEDED
            : whatIsWrongWithTheName(sellerName)
          : null;
        const walletWrong =
          config.surfaceMode === "sandbox" && wallet === ""
            ? null
            : wallet === ""
              ? WALLET_NEEDED
              : whatIsWrongWithTheWallet(wallet);
        if (nameWrong !== null || walletWrong !== null)
          return refused(null, 400, {
            ...(nameWrong === null ? {} : { nameProblem: nameWrong }),
            ...(walletWrong === null ? {} : { walletProblem: walletWrong }),
          });
        const finished = async (): Promise<Outcome<OnboardingPress | WooShopView>> => {
          if (!profile || !form.has("checked_job"))
            return { kind: "redirect", location: `${base}/products` };
          const savedProfile =
            wallet === ""
              ? "Your seller name was saved."
              : "Your seller name and wallet were saved.";
          const problem = (
            said: string,
            status: number,
          ): Outcome<OnboardingPress | WooShopView> => ({
            kind: "problem",
            problem: { status, said: `${savedProfile} ${said}` },
          });
          if (parts.woo === null)
            return problem("Connect your shop from Integrations before publishing.", 409);
          try {
            const publication = await parts.woo.importCatalogue(
              person,
              typedIn(form, "checked_job"),
            );
            if (publication.kind === "view")
              return { ...publication, view: { ...publication.view, savedProfile } };
            if (publication.kind === "problem")
              return problem(publication.problem.said, publication.problem.status);
            return problem(
              "Your shop is no longer connected. Open Integrations to reconnect it before publishing.",
              409,
            );
          } catch {
            console.error("[dashboard] an onboarding publication result could not be confirmed");
            return problem(
              "We couldn't confirm whether publication started. Open Products before trying again.",
              503,
            );
          }
        };
        if (profile) {
          const named = await gateway.setSellerName(sellerName).catch(() => {
            console.error("[dashboard] an onboarding seller-name result could not be confirmed");
            return null;
          });
          if (named === null || !named.ok)
            return refused(
              "We couldn't confirm your seller name. Check Settings before saving again.",
              503,
            );
        }
        if (wallet === "" && config.surfaceMode === "sandbox") return await finished();
        const saved = await gateway.setPayoutWallet(wallet).catch(() => {
          console.error("[dashboard] an onboarding wallet result could not be confirmed");
          return null;
        });
        const unconfirmedWallet = `${profile ? "Your seller name was saved. " : ""}We couldn't confirm your wallet. Check Settings before saving again.`;
        if (saved === null) return refused(unconfirmedWallet, 503);
        if (!saved.ok) {
          const known =
            saved.nothingRecorded === true || (saved.status >= 400 && saved.status < 500);
          return refused(
            known
              ? `${profile ? "Your seller name was saved. " : ""}${saidOf(saved)}`
              : unconfirmedWallet,
            known ? saved.status : 503,
          );
        }
        return await finished();
      },
      async shopPress(person, operation, form, cookie) {
        const woo = parts.woo;
        if (woo === null)
          return {
            kind: "problem",
            problem: { status: 404, said: "There is no shop connector on this dashboard." },
          };
        const operations: Readonly<Record<string, () => Promise<Outcome<WooShopView>>>> = {
          connect: () => woo.connect(person, form),
          check: () => woo.checkCatalogue(person),
          import: () =>
            woo.importCatalogue(
              person,
              typeof form.get("checked_job") === "string" ? String(form.get("checked_job")) : null,
            ),
          site: () => woo.useShopSite(person),
          rate: () => woo.setRate(person, form, cookie),
          switch: () => woo.switchToShop(person),
          disconnect: () => woo.disconnect(person, form),
        };
        const press = Object.hasOwn(operations, operation) ? operations[operation] : undefined;
        if (press === undefined)
          return {
            kind: "problem",
            problem: { status: 404, said: "There is no such shop action." },
          };
        const result = await press();
        return result.kind === "redirect" && result.location.startsWith(`${base}/woocommerce`)
          ? {
              ...result,
              location: result.location.replace(`${base}/woocommerce`, `${base}/products`),
            }
          : result;
      },
      async press(person, form) {
        const intent = typedIn(form, "intent");
        const platform = typedIn(form, "platform");
        const chosen =
          platform === "woocommerce" || platform === "api" || platform === "other"
            ? platform
            : undefined;
        try {
          if (intent === "acknowledge-test") {
            if (config.surfaceMode !== "test" || typedIn(form, "understood") !== "yes")
              return {
                kind: "view",
                status: 400,
                view: { problem: "Read and acknowledge the test environment before starting." },
              };
            await identity.acknowledgeTest(person.id);
          } else {
            if (chosen === undefined)
              return {
                kind: "view",
                status: 400,
                view: { problem: "Choose one of the available ways to add products." },
              };
            const integration = await gatewayAs(person, FRAME_WITHIN_MS)
              .integration()
              .catch(() => null);
            if (integration?.ok !== true)
              console.error(
                "[analytics] a platform answer went unrecorded: its integration was not read",
              );
            await identity.choosePlatform(
              person.id,
              chosen,
              integration?.ok === true ? integration.document.through : undefined,
            );
          }
        } catch {
          return {
            kind: "view",
            status: 503,
            view: {
              problem:
                intent === "acknowledge-test"
                  ? "We couldn't save that. Try again."
                  : "We couldn't save your answer. Choose again.",
              ...(chosen === undefined ? {} : { platform: chosen }),
            },
          };
        }
        return { kind: "redirect", location: `${base}/products` };
      },
    },
    async practice(person) {
      try {
        if (person.merchant === null || (await identity.analyticsOptedOut(person.id))) return;
        await identity.observe({
          name: "agc_practice_opened",
          actor: "human",
          source: "dashboard",
          refs: { person: person.id, merchant: person.merchant.id },
          fields: {},
        });
      } catch {
        console.error("[analytics] a practice visit could not be recorded");
      }
    },
    shown(screen, person, status, userAgent) {
      if (person === null && fetchedByAProgram(userAgent)) return;
      const who = person === null ? {} : { refs: whoIn(person) };
      observe({
        name: "agc_dashboard_viewed",
        actor: "human",
        source: "dashboard",
        ...who,
        fields: { screen },
      });
      if (status >= 400) {
        observe({
          name: "agc_ui_blocked",
          actor: "human",
          source: "dashboard",
          ...who,
          fields: { screen, operation: "load_screen", ...loadFailedAs(status) },
        });
      }
    },
    workspace: parts.workspace ?? null,
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
            location: pathAfterSignIn(base, signedIn.person, destination),
            setCookies: signedIn.setCookies,
          };
        }
        return {
          kind: "view",
          view: { ...askViewOf(query, identity.googleEnabled), ...carriedIn(query) },
        };
      },

      async ask(form, client) {
        const typed = once(form.getAll("email"));
        const email = typeof typed === "string" ? typed.trim() : "";
        const destination = dashboardDestinationIn(once(form.getAll("destination")));
        const carried = carriedIn(form);
        if (!LOOKS_LIKE_AN_ADDRESS.test(email)) {
          // Decided here, before the identity is asked; every later refusal
          // of the request is the identity's to record.
          observe({
            name: "agc_auth_result",
            actor: "human",
            source: "dashboard",
            fields: { method: "email_link", stage: "start", ...INVALID_INPUT },
          });
          return {
            kind: "view",
            status: 400,
            view: {
              screen: "ask",
              destination,
              googleEnabled: identity.googleEnabled,
              problem: NOT_AN_ADDRESS,
              ...carried,
            },
          };
        }
        const requested = await identity.requestLink(email, destination, { client, ...carried });
        if (requested.status === "unavailable") {
          return {
            kind: "view",
            status: 503,
            view: { screen: "unavailable", destination, ...carried },
          };
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
          view: {
            screen: "requested",
            email,
            destination,
            answer,
            googleEnabled: identity.googleEnabled,
            ...carried,
          },
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
          // Decided here: the page drawn has no press, so nothing after it
          // records this refusal again.
          observe(LINK_REFUSED);
          return await refuseLink(cookie, readingIn(query));
        }
        return {
          kind: "view",
          view: { screen: "open", token, email: link.email, destination: readingIn(query) },
          headers: LINK_HEADERS,
        };
      },

      async open(cookie, form) {
        const named = once(form.getAll("token"));
        const token = typeof named === "string" ? named : "";
        // Decided here; a token the identity is asked about is its own to record.
        if (token === "") observe(LINK_REFUSED);
        const opened =
          token === "" ? { status: "refused" as const } : await identity.openLink(token);
        if (opened.status === "refused") {
          return await refuseLink(cookie, readingIn(form));
        }
        // The new session replaces the old one rather than sitting beside it;
        // otherwise the old row would live on with nothing holding its cookie
        // and count as another place this account is signed in.
        await identity.signOut(cookie);
        return {
          kind: "redirect",
          headers: LINK_HEADERS,
          ...(await signedInTo(opened.person, opened.destination, opened.setCookies)),
        };
      },

      async googleStart(form) {
        const destination = dashboardDestinationIn(once(form.getAll("destination")));
        const carried = carriedIn(form);
        const started = await identity.startGoogle(destination, carried.clickId);
        if (started.status === "redirect") {
          return {
            kind: "redirect",
            location: started.location,
            headers: LINK_HEADERS,
            setCookies: started.setCookies,
          };
        }
        return {
          kind: "view",
          status: 503,
          headers: LINK_HEADERS,
          view: {
            ...googleRefusalView(identity.googleEnabled, "unavailable", destination),
            ...carried,
          },
        };
      },

      async googleFinish(cookie, query) {
        const finished = await identity.finishGoogle(query, cookie);
        if (finished.status === "opened") {
          await identity.signOut(cookie);
          return {
            kind: "redirect",
            headers: LINK_HEADERS,
            ...(await signedInTo(finished.person, finished.destination, finished.setCookies)),
          };
        }
        return {
          kind: "view",
          status: finished.reason === "unavailable" ? 503 : 401,
          headers: LINK_HEADERS,
          setCookies: finished.setCookies,
          view: {
            ...googleRefusalView(
              identity.googleEnabled,
              finished.reason,
              finished.destination,
              finished.email,
            ),
            ...(finished.clickId === undefined ? {} : { clickId: finished.clickId }),
          },
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
        // The site's sign-out is pressed on the scanner's pages too, so the
        // sign-in it leads to makes no merchant; somebody who has one is sent
        // on to it all the same.
        return {
          kind: "redirect",
          location: `${base}/sign-in?destination=reports`,
          setCookies: [...clearingLines(identity, config.cookieSecure), unopenedLine(false)],
        };
      },
    },

    start: {
      where: (person) => ({
        kind: "redirect",
        location: person.merchant === null ? `${base}/merchant` : `${base}/products`,
      }),

      // Drawing it makes nothing; only the same-origin press asks the gateway
      // for the merchant.
      merchant: (person, cookie) => {
        if (person.merchant !== null) return { kind: "redirect", location: `${base}/products` };
        const told = carriesUnopened(cookie);
        return {
          kind: "view",
          view: { unavailable: told },
          ...(told ? { setCookies: [unopenedLine(false)] } : {}),
        };
      },

      async openMerchant(person) {
        if (person.merchant !== null) {
          return { kind: "redirect", location: `${base}/products` };
        }
        const made = await merchantMadeFor(person);
        return made === null
          ? { kind: "view", status: 503, view: { unavailable: true } }
          : { kind: "redirect", ...made };
      },
    },

    fulfillment: {
      async close(person, form) {
        const id = IdentifierSchema.safeParse(once(form.getAll("order_id")));
        const sent = once(form.getAll("message"));
        // A browser sends the line breaks of a box of several lines as a
        // carriage return and a line feed; plain text breaks with the feed alone.
        const typed = typeof sent === "string" ? sent.replaceAll("\r\n", "\n") : sent;
        const request = OrderCloseRequestSchema.safeParse(
          typeof typed === "string"
            ? typed.trim() === ""
              ? {}
              : { message: typed }
            : form.has("message")
              ? { message: typed }
              : {},
        );
        if (!id.success || form.getAll("message").length > 1) {
          blocked(person, "orders", "close_order", INVALID_INPUT);
          return {
            kind: "problem",
            problem: {
              status: 400,
              said: "Choose one order and an optional explanation of at most 2000 characters.",
            },
          };
        }
        const said = typeof typed === "string" ? typed : "";
        // Back to the list the closure was pressed on, the order opened there.
        const place = ordersPlace(fieldsIn(form));
        const drawn = `${base}${place}${place.includes("?") ? "&" : "?"}${new URLSearchParams({ details: id.data })}#details-${encodeURIComponent(id.data)}`;
        // Drawn here rather than redirected to, so what was typed stays in
        // the box and a reload does not repeat the note. Lists that cannot be
        // read beside it do not take the press's answer away.
        // Recorded only where the page drawn says the closure did not happen
        // or is not known to have happened.
        const answered = async (
          pressed: ClosurePressed,
          status: number,
          came: Blocked,
        ): Promise<Outcome<OrdersView | ClosureUnlisted>> => {
          const drawnWith = await answeredWith(pressed, status);
          if (drawnWith.kind === "view") blocked(person, "orders", "close_order", came);
          return drawnWith;
        };
        const answeredWith = async (
          pressed: ClosurePressed,
          status: number,
        ): Promise<Outcome<OrdersView | ClosureUnlisted>> => {
          const page = await ordersScreen(
            person,
            new URLSearchParams({ q: id.data, details: id.data }),
          ).catch(() => {
            console.error("[dashboard] the orders beside a closure could not be read");
            return null;
          });
          if (page?.kind !== "view") {
            return { kind: "view", status, view: { pressed, again: drawn } };
          }
          // Lists that show the closure recorded confirm it as a reread would.
          if (
            pressed.note === CLOSURE_NOTES.unconfirmed &&
            drawnClosedForGood(page.view, id.data)
          ) {
            return { kind: "redirect", location: drawn };
          }
          return { kind: "view", status, view: { ...page.view, pressed } };
        };
        if (!request.success) {
          // The contract's own reason, said of the box it is about.
          const reason = request.error.issues[0]?.message ?? "";
          return await answered(
            {
              id: id.data,
              note: null,
              refusal: `Your note ${reason.replace(/^a closure message /, "")}.`,
              typed: said,
            },
            400,
            INVALID_INPUT,
          );
        }
        const gateway = gatewayAs(person);
        const closed = await gateway.closeOrder(id.data, request.data);
        if (closed.ok) return { kind: "redirect", location: drawn };
        const refused = closed.status !== 0 && closed.status < 500;
        if (refused && closed.status !== 409) {
          blocked(person, "orders", "close_order", refusedAs(closed));
          return problemOf(closed);
        }
        // A timed-out write may have committed, and a refused one may have
        // lost to a delivery or an ending: only a fresh read says which. A read
        // that throws knows no more than one that was not answered.
        const read = await gateway.getOrder(id.data).catch(() => {
          console.error("[dashboard] the order a closure was pressed on could not be read");
          return null;
        });
        const order = read?.ok === true ? read.document : null;
        const open =
          order?.merchant_closure === undefined
            ? null
            : await gateway.orders(true).catch(() => null);
        if (order !== null && open?.ok === true && closedForGood(order, open.document)) {
          return { kind: "redirect", location: drawn };
        }
        return await answered(
          {
            id: id.data,
            note: !refused
              ? CLOSURE_NOTES.unconfirmed
              : order !== null && !closable(order)
                ? CLOSURE_NOTES.ended
                : saidOf(closed),
            refusal: null,
            typed: said,
          },
          refused ? 409 : 503,
          refused
            ? refusedAs(closed)
            : {
                outcome: "unknown",
                reason_code:
                  closed.status === 0
                    ? "timeout"
                    : closed.status === 503
                      ? "dependency_unavailable"
                      : "internal_error",
              },
        );
      },
    },

    selling: {
      async press(person, query, form) {
        const pressed = switchIn(query);
        if (pressed === null) {
          blocked(person, "cards", "change_selling", INVALID_INPUT);
          return { kind: "problem", problem: { status: 404, said: NO_SUCH_SWITCH } };
        }
        const gateway = gatewayAs(person);
        const switched =
          pressed.card === undefined
            ? await gateway.setSelling(!pressed.paused)
            : await gateway.pauseCard(pressed.card, pressed.paused);
        if (!switched.ok) {
          blocked(person, "cards", "change_selling", refusedAs(switched));
          return problemOf(switched);
        }
        noted(
          person,
          pressed.card === undefined
            ? pressed.paused
              ? "stopped all selling"
              : "started selling again"
            : `${pressed.paused ? "paused" : "resumed"} the card ${pressed.card}`,
        );
        // A redirect, so a reload does not press the switch again.
        return { kind: "redirect", location: `${base}${cardsPlace(fieldsIn(form))}` };
      },
    },

    screens: {
      async cards(person, query) {
        const gateway = gatewayAs(person);
        const [cards, integration] = await Promise.all([gateway.cards(), gateway.integration()]);
        if (!cards.ok) return problemOf(cards);
        if (!integration.ok) return problemOf(integration);
        const view = cardsView(cards.document, config.publicBaseUrl, integration.document, query);
        if (parts.woo !== null) {
          const [choices, shop] = await Promise.all([
            identity.onboardingChoices(person.id),
            parts.woo.stateOf(person.id),
          ]);
          if (
            choices.platform === "woocommerce" ||
            shop.kind !== "none" ||
            integration.document.through === "woocommerce"
          ) {
            const opened = await parts.woo.shop(person, query);
            if (opened.kind !== "view") return opened;
            return { kind: "view", view: { ...view, shop: opened.view } };
          }
        }
        return { kind: "view", view };
      },

      orders: ordersScreen,

      async receipts(person, query) {
        const gateway = gatewayAs(person);
        const [cards, receipts, paidInto] = await Promise.all([
          gateway.cards(),
          gateway.receipts(),
          gateway.paidIntoSplits(),
        ]);
        if (!cards.ok) return problemOf(cards);
        if (!receipts.ok) return problemOf(receipts);
        if (!paidInto.ok) return problemOf(paidInto);
        return {
          kind: "view",
          view: receiptsView(
            cards.document,
            receipts.document,
            config.transactionPage,
            paidInto.document,
            query,
          ),
        };
      },

      // Asked beside the page's own reads and cut short at the frame's
      // deadline: a read that fails or is slow does not take the page down or
      // hold it long, and the banner says it could not check.
      async frame(person) {
        const woo = parts.woo;
        const frameStarted = performance.now();
        const publicationPending = parts.livePublicationPending;
        const merchantId = person.merchant?.id;
        const gateway = gatewayAs(person, FRAME_WITHIN_MS);
        const [standing, choices, shop, request, shopFacts, publication] = await Promise.all([
          readOf(() => gateway.standing()),
          readOf(async () => ({
            ok: true as const,
            document: await identity.onboardingChoices(person.id),
          })),
          woo === null
            ? Promise.resolve({ kind: "none" as const })
            : readOf(async () => ({
                ok: true as const,
                document: await woo.stateOf(person.id),
              })).then((read) => (read.read ? read.value : { kind: "unread" as const })),
          config.surfaceMode === "live"
            ? readOf(() => gateway.liveSalesRequest())
            : Promise.resolve({ read: true as const, value: null }),
          woo === null
            ? Promise.resolve({
                read: true as const,
                value: { evidence: null, connectedBefore: false },
              })
            : readOf(async () => ({
                ok: true as const,
                document: await woo.onboardingFacts(person),
              })),
          config.surfaceMode === "live" &&
          merchantId !== undefined &&
          publicationPending !== undefined
            ? readOf(async () => ({
                ok: true as const,
                document: await publicationPending(merchantId),
              }))
            : Promise.resolve({ read: true as const, value: false }),
        ]);
        const remaining = Math.max(1, FRAME_WITHIN_MS - (performance.now() - frameStarted));
        const keys =
          standing.read && !standing.value.hasProducts && standing.value.through === "api"
            ? await readOf(() => gatewayAs(person, remaining).keys(), remaining)
            : { read: true as const, value: [] };
        const unread =
          !standing.read ||
          !choices.read ||
          !keys.read ||
          !request.read ||
          !shopFacts.read ||
          !publication.read ||
          shop.kind === "unread";
        const value = standing.read ? standing.value : null;
        const facts = {
          mode: config.surfaceMode,
          platform: choices.read ? choices.value.platform : null,
          testAcknowledged: choices.read && choices.value.testAcknowledged,
          cards: standing.read && standing.value.hasProducts ? 1 : 0,
          keys: keys.read ? keys.value.length : 0,
          contact: value?.lastContact == null ? null : new Date(value.lastContact).toISOString(),
          contactAlive: value?.contactAlive === true,
          outOfTouch: value?.outOfTouch != null,
          shop:
            shop.kind === "unread"
              ? ("none" as const)
              : shop.kind === "connected" && shop.shop.permissions !== "read_write"
                ? ("read-only" as const)
                : shop.kind,
          through: value?.through ?? "api",
          sellerName: value?.sellerName != null,
          payoutWallet: value?.payoutWallet != null,
          liveApproved: value?.liveApproved ?? false,
          selling: value?.selling ?? "open",
          unread,
          withdrawn: value?.withdrawn != null,
          walletChange: value?.pendingPayoutWallet != null,
          unserved: value?.unserved ?? false,
          request:
            request.read && request.value?.state === "pending"
              ? ("pending" as const)
              : request.read && request.value?.state === "declined"
                ? ("declined" as const)
                : ("none" as const),
          ready:
            shopFacts.read && shopFacts.value.evidence?.integration === "woocommerce"
              ? shopFacts.value.evidence.ready
              : null,
          connectedBefore: shopFacts.read && shopFacts.value.connectedBefore,
        };
        const step = nextStepOf(facts);
        const prefill =
          value?.sellerName == null &&
          (step.account === "request" || step.account === "test-profile") &&
          facts.through === "woocommerce" &&
          woo !== null
            ? await readOf(
                async () => ({
                  ok: true as const,
                  document: await woo.sellerName(person),
                }),
                Math.max(1, FRAME_WITHIN_MS - (performance.now() - frameStarted)),
              )
            : { read: true as const, value: null };
        const onboarding: OnboardingView = {
          mode: config.surfaceMode,
          step,
          publicationPending: publication.read && publication.value && value?.liveApproved === true,
          keys: keys.read ? keysView(keys.value) : null,
          contact: facts.contact === null ? null : momentView(facts.contact),
          origin: config.publicBaseUrl,
          unread,
          ...(value === null
            ? {}
            : {
                account: onboardingAccountView(step, {
                  mode: config.surfaceMode,
                  sellerName: value.sellerName ?? (prefill.read ? prefill.value : null) ?? "",
                  savedWallet: value.payoutWallet,
                  nameRule: NAME_RULE,
                  wallet:
                    config.surfaceMode !== "sandbox" &&
                    (value.payoutWallet === null || step.account === "test-profile")
                      ? walletEntryView(
                          config.surfaceMode,
                          value.commissionRate,
                          config.walletChain,
                        )
                      : null,
                  email: person.email,
                  request:
                    request.read && request.value?.state === "pending"
                      ? { at: momentView(new Date(request.value.requestedAt).toISOString()) }
                      : null,
                  decision:
                    request.read &&
                    request.value?.state === "declined" &&
                    request.value.decline !== null
                      ? {
                          at: momentView(new Date(request.value.decline.at).toISOString()),
                          note: request.value.decline.reason,
                        }
                      : value.withdrawn === null
                        ? null
                        : {
                            at: momentView(new Date(value.withdrawn.at).toISOString()),
                            note: value.withdrawn.note,
                          },
                }),
              }),
        };
        const account = standing.read
          ? accountOf(
              {
                ...viewing(person, standing.value.sellerName),
                payout: { wallet: standing.value.payoutWallet },
                liveApproval: standing.value.liveApproved,
              },
              {
                unread,
                selling: standing.value.selling,
                ...(standing.value.pendingPayoutWallet === null
                  ? {}
                  : {
                      walletChange: {
                        wallet: standing.value.pendingPayoutWallet.address,
                        takesEffectAt: new Date(
                          standing.value.pendingPayoutWallet.takesEffectAt,
                        ).toISOString(),
                      },
                    }),
                unserved: standing.value.unserved,
                ...(standing.value.withdrawn === null
                  ? {}
                  : {
                      withdrawn: {
                        at: new Date(standing.value.withdrawn.at).toISOString(),
                        note: standing.value.withdrawn.note,
                      },
                    }),
                ...(standing.value.outOfTouch === null
                  ? {}
                  : {
                      outOfTouch: {
                        since:
                          standing.value.outOfTouch.since === null
                            ? null
                            : new Date(standing.value.outOfTouch.since).toISOString(),
                      },
                    }),
              },
            )
          : accountOf(viewing(person), { unread: true });
        return {
          onboarding,
          account: account.filter((note) => note.reason === step.reason).slice(0, 1),
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
          setupRefused(person, "seller_name", typed === "" ? "profile_missing" : "invalid_input");
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
          setupRefused(
            person,
            "seller_site",
            typed === "" ? "seller_site_missing" : "invalid_input",
          );
          return await settingsDrawn(person, { kind: "site", problem: wrong, typed }, 400);
        }
        const set = await gatewayAs(person).setSellerSite(typed);
        if (!set.ok) return problemOf(set);
        noted(person, "changed the site of their shop");
        return toSettings;
      },

      // The answer to a session left open somewhere or held by somebody else.
      // The presser's own session ends too: one copied from this browser
      // carries the same token, and keeping this one would keep the copy. It
      // ends no other account's sessions and touches no key.
      async signOutEverywhere(person) {
        const ended = await identity.endSessionsOfPerson(person.id);
        noted(person, `signed out everywhere, ${ended} sessions in all`);
        return {
          kind: "redirect",
          location: `${base}/sign-in?reason=${SIGNED_OUT_EVERYWHERE_REASON}`,
          setCookies: clearingLines(identity, config.cookieSecure),
        };
      },

      // Bound to the account signed in, never to one a form names: the gate
      // refused the press unless its page was drawn for this account.
      async analytics(person, form) {
        const chosen = once(form.getAll("analytics"));
        if (chosen !== "on" && chosen !== "off") {
          return {
            kind: "problem",
            problem: { status: 400, said: "Choose whether product analytics are on or off." },
          };
        }
        await identity.setAnalyticsOptOut(person.id, chosen === "off");
        noted(person, `turned product analytics ${chosen}`);
        return await settingsDrawn(person);
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
          setupRefused(person, "payout_wallet", typed === "" ? "wallet_missing" : "invalid_input");
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
        if (!set.ok && set.code === NOT_A_PAYOUT_WALLET_CODE) {
          return await settingsDrawn(person, { kind: "wallet", problem: set.why, typed }, 400);
        }
        if (!set.ok) return problemOf(set);
        // The address stays out of the line: not a secret, but this log records
        // who changed it, not what to.
        noted(
          person,
          set.document.pending === null
            ? "changed the wallet their share is paid out to"
            : "asked for a change of the wallet their share is paid out to, which now waits",
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
        const back = pageToReturnTo(form);
        const { payout_wallet: applies, pending } = read.document;
        // A change that applied before the press is answered on Settings
        // wherever it was pressed, since what to do next is done there. It is
        // asked first: a change waiting now is then one the page never showed,
        // such as the change back asked for since, which a cancel sent again by
        // a reload would otherwise take away.
        if (shown !== null && applies === shown.waiting) {
          return await tookEffectBeforePress(person, cookie, shown, "pressed cancel");
        }
        if (pending !== null && applies !== null) {
          return await cancelWaiting(person, cookie, gateway, applies, pending, false, back);
        }
        return backTo(back);
      },
    },

    integrations: {
      // A shops read that fails is drawn as one that could not be read, never as
      // no block, which would tell a merchant who connected a shop that none is.
      // The failure is logged as a line: a store's exception can carry a shop's
      // key. The integration failing to read marks neither way rather than
      // failing the page.
      async page(person) {
        if (parts.woo === null) return { kind: "view", view: integrationsView() };
        const [shop, integration] = await Promise.all([
          parts.woo.stateOf(person.id).catch((): ShopTile => {
            console.error(
              "[dashboard] the WooCommerce connection could not be read for the integrations screen",
            );
            return { kind: "unread" };
          }),
          gatewayAs(person).integration(),
        ]);
        return {
          kind: "view",
          view: integrationsView(
            shop,
            integration.ok
              ? { through: integration.document.through, offSale: integration.document.offSale }
              : { unread: true },
          ),
        };
      },
    },

    keys: {
      async list(person, query) {
        const keys = await gatewayAs(person).keys();
        if (!keys.ok) return problemOf(keys);
        return {
          kind: "view",
          view: keysView(keys.document, {
            startNew: once(query.getAll("new")) === "key",
            confirming: textOf(once(query.getAll("revoke"))),
          }),
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
          return {
            kind: "view",
            status: 400,
            view: keysView(keys.document, { problem, typed: label }),
          };
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
        if (!stopped.ok) return problemOf(stopped);
        noted(person, `revoked the key ${keyId}`);
        // A redirect, so a reload does not press it again.
        return { kind: "redirect", location: `${base}/keys` };
      },
    },
  };
}
