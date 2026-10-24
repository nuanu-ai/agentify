/**
 * The identity port the server-rendered pages use; Better Auth, verification
 * rows and database locks stay behind it. What the scanner asks over the
 * internal route is on `Identity` in `identity.ts` and does not widen this.
 */

import type { AnalyticsEvent } from "@agentify/gateway/analytics";

interface AccountMerchant {
  readonly id: string;
}

/** A null merchant means signed in but not yet set up. */
export interface Person {
  readonly id: string;
  readonly email: string;
  readonly confirmed: boolean;
  readonly merchant: AccountMerchant | null;
}

/**
 * Read wherever a destination travels: the gate, the sign-in form, the link's
 * stored claim and the redirect. Anything else a browser sends becomes the
 * start, and a stored claim naming anything else opens nothing.
 */
const DASHBOARD_DESTINATIONS = [
  "default",
  "orders",
  "receipts",
  "integrations",
  "keys",
  "settings",
  "woocommerce",
] as const;

/** A section of the merchant's dashboard a sign-in can return to. */
export type SectionDestination = (typeof DASHBOARD_DESTINATIONS)[number];

/**
 * A page of the operator's workspace a sign-in returns to, its path under the
 * dashboard's prefix: a section, or one record by its identifier.
 */
export type AdminDestination = `admin${string}`;

export type DashboardDestination = SectionDestination | AdminDestination;

/**
 * One closed shape per page of the workspace, a record's identifier held to
 * the shape the product gives one; the lookup is none, since what it was asked
 * does not travel.
 */
const ADMIN_PAGES =
  /^admin(?:\/(?:money|health|journal|(?:merchants|orders|accounts)(?:\/[A-Za-z0-9_-]{1,64})?))?$/;

/** The workspace's page a value names, or null for anything else. */
export const adminDestinationIn = (value: unknown): AdminDestination | null =>
  typeof value === "string" && ADMIN_PAGES.test(value) ? (value as AdminDestination) : null;

/** The destination a value names exactly, or null where it names none. */
export const destinationNamed = (value: unknown): DashboardDestination | null =>
  DASHBOARD_DESTINATIONS.find((destination) => destination === value) ?? adminDestinationIn(value);

export const dashboardDestinationIn = (value: unknown): DashboardDestination =>
  destinationNamed(value) ?? "default";

/** A closed set, recorded with the token when the link is asked for. */
export type LinkDestination = DashboardDestination | Readonly<{ report: string }>;

/**
 * The waits differ by an order of magnitude (under a minute against most of an
 * hour), so a page that says how long to wait has to know which one it hit.
 * `interval` and `hourly` are the address's own limits; `client` is the hour's
 * allowance of the visitor the request came from, `shared` the one allowance
 * of every request whose address names no visitor, and `ceiling` the channel's
 * for everybody. None of the last three depends on the address typed, so none
 * says anything about it.
 */
export type LinkWall = "interval" | "hourly" | "client" | "shared" | "ceiling";

/**
 * Both answers carry the moment the address may ask again: a refusal's is the
 * limit it hit; an accepted request's is usually the minute, and the rest of
 * the hour when this was the address's third link. A caller left to assume the
 * minute would invite a press it knows will be refused.
 */
export type LinkRequestResult =
  | Readonly<{ status: "accepted"; retryAt: Date }>
  | Readonly<{ status: "cooldown"; wall: LinkWall; retryAt: Date }>
  | Readonly<{ status: "unavailable" }>;

/**
 * Who asked for a link. `client` is the address the request came from, as the
 * edge in front of the dashboard wrote it. `clickId` is kept with the link, as
 * for `startGoogle`, and reported only if the link's press makes the address's
 * first verified account; a click id not of the tracker's form throws, and
 * nothing is sent or counted.
 */
export type LinkAsker = Readonly<{ client: string; clickId?: string }>;

/** What the page a link lands on draws: the address the link signs in. */
type LinkLanding = Readonly<{ email: string }>;

export type DashboardLinkResult =
  | Readonly<{
      status: "opened";
      person: Person;
      destination: LinkDestination;
      setCookies: readonly string[];
    }>
  | Readonly<{ status: "refused" }>;

export type GoogleStartResult =
  | Readonly<{ status: "redirect"; location: string; setCookies: readonly string[] }>
  | Readonly<{ status: "unavailable" }>;

export type GoogleFinishResult =
  | Readonly<{
      status: "opened";
      person: Person;
      destination: DashboardDestination;
      setCookies: readonly string[];
    }>
  | Readonly<{
      status: "refused";
      reason: "email-unverified" | "email-changed" | "cancelled" | "invalid" | "unavailable";
      email: string | null;
      destination: DashboardDestination;
      setCookies: readonly string[];
      /**
       * The click the refused sign-in was started with, given back only where
       * reporting is on and the state was this browser's own.
       */
      clickId?: string;
    }>;

export type MerchantPerson = Person & Readonly<{ merchant: AccountMerchant }>;
export type UnattachedPerson = Person & Readonly<{ merchant: null }>;

export type AttachMerchantResult =
  | Readonly<{
      status: "attached" | "already-attached";
      person: MerchantPerson;
    }>
  | Readonly<{ status: "unavailable"; person: UnattachedPerson }>
  | Readonly<{ status: "person-missing" }>;

/**
 * The operator flag is read with the session every time, so a change at the
 * terminal holds from the next request. `request` is the scanner's full-report
 * request whose link opened this session, null otherwise. `signedInAt` is when
 * this session was opened, which tells two sessions of one account apart where
 * their address cannot. The cookie lines
 * renew the session when the reading moved its end (at most once a day) and are
 * empty otherwise; whoever answers the browser passes them on as they are.
 */
