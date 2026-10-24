/**
 * Better Auth owns token consumption, people and sessions, but its HTTP routes
 * stay unmounted: the dashboard sends every link itself and calls the component
 * only from its own handlers. OAuth starts with a same-origin POST and returns
 * through a state-bound callback. Production runs it on a
 * transaction-bound Drizzle adapter; the memory store runs the same component
 * on an isolated transaction copy.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Store } from "@agentify/gateway";
import {
  type AnalyticsEvent,
  type AuthResult,
  recordAlong,
  recordObserved,
} from "@agentify/gateway/analytics";
import { journalAlong } from "@agentify/gateway/journal";
import { countedClient } from "@agentify/scanner/ip";
import { PARTNER_CLICK_ID_PATTERN } from "@agentify/scanner-contracts/click-id";
import {
  type DeleteUnattachedPersonRequest,
  type DeleteUnattachedPersonResponse,
  type SendReportLinkRequest,
  type SendReportLinkResponse,
  sessionCookieName,
} from "@agentify/scanner-contracts/report-identity";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { memoryAdapter } from "better-auth/adapters/memory";
import { isAPIError } from "better-auth/api";
import { getCookies } from "better-auth/cookies";
import { magicLink } from "better-auth/plugins/magic-link";
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, type SQL, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { channelOf } from "./admin/frame.js";
import type { JournalTransaction } from "./admin/journal.js";
import { operatorFlagMessage } from "./admin/operator-mail.js";
import type { DashboardConfig } from "./config.js";
import {
  ACCOUNTS_FOUND_MAX,
  type AttachMerchantResult,
  adminDestinationIn,
  type DashboardDestination,
  type DashboardIdentity,
  type DashboardLinkResult,
  dashboardDestinationIn,
  destinationNamed,
  type GoogleFinishResult,
  type GoogleStartResult,
  type LinkAsker,
  type LinkDestination,
  type LinkPurpose,
  type LinkRequestResult,
  type LinkWall,
  type LiveSession,
  type MerchantPerson,
  type Person,
  type UnattachedPerson,
} from "./dashboard-entry.js";
import { boundedGoogleExchange } from "./google-exchange.js";
import { type Message, type Postman, postmanFor } from "./mail.js";
import { transactionalEmailHtml } from "./mail-template.js";
import { suppressWaitingAbout } from "./nuanu-analytics.js";
import {
  type AccountSummary,
  type AccountsListing,
  endSessionsIn,
  endSessionsInMemory,
  type FlagChange,
  type Forgetting,
  firstOperatorIn,
  firstOperatorInMemory,
  forgetIn,
  forgetInMemory,
  listedIn,
  listedInMemory,
  type Statements,
  setFlagIn,
  setFlagInMemory,
  summaryIn,
  summaryInMemoryOf,
} from "./operator-accounts.js";
import { renewedSession } from "./renewed-session.js";
import { reportLinkMessage } from "./report-mail.js";
import {
  accounts,
  adReports,
  credentials,
  linkSends,
  reportDeletionTombstones,
  reportIdentitySecrets,
  sessions,
  verifications,
} from "./schema.js";

/**
 * A change of the operator flag that was not made because a mail to an
 * operator, or to the account changed, was not handed to the provider: the
 * flag is as it was.
 */
export class OperatorMailRefused extends Error {
  constructor() {
    super("a mail about the operator flag was not handed to the provider");
  }
}

/** Operator-only operations, kept out of the page-facing port. */
export interface Identity extends DashboardIdentity {
  /**
   * Writes an unconfirmed account naming an existing merchant, or returns null
   * where the address has one. No command or route calls it; it is how a test
   * arranges a person who already owns a merchant.
   */
  make(email: string, merchantId: string): Promise<Person | null>;
  byEmail(email: string): Promise<Person | null>;
  byId(personId: string): Promise<Person | null>;
  /** For an announcement. */
  emailsNaming(merchantId: string): Promise<readonly string[]>;
  /** The accounts that made a merchant or hold the flag, and how many others only signed in. */
  operatorAccounts(now: Date): Promise<AccountsListing>;
  /** One account, listed or not, as the workspace shows it; null where there is none. */
  operatorAccount(accountId: string, now: Date): Promise<AccountSummary | null>;
  /**
   * Ends every session of one account, on the journal's transaction `tx` (null
   * in memory), keeping the account.
   */
  endSessionsIn(
    tx: JournalTransaction | null,
    accountId: string,
    now: Date,
  ): Promise<"ended" | "none" | "no-account">;
  /**
   * Grants or removes the operator flag on `tx`, under the one lock every
   * change of who holds the flag takes, so the last operator's flag is never
   * removed. Before it returns, a mail about the change has been handed over
   * to every operator there was and to the account changed; a refused
   * hand-over throws `OperatorMailRefused` and the flag stays as it was.
   */
  setOperatorIn(
    tx: JournalTransaction | null,
    accountId: string,
    on: boolean,
    asked: Readonly<{ at: Date; by: string }>,
  ): Promise<FlagChange>;
  /**
   * Removes one account and the merchant it names on `tx`, under the same
   * lock, so the address next signs in as a newcomer; refused for an account
   * holding the operator flag and for a merchant with money history or
   * another account. Only
   * the test channel's workspace calls it.
   */
  forgetIn(tx: JournalTransaction | null, accountId: string): Promise<Forgetting>;
  sendReportLink(request: SendReportLinkRequest): Promise<SendReportLinkResponse>;
  deleteUnattachedPerson(
    request: DeleteUnattachedPersonRequest,
  ): Promise<DeleteUnattachedPersonResponse>;
  close(): Promise<void>;
}

const emailAs = (raw: string): string => raw.trim().toLowerCase();

/**
 * Sliding: a person who keeps coming back does not meet the sign-in form again.
 * What protects the money is the wait on a wallet change, not a short session.
 */
export const SESSION_DAYS = 30;
/**
 * At most once a day, so a click is not a write to the sessions table; the
 * cookie handed back on that visit carries the new end.
 */
const SESSION_RENEWAL_SECONDS = 24 * 60 * 60;
const LINK_TTL_SECONDS = 60 * 60;
export const LINK_RATE_WINDOW_MS = 60 * 60 * 1000;
const LINK_RATE_LIMIT = 3;
export const LINK_MIN_INTERVAL_MS = 60 * 1000;
/** Sign-in links in the rolling hour from one visitor, whatever addresses it types. */
export const LINK_CLIENT_LIMIT = 10;
/**
 * Sign-in links in the rolling hour from every request whose address names no
 * visitor, together: on a channel whose ingress hides visitors' addresses, all
 * of its visitors.
 */
export const LINK_UNKNOWN_CLIENT_LIMIT = 30;
/**
 * Links of one purpose the channel sends in the rolling hour, whoever asks. A
 * mail provider pauses a sender whose bounces and complaints climb, and both
 * channels send from one domain: a pause would stop email sign-in everywhere
 * and every live payout-wallet change, which waits on its announcement mail.
 * The ceiling turns that into a wall that clears within the hour. It is a lever
 * as well as a guard: twenty addresses asking ten links each spend it, and then
 * nobody on the channel gets an emailed link until the hour clears. Google
 * sign-in does not pass through it. Its first refusal in a window is logged.
 */
export const LINK_CHANNEL_LIMIT = 200;
const LINK_SEND_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LINK_PROOF_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LINK_CLEANUP_BATCH = 100;
const REPORT_DIGEST_KEY_ID = "digest-v1";
const RAW_TOKEN = /^[A-Za-z0-9]{32}$/;

type MemoryRows = Record<string, Record<string, unknown>[]>;

export interface IdentityParts {
  readonly pool?: Pool;
  readonly rows?: MemoryRows;
  readonly postman?: Postman;
  /**
   * In memory, where the journal is the gateway's memory store: the configured
   * first operator is given the flag only with one, and its row goes there.
   * On Postgres the journal is the database's own table.
   */
  readonly journal?: Pick<Store, "journal" | "recordJournal">;
}

/**
 * Recorded with the token and read only from there; nothing in the link itself
 * is ever read as any of these.
 */
type LinkClaim = Readonly<{
  email: string;
  destination: LinkDestination;
  request: string | null;
  clickId?: string;
  /**
   * Asked from an operator's own session to confirm an administrative action:
   * the mail says so, and the link returns to the admin page it was asked on.
   */
  stepUp?: true;
}>;

type AdReport = typeof adReports.$inferInsert;

/**
 * What an opening transaction does that the component cannot: take the
 * address's lock, and write the registration's reports and the sign-in's
 * analytics event in the same transaction.
 */
type OpeningTransaction = Readonly<{
  lockEmail?: (email: string) => Promise<void>;
  register: (reports: readonly AdReport[]) => Promise<void>;
  record: (event: AnalyticsEvent) => Promise<void>;
}>;

type LinkSend = {
  readonly claim: LinkClaim;
  handed: "accepted" | "refused";
};

type ReportIdentitySecretRow = {
  id: typeof REPORT_DIGEST_KEY_ID;
  digestKey: string;
  createdAt: Date;
};

type StoredVerification = {
  value: string;
  expiresAt: Date;
};

const schema = {
  dashboard_accounts: accounts,
  dashboard_sessions: sessions,
  dashboard_credentials: credentials,
  dashboard_verifications: verifications,
};

/** Why a sign-in was refused, as product analytics counts it. */
type Refused = Pick<
  Extract<AuthResult["fields"], { readonly reason_code: string }>,
  "outcome" | "reason_code"
>;

const A_SPENT_LINK: Refused = { outcome: "blocked", reason_code: "invalid_link" };
const NOT_THE_SAME_PERSON: Refused = { outcome: "blocked", reason_code: "identity_mismatch" };
const UNAVAILABLE: Refused = { outcome: "failed", reason_code: "dependency_unavailable" };
/** A failure whose cause this side cannot tell: Google's, the database's, or a defect. */
const FAILED_UNTOLD: Refused = { outcome: "failed", reason_code: "unknown" };

/**
 * What each error Google's return can carry counts as. A cancel is the person's
 * own choice and is no refusal; an error not listed here is refused as a
 * failure nobody can tell the cause of.
 */
const GOOGLE_ERRORS: Readonly<Record<string, Refused | null>> = {
  google_email_unverified: NOT_THE_SAME_PERSON,
  google_email_changed: NOT_THE_SAME_PERSON,
  email_not_found: NOT_THE_SAME_PERSON,
  account_not_linked: NOT_THE_SAME_PERSON,
  access_denied: null,
  invalid_code: UNAVAILABLE,
  unable_to_get_user_info: UNAVAILABLE,
  state_not_found: A_SPENT_LINK,
  state_mismatch: A_SPENT_LINK,
  state_invalid: A_SPENT_LINK,
  no_code: A_SPENT_LINK,
};

