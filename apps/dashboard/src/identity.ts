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
import { and, asc, desc, eq, gt, isNull, lte, type SQL, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import type { DashboardConfig } from "./config.js";
import {
  type AttachMerchantResult,
  DASHBOARD_DESTINATIONS,
  type DashboardDestination,
  type DashboardIdentity,
  type DashboardLinkResult,
  type GoogleFinishResult,
  type GoogleStartResult,
  type LinkDestination,
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

interface AccountSummary {
  readonly email: string;
  readonly createdAt: Date;
  readonly sessions: number;
  readonly merchant: string | null;
  readonly confirmed: boolean;
  readonly operator: boolean;
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
  endEverySessionFor(email: string): Promise<number>;
  /**
   * Sessions are left as they are: the flag is read on every session read, so
   * the next request already sees the change.
   */
  setOperator(email: string, operator: boolean): Promise<boolean>;
  /** For an announcement. */
  emailsNaming(merchantId: string): Promise<readonly string[]>;
  list(now: Date): Promise<readonly AccountSummary[]>;
  sendReportLink(request: SendReportLinkRequest): Promise<SendReportLinkResponse>;
  deleteUnattachedPerson(
    request: DeleteUnattachedPersonRequest,
  ): Promise<DeleteUnattachedPersonResponse>;
  close(): Promise<void>;
}

export const emailAs = (raw: string): string => raw.trim().toLowerCase();

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
}>;

type AdReport = typeof adReports.$inferInsert;

/**
 * What an opening transaction does that the component cannot: take the
 * address's lock, and write the registration's reports in the same
 * transaction.
 */
type OpeningTransaction = Readonly<{
  lockEmail?: (email: string) => Promise<void>;
  register: (reports: readonly AdReport[]) => Promise<void>;
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

class DeliveryRefused extends Error {}
class VerificationRefused extends Error {}
class GoogleTransactionRefused extends Error {}

type GoogleAdmission = {
  email: string | null;
  admit: (subject: string, email: string) => Promise<void>;
  /** Unknown until Google has named the address and it is admitted. */
  firstVerification?: boolean;
};

/**
 * What a Google callback's transaction does that the component cannot: take
 * the subject's and the address's locks, and write the registration's reports
 * in the same transaction.
 */
type GoogleTransaction = Readonly<{
  lockIdentity?: (subject: string, email: string) => Promise<void>;
  register: (reports: readonly AdReport[]) => Promise<void>;
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
  const reportsOf = (accountId: string, clickId: string): AdReport[] =>
    adReportsOf(accountId, clickId, config.storePostback);
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
          // Closed to input: only the terminal command writes it.
          operator: { type: "boolean", required: false, defaultValue: false, input: false },
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
              typeof claim.destination === "string"
                ? dashboardLinkMessage(email, action.toString())
                : reportLinkMessage(email, action.toString()),
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
  const clickToReport = async (
    context: Awaited<typeof auth.$context>,
    claim: LinkClaim,
  ): Promise<string | undefined> =>
    reporting && claim.clickId !== undefined && (await isFirstVerification(context, claim.email))
      ? claim.clickId
      : undefined;

  // The memory adapter is for deterministic tests and local work. Queueing its
  // transaction copies gives it all-or-nothing behaviour; PostgreSQL remains
  // the authority for concurrent row locking.
  let memoryTail: Promise<void> = Promise.resolve();
  const inMemoryTransaction = async <T>(
    work: (bound: typeof auth, rows: MemoryRows) => Promise<T>,
    forGoogle = false,
  ): Promise<T> => {
    const run = async (): Promise<T> => {
      const cloned = structuredClone(memoryRows);
      const result = await work(authFor(memoryAdapter(cloned), forGoogle), cloned);
      for (const key of new Set([...Object.keys(memoryRows), ...Object.keys(cloned)])) {
        if (cloned[key] === undefined) delete memoryRows[key];
        else memoryRows[key] = cloned[key];
      }
      return result;
    };
    const result = memoryTail.then(run, run);
    memoryTail = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  };

  const requestWith = async (
    bound: typeof auth,
    email: string,
    destination: DashboardDestination,
    clickId: string | undefined,
    retryAt: Date,
  ): Promise<LinkRequestResult> => {
    const active: LinkSend = {
      claim: { email, destination, request: null, ...(clickId === undefined ? {} : { clickId }) },
      handed: "refused",
    };
    await sending.run(active, async () => {
      await bound.api.signInMagicLink({
        headers: originHeaders,
        body: { email, metadata: active.claim },
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
    { lockEmail, register }: OpeningTransaction,
  ): Promise<DashboardLinkResult> => {
    if (!RAW_TOKEN.test(token)) return { status: "refused" };
    const context = await bound.$context;
    const stored = await context.adapter.findOne<StoredVerification>({
      model: "verification",
      where: [{ field: "identifier", value: tokenHash(token) }],
    });
    if (stored === null || new Date(stored.expiresAt).getTime() <= Date.now()) {
      return { status: "refused" };
    }
    const claim = claimFrom(stored.value);
    if (claim === null) return { status: "refused" };
    await lockEmail?.(claim.email);
    // Whether this press makes the address's first verified account has to be
    // read before the component verifies it. Under the address's lock, a second
    // press waits here and then finds the account the first one verified.
    const registering = await clickToReport(context, claim);

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
      if (isAPIError(thrown)) throw new VerificationRefused();
      throw thrown;
    }
    if (opened.response.user.email !== claim.email || opened.response.user.emailVerified !== true) {
      throw new VerificationRefused();
    }
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
      await register(reportsOf(opened.response.user.id, registering));
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
    { lockIdentity, register }: GoogleTransaction,
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
      const destination =
        DASHBOARD_DESTINATIONS.find((value) => value === redirected.searchParams.get("next")) ??
        "default";
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
        if (
          ![
            "google_email_unverified",
            "google_email_changed",
            "access_denied",
            "invalid_code",
            "state_not_found",
            "state_mismatch",
            "state_invalid",
            "no_code",
            "email_not_found",
            "unable_to_get_user_info",
            "account_not_linked",
          ].includes(error)
        ) {
          throw new GoogleTransactionRefused();
        }
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
        throw new GoogleTransactionRefused();
      }
      if (clickId !== undefined && active.firstVerification === true) {
        await register(reportsOf(opened.user.id, clickId));
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

  return {
    cookieNames: [
      cookies.sessionToken.name,
      cookies.sessionData.name,
      cookies.dontRememberToken.name,
      googleStateCookie,
    ],
    googleEnabled: config.google !== null,

    async startGoogle(destination, clickId) {
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
        return { status: "unavailable" };
      }
    },

    async finishGoogle(query, cookie) {
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
        if (values.length > 1)
          return {
            status: "refused",
            reason: "invalid",
            email: null,
            destination: "default",
            setCookies: [],
          };
        if (values[0] !== undefined) proof.set(key, values[0]);
      }
      // The lock and the OAuth component must consume one identical proof.
      // Choosing different occurrences of a repeated state bypasses serialization.
      if (!proof.get("state") || Boolean(proof.get("code")) === Boolean(proof.get("error"))) {
        return {
          status: "refused",
          reason: "invalid",
          email: null,
          destination: "default",
          setCookies: [],
        };
      }
      try {
        if (parts.pool === undefined) {
          return await inMemoryTransaction(
            async (bound, rows) =>
              await finishGoogleWith(bound, proof, cookie, {
                register: async (reports) => registerInMemory(rows, reports),
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
            if (lock.rows[0]?.acquired !== true)
              return {
                status: "refused",
                reason: "invalid",
                email: null,
                destination: "default",
                setCookies: [],
              };
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
            },
          );
        });
      } catch {
        return {
          status: "refused",
          reason: "unavailable",
          email: null,
          destination: "default",
          setCookies: [],
        };
      }
    },

    // The sweep of old links runs in a transaction of its own, first: inside
    // the one that waits on the mail provider it would hold other requests up
    // behind a send, and a refused send would undo it.
    async requestLink(rawEmail, destination, { client, clickId }) {
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
      try {
        if (parts.pool === undefined) {
          await inMemoryTransaction(async (_bound, rows) => {
            cleanupOldLinksInMemory(rows, new Date());
          });
          return await inMemoryTransaction(async (bound, rows) => {
            const rated = watchCeiling(
              "dashboard",
              memoryRate(rows, rateKey(config.authSecret, email), "dashboard", asking),
            );
            if (!rated.sent)
              return { status: "cooldown", wall: rated.wall, retryAt: rated.retryAt };
            return await requestWith(bound, email, destination, clickId, rated.retryAt);
          });
        }
        const db = drizzle(parts.pool, {
          schema: { accounts, credentials, linkSends, sessions, verifications },
        });
        await db.transaction(async (tx) => {
          await cleanupOldLinksInPostgres(tx, new Date());
        });
        return await db.transaction(async (tx) => {
          await lockEmail(tx, email);
          const rated = watchCeiling(
            "dashboard",
            await postgresRate(tx, rateKey(config.authSecret, email), "dashboard", asking),
          );
          if (!rated.sent) return { status: "cooldown", wall: rated.wall, retryAt: rated.retryAt };
          return await requestWith(
            authFor(drizzleAdapter(tx, { provider: "pg", schema })),
            email,
            destination,
            clickId,
            rated.retryAt,
          );
        });
      } catch (thrown) {
        if (thrown instanceof DeliveryRefused) return { status: "unavailable" };
        throw thrown;
      }
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
      try {
        if (parts.pool === undefined) {
          return await inMemoryTransaction(
            async (bound, rows) =>
              await openWith(bound, token, {
                register: async (reports) => registerInMemory(rows, reports),
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
          });
        });
      } catch (thrown) {
        if (thrown instanceof VerificationRefused) return { status: "refused" };
        throw thrown;
      }
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
          row === undefined ? "already_absent" : row.merchantId === null ? "deleted" : "retained";
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

    async endEverySessionFor(email) {
      const context = await contextOf();
      const found = await context.internalAdapter.findUserByEmail(emailAs(email));
      if (found === null) return 0;
      const open = await context.internalAdapter.listSessions(found.user.id);
      await context.internalAdapter.deleteUserSessions(found.user.id);
      return open.length;
    },

    async setOperator(email, operator) {
      const written = await (await contextOf()).adapter.update<{ operator?: unknown }>({
        model: "user",
        where: [{ field: "email", value: emailAs(email) }],
        update: { operator },
      });
      return written !== null && written !== undefined;
    },

    async emailsNaming(merchantId) {
      const people = await (await contextOf()).adapter.findMany<{ email: string }>({
        model: "user",
        where: [{ field: "merchantId", value: merchantId }],
      });
      return people.map((person) => person.email);
    },

    async endOtherSessionsOfMerchant(merchantId, keep) {
      // Read without renewing: this is not the pressing person's visit, and a
      // renewal would move their session's end while the cookie lines saying so
      // are thrown away.
      const kept = new Set((await liveOnesIn(keep, false)).map((one) => one.token));
      const people = await (await contextOf()).adapter.findMany<{ id: string }>({
        model: "user",
        where: [{ field: "merchantId", value: merchantId }],
      });
      let ended = 0;
      for (const person of people) {
        ended += await endLiveSessionsOf(person.id, kept);
      }
      return ended;
    },

    async endOtherSessionsOfPerson(personId, keep) {
      // Read without renewing, as above.
      const kept = new Set((await liveOnesIn(keep, false)).map((one) => one.token));
      return await endLiveSessionsOf(personId, kept);
    },

    async list(now) {
      const context = await contextOf();
      const everybody = await context.internalAdapter.listUsers();
      const rows: AccountSummary[] = [];
      for (const one of everybody) {
        const person = personFrom(one as PersonRow);
        const open = await context.internalAdapter.listSessions(person.id);
        rows.push({
          email: person.email,
          createdAt: (one as { createdAt: Date }).createdAt,
          sessions: open.filter((session) => session.expiresAt > now).length,
          merchant: person.merchant?.id ?? null,
          confirmed: person.confirmed,
          operator: operatorOn(one),
        });
      }
      return rows.sort((one, other) => one.email.localeCompare(other.email));
    },

    async close() {
      await parts.pool?.end();
    },
  };
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
  if (typeof destination === "string") {
    const known = DASHBOARD_DESTINATIONS.find((one) => one === destination);
    if (known === undefined) return null;
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
 * registration is worth waiting for, and, where the store report is switched
 * on, that report waiting for the merchant's first card with its own copy of
 * the click.
 */
function adReportsOf(accountId: string, clickId: string, storeReported: boolean): AdReport[] {
  const now = new Date();
  const registration: AdReport = {
    accountId,
    event: "reg",
    clickId,
    state: "pending",
    attempts: 0,
    nextAttemptAt: now,
    createdAt: now,
    eventAt: now,
  };
  if (!storeReported) return [registration];
  return [
    registration,
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

/** `pnpm forget` clears an address's link sends by this same key. */
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
  purpose: "dashboard" | "report",
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

const CEILING_WORDS = { dashboard: "sign-in", report: "report" } as const;

/**
 * Writes one warning line when the channel's ceiling of a purpose first
 * refuses, and again only once a send of that purpose has gone through since,
 * so an alert can hang on it without counting refusals. Each process keeps its
 * own note, so every process writes its own line. The line names no address.
 */
function ceilingWatch(): (purpose: "dashboard" | "report", rated: LinkRate) => LinkRate {
  const full = new Set<"dashboard" | "report">();
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
  purpose: "dashboard" | "report",
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
    result = person.merchant === null ? "deleted" : "retained";
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
