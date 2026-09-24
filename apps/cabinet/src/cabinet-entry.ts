/**
 * The one cabinet identity surface used by its server-rendered pages.
 *
 * Better Auth, verification rows and database locks stay behind this port. A
 * page can ask for or open a cabinet link, read or end a session, and finish
 * the one merchant binding. Report identity is a later private boundary and
 * deliberately does not make this interface larger.
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

/**
 * The only places a cabinet mail link may return to after it is opened: the
 * cabinet's own screens, by name. "default" is the card list.
 */
export const CABINET_DESTINATIONS = [
  "default",
  "orders",
  "receipts",
  "integrations",
  "keys",
  "settings",
  "woocommerce",
] as const;
export type CabinetDestination = (typeof CABINET_DESTINATIONS)[number];

export const cabinetDestinationIn = (value: unknown): CabinetDestination =>
  CABINET_DESTINATIONS.find((destination) => destination === value) ?? "default";

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
      destination: CabinetDestination;
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

export interface CabinetIdentity {
  readonly cookieNames: readonly string[];

  requestLink(email: string, destination: CabinetDestination): Promise<LinkRequestResult>;
  openLink(token: string): Promise<CabinetLinkResult>;

  whoIs(cookieHeader: string | undefined): Promise<Person | null>;
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
}