const signInConfirmed = (
  person: string,
  method: AuthResult["fields"]["method"],
  firstVerification: boolean,
): AuthResult => ({
  name: "agc_auth_result",
  actor: "human",
  source: "dashboard",
  refs: { person },
  fields: { method, stage: "verify", outcome: "confirmed", first_verification: firstVerification },
});

const signInRefused = (
  method: AuthResult["fields"]["method"],
  stage: "start" | "verify",
  why: Refused,
): AuthResult => ({
  name: "agc_auth_result",
  actor: "human",
  source: "dashboard",
  fields: { method, stage, ...why },
});

const merchantCreated = (merchant: string, person: string): AnalyticsEvent => ({
  name: "agc_merchant_created",
  actor: "human",
  source: "dashboard",
  refs: { merchant, person },
});

const ANALYTICS_ROWS = "commerce_analytics_events";

/** As the memory store keeps an event: beside the rows of the fact it records. */
function recordInMemory(rows: MemoryRows, event: AnalyticsEvent): void {
  const kept = rows[ANALYTICS_ROWS] ?? [];
  rows[ANALYTICS_ROWS] = kept;
  kept.push({ ...event, occurredAt: new Date() });
}

class DeliveryRefused extends Error {}
class VerificationRefused extends Error {
  constructor(readonly why: Refused) {
    super("dashboard_link_refused");
  }
}
class GoogleTransactionRefused extends Error {
  constructor(readonly why: Refused = FAILED_UNTOLD) {
    super("dashboard_google_refused");
  }
}

type GoogleAdmission = {
  email: string | null;
  admit: (subject: string, email: string) => Promise<void>;
  /** Unknown until Google has named the address and it is admitted. */
  firstVerification?: boolean;
};

/**
 * What a Google callback's transaction does that the component cannot: take
 * the subject's and the address's locks, and write the registration's reports
 * and the sign-in's analytics event in the same transaction. `refused` is told
 * why a refusal it answers with was refused.
 */
type GoogleTransaction = Readonly<{
  lockIdentity?: (subject: string, email: string) => Promise<void>;
  register: (reports: readonly AdReport[]) => Promise<void>;
  record: (event: AnalyticsEvent) => Promise<void>;
  refused: (why: Refused) => void;
}>;

const hostedDomain = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

const googleControlsEmail = (email: string, profile: Record<string, unknown>): boolean => {
  const domain = /^[^\s@]+@([^\s@]+)$/.exec(email)?.[1];
  return (
    profile.email_verified === true &&
    domain !== undefined &&
    (domain === "gmail.com" ||
      domain === "googlemail.com" ||
      (typeof profile.hd === "string" && hostedDomain.test(profile.hd)))
  );
};

/** As the component hashes it. */
const tokenHash = (token: string): string => createHash("sha256").update(token).digest("base64url");

