/**
 * The one cabinet identity surface used by its server-rendered pages.
 *
 * Better Auth, verification rows and database locks stay behind this port. A
 * page can ask for or open a link, read or end a session, and finish the one
 * merchant binding. What the scanner asks over the internal route is on the
 * operator-facing `Identity` in `identity.ts` and does not make this larger.
 */

/** The merchant an account belongs to, and the key used only behind a page. */
export interface AccountMerchant {
  readonly id: string;
  readonly key: string;
}

/** A cabinet person. A null merchant is the authenticated P1 state. */
export interface Person {
  readonly id: string;
  readonly email: string;
  readonly confirmed: boolean;
  readonly merchant: AccountMerchant | null;
}

/** The cabinet screens a link asked for on the sign-in page may lead to. */
export type CabinetDestination = "default" | "settings" | "woocommerce";

/**
 * Every place a link may lead once it is opened: a cabinet screen, or the full
 * report of one named scan for a link the scanner asked for. A closed set,
 * recorded with the token when the link is asked for (ADR-0026 §1).
 */
export type LinkDestination = CabinetDestination | Readonly<{ report: string }>;

/**
 * Which of the two walls in front of a link refused this request.
 *
 * They are waits of different orders — under a minute against the better part
 * of an hour — and a screen that cannot tell them apart has to guess, which on
 * a page that says how long to wait means saying something untrue. So the
 * answer names the wall it hit.
 */
export type LinkWall = "interval" | "hourly";

/**
 * What became of a request for a link, and when this address may ask again.
 *
 * Both answers carry that moment, because both leave a wait behind them. A
 * refusal's wait is the wall it hit. An accepted request's is the wall in
 * front of the next link, which is usually the minute the door keeps between
 * two of them and is the rest of the hour when the link that just went out was
 * this address's third. A caller told "accepted" and left to assume the minute
 * draws a page that invites a press it knows will be refused.
 */
export type LinkRequestResult =
  | Readonly<{ status: "accepted"; retryAt: Date }>
  | Readonly<{ status: "cooldown"; wall: LinkWall; retryAt: Date }>
  | Readonly<{ status: "unavailable" }>;

export type CabinetLinkResult =
  | Readonly<{
      status: "opened";
      person: Person;
      destination: LinkDestination;
      setCookies: readonly string[];
    }>
  | Readonly<{ status: "refused" }>;

export type MerchantPerson = Person & Readonly<{ merchant: AccountMerchant }>;
export type UnattachedPerson = Person & Readonly<{ merchant: null }>;

export type AttachMerchantResult =
  | Readonly<{
      status: "attached" | "already-attached";
      person: MerchantPerson;
    }>
  | Readonly<{ status: "unavailable"; person: UnattachedPerson }>
  | Readonly<{ status: "person-missing" }>;

/** What is known after the conditional merchant-key write returns. */
export type MerchantKeyReplacement = "replaced" | "not-matched" | "unknown";

/**
 * A live session: whose it is, whether that person is an operator, which
 * request its link was asked for, and what reading it asked of the browser.
 *
 * The operator flag is read with the session every time, so a flag set or
 * cleared at the terminal holds from the next request (ADR-0026 §6). The
 * request is the scanner's full-report request the link that opened this
 * session was asked for, and null for any other session. The lines renew the
 * session's cookie when the reading moved the session's end, which happens at
 * most once a day, and are empty otherwise. Whoever answers the browser passes
 * them on as they are.
 */
export type LiveSession = Readonly<{
  person: Person;
  operator: boolean;
  request: string | null;
  setCookies: readonly string[];
}>;

/**
 * How a session is read. `renew: false` reads it without moving its end, for
 * an answer that cannot pass a renewed cookie on to the browser.
 */
export type SessionReading = Readonly<{ renew?: boolean }>;

export interface CabinetIdentity {
  readonly cookieNames: readonly string[];

  requestLink(email: string, destination: CabinetDestination): Promise<LinkRequestResult>;
  /**
   * The address a live link would sign in, read without spending it, or null
   * for a link that no longer opens anything.
   */
  addressOfLink(token: string): Promise<string | null>;
  openLink(token: string): Promise<CabinetLinkResult>;

  whoIs(cookieHeader: string | undefined, reading?: SessionReading): Promise<LiveSession | null>;
  signOut(cookieHeader: string | undefined): Promise<number>;

  attachMerchant(
    personId: string,
    register: () => Promise<AccountMerchant | null>,
  ): Promise<AttachMerchantResult>;

  replaceMerchantKey(
    personId: string,
    expectedKey: string,
    replacementKey: string,
  ): Promise<MerchantKeyReplacement>;

  /**
   * Ends every session of every account naming this merchant except the ones
   * this cookie header carries, and says how many ended.
   *
   * What a cancelled wallet change does (ADR-0019): the change may have been
   * asked for from a session somebody else holds, and the person who pressed
   * cancel is the one known to be the owner, so theirs is the one left.
   */
  endOtherSessionsOfMerchant(merchantId: string, keep: string | undefined): Promise<number>;
}