export type LiveSession = Readonly<{
  person: Person;
  operator: boolean;
  request: string | null;
  signedInAt: Date;
  setCookies: readonly string[];
}>;

/**
 * `renew: false` reads a session without moving its end, for an answer that
 * cannot pass a renewed cookie on to the browser.
 */
type SessionReading = Readonly<{ renew?: boolean }>;

export interface DashboardIdentity {
  readonly cookieNames: readonly string[];
  readonly googleEnabled: boolean;

  /**
   * `clickId` is the ad tracker's identifier of the click the sign-in page was
   * opened with, which the page checks and passes only where reporting is
   * switched on. It is kept with the sign-in's single-use state and reported
   * only if Google's return makes the address's first verified account. A
   * click id not of the tracker's form makes the start unavailable and keeps
   * nothing.
   */
  startGoogle(destination: DashboardDestination, clickId?: string): Promise<GoogleStartResult>;
  finishGoogle(query: URLSearchParams, cookie: string | undefined): Promise<GoogleFinishResult>;

  requestLink(
    email: string,
    destination: DashboardDestination,
    asker: LinkAsker,
  ): Promise<LinkRequestResult>;
  /**
   * A link an operator asks for from their own session to confirm an
   * administrative action: the mail says so, and the link signs in the browser
   * it is opened in and returns it to `destination`. It is counted apart from
   * the public form's links, so typing an operator's address there spends none
   * of these; the address's own minute and hour still hold.
   */
  requestStepUpLink(email: string, destination: AdminDestination): Promise<LinkRequestResult>;
  /**
   * Read without spending the link; null for a link that no longer opens
   * anything.
   */
  landingOf(token: string): Promise<LinkLanding | null>;
  /**
   * A press that makes the address's first verified account reports the click
   * the link was asked for with, where reporting is switched on.
   */
  openLink(token: string): Promise<DashboardLinkResult>;

  whoIs(cookieHeader: string | undefined, reading?: SessionReading): Promise<LiveSession | null>;
  signOut(cookieHeader: string | undefined): Promise<number>;

  attachMerchant(
    personId: string,
    register: () => Promise<string | null>,
  ): Promise<AttachMerchantResult>;

  /**
   * Ends every live session of every account naming this merchant, the one the
   * `cookieHeader` carries included, and gives that browser a new session of
   * the same person: `setCookies` sets it, and `ended` counts the sessions
   * ended. A copy of the pressing browser's cookie names an ended session, so
   * it opens nothing. A cookie with no live session of this merchant gets no
   * new session, and `setCookies` is empty.
   *
   * For a cancelled wallet change: the change may have been asked for from any
   * session of the merchant, a copy of the presser's own among them, and the
   * person who pressed cancel is the one known to be the owner.
   */
  endMerchantSessionsAndRenew(
    merchantId: string,
    cookieHeader: string | undefined,
  ): Promise<{ ended: number; setCookies: readonly string[] }>;

  /**
   * Ends every live session of this one account, the one asking included, and
   * returns how many ended. Another account naming the same merchant is
   * somebody else's, and its sessions are not this person's to end.
   */
  endSessionsOfPerson(personId: string): Promise<number>;

  /**
   * Records a product analytics observation that has no transaction of its
   * own, such as a screen shown or a press refused, in the database the
   * identity holds. It never rejects, and a page need not wait for it.
   */
  observe(event: AnalyticsEvent): Promise<void>;
  /** Whether this one account opted out of product analytics. */
  analyticsOptedOut(personId: string): Promise<boolean>;
  /**
   * Sets that choice on this one account; another account naming the same
   * merchant keeps its own.
   */
  setAnalyticsOptOut(personId: string, optedOut: boolean): Promise<void>;
  /**
   * How many links of each purpose the channel sent in the rolling hour
   * before `now`, which the channel's ceiling counts. For the operator's
   * workspace alone.
   */
  linksSentInTheHour(now: Date): Promise<Readonly<Record<LinkPurpose, number>>>;
  /**
   * The accounts with one of these identifiers or naming one of these
   * merchants, each with its address and merchant. For the operator's
   * workspace alone, which names who acted and who owns a merchant.
   */
  accountsNamed(
    named: Readonly<{ accountIds?: readonly string[]; merchantIds?: readonly string[] }>,
  ): Promise<readonly NamedAccount[]>;
  /**
   * How the sign-up reports to the ad network stand: those settled since
   * `since` by how they ended, and those still waiting to leave. For the
   * operator's workspace alone.
   */
  adReportsSince(since: Date): Promise<AdReportCounts>;
  /**
   * The account with this address, in any case, with its merchant; null where
   * nobody signed in with it. For the operator's lookup alone.
   */
  accountWithEmail(email: string): Promise<NamedAccount | null>;
  /**
   * The accounts whose address contains this text, ignoring case; none for a
   * blank text. The read looks at no more than `ACCOUNTS_FOUND_MAX` addresses,
   * and `cut` says where it stopped there, so an account past them may be
   * missing. For the operator's workspace alone, whose search finds a merchant
   * by the address its owner pasted.
   */
  accountsWithEmailContaining(
    text: string,
  ): Promise<Readonly<{ accounts: readonly NamedAccount[]; cut: boolean }>>;
}

/** The most addresses one `accountsWithEmailContaining` read looks at. */
export const ACCOUNTS_FOUND_MAX = 200;

/** What a link is sent for, each counted against the channel's ceiling of its own. */
export type LinkPurpose = "dashboard" | "report" | "step-up";

export interface NamedAccount {
  readonly id: string;
  readonly email: string;
  readonly merchantId: string | null;
}

export interface AdReportCounts {
  readonly delivered: number;
  readonly refused: number;
  readonly givenUp: number;
  /** Waiting for a click or for their turn to leave, whenever they were made. */
  readonly waiting: number;
}