export function identityFor(config: DashboardConfig, parts: IdentityParts = {}): Identity {
  const watchCeiling = ceilingWatch();
  const postman = parts.postman ?? postmanFor(config);
  const reporting = config.registrationPostback !== null;
  const base = `${config.publicBaseUrl}${config.basePath}`;
  const originHeaders = new Headers({ origin: new URL(config.publicBaseUrl).origin });
  const sending = new AsyncLocalStorage<LinkSend>();
  const googleAdmission = new AsyncLocalStorage<GoogleAdmission>();
  const googleStateCookie = `${config.cookieSecure ? "__Host-" : ""}agentify.state`;
  const googleCallback = `${base}/sign-in/google/callback`;
  const memoryRows =
    parts.rows ??
    ({
      dashboard_accounts: [],
      dashboard_sessions: [],
      dashboard_credentials: [],
      dashboard_verifications: [],
      dashboard_link_sends: [],
      dashboard_report_identity_secrets: [],
      dashboard_report_deletion_tombstones: [],
      dashboard_ad_reports: [],
    } satisfies MemoryRows);

  const validateGoogleInfo: NonNullable<
    NonNullable<BetterAuthOptions["user"]>["validateUserInfo"]
  > = async ({ user, source }, context) => {
    if (source.method !== "oauth" || source.oauth?.providerId !== "google") return;
    const profile = source.oauth.profile ?? {};
    const email = typeof user.email === "string" ? emailAs(user.email) : "";
    if (
      typeof profile.sub !== "string" ||
      profile.sub.trim() === "" ||
      !googleControlsEmail(email, profile)
    )
      return { error: "google_email_unverified" };
    if (source.action !== "create-user" && typeof user.id === "string") {
      const existing = await context.context.internalAdapter.findUserById(user.id);
      if (existing === null || existing.email !== email) return { error: "google_email_changed" };
    }
  };

  const optionsFor = (database: BetterAuthOptions["database"], forGoogle = false) =>
    ({
      baseURL: base,
      secret: config.authSecret,
      telemetry: { enabled: false },
      onAPIError: { errorURL: `${base}/sign-in` },
      database,
      socialProviders:
        config.google === null
          ? {}
          : {
              google: {
                clientId: config.google.clientId,
                clientSecret: config.google.clientSecret,
                redirectURI: googleCallback,
                async mapProfileToUser(profile) {
                  const active = googleAdmission.getStore();
                  if (active === undefined) throw new Error("Google admission context is missing");
                  const email = typeof profile.email === "string" ? emailAs(profile.email) : "";
                  active.email = email || null;
                  if (typeof profile.sub === "string" && profile.sub !== "" && email !== "") {
                    await active.admit(profile.sub, email);
                  }
                  return { email, name: "", image: undefined };
                },
              },
            },
      user: {
        modelName: "dashboard_accounts",
        ...(forGoogle ? { validateUserInfo: validateGoogleInfo } : {}),
        additionalFields: {
          merchantId: { type: "string", required: false, input: false },
          // Closed to input: only the operator's workspace and the first
          // operator's configuration write it.
          operator: { type: "boolean", required: false, defaultValue: false, input: false },
          // Closed to input: only the settings' own press writes it.
          analyticsOptOut: {
            type: "boolean",
            required: false,
            defaultValue: false,
            input: false,
          },
        },
      },
      session: {
        modelName: "dashboard_sessions",
        expiresIn: SESSION_DAYS * 24 * 60 * 60,
        updateAge: SESSION_RENEWAL_SECONDS,
        additionalFields: {
          // Lets the scanner finish the request this session's link was asked
          // for, and no other.
          reportRequest: { type: "string", required: false, input: false },
        },
      },
      account: {
        modelName: "dashboard_credentials",
        storeAccountCookie: false,
        updateAccountOnSignIn: false,
      },
      databaseHooks: {
        account: {
          create: {
            before: async () => ({
              data: {
                accessToken: null,
                refreshToken: null,
                idToken: null,
                accessTokenExpiresAt: null,
                refreshTokenExpiresAt: null,
                scope: null,
              },
            }),
          },
        },
      },
      verification: { modelName: "dashboard_verifications" },
      advanced: {
        cookiePrefix: "agentify",
        // The component would prefix `__Secure-` on an https base; the
        // dashboard needs `__Host-`, which a browser accepts only when Secure,
        // for the whole origin and with no Domain, so a sibling host cannot
        // plant or replace a session.
        useSecureCookies: false,
        cookies: {
          session_token: { name: sessionCookieName(config.cookieSecure) },
          state: { name: googleStateCookie },
        },
        defaultCookieAttributes: {
          path: "/",
          sameSite: "lax",
          httpOnly: true,
          secure: config.cookieSecure,
        },
      },
      plugins: [
        ...(config.google === null ? [] : [boundedGoogleExchange()]),
        renewedSession(),
        magicLink({
          expiresIn: LINK_TTL_SECONDS,
          storeToken: "hashed",
          async sendMagicLink({ email, token, metadata }, context) {
            const active = sending.getStore();
            const claim = metadata === undefined ? null : claimOf(metadata);
            if (
              active === undefined ||
              claim === null ||
              claim.email !== email ||
              !sameClaim(claim, active.claim)
            ) {
              throw new Error("dashboard_link_claim_missing");
            }
            const stored = await context?.context.adapter.update<StoredVerification>({
              model: "verification",
              where: [{ field: "identifier", value: tokenHash(token) }],
              update: { value: JSON.stringify(claim) },
            });
            if (stored === null || stored === undefined) {
              throw new Error("dashboard_link_storage_missing");
            }
            // Only the token rides in the link.
            const action = new URL(`${base}/sign-in/open`);
            action.searchParams.set("token", token);
            active.handed = await postman(
              typeof claim.destination !== "string"
                ? reportLinkMessage(email, action.toString())
                : claim.stepUp === true
                  ? stepUpLinkMessage(email, action.toString())
                  : dashboardLinkMessage(email, action.toString()),
            );
          },
        }),
      ],
    }) satisfies BetterAuthOptions;

  const authFor = (database: BetterAuthOptions["database"], forGoogle = false) =>
    betterAuth(optionsFor(database, forGoogle));
  const rootDatabase =
    parts.pool === undefined
      ? memoryAdapter(memoryRows)
      : drizzleAdapter(drizzle(parts.pool), { provider: "pg", schema });
  const auth = authFor(rootDatabase);
  const cookies = getCookies(optionsFor(rootDatabase));
  const sessionCookie = cookies.sessionToken.name;

  /**
   * Whether verifying the address now makes its first verified account: it has
   * no account, or only one nobody has verified.
   */
  const isFirstVerification = async (
    context: Awaited<typeof auth.$context>,
    email: string,
  ): Promise<boolean> =>
    (await context.internalAdapter.findUserByEmail(email))?.user.emailVerified !== true;

  /**
   * The click a press of this link would report: only where reporting is
   * switched on, the link was asked for with a click, and the press makes the
   * address's first verified account. A click asked for while reporting was on
   * goes unreported once it is off.
   */
  const clickToReport = (claim: LinkClaim, firstVerification: boolean): string | undefined =>
    reporting && claim.clickId !== undefined && firstVerification ? claim.clickId : undefined;

  // The memory adapter is for deterministic tests and local work. Queueing its
  // transaction copies gives it all-or-nothing behaviour; PostgreSQL remains
  // the authority for concurrent row locking.
  let memoryTail: Promise<void> = Promise.resolve();
  const inMemoryTurn = async <T>(run: () => Promise<T>): Promise<T> => {
    const result = memoryTail.then(run, run);
    memoryTail = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  };
  const inMemoryTransaction = async <T>(
    work: (bound: typeof auth, rows: MemoryRows) => Promise<T>,
    forGoogle = false,
  ): Promise<T> =>
    await inMemoryTurn(async () => {
      const cloned = structuredClone(memoryRows);
      const result = await work(authFor(memoryAdapter(cloned), forGoogle), cloned);
      for (const key of new Set([...Object.keys(memoryRows), ...Object.keys(cloned)])) {
        if (cloned[key] === undefined) delete memoryRows[key];
        else memoryRows[key] = cloned[key];
      }
      return result;
    });

  // Queued behind the transactions, whose copies would otherwise write over
  // an event recorded while one of them ran.
  const observe = async (event: AnalyticsEvent): Promise<void> => {
    if (parts.pool !== undefined) {
      await recordObserved(drizzle(parts.pool), event, new Date());
      return;
    }
    await inMemoryTurn(async () => recordInMemory(memoryRows, event));
  };

  const requestWith = async (
    bound: typeof auth,
    claim: LinkClaim,
    retryAt: Date,
  ): Promise<LinkRequestResult> => {
    const active: LinkSend = { claim, handed: "refused" };
    await sending.run(active, async () => {
      await bound.api.signInMagicLink({
        headers: originHeaders,
        body: { email: claim.email, metadata: active.claim },
      });
    });
    if (active.handed !== "accepted") throw new DeliveryRefused();
    return { status: "accepted", retryAt };
  };

  const requestReportWith = async (
    bound: typeof auth,
    request: SendReportLinkRequest,
  ): Promise<SendReportLinkResponse> => {
    const claim: LinkClaim = {
      email: request.email,
      destination: { report: request.destination.report },
      request: request.request,
    };
    const active: LinkSend = { claim, handed: "refused" };
    await sending.run(active, async () => {
      await bound.api.signInMagicLink({
        headers: originHeaders,
        body: { email: request.email, metadata: claim },
      });
    });
    if (active.handed !== "accepted") throw new DeliveryRefused();
    return { status: "accepted" };
  };

  const openWith = async (
    bound: typeof auth,
    token: string,
    { lockEmail, register, record }: OpeningTransaction,
  ): Promise<DashboardLinkResult> => {
    if (!RAW_TOKEN.test(token)) throw new VerificationRefused(A_SPENT_LINK);
    const context = await bound.$context;
    const stored = await context.adapter.findOne<StoredVerification>({
      model: "verification",
      where: [{ field: "identifier", value: tokenHash(token) }],
    });
    if (stored === null || new Date(stored.expiresAt).getTime() <= Date.now()) {
      throw new VerificationRefused(A_SPENT_LINK);
    }
    const claim = claimFrom(stored.value);
    if (claim === null) throw new VerificationRefused(A_SPENT_LINK);
    await lockEmail?.(claim.email);
    // Whether this press makes the address's first verified account has to be
    // read before the component verifies it. Under the address's lock, a second
    // press waits here and then finds the account the first one verified.
    const firstVerification = await isFirstVerification(context, claim.email);
    const registering = clickToReport(claim, firstVerification);

    const verify = async () =>
      await bound.api.magicLinkVerify({
        returnHeaders: true,
        query: { token },
        headers: originHeaders,
      });
    let opened: Awaited<ReturnType<typeof verify>>;
    try {
      opened = await verify();
    } catch (thrown) {
      // The component refuses a spent or expired link by throwing a redirect,
      // which is not an instance of the error class it exports.
      if (isAPIError(thrown)) throw new VerificationRefused(A_SPENT_LINK);
      throw thrown;
    }
    if (opened.response.user.email !== claim.email || opened.response.user.emailVerified !== true) {
      throw new VerificationRefused(NOT_THE_SAME_PERSON);
    }
    await record(signInConfirmed(opened.response.user.id, "email_link", firstVerification));
    if (claim.request !== null) {
      // In the same transaction as the session: a session opened without its
      // request would leave that request waiting for a visit that can never
      // finish it.
      await context.internalAdapter.updateSession(opened.response.token, {
        reportRequest: claim.request,
      });
    }
    if (registering !== undefined) {
      // A plain insert on both sides: an account verified for the first time
      // cannot have a registration yet, and one already there is a broken
      // invariant that fails the press rather than being skipped.
      await register(adReportsOf(opened.response.user.id, registering));
    }
    return {
      status: "opened",
      person: personFrom(opened.response.user),
      destination: claim.destination,
      setCookies: opened.headers.getSetCookie(),
    };
  };

  const startGoogleWith = async (
    bound: typeof auth,
    destination: DashboardDestination,
    clickId: string | undefined,
  ): Promise<GoogleStartResult> => {
    const callback = new URL(`${base}/sign-in`);
    callback.searchParams.set("next", destination);
    if (clickId !== undefined) {
      if (clickIdOf(clickId) === null) throw new GoogleTransactionRefused();
      // The component keeps the callback address in the state's own row on
      // the server, keyed by the state the browser's cookie is bound to; the
      // browser and Google are handed only the state.
      callback.searchParams.set("clickid", clickId);
    }
    const started = await bound.api.signInSocial({
      headers: originHeaders,
      returnHeaders: true,
      body: {
        provider: "google",
        callbackURL: callback.toString(),
        errorCallbackURL: callback.toString(),
        disableRedirect: true,
      },
    });
    if (typeof started.response.url !== "string") throw new GoogleTransactionRefused();
    return {
      status: "redirect",
      location: started.response.url,
      setCookies: started.headers.getSetCookie(),
    };
  };

  const finishGoogleWith = async (
    bound: typeof auth,
    query: URLSearchParams,
    cookie: string | undefined,
    { lockIdentity, register, record, refused }: GoogleTransaction,
  ): Promise<GoogleFinishResult> => {
    const context = await bound.$context;
    const active: GoogleAdmission = {
      email: null,
      async admit(subject, email) {
        await lockIdentity?.(subject, email);
        // Read under the address's lock and before the component writes, so a
        // second callback for a new address waits here and then finds the
        // account the first one made.
        active.firstVerification = await isFirstVerification(context, email);
      },
    };
    return await googleAdmission.run(active, async () => {
      const headers = new Headers(originHeaders);
      if (cookie !== undefined) headers.set("cookie", cookie);
      const response = await bound.api.callbackOAuth({
        method: "GET",
        params: { id: "google" },
        query: Object.fromEntries(query),
        headers,
        asResponse: true,
      });
      const setCookies = response.headers.getSetCookie();
      const location = response.headers.get("location");
      if (location === null) throw new GoogleTransactionRefused();
      const redirected = new URL(location, base);
      const destination = dashboardDestinationIn(redirected.searchParams.get("next"));
      const clickId = reporting ? clickIdIn(redirected) : undefined;
      const error = redirected.searchParams.get("error");
      if (error !== null) {
        const reason =
          error === "google_email_unverified"
            ? "email-unverified"
            : error === "google_email_changed"
              ? "email-changed"
              : error === "access_denied"
                ? "cancelled"
                : error === "invalid_code"
                  ? "unavailable"
                  : "invalid";
        const why = Object.hasOwn(GOOGLE_ERRORS, error) ? GOOGLE_ERRORS[error] : undefined;
        if (why === undefined) throw new GoogleTransactionRefused();
        if (why !== null) refused(why);
        // A refusal of the state itself may come with another browser's
        // sign-in, so only a state held to this browser's cookie gives back
        // the click this browser's own press kept.
        const ownState = !["state_not_found", "state_mismatch", "state_invalid"].includes(error);
        return {
          status: "refused",
          reason,
          destination,
          setCookies,
          email: reason === "email-unverified" || reason === "email-changed" ? active.email : null,
          ...(clickId === undefined || !ownState ? {} : { clickId }),
        };
      }
      const sessionHeaders = new Headers({
        cookie: setCookies.map((line) => line.split(";", 1)[0]).join("; "),
      });
      const opened = await bound.api.getSession({ headers: sessionHeaders });
      if (
        opened === null ||
        opened.user.emailVerified !== true ||
        opened.user.email !== active.email
      ) {
        throw new GoogleTransactionRefused(NOT_THE_SAME_PERSON);
      }
      await record(signInConfirmed(opened.user.id, "google", active.firstVerification === true));
      if (clickId !== undefined && active.firstVerification === true) {
        await register(adReportsOf(opened.user.id, clickId));
      }
      return { status: "opened", person: personFrom(opened.user), destination, setCookies };
    });
  };

  const makeWith = async (
    bound: typeof auth,
    email: string,
    merchantId: string,
  ): Promise<Person | null> => {
    const context = await bound.$context;
    if ((await context.internalAdapter.findUserByEmail(email)) !== null) return null;
    const made = await context.internalAdapter.createUser(
      {
        email,
        emailVerified: false,
        name: "",
        merchantId,
      },
      { method: "operator" },
    );
    return personFrom(made);
  };

  const valuesIn = (cookieHeader: string | undefined): readonly string[] => {
    if (cookieHeader === undefined) return [];
    const found = new Set<string>();
    for (const pair of cookieHeader.split(";")) {
      const at = pair.indexOf("=");
      if (at === -1 || pair.slice(0, at).trim() !== sessionCookie) continue;
      const value = pair.slice(at + 1).trim();
      if (value !== "") found.add(value);
    }
    return [...found];
  };
  const asHeaders = (value: string): Headers =>
    new Headers({ cookie: `${sessionCookie}=${value}` });
  const contextOf = async () => await auth.$context;

  /** A change of accounts outside a journal's transaction: only in memory, inside its queued copy. */
  const memoryOnly = async <T>(work: (rows: MemoryRows) => Promise<T>): Promise<T> => {
    if (parts.pool !== undefined) {
      throw new Error("a change of an account on Postgres runs on the journal's transaction");
    }
    return await inMemoryTransaction(async (_bound, rows) => await work(rows));
  };

  /**
   * Gives the configured first operator the flag at their sign-in, journaled
   * as the configuration's, where the channel has never had an operator. A
   * failure leaves the sign-in as it is, and the next one tries again.
   */
  const firstOperatorAt = async (person: Person): Promise<void> => {
    if (config.firstOperator === null || person.email !== config.firstOperator) return;
    const rowFor = (id: string) =>
      ({
        at: Date.now(),
        actor: { kind: "configuration" },
        action: "first_operator",
        subject: { kind: "account", id },
        reason: null,
        outcome: { kind: "done" },
      }) as const;
    try {
      if (parts.pool === undefined) {
        const journal = parts.journal;
        if (journal === undefined) return;
        const touched = (await journal.journal({ actions: FLAG_ACTIONS, limit: 1 })).total > 0;
        const given = await inMemoryTransaction(async (_bound, rows) =>
          firstOperatorInMemory(rows, person.email, touched),
        );
        if (given !== null) await journal.recordJournal(rowFor(given));
        return;
      }
      await drizzle(parts.pool).transaction(async (tx) => {
        const given = await firstOperatorIn(tx, person.email);
        if (given !== null) await journalAlong(tx, rowFor(given));
      });
    } catch {
      console.error(
        "[dashboard] the configured first operator could not be given the flag; their next sign-in tries again",
      );
    }
  };
  /**
   * The component moves a session's end at most once a day and says so with a
   * cookie of its own; dropping that line would extend the row while the
   * browser's cookie still expires thirty days after sign-in. A dead value
   * answers with a line clearing the cookie, which is dropped here: it names
   * the same cookie the live value sits under, so passing it on would sign the
   * person out.
   */
  const liveOnesIn = async (
    cookieHeader: string | undefined,
    renew = true,
  ): Promise<readonly (LiveSession & { token: string })[]> => {
    const live: (LiveSession & { token: string })[] = [];
    for (const value of valuesIn(cookieHeader)) {
      const found = await auth.api.getSession({
        headers: asHeaders(value),
        returnHeaders: true,
        ...(renew ? {} : { query: { disableRefresh: true } }),
      });
      if (found.response !== null) {
        const request = (found.response.session as { reportRequest?: unknown }).reportRequest;
        live.push({
          token: found.response.session.token,
          person: personFrom(found.response.user),
          operator: operatorOn(found.response.user),
          request: typeof request === "string" ? request : null,
          signedInAt: new Date(found.response.session.createdAt),
          setCookies: found.headers.getSetCookie(),
        });
      }
    }
    return live;
  };
  const endSession = async (token: string): Promise<void> => {
    await (await contextOf()).internalAdapter.deleteSession(token);
  };

  /**
   * Only live rows are asked for, since expired rows are never deleted. The
   * store reads at most a hundred rows at a time in no order, so this asks
   * again until a read finds nothing left to end; a token already ended is not
   * ended or counted twice, which also stops the loop if a row survives its
   * delete.
   */
  const endLiveSessionsOf = async (
    personId: string,
    kept: ReadonlySet<string>,
  ): Promise<number> => {
    const context = await contextOf();
    const ended = new Set<string>();
    for (;;) {
      const live = await context.internalAdapter.listSessions(personId, {
        onlyActiveSessions: true,
      });
      const others = live.filter((one) => !kept.has(one.token) && !ended.has(one.token));
      if (others.length === 0) return ended.size;
      for (const one of others) {
        await endSession(one.token);
        ended.add(one.token);
      }
    }
  };

  const linkRequested = async (
    rawEmail: string,
    destination: DashboardDestination,
    { client, clickId }: LinkAsker,
  ): Promise<LinkRequestResult> => {
    const email = emailAs(rawEmail);
    const counted = countedClient(client);
    const asking: ClientCount = counted.visitor
      ? {
          hash: clientKey(config.authSecret, counted.key),
          limit: LINK_CLIENT_LIMIT,
          wall: "client",
        }
      : {
          hash: clientKey(config.authSecret, UNKNOWN_CLIENT),
          limit: LINK_UNKNOWN_CLIENT_LIMIT,
          wall: "shared",
        };
    return await sentCounted(
      { email, destination, request: null, ...(clickId === undefined ? {} : { clickId }) },
      "dashboard",
      asking,
    );
  };

  /**
   * Sends the link `claim` names once the limits of `purpose` let it: the
   * address's minute and hour, the client's hour where one is counted, and the
   * channel's ceiling, each counted among the sends of that purpose alone.
   */
  const sentCounted = async (
    claim: LinkClaim,
    purpose: "dashboard" | "step-up",
    asking: ClientCount | null,
  ): Promise<LinkRequestResult> => {
    const email = claim.email;
    try {
      if (parts.pool === undefined) {
        await inMemoryTransaction(async (_bound, rows) => {
          cleanupOldLinksInMemory(rows, new Date());
        });
        return await inMemoryTransaction(async (bound, rows) => {
          const rated = watchCeiling(
            purpose,
            memoryRate(rows, rateKey(config.authSecret, email), purpose, asking),
          );
          if (!rated.sent) return { status: "cooldown", wall: rated.wall, retryAt: rated.retryAt };
          return await requestWith(bound, claim, rated.retryAt);
        });
      }
      const db = drizzle(parts.pool, {
        schema: { accounts, credentials, linkSends, sessions, verifications },
      });
      // The sweep of old links runs in a transaction of its own, first: inside
      // the one that waits on the mail provider it would hold other requests up
      // behind a send, and a refused send would undo it.
      await db.transaction(async (tx) => {
        await cleanupOldLinksInPostgres(tx, new Date());
      });
      return await db.transaction(async (tx) => {
        await lockEmail(tx, email);
        const rated = watchCeiling(
          purpose,
          await postgresRate(tx, rateKey(config.authSecret, email), purpose, asking),
        );
        if (!rated.sent) return { status: "cooldown", wall: rated.wall, retryAt: rated.retryAt };
        return await requestWith(
          authFor(drizzleAdapter(tx, { provider: "pg", schema })),
          claim,
          rated.retryAt,
        );
      });
    } catch (thrown) {
      if (thrown instanceof DeliveryRefused) return { status: "unavailable" };
      throw thrown;
    }
  };

  /**
   * Google's return in a transaction of its own. Why a refusal it answers with
   * was refused is told to `refused`, a failure's included.
   */
  const finishedGoogle = async (
    proof: URLSearchParams,
    cookie: string | undefined,
    refused: (why: Refused) => void,
  ): Promise<GoogleFinishResult> => {
    try {
      if (parts.pool === undefined) {
        return await inMemoryTransaction(
          async (bound, rows) =>
            await finishGoogleWith(bound, proof, cookie, {
              register: async (reports) => registerInMemory(rows, reports),
              record: async (event) => recordInMemory(rows, event),
              refused,
            }),
          true,
        );
      }
      return await drizzle(parts.pool).transaction(async (tx) => {
        const state = proof.get("state");
        if (state !== null) {
          // A replay must not occupy another connection while its owner waits for Google.
          const lock = await tx.execute<{ acquired: boolean }>(
            sql`select pg_try_advisory_xact_lock(hashtextextended(${`dashboard-google-state:${state}`}, 0)) as acquired`,
          );
          if (lock.rows[0]?.acquired !== true) {
            refused(A_SPENT_LINK);
            return {
              status: "refused",
              reason: "invalid",
              email: null,
              destination: "default",
              setCookies: [],
            };
          }
        }
        return await finishGoogleWith(
          authFor(drizzleAdapter(tx, { provider: "pg", schema }), true),
          proof,
          cookie,
          {
            lockIdentity: async (subject, email) => {
              await tx.execute(
                sql`select pg_advisory_xact_lock(hashtextextended(${`dashboard-google-sub:${subject}`}, 0))`,
              );
              await lockEmail(tx, email);
            },
            register: async (reports) => {
              await tx.insert(adReports).values([...reports]);
            },
            record: async (event) => await recordAlong(tx, event, new Date()),
            refused,
          },
        );
      });
    } catch (thrown) {
      refused(thrown instanceof GoogleTransactionRefused ? thrown.why : FAILED_UNTOLD);
      return {
        status: "refused",
        reason: "unavailable",
        email: null,
        destination: "default",
        setCookies: [],
      };
    }
  };

  return {
    cookieNames: [
      cookies.sessionToken.name,
      cookies.sessionData.name,
      cookies.dontRememberToken.name,
      googleStateCookie,
    ],
    googleEnabled: config.google !== null,

    async startGoogle(destination, clickId) {
      // Nothing is offered where Google is not configured, so nothing was tried.
      if (config.google === null) return { status: "unavailable" };
      try {
        if (parts.pool === undefined) {
          return await inMemoryTransaction(
            async (bound) => await startGoogleWith(bound, destination, clickId),
          );
        }
        return await drizzle(parts.pool).transaction(
          async (tx) =>
            await startGoogleWith(
              authFor(drizzleAdapter(tx, { provider: "pg", schema })),
              destination,
              clickId,
            ),
        );
      } catch {
        void observe(signInRefused("google", "start", UNAVAILABLE));
        return { status: "unavailable" };
      }
    },

    async finishGoogle(query, cookie) {
      // Nothing is offered where Google is not configured, so nothing was tried.
      if (config.google === null)
        return {
          status: "refused",
          reason: "unavailable",
          email: null,
          destination: "default",
          setCookies: [],
        };
      const proof = new URLSearchParams();
      for (const key of ["state", "code", "error", "error_description", "iss"]) {
        const values = query.getAll(key);
        if (values.length > 1) {
          void observe(signInRefused("google", "verify", A_SPENT_LINK));
          return {
            status: "refused",
            reason: "invalid",
            email: null,
            destination: "default",
            setCookies: [],
          };
        }
        if (values[0] !== undefined) proof.set(key, values[0]);
      }
      // The lock and the OAuth component must consume one identical proof.
      // Choosing different occurrences of a repeated state bypasses serialization.
      if (!proof.get("state") || Boolean(proof.get("code")) === Boolean(proof.get("error"))) {
        void observe(signInRefused("google", "verify", A_SPENT_LINK));
        return {
          status: "refused",
          reason: "invalid",
          email: null,
          destination: "default",
          setCookies: [],
        };
      }
      // Told inside the transaction and recorded once it is over, so a
      // refusal is recorded whichever way the transaction ended.
      const told: { why: Refused | null } = { why: null };
      const finished = await finishedGoogle(proof, cookie, (why) => {
        told.why = why;
      });
      if (finished.status === "refused" && told.why !== null) {
        void observe(signInRefused("google", "verify", told.why));
      }
      if (finished.status === "opened") await firstOperatorAt(finished.person);
      return finished;
    },

    async requestStepUpLink(rawEmail, destination) {
      // Counted under a purpose of its own, so the public form, where anybody
      // can type an operator's address, spends none of these sends. No client
      // is counted: the asker is an operator's session, not a visitor.
      return await sentCounted(
        { email: emailAs(rawEmail), destination, request: null, stepUp: true },
        "step-up",
        null,
      );
    },

    async requestLink(rawEmail, destination, asker) {
      const requested = await linkRequested(rawEmail, destination, asker);
      if (requested.status === "cooldown") {
        void observe(
          signInRefused("email_link", "start", { outcome: "blocked", reason_code: "rate_limited" }),
        );
      }
      if (requested.status === "unavailable") {
        void observe(signInRefused("email_link", "start", UNAVAILABLE));
      }
      return requested;
    },

    async sendReportLink(request) {
      try {
        if (parts.pool === undefined) {
          return await inMemoryTransaction(async (bound, rows) => {
            const now = new Date();
            cleanupOldLinksInMemory(rows, now);
            const digestKey = reportDigestKeyInMemory(rows, now);
            const rated = watchCeiling(
              "report",
              memoryRate(rows, rateKey(digestKey, request.email), "report", null),
            );
            if (!rated.sent) {
              return { status: "cooldown", retry_at: rated.retryAt.toISOString() };
            }
            return await requestReportWith(bound, request);
          });
        }
        const db = drizzle(parts.pool, {
          schema: {
            accounts,
            credentials,
            linkSends,
            reportIdentitySecrets,
            sessions,
            verifications,
          },
        });
        return await db.transaction(async (tx) => {
          const now = new Date();
          const digestKey = await reportDigestKeyInPostgres(tx, now);
          await cleanupOldLinksInPostgres(tx, now);
          await lockEmail(tx, request.email);
          const rated = watchCeiling(
            "report",
            await postgresRate(tx, rateKey(digestKey, request.email), "report", null),
          );
          if (!rated.sent) {
            return { status: "cooldown", retry_at: rated.retryAt.toISOString() };
          }
          return await requestReportWith(
            authFor(drizzleAdapter(tx, { provider: "pg", schema })),
            request,
          );
        });
      } catch (thrown) {
        if (thrown instanceof DeliveryRefused) return { status: "unavailable" };
        throw thrown;
      }
    },

    async landingOf(token) {
      if (!RAW_TOKEN.test(token)) return null;
      const context = await contextOf();
      const stored = await context.adapter.findOne<StoredVerification>({
        model: "verification",
        where: [{ field: "identifier", value: tokenHash(token) }],
      });
      if (stored === null || new Date(stored.expiresAt).getTime() <= Date.now()) return null;
      const claim = claimFrom(stored.value);
      if (claim === null) return null;
      return { email: claim.email };
    },

    async openLink(token) {
      const opened = await (async (): Promise<DashboardLinkResult> => {
        try {
          if (parts.pool === undefined) {
            return await inMemoryTransaction(
              async (bound, rows) =>
                await openWith(bound, token, {
                  register: async (reports) => registerInMemory(rows, reports),
                  record: async (event) => recordInMemory(rows, event),
                }),
            );
          }
          const db = drizzle(parts.pool);
          return await db.transaction(async (tx) => {
            const bound = authFor(drizzleAdapter(tx, { provider: "pg", schema }));
            return await openWith(bound, token, {
              lockEmail: async (email) => await lockEmail(tx, email),
              register: async (reports) => {
                await tx.insert(adReports).values([...reports]);
              },
              record: async (event) => await recordAlong(tx, event, new Date()),
            });
          });
        } catch (thrown) {
          if (thrown instanceof VerificationRefused) {
            void observe(signInRefused("email_link", "verify", thrown.why));
            return { status: "refused" };
          }
          throw thrown;
        }
      })();
      if (opened.status === "opened") await firstOperatorAt(opened.person);
      return opened;
    },

    async deleteUnattachedPerson(request) {
      if (parts.pool === undefined) {
        return await inMemoryTransaction(async (_bound, rows) => {
          const now = new Date();
          const digestKey = reportDigestKeyInMemory(rows, now);
          const operationDigest = reportDeleteDigest(
            digestKey,
            request.operation_id,
            request.email,
          );
          const prior = (rows.dashboard_report_deletion_tombstones ?? []).find(
            (row) => row.operationId === request.operation_id,
          ) as { operationDigest: string; result: DeleteResult } | undefined;
          if (prior !== undefined) {
            return prior.operationDigest === operationDigest
              ? { status: prior.result }
              : { status: "refused" };
          }
          cleanupOldLinksInMemory(rows, now);
          const result = deleteFromMemory(rows, request.email);
          const tombstones = rows.dashboard_report_deletion_tombstones ?? [];
          rows.dashboard_report_deletion_tombstones = tombstones;
          tombstones.push({
            operationId: request.operation_id,
            operationDigest,
            result,
            createdAt: now,
            completedAt: now,
          });
          return { status: result };
        });
      }

      const db = drizzle(parts.pool, {
        schema: {
          accounts,
          reportDeletionTombstones,
          reportIdentitySecrets,
          verifications,
        },
      });
      return await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`dashboard-report-delete:${request.operation_id}`}, 0))`,
        );
        const now = new Date();
        const digestKey = await reportDigestKeyInPostgres(tx, now);
        const operationDigest = reportDeleteDigest(digestKey, request.operation_id, request.email);
        const prior = (
          await tx
            .select()
            .from(reportDeletionTombstones)
            .where(eq(reportDeletionTombstones.operationId, request.operation_id))
        )[0];
        if (prior !== undefined) {
          return prior.operationDigest === operationDigest
            ? { status: prior.result as DeleteResult }
            : { status: "refused" };
        }
        await cleanupOldLinksInPostgres(tx, now);
        await lockEmail(tx, request.email);
        const candidate = (
          await tx
            .select({ id: accounts.id })
            .from(accounts)
            .where(eq(accounts.email, request.email))
        )[0];
        if (candidate !== undefined) {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`dashboard-person:${candidate.id}`}, 0))`,
          );
        }
        const row = (
          await tx.select().from(accounts).where(eq(accounts.email, request.email)).for("update")
        )[0];
        const result: DeleteResult =
          row === undefined
            ? "already_absent"
            : row.merchantId === null && !row.operator
              ? "deleted"
              : "retained";
        const proofs = await tx
          .select({ id: verifications.id, value: verifications.value })
          .from(verifications);
        for (const proof of proofs) {
          if (goesWithTheDeletion(claimFrom(proof.value), request.email, result)) {
            await tx.delete(verifications).where(eq(verifications.id, proof.id));
          }
        }
        if (result === "deleted" && row !== undefined) {
          await tx.delete(accounts).where(eq(accounts.id, row.id));
        }
        await tx.insert(reportDeletionTombstones).values({
          operationId: request.operation_id,
          operationDigest,
          result,
          createdAt: now,
          completedAt: now,
        });
        return { status: result };
      });
    },

    async whoIs(cookieHeader, options) {
      const live = await liveOnesIn(cookieHeader, options?.renew ?? true);
      const first = live[0];
      if (first === undefined) return null;
      const owners = new Set(live.map((one) => one.person.id));
      if (owners.size === 1) {
        return {
          person: first.person,
          operator: first.operator,
          request: first.request,
          signedInAt: first.signedInAt,
          setCookies: first.setCookies,
        };
      }
      for (const one of live) await endSession(one.token);
      console.log(
        `[dashboard] a request carried live sessions of ${owners.size} different people;` +
          " every one of them was ended and nobody was signed in",
      );
      return null;
    },

    async signOut(cookieHeader) {
      const live = await liveOnesIn(cookieHeader);
      for (const one of live) await endSession(one.token);
      return live.length;
    },

    async attachMerchant(personId, register) {
      if (parts.pool === undefined) {
        return await inMemoryTransaction(async (_bound, rows) => {
          const row = rows.dashboard_accounts?.find((one) => one.id === personId);
          if (row === undefined) return { status: "person-missing" };
          const person = personFrom(row as PersonRow);
          if (person.merchant !== null) {
            return { status: "already-attached", person: asMerchantPerson(person) };
          }
          const merchantId = await register();
          if (merchantId === null) {
            return { status: "unavailable", person: asUnattachedPerson(person) };
          }
          row.merchantId = merchantId;
          row.updatedAt = new Date();
          recordInMemory(rows, merchantCreated(merchantId, personId));
          return {
            status: "attached",
            person: asMerchantPerson({ ...person, merchant: { id: merchantId } }),
          };
        });
      }

      const db = drizzle(parts.pool, { schema: { accounts } });
      return await db.transaction(async (tx): Promise<AttachMerchantResult> => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`dashboard-person:${personId}`}, 0))`,
        );
        const row = (
          await tx.execute<PersonRow>(sql`
            select id, email, email_verified as "emailVerified", merchant_id as "merchantId"
            from dashboard_accounts where id = ${personId} for update
          `)
        ).rows[0];
        if (row === undefined) return { status: "person-missing" };
        const person = personFrom(row);
        if (person.merchant !== null) {
          return { status: "already-attached", person: asMerchantPerson(person) };
        }
        const merchantId = await register();
        if (merchantId === null) {
          return { status: "unavailable", person: asUnattachedPerson(person) };
        }
        const written = await tx
          .update(accounts)
          .set({ merchantId, updatedAt: new Date() })
          .where(and(eq(accounts.id, personId), isNull(accounts.merchantId)))
          .returning({ id: accounts.id });
        if (written.length !== 1) throw new Error("dashboard_merchant_attachment_lost_lock");
        await recordAlong(tx, merchantCreated(merchantId, personId), new Date());
        return {
          status: "attached",
          person: asMerchantPerson({ ...person, merchant: { id: merchantId } }),
        };
      });
    },

    async make(rawEmail, merchantId) {
      const email = emailAs(rawEmail);
      if (parts.pool === undefined) {
        return await inMemoryTransaction(async (bound) => await makeWith(bound, email, merchantId));
      }
      const db = drizzle(parts.pool);
      return await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`dashboard-email:${email}`}, 0))`,
        );
        return await makeWith(
          authFor(drizzleAdapter(tx, { provider: "pg", schema })),
          email,
          merchantId,
        );
      });
    },

    async byEmail(email) {
      const found = await (await contextOf()).internalAdapter.findUserByEmail(emailAs(email));
      return found === null ? null : personFrom(found.user);
    },

    async byId(personId) {
      const found = await (await contextOf()).internalAdapter.findUserById(personId);
      return found === null || found === undefined ? null : personFrom(found);
    },

    async emailsNaming(merchantId) {
      const people = await (await contextOf()).adapter.findMany<{ email: string }>({
        model: "user",
        where: [{ field: "merchantId", value: merchantId }],
      });
      return people.map((person) => person.email);
    },

    async endMerchantSessionsAndRenew(merchantId, cookieHeader) {
      // The new session is made first, so the one thing kept is a token no
      // copy of the pressing browser's cookie can carry.
      const kept = new Set<string>();
      let setCookies: readonly string[] = [];
      for (const value of valuesIn(cookieHeader)) {
        const found = await auth.api.getSession({
          headers: asHeaders(value),
          query: { disableRefresh: true },
        });
        if (found === null || personFrom(found.user).merchant?.id !== merchantId) continue;
        try {
          const renewed = await auth.api.renewSession({
            headers: asHeaders(value),
            returnHeaders: true,
          });
          kept.add(renewed.response.token);
          setCookies = renewed.headers.getSetCookie();
        } catch {
          // The session can end between the read and the renewal, as when
          // another tab signs out everywhere; failing here would end nothing,
          // so every session ends and the browser signs in again.
          console.error("[dashboard] a session could not be renewed, so none was kept");
        }
        break;
      }
      const people = await (await contextOf()).adapter.findMany<{ id: string }>({
        model: "user",
        where: [{ field: "merchantId", value: merchantId }],
      });
      let ended = 0;
      for (const person of people) {
        ended += await endLiveSessionsOf(person.id, kept);
      }
      return { ended, setCookies };
    },

    async endSessionsOfPerson(personId) {
      return await endLiveSessionsOf(personId, new Set());
    },

    async operatorAccounts(now) {
      if (parts.pool === undefined) {
        return await inMemoryTurn(async () => listedInMemory(memoryRows, now));
      }
      return await readingAccounts(parts.pool, async (tx) => await listedIn(tx, now));
    },

    async operatorAccount(accountId, now) {
      if (parts.pool === undefined) {
        return await inMemoryTurn(async () => summaryInMemoryOf(memoryRows, accountId, now));
      }
      return await readingAccounts(parts.pool, async (tx) => await summaryIn(tx, accountId, now));
    },

    async endSessionsIn(tx, accountId, now) {
      if (tx === null) {
        return await memoryOnly(async (rows) => endSessionsInMemory(rows, accountId, now));
      }
      return await endSessionsIn(tx, accountId, now);
    },

    async setOperatorIn(tx, accountId, on, asked) {
      const channel = channelOf(config);
      const tell = async (
        before: readonly Readonly<{ id: string; email: string }>[],
        changed: Readonly<{ id: string; email: string }>,
      ) => {
        const told = new Set([...before.map((one) => one.email), changed.email]);
        // Handed over side by side, since the channel's lock is held meanwhile.
        const handed = await Promise.all(
          [...told].map((to) =>
            postman(
              operatorFlagMessage(to, {
                email: changed.email,
                granted: on,
                at: asked.at,
                askedBy: asked.by,
                channel: `${channel.name.toLowerCase()} (${channel.line})`,
                accounts: `${base}/admin/accounts`,
              }),
            ),
          ),
        );
        if (handed.some((one) => one !== "accepted")) throw new OperatorMailRefused();
      };
      if (tx === null) {
        return await memoryOnly(async (rows) => await setFlagInMemory(rows, accountId, on, tell));
      }
      return await setFlagIn(tx, accountId, on, tell);
    },

    async forgetIn(tx, accountId) {
      if (tx === null) return await memoryOnly(async (rows) => forgetInMemory(rows, accountId));
      return await forgetIn(tx, accountId, config.authSecret);
    },

    observe,

    async analyticsOptedOut(personId) {
      const found = await (await contextOf()).internalAdapter.findUserById(personId);
      return (found as { analyticsOptOut?: unknown } | null)?.analyticsOptOut === true;
    },

    async setAnalyticsOptOut(personId, optedOut) {
      const choose = async (adapter: Awaited<typeof auth.$context>["adapter"]) =>
        await adapter.update<{ merchantId?: unknown }>({
          model: "user",
          where: [
            { field: "id", value: personId },
            // Only a choice that changes reaches the account, so pressing the
            // one already held settles nothing that waits about them.
            { field: "analyticsOptOut", operator: "ne", value: optedOut },
          ],
          update: { analyticsOptOut: optedOut },
        });
      if (parts.pool === undefined) {
        await choose((await contextOf()).adapter);
        return;
      }
      await drizzle(parts.pool).transaction(async (tx) => {
        const bound = authFor(drizzleAdapter(tx, { provider: "pg", schema }));
        const chosen = await choose((await bound.$context).adapter);
        if (chosen === null) return;
        const { merchantId } = chosen;
        await suppressWaitingAbout(
          tx,
          personId,
          typeof merchantId === "string" && merchantId !== "" ? merchantId : null,
        );
      });
    },

    async close() {
      await parts.pool?.end();
    },

    async linksSentInTheHour(now) {
      const since = now.getTime() - LINK_RATE_WINDOW_MS;
      const counted: Record<LinkPurpose, number> = { dashboard: 0, report: 0, "step-up": 0 };
      const purposes = Object.keys(counted);
      if (parts.pool === undefined) {
        for (const row of memoryRows.dashboard_link_sends ?? []) {
          const sentAt = new Date(row.sentAt as Date).getTime();
          if (sentAt > since && sentAt <= now.getTime() && purposes.includes(String(row.purpose))) {
            counted[row.purpose as LinkPurpose] += 1;
          }
        }
        return counted;
      }
      const rows = await drizzle(parts.pool)
        .select({ purpose: linkSends.purpose, sent: sql<number>`count(*)::int` })
        .from(linkSends)
        .where(and(gt(linkSends.sentAt, new Date(since)), lte(linkSends.sentAt, now)))
        .groupBy(linkSends.purpose);
      for (const row of rows) {
        if (purposes.includes(row.purpose)) counted[row.purpose as LinkPurpose] = row.sent;
      }
      return counted;
    },

    async accountsNamed(named) {
      const ids = named.accountIds ?? [];
      const merchantIds = named.merchantIds ?? [];
      if (ids.length === 0 && merchantIds.length === 0) return [];
      if (parts.pool === undefined) {
        return (memoryRows.dashboard_accounts ?? [])
          .filter(
            (row) =>
              ids.includes(String(row.id)) ||
              (typeof row.merchantId === "string" && merchantIds.includes(row.merchantId)),
          )
          .map((row) => ({
            id: String(row.id),
            email: String(row.email),
            merchantId: typeof row.merchantId === "string" ? row.merchantId : null,
          }));
      }
      const either = [
        ...(ids.length === 0 ? [] : [inArray(accounts.id, [...ids])]),
        ...(merchantIds.length === 0 ? [] : [inArray(accounts.merchantId, [...merchantIds])]),
      ];
      return await drizzle(parts.pool)
        .select({ id: accounts.id, email: accounts.email, merchantId: accounts.merchantId })
        .from(accounts)
        .where(or(...either));
    },

    async adReportsSince(since) {
      const counted = { delivered: 0, refused: 0, givenUp: 0, waiting: 0 };
      const settledAs: Readonly<Record<string, keyof typeof counted>> = {
        delivered: "delivered",
        refused: "refused",
        given_up: "givenUp",
      };
      const tally = (state: string, settledAt: Date | null, many = 1) => {
        if (state === "waiting" || state === "pending") counted.waiting += many;
        const as = settledAs[state];
        if (as !== undefined && settledAt !== null && settledAt.getTime() >= since.getTime()) {
          counted[as] += many;
        }
      };
      if (parts.pool === undefined) {
        for (const row of memoryRows.dashboard_ad_reports ?? []) {
          tally(String(row.state), row.settledAt == null ? null : new Date(row.settledAt as Date));
        }
        return counted;
      }
      const rows = await drizzle(parts.pool)
        .select({
          state: adReports.state,
          settled: sql<number>`(count(*) filter (where ${adReports.settledAt} >= ${since}))::int`,
          all: sql<number>`count(*)::int`,
        })
        .from(adReports)
        .groupBy(adReports.state);
      for (const row of rows) {
        if (row.state === "waiting" || row.state === "pending") tally(row.state, null, row.all);
        else tally(row.state, since, row.settled);
      }
      return counted;
    },

    async accountWithEmail(email) {
      const found = await (await contextOf()).internalAdapter.findUserByEmail(emailAs(email));
      if (found === null) return null;
      const person = personFrom(found.user);
      return { id: person.id, email: person.email, merchantId: person.merchant?.id ?? null };
    },

    async accountsWithEmailContaining(text) {
      const wanted = text.trim().toLowerCase();
      if (wanted === "") return { accounts: [], cut: false };
      const { adapter } = await contextOf();
      const rows = await adapter.findMany<{ id: string; email: string; merchantId?: unknown }>({
        model: "user",
        where: [{ field: "email", operator: "contains", value: wanted }],
        limit: ACCOUNTS_FOUND_MAX,
      });
      // The adapter's own match reads `%` and `_` as wildcards, so what it
      // finds is held to the text exactly; where it found as many as it reads,
      // an account matching exactly may be among those it did not read.
      const accounts = rows
        .filter((row) => row.email.toLowerCase().includes(wanted))
        .map((row) => ({
          id: row.id,
          email: row.email,
          merchantId:
            typeof row.merchantId === "string" && row.merchantId !== "" ? row.merchantId : null,
        }));
      return { accounts, cut: rows.length >= ACCOUNTS_FOUND_MAX };
    },
  };
}

