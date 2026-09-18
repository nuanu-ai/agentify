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

/** The only places a cabinet mail link may return to after it is opened. */
export type CabinetDestination = "default" | "settings" | "woocommerce";

export type LinkRequestResult =
  | Readonly<{ status: "accepted" }>
  | Readonly<{ status: "cooldown"; retryAt: Date }>
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
