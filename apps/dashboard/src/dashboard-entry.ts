/**
 * The identity port the server-rendered pages use; Better Auth, verification
 * rows and database locks stay behind it. What the scanner asks over the
 * internal route is on `Identity` in `identity.ts` and does not widen this.
 */

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
export const DASHBOARD_DESTINATIONS = [
  "default",
  "orders",
  "receipts",
  "integrations",
  "keys",
  "settings",
  "woocommerce",
] as const;

export type DashboardDestination = (typeof DASHBOARD_DESTINATIONS)[number];

export const dashboardDestinationIn = (value: unknown): DashboardDestination =>
  DASHBOARD_DESTINATIONS.find((destination) => destination === value) ?? "default";

/** A closed set, recorded with the token when the link is asked for. */
export type LinkDestination = DashboardDestination | Readonly<{ report: string }>;

/**
 * A partner network's click identifier that the person asking for a link
 * agreed, on the sign-in form, to have kept with it; it is reported only if the
 * address's owner confirms when pressing the link and the press makes their
 * account. `consentedAt` is the moment of the tick as
 * `Date.prototype.toISOString` writes it, and `wording` names the version of
 * the sentences agreed to, at most 64 characters. A request
 * carrying a click that does not have exactly this form throws, and nothing is
 * sent or counted: the page checks the identifier before passing it.
 */
export type ConsentedClick = Readonly<{ id: string; consentedAt: string; wording: string }>;

/**
 * The waits differ by an order of magnitude (under a minute against most of an
 * hour), so a page that says how long to wait has to know which one it hit.
 */
export type LinkWall = "interval" | "hourly";

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
 * What the page a link lands on draws: the address the link signs in, and
 * whether pressing it would tell the ad tracker of a registration, which the
 * page then asks the address's owner to confirm. That is so only where
 * reporting is switched on, the link was asked for with a consented click, and
 * the address has no verified account yet.
 */
type LinkLanding = Readonly<{ email: string; tellsTracker: boolean }>;

/** The address's owner's answer on the link's page. */
export type OwnersChoice = Readonly<{ tellTracker: boolean }>;

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
 * request whose link opened this session, null otherwise. The cookie lines
 * renew the session when the reading moved its end (at most once a day) and are
 * empty otherwise; whoever answers the browser passes them on as they are.
 */
export type LiveSession = Readonly<{
  person: Person;
  operator: boolean;
  request: string | null;
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
   * A click is handed only where the box was ticked on the press that starts
   * the sign-in, which is the consent; the same person finishes it in the same
   * browser, Google vouching for the address.
   */
  startGoogle(
    destination: DashboardDestination,
    click?: ConsentedClick,
  ): Promise<GoogleStartResult>;
  finishGoogle(query: URLSearchParams, cookie: string | undefined): Promise<GoogleFinishResult>;

  requestLink(
    email: string,
    destination: DashboardDestination,
    click?: ConsentedClick,
  ): Promise<LinkRequestResult>;
  /**
   * Read without spending the link; null for a link that no longer opens
   * anything.
   */
  landingOf(token: string): Promise<LinkLanding | null>;
  /**
   * A registration is reported only where the owner said yes on the link's
   * page; without the choice, or with a no, the press signs in and reports
   * nothing, whatever the link was asked for with.
   */
  openLink(token: string, owner?: OwnersChoice): Promise<DashboardLinkResult>;

  whoIs(cookieHeader: string | undefined, reading?: SessionReading): Promise<LiveSession | null>;
  signOut(cookieHeader: string | undefined): Promise<number>;

  attachMerchant(
    personId: string,
    register: () => Promise<string | null>,
  ): Promise<AttachMerchantResult>;

  /**
   * Ends every session of every account naming this merchant except the ones
   * the `keep` Cookie header carries, and returns how many ended. `keep` is the
   * raw Cookie header of the presser's request, not a token: anything else
   * keeps nothing and signs the presser out too.
   *
   * For a cancelled wallet change: the change may have been asked for from a
   * session somebody else holds, and the person who pressed cancel is the one
   * known to be the owner, so theirs is the one kept.
   */
  endOtherSessionsOfMerchant(merchantId: string, keep: string | undefined): Promise<number>;

  /**
   * Ends every live session of this one account except the ones the `keep`
   * Cookie header carries, and returns how many ended. `keep` is the raw Cookie
   * header of the presser's request, not a token: anything else keeps nothing
   * and signs the presser out too. Another account naming the same merchant is
   * somebody else's, and its sessions are not this person's to end.
   */
  endOtherSessionsOfPerson(personId: string, keep: string | undefined): Promise<number>;
}