/** The journal's actions that show the channel's flag was ever given or taken. */
const FLAG_ACTIONS = ["first_operator", "grant_operator", "remove_operator"] as const;

/** A read of the accounts: read only, and cut off rather than holding the database. */
async function readingAccounts<T>(pool: Pool, read: (tx: Statements) => Promise<T>): Promise<T> {
  return await drizzle(pool).transaction(
    async (tx) => {
      await tx.execute(sql`select set_config('statement_timeout', '5000', true)`);
      return await read(tx);
    },
    { accessMode: "read only" },
  );
}

type PersonRow = {
  id: string;
  email: string;
  emailVerified: boolean;
  merchantId?: unknown;
};

function personFrom(user: PersonRow): Person {
  if (user.merchantId === null || user.merchantId === undefined) {
    return {
      id: user.id,
      email: user.email,
      confirmed: user.emailVerified === true,
      merchant: null,
    };
  }
  // Nothing writes an empty identifier; a row holding one was edited by hand,
  // and reading it as no merchant would hide that.
  if (typeof user.merchantId !== "string" || user.merchantId === "") {
    throw new Error("dashboard_account_unreadable_merchant");
  }
  return {
    id: user.id,
    email: user.email,
    confirmed: user.emailVerified === true,
    merchant: { id: user.merchantId },
  };
}

/**
 * Anything but a stored true is no, so a row without the flag grants nothing.
 */
function operatorOn(user: object): boolean {
  return (user as { operator?: unknown }).operator === true;
}

function asMerchantPerson(person: Person): MerchantPerson {
  if (person.merchant === null) throw new Error("dashboard_person_has_no_merchant");
  return person as MerchantPerson;
}

function asUnattachedPerson(person: Person): UnattachedPerson {
  if (person.merchant !== null) throw new Error("dashboard_person_has_a_merchant");
  return person as UnattachedPerson;
}

function claimFrom(value: string): LinkClaim | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return null;
    return claimOf(parsed as Record<string, unknown>);
  } catch {
    return null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A field holding a value outside its closed set means the row was not written
 * by this file, and it opens nothing; a field this file does not read is
 * passed over, so a link asked for before a release still opens after it.
 */
function claimOf(value: Record<string, unknown>): LinkClaim | null {
  if (typeof value.email !== "string" || value.email !== emailAs(value.email)) return null;
  const request = value.request ?? null;
  if (request !== null && (typeof request !== "string" || !UUID.test(request))) return null;
  const clickId = value.clickId === undefined ? undefined : clickIdOf(value.clickId);
  if (clickId === null) return null;
  const destination = value.destination;
  if (value.stepUp !== undefined) {
    // Only an operator's own session asks for one, for a page of the
    // workspace, with no click and no report request beside it.
    const page = adminDestinationIn(destination);
    if (value.stepUp !== true || page === null || clickId !== undefined || request !== null) {
      return null;
    }
    return { email: value.email, destination: page, request: null, stepUp: true };
  }
  if (typeof destination === "string") {
    const known = destinationNamed(destination);
    if (known === null) return null;
    return {
      email: value.email,
      destination: known,
      request,
      ...(clickId === undefined ? {} : { clickId }),
    };
  }
  // The scanner asks for report links, and no click travels with its request.
  if (clickId !== undefined) return null;
  if (typeof destination !== "object" || destination === null) return null;
  const keys = Object.keys(destination);
  const report = (destination as { report?: unknown }).report;
  if (keys.length !== 1 || typeof report !== "string" || !UUID.test(report)) return null;
  return { email: value.email, destination: { report }, request };
}

/** The identifier in the partner network's form, or null for anything else. */
function clickIdOf(value: unknown): string | null {
  return typeof value === "string" && PARTNER_CLICK_ID_PATTERN.test(value) ? value : null;
}

/**
 * The click a Google sign-in was started with, read back from where the
 * component kept it, or none where it holds anything this file would not have
 * written there.
 */
function clickIdIn(callback: URL): string | undefined {
  return clickIdOf(callback.searchParams.get("clickid")) ?? undefined;
}

/**
 * The registration's report, due at once since nothing about a new
 * registration is worth waiting for, and the store report waiting for the
 * merchant's first card with its own copy of the click.
 */
function adReportsOf(accountId: string, clickId: string): AdReport[] {
  const now = new Date();
  return [
    {
      accountId,
      event: "reg",
      clickId,
      state: "pending",
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
      eventAt: now,
    },
    {
      accountId,
      event: "store_connected",
      clickId,
      state: "waiting",
      attempts: 0,
      nextAttemptAt: null,
      createdAt: now,
      eventAt: null,
    },
  ];
}

function sameClaim(one: LinkClaim, other: LinkClaim): boolean {
  return (
    one.email === other.email &&
    one.request === other.request &&
    one.clickId === other.clickId &&
    one.stepUp === other.stepUp &&
    (typeof one.destination === "string" || typeof other.destination === "string"
      ? one.destination === other.destination
      : one.destination.report === other.destination.report)
  );
}

/**
 * A report link always goes, because its reports are being deleted. A dashboard
 * link goes with the person, and stays for a person who owns a merchant and is
 * kept.
 */
function goesWithTheDeletion(
  claim: LinkClaim | null,
  email: string,
  result: DeleteResult,
): boolean {
  return claim?.email === email && (typeof claim.destination !== "string" || result !== "retained");
}

/**
 * What a link is for, each counted apart: a sign-in from the public form, a
 * scanner's report, or an operator's fresh sign-in asked from the workspace.
 */
/** Forgetting an account clears its address's link sends by this same key. */
export const rateKey = (secret: string, email: string): string =>
  createHmac("sha256", secret).update(`dashboard-link:${email}`).digest("hex");

const clientKey = (secret: string, client: string): string =>
  createHmac("sha256", secret).update(`dashboard-link-client:${client}`).digest("hex");

/** Never a visitor's key, which is an address or a /64. */
const UNKNOWN_CLIENT = "unknown";

/** Whom a sign-in link is counted against besides its address, and how many it gets. */
type ClientCount = Readonly<{ hash: string; limit: number; wall: "client" | "shared" }>;

type LinkRefusal = Readonly<{ wall: LinkWall; retryAt: Date }>;

/**
 * Both arms carry the moment the address may ask again: for a refusal, the
 * limit that refused; for a send, the address's limit in front of the next
 * link, read from the rows the send just joined.
 */
type LinkRate =
  | Readonly<{ sent: true; retryAt: Date }>
  | Readonly<{ sent: false; wall: LinkWall; retryAt: Date }>;

/**
 * The sends of one purpose inside the rolling hour, oldest first: of this
 * address, of the client it is counted against (null for a report link, which
 * has none here), and of the whole channel. A list may stop at its limit's
 * length, which is all a limit reads.
 */
type CountedSends = Readonly<{
  address: readonly Date[];
  client: Readonly<{ sentAt: readonly Date[]; count: ClientCount }> | null;
  channel: readonly Date[];
}>;

/** When a full rolling hour lets one more link through; null while it has room. */
function hourFreesAt(sentAt: readonly Date[], limit: number): Date | null {
  if (sentAt.length < limit) return null;
  const firstCounted = sentAt[sentAt.length - limit];
  // Rows this cannot explain are refused loudly: standing aside quietly is how
  // a rate limit becomes no rate limit for one caller.
  if (firstCounted === undefined) throw new Error("dashboard_link_rate_count_inconsistent");
  return new Date(firstCounted.getTime() + LINK_RATE_WINDOW_MS);
}

/**
 * Three links an hour per address, and at least a minute between two. A request
 * the minute refuses writes no row, so the three are messages that actually
 * went out.
 *
 * The dashboard's answer names which limit, and its pages have a sentence for
 * each. The report answer crosses the scanner's contract, which carries only
 * the moment, so the scanner must say one sentence true of all of them and
 * must not guess the limit from how far away the moment is.
 */
function addressRefusal(sentAt: readonly Date[], now: Date): LinkRefusal | null {
  const newest = sentAt.at(-1);
  const interval =
    newest !== undefined && newest.getTime() > now.getTime() - LINK_MIN_INTERVAL_MS
      ? ({
          wall: "interval",
          retryAt: new Date(newest.getTime() + LINK_MIN_INTERVAL_MS),
        } as const)
      : null;
  const hourly = hourFreesAt(sentAt, LINK_RATE_LIMIT);
  return latestOf([interval, hourly === null ? null : { wall: "hourly", retryAt: hourly }]);
}

/**
 * When several limits stand, the answer names the latest: naming a nearer one
 * would send somebody back to a button that is still refused.
 */
function latestOf(refusals: readonly (LinkRefusal | null)[]): LinkRefusal | null {
  let latest: LinkRefusal | null = null;
  for (const refusal of refusals) {
    if (
      refusal !== null &&
      (latest === null || refusal.retryAt.getTime() >= latest.retryAt.getTime())
    )
      latest = refusal;
  }
  return latest;
}

function refusalIn(counted: CountedSends, now: Date): LinkRefusal | null {
  const client =
    counted.client === null ? null : hourFreesAt(counted.client.sentAt, counted.client.count.limit);
  const channel = hourFreesAt(counted.channel, LINK_CHANNEL_LIMIT);
  return latestOf([
    addressRefusal(counted.address, now),
    client === null || counted.client === null
      ? null
      : { wall: counted.client.count.wall, retryAt: client },
    channel === null ? null : { wall: "ceiling", retryAt: channel },
  ]);
}

/**
 * There is always a limit in front of the address's next link, since a send a
 * moment old raises the minute by itself; answering "no wait" would mean the
 * rows disagree with the send just written.
 */
function waitAfter(sentAt: readonly Date[], now: Date): Date {
  const next = addressRefusal(sentAt, now);
  if (next === null) throw new Error("dashboard_link_rate_interval_missing");
  return next.retryAt;
}

function memoryRate(
  rows: MemoryRows,
  emailHash: string,
  purpose: LinkPurpose,
  asking: ClientCount | null,
): LinkRate {
  const now = new Date();
  const all = (rows.dashboard_link_sends ?? []).filter(
    (row) => new Date(row.expiresAt as Date).getTime() > now.getTime(),
  );
  rows.dashboard_link_sends = all;
  const inTheHour = all
    .filter(
      (row) =>
        row.purpose === purpose &&
        new Date(row.sentAt as Date).getTime() > now.getTime() - LINK_RATE_WINDOW_MS,
    )
    .sort(
      (one, other) =>
        new Date(one.sentAt as Date).getTime() - new Date(other.sentAt as Date).getTime(),
    );
  const sentAt = (kept: readonly Record<string, unknown>[]) =>
    kept.map((row) => new Date(row.sentAt as Date));
  const address = sentAt(inTheHour.filter((row) => row.emailHash === emailHash));
  const refused = refusalIn(
    {
      address,
      client:
        asking === null
          ? null
          : {
              sentAt: sentAt(inTheHour.filter((row) => row.clientHash === asking.hash)),
              count: asking,
            },
      channel: sentAt(inTheHour),
    },
    now,
  );
  if (refused !== null) return { sent: false, ...refused };
  rows.dashboard_link_sends.push({
    id: randomUUID(),
    emailHash,
    clientHash: asking?.hash ?? null,
    purpose,
    sentAt: now,
    expiresAt: new Date(now.getTime() + LINK_SEND_RETENTION_MS),
  });
  return { sent: true, retryAt: waitAfter([...address, now], now) };
}

const CEILING_WORDS = { dashboard: "sign-in", report: "report", "step-up": "step-up" } as const;

/**
 * Writes one warning line when the channel's ceiling of a purpose first
 * refuses, and again only once a send of that purpose has gone through since,
 * so an alert can hang on it without counting refusals. Each process keeps its
 * own note, so every process writes its own line. The line names no address.
 */
function ceilingWatch(): (purpose: LinkPurpose, rated: LinkRate) => LinkRate {
  const full = new Set<LinkPurpose>();
  return (purpose, rated) => {
    if (rated.sent) {
      full.delete(purpose);
    } else if (rated.wall === "ceiling" && !full.has(purpose)) {
      full.add(purpose);
      const now = new Date();
      const from = new Date(now.getTime() - LINK_RATE_WINDOW_MS);
      console.warn(
        `[dashboard] link ceiling reached: purpose=${CEILING_WORDS[purpose]}` +
          ` limit=${LINK_CHANNEL_LIMIT} window=${from.toISOString()}/${now.toISOString()}` +
          ` refused_until=${rated.retryAt.toISOString()}`,
      );
    }
    return rated;
  };
}

/**
 * The address and the client are each counted under a lock of their own, so
 * two processes cannot both take the last link. The channel is counted without
 * one: a channel-wide lock would hold every sign-in behind whichever one is
 * waiting on the mail provider, so sends in flight at the same moment can pass
 * the ceiling by as many as there are of them.
 */
async function postgresRate(
  tx: DashboardTransaction,
  emailHash: string,
  purpose: LinkPurpose,
  asking: ClientCount | null,
): Promise<LinkRate> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - LINK_RATE_WINDOW_MS);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`dashboard-link-rate:${purpose}:${emailHash}`}, 0))`,
  );
  if (asking !== null) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`dashboard-link-client:${purpose}:${asking.hash}`}, 0))`,
    );
  }
  await tx.delete(linkSends).where(lte(linkSends.expiresAt, now));
  const newest = async (limit: number, ...where: SQL[]): Promise<Date[]> =>
    (
      await tx
        .select({ sentAt: linkSends.sentAt })
        .from(linkSends)
        .where(and(eq(linkSends.purpose, purpose), gt(linkSends.sentAt, cutoff), ...where))
        .orderBy(desc(linkSends.sentAt))
        .limit(limit)
    )
      .map((row) => row.sentAt)
      .reverse();
  const address = await newest(LINK_RATE_LIMIT, eq(linkSends.emailHash, emailHash));
  const refused = refusalIn(
    {
      address,
      client:
        asking === null
          ? null
          : {
              sentAt: await newest(asking.limit, eq(linkSends.clientHash, asking.hash)),
              count: asking,
            },
      channel: await newest(LINK_CHANNEL_LIMIT),
    },
    now,
  );
  if (refused !== null) return { sent: false, ...refused };
  await tx.insert(linkSends).values({
    id: randomUUID(),
    emailHash,
    clientHash: asking?.hash ?? null,
    purpose,
    sentAt: now,
    expiresAt: new Date(now.getTime() + LINK_SEND_RETENTION_MS),
  });
  return { sent: true, retryAt: waitAfter([...address, now], now) };
}

type DashboardTransaction = Parameters<Parameters<ReturnType<typeof drizzle>["transaction"]>[0]>[0];

async function lockEmail(tx: DashboardTransaction, email: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`dashboard-email:${email}`}, 0))`,
  );
}

function reportDigestKeyInMemory(rows: MemoryRows, now: Date): string {
  const secrets = (rows.dashboard_report_identity_secrets ?? []) as ReportIdentitySecretRow[];
  rows.dashboard_report_identity_secrets = secrets;
  const existing = secrets.find((row) => row.id === REPORT_DIGEST_KEY_ID);
  if (existing !== undefined) return existing.digestKey;
  const digestKey = randomBytes(32).toString("base64url");
  secrets.push({ id: REPORT_DIGEST_KEY_ID, digestKey, createdAt: now });
  return digestKey;
}

async function reportDigestKeyInPostgres(tx: DashboardTransaction, now: Date): Promise<string> {
  const existing = (
    await tx
      .select({ digestKey: reportIdentitySecrets.digestKey })
      .from(reportIdentitySecrets)
      .where(eq(reportIdentitySecrets.id, REPORT_DIGEST_KEY_ID))
  )[0];
  if (existing !== undefined) return existing.digestKey;

  await tx
    .insert(reportIdentitySecrets)
    .values({
      id: REPORT_DIGEST_KEY_ID,
      digestKey: randomBytes(32).toString("base64url"),
      createdAt: now,
    })
    .onConflictDoNothing();
  const stored = (
    await tx
      .select({ digestKey: reportIdentitySecrets.digestKey })
      .from(reportIdentitySecrets)
      .where(eq(reportIdentitySecrets.id, REPORT_DIGEST_KEY_ID))
  )[0];
  if (stored === undefined) throw new Error("dashboard_report_digest_key_missing");
  return stored.digestKey;
}

/**
 * A spent link's row is deleted by the component; an unpressed one keeps a
 * hashed token, an address and any ad click its claim carries, and this bounds
 * how long. Every request for a link runs it, in batches, so one request never
 * pays for a backlog.
 */
function cleanupOldLinksInMemory(rows: MemoryRows, now: Date): void {
  const cutoff = now.getTime() - LINK_PROOF_RETENTION_MS;
  let removed = 0;
  rows.dashboard_verifications = (rows.dashboard_verifications ?? []).filter((row) => {
    if (removed < LINK_CLEANUP_BATCH && new Date(row.expiresAt as Date).getTime() <= cutoff) {
      removed += 1;
      return false;
    }
    return true;
  });
}

async function cleanupOldLinksInPostgres(tx: DashboardTransaction, now: Date): Promise<void> {
  const old = await tx
    .select({ id: verifications.id })
    .from(verifications)
    .where(lte(verifications.expiresAt, new Date(now.getTime() - LINK_PROOF_RETENTION_MS)))
    .orderBy(asc(verifications.expiresAt), asc(verifications.id))
    .limit(LINK_CLEANUP_BATCH);
  for (const proof of old) {
    await tx.delete(verifications).where(eq(verifications.id, proof.id));
  }
}

const reportDeleteDigest = (secret: string, operationId: string, email: string): string =>
  createHmac("sha256", secret)
    .update(`report-delete\0${operationId}\0${email}`)
    .digest("base64url");

type DeleteResult = "deleted" | "already_absent" | "retained";

function deleteFromMemory(rows: MemoryRows, email: string): DeleteResult {
  const account = (rows.dashboard_accounts ?? []).find((row) => row.email === email);
  let result: DeleteResult;
  if (account === undefined) result = "already_absent";
  else {
    const person = personFrom(account as PersonRow);
    // An operator's account stays until its flag is removed, so the channel
    // cannot lose its operators this way.
    result = person.merchant === null && account.operator !== true ? "deleted" : "retained";
  }
  rows.dashboard_verifications = (rows.dashboard_verifications ?? []).filter(
    (proof) => !goesWithTheDeletion(claimFrom(String(proof.value)), email, result),
  );
  if (result === "deleted" && account !== undefined) {
    const personId = String(account.id);
    rows.dashboard_accounts = (rows.dashboard_accounts ?? []).filter((row) => row.id !== personId);
    rows.dashboard_sessions = (rows.dashboard_sessions ?? []).filter(
      (row) => row.userId !== personId,
    );
    rows.dashboard_credentials = (rows.dashboard_credentials ?? []).filter(
      (row) => row.userId !== personId,
    );
    rows.dashboard_woo_grants = (rows.dashboard_woo_grants ?? []).filter(
      (row) => row.accountId !== personId,
    );
    rows.dashboard_woo_orders = (rows.dashboard_woo_orders ?? []).filter(
      (row) => row.accountId !== personId,
    );
    rows.dashboard_woo_shops = (rows.dashboard_woo_shops ?? []).filter(
      (row) => row.accountId !== personId,
    );
    rows.dashboard_ad_reports = (rows.dashboard_ad_reports ?? []).filter(
      (row) => row.accountId !== personId,
    );
  }
  return result;
}

/** Refuses a second row for one account and event, as the table's primary key does. */
function registerInMemory(rows: MemoryRows, reports: readonly AdReport[]): void {
  const registered = rows.dashboard_ad_reports ?? [];
  rows.dashboard_ad_reports = registered;
  for (const report of reports) {
    if (
      registered.some((row) => row.accountId === report.accountId && row.event === report.event)
    ) {
      throw new Error("dashboard_ad_report_duplicate");
    }
  }
  for (const report of reports) registered.push({ lastOutcome: null, settledAt: null, ...report });
}

/**
 * The link an operator asks for from the workspace to confirm an action. It
 * signs in the browser it is opened in and returns there to the page it was
 * asked on, where the action is pressed again; it carries out nothing itself.
 */
function stepUpLinkMessage(to: string, link: string): Message {
  const title = "Confirm it is you";
  const lead =
    "An administrative action in the Agentify operator's workspace asked for a fresh sign-in." +
    " Open this link in the browser you are working in; it signs that browser in and returns" +
    " you to the page you were on, where you press the action again.";
  const lifetime =
    "This link opens once and expires an hour after it was sent. It changes nothing by itself.";
  const unasked =
    "If you did not ask for this, do not open the link: somebody may be using a session of" +
    " yours. Tell the other operators of this channel, who can end every session of your account.";
  return {
    to,
    subject: "Confirm an administrative action on Agentify",
    body: `Agentify\n\n${title}\n\n${lead}\n\n${link}\n\n${lifetime}\n\n${unasked}`,
    html: transactionalEmailHtml({
      preview: "Confirm the administrative action you were taking.",
      eyebrow: "Operator's workspace",
      title,
      lead,
      action: "Sign in and go back",
      link,
      paragraphs: [lifetime, unasked],
    }),
  };
}

function dashboardLinkMessage(to: string, link: string): Message {
  const title = "Open your dashboard";
  const lifetime =
    "This link opens once and expires an hour after it was sent. There is nothing here to keep:" +
    " the next time you sign in, ask for a new link.";
  const unasked =
    "If you did not ask for this, ignore the message. Opening the link only shows a page;" +
    " nothing happens unless the button on it is pressed.";
  return {
    to,
    subject: "Sign in to your Agentify dashboard",
    // The URL stands on a line of its own, so a client that draws no button and
    // a person copying it by hand both get the whole of it.
    body: `Agentify\n\n${title}\n\nSign in with this link:\n\n${link}\n\n${lifetime}\n\n${unasked}`,
    html: transactionalEmailHtml({
      preview: "Press the button to sign in to your dashboard.",
      eyebrow: "Dashboard sign-in",
      title,
      lead: "Press the button below to sign in to your dashboard.",
      action: "Open my dashboard",
      link,
      paragraphs: [lifetime, unasked],
    }),
  };
}
