/**
 * Cabinet identity behind one emailed-link door, for the whole site.
 *
 * Better Auth owns token consumption, people and sessions. Its generated HTTP
 * routes stay unmounted: the cabinet sends every link itself, the ones the
 * scanner asks for included, and calls the component only from the same-origin
 * POST owned by the SSR server. Production verification runs on a
 * transaction-bound Drizzle adapter; the deterministic memory store runs the
 * same component against an isolated transaction copy.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
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
import { APIError } from "better-auth/api";
import { getCookies } from "better-auth/cookies";
import { magicLink } from "better-auth/plugins/magic-link";
import { and, asc, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import type {
  AccountMerchant,
  AttachMerchantResult,
  CabinetDestination,
  CabinetIdentity,
  CabinetLinkResult,
  LinkDestination,
  LinkRequestResult,
  LinkWall,
  LiveSession,
  MerchantPerson,
  Person,
  UnattachedPerson,
} from "./cabinet-entry.js";
import type { CabinetConfig } from "./config.js";
import { type Message, type Postman, postmanFor } from "./mail.js";
import { transactionalEmailHtml } from "./mail-template.js";
import { reportLinkMessage } from "./report-mail.js";
import {
  accounts,
  credentials,
  linkSends,
  reportDeletionTombstones,
  reportIdentitySecrets,
  sessions,
  verifications,
} from "./schema.js";

export type {
  AccountMerchant,
  AttachMerchantResult,
  CabinetDestination,
  CabinetIdentity,
  CabinetLinkResult,
  LinkDestination,
  LinkRequestResult,
  LiveSession,
  MerchantKeyReplacement,
  MerchantPerson,
  Person,
  UnattachedPerson,
} from "./cabinet-entry.js";

export interface AccountSummary {
  readonly email: string;
  readonly createdAt: Date;
  readonly sessions: number;
  readonly merchant: string | null;
  readonly confirmed: boolean;
  readonly operator: boolean;
}

/** Operator-only operations kept out of the page-facing identity port. */
export interface Identity extends CabinetIdentity {
  make(email: string, merchant: AccountMerchant): Promise<Person | null>;
  byEmail(email: string): Promise<Person | null>;
  byId(personId: string): Promise<Person | null>;
  endEverySessionFor(email: string): Promise<number>;
  /**
   * Sets or clears the operator flag on the account at this address, and says
   * whether there was one. Sessions are left as they are: the flag is read on
   * every reading of a session, so the next request already sees the move.
   */
  setOperator(email: string, operator: boolean): Promise<boolean>;
  /** The addresses of every account naming this merchant, for an announcement. */
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
 * How long a session lasts from the last visit (ADR-0009 §6).
 *
 * Thirty days, and sliding: a person who keeps coming back does not meet the
 * sign-in form again. A short session is not what protects the money; the wait
 * on a wallet change is (ADR-0019).
 */
export const SESSION_DAYS = 30;
/**
 * How often a visit moves a session's end, at most.
 *
 * Once a day rather than on every request, so a click is not a write to the
 * sessions table, and the cookie handed back on that visit carries the new end.
 */
const SESSION_RENEWAL_SECONDS = 24 * 60 * 60;
export const LINK_TTL_SECONDS = 60 * 60;
export const LINK_RATE_WINDOW_MS = 60 * 60 * 1000;
export const LINK_RATE_LIMIT = 3;
export const LINK_MIN_INTERVAL_MS = 60 * 1000;
export const LINK_SEND_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a link's hashed row is kept once it has run out, then removed. */
export const LINK_PROOF_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
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
 * What a link's token was asked for, recorded with the token and read only
 * from there: the address, where the link leads, and the scanner's request it
 * was asked for, if any (ADR-0026 §1, §2). Nothing in the link itself is ever
 * read as any of these.
 */
type LinkClaim = Readonly<{
  email: string;
  destination: LinkDestination;
  request: string | null;
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
  cabinet_accounts: accounts,
  cabinet_sessions: sessions,
  cabinet_credentials: credentials,
  cabinet_verifications: verifications,
};

class DeliveryRefused extends Error {}
class VerificationRefused extends Error {}

/** How a one-time token is written at rest, the way the component hashes it. */
const tokenHash = (token: string): string => createHash("sha256").update(token).digest("base64url");

export function identityFor(config: CabinetConfig, parts: IdentityParts = {}): Identity {
  const postman = parts.postman ?? postmanFor(config);
  const base = `${config.publicBaseUrl}${config.basePath}`;
  const originHeaders = new Headers({ origin: new URL(config.publicBaseUrl).origin });
  const sending = new AsyncLocalStorage<LinkSend>();
  const memoryRows =
    parts.rows ??
    ({
      cabinet_accounts: [],
      cabinet_sessions: [],
      cabinet_credentials: [],
      cabinet_verifications: [],
      cabinet_link_sends: [],
      cabinet_report_identity_secrets: [],
      cabinet_report_deletion_tombstones: [],
    } satisfies MemoryRows);

  const optionsFor = (database: BetterAuthOptions["database"]) =>
    ({
      baseURL: base,
      secret: config.authSecret,
      telemetry: { enabled: false },
      database,
      user: {
        modelName: "cabinet_accounts",
        additionalFields: {
          merchantId: { type: "string", required: false, input: false },
          merchantKey: { type: "string", required: false, input: false },
          // Whether this person may read the operator's dashboard (ADR-0026
          // §6). Closed to input like the merchant: only the terminal's
          // command writes it.
          operator: { type: "boolean", required: false, defaultValue: false, input: false },
        },
      },
      session: {
        modelName: "cabinet_sessions",
        expiresIn: SESSION_DAYS * 24 * 60 * 60,
        updateAge: SESSION_RENEWAL_SECONDS,
        additionalFields: {
          // The scanner's request the link that opened this session was asked
          // for, which the answer to whose session a cookie is names so the
          // scanner can finish that request and no other (ADR-0026 §2).
          reportRequest: { type: "string", required: false, input: false },
        },
      },
      account: { modelName: "cabinet_credentials" },
      verification: { modelName: "cabinet_verifications" },
      advanced: {
        cookiePrefix: "agentify",
        // The prefix is chosen here and not by the component. Left to itself it
        // puts `__Secure-` in front of every name on an https base, and what
        // ADR-0009 §6 asks for is `__Host-`: the one a browser refuses unless
        // the cookie is Secure, for the whole origin and names no Domain, which
        // is what keeps a sibling host from planting or replacing a session.
        useSecureCookies: false,
        cookies: { session_token: { name: sessionCookieName(config.cookieSecure) } },
        defaultCookieAttributes: {
          path: "/",
          sameSite: "lax",
          httpOnly: true,
          secure: config.cookieSecure,
        },
      },
      plugins: [
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
              throw new Error("cabinet_link_claim_missing");
            }
            const stored = await context?.context.adapter.update<StoredVerification>({
              model: "verification",
              where: [{ field: "identifier", value: tokenHash(token) }],
              update: { value: JSON.stringify(claim) },
            });
            if (stored === null || stored === undefined) {
              throw new Error("cabinet_link_storage_missing");
            }
            // Every link lands on the cabinet's page with one control, whoever
            // asked for it; only the token rides in it (ADR-0026 §1).
            const action = new URL(`${base}/sign-in/open`);
            action.searchParams.set("token", token);
            active.handed = await postman(
              typeof claim.destination === "string"
                ? cabinetLinkMessage(email, action.toString())
                : reportLinkMessage(email, action.toString()),
            );
          },
        }),
      ],
    }) satisfies BetterAuthOptions;

  const authFor = (database: BetterAuthOptions["database"]) => betterAuth(optionsFor(database));
  const rootDatabase =
    parts.pool === undefined
      ? memoryAdapter(memoryRows)
      : drizzleAdapter(drizzle(parts.pool), { provider: "pg", schema });
  const auth = authFor(rootDatabase);
  const cookies = getCookies(optionsFor(rootDatabase));
  const sessionCookie = cookies.sessionToken.name;

  // The memory adapter is for deterministic tests and local work. Queueing its
  // transaction copies gives it all-or-nothing behavior; PostgreSQL remains the
  // authority for concurrent row locking.
  let memoryTail: Promise<void> = Promise.resolve();
  const inMemoryTransaction = async <T>(
    work: (bound: typeof auth, rows: MemoryRows) => Promise<T>,
  ): Promise<T> => {
    const run = async (): Promise<T> => {
      const cloned = structuredClone(memoryRows);
      const result = await work(authFor(memoryAdapter(cloned)), cloned);
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
    destination: CabinetDestination,
    retryAt: Date,
  ): Promise<LinkRequestResult> => {
    const active: LinkSend = {
      claim: { email, destination, request: null },
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
    lockEmail?: (email: string) => Promise<void>,
  ): Promise<CabinetLinkResult> => {
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
      if (thrown instanceof APIError) throw new VerificationRefused();
      throw thrown;
    }
    if (opened.response.user.email !== claim.email || opened.response.user.emailVerified !== true) {
      throw new VerificationRefused();
    }
    if (claim.request !== null) {
      // In the same transaction as the session itself: a session that opened
      // without the request it was asked for would leave that request waiting
      // for a visit that can never finish it.
      await context.internalAdapter.updateSession(opened.response.token, {
        reportRequest: claim.request,
      });
    }
    return {
      status: "opened",
      person: personFrom(opened.response.user),
      destination: claim.destination,
      setCookies: opened.headers.getSetCookie(),
    };
  };

  const makeWith = async (
    bound: typeof auth,
    email: string,
    merchant: AccountMerchant,
  ): Promise<Person | null> => {
    const context = await bound.$context;
    if ((await context.internalAdapter.findUserByEmail(email)) !== null) return null;
    const made = await context.internalAdapter.createUser(
      {
        email,
        emailVerified: false,
        name: "",
        merchantId: merchant.id,
        merchantKey: merchant.key,
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
   * Every live session among the values a request carries, each with the lines
   * that renew its cookie when this reading moved its end.
   *
   * The component moves a session's end at most once a day and says so with a
   * cookie of its own; a reader that dropped that line would extend the row and
   * leave the browser holding a cookie that still expires thirty days after
   * sign-in. A value whose session is dead answers with a line clearing the
   * cookie, and that line is dropped here: it names the same cookie the live
   * value sits under, so passing it on would sign the person out.
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

  return {
    cookieNames: [
      cookies.sessionToken.name,
      cookies.sessionData.name,
      cookies.dontRememberToken.name,
    ],

    async requestLink(rawEmail, destination) {
      const email = emailAs(rawEmail);
      try {
        if (parts.pool === undefined) {
          return await inMemoryTransaction(async (bound, rows) => {
            const rated = memoryRate(rows, rateKey(config.authSecret, email), "cabinet");
            if (!rated.sent)
              return { status: "cooldown", wall: rated.wall, retryAt: rated.retryAt };
            return await requestWith(bound, email, destination, rated.retryAt);
          });
        }
        const db = drizzle(parts.pool, {
          schema: { accounts, credentials, linkSends, sessions, verifications },
        });
        return await db.transaction(async (tx) => {
          await lockEmail(tx, email);
          const rated = await postgresRate(tx, rateKey(config.authSecret, email), "cabinet");
          if (!rated.sent) return { status: "cooldown", wall: rated.wall, retryAt: rated.retryAt };
          return await requestWith(
            authFor(drizzleAdapter(tx, { provider: "pg", schema })),
            email,
            destination,
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
            const rated = memoryRate(rows, rateKey(digestKey, request.email), "report");
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
          const rated = await postgresRate(tx, rateKey(digestKey, request.email), "report");
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

    async addressOfLink(token) {
      if (!RAW_TOKEN.test(token)) return null;
      const stored = await (await contextOf()).adapter.findOne<StoredVerification>({
        model: "verification",
        where: [{ field: "identifier", value: tokenHash(token) }],
      });
      if (stored === null || new Date(stored.expiresAt).getTime() <= Date.now()) return null;
      return claimFrom(stored.value)?.email ?? null;
    },

    async openLink(token) {
      try {
        if (parts.pool === undefined) {
          return await inMemoryTransaction(async (bound) => await openWith(bound, token));
        }
        const db = drizzle(parts.pool);
        return await db.transaction(async (tx) => {
          const bound = authFor(drizzleAdapter(tx, { provider: "pg", schema }));
          return await openWith(bound, token, async (email) => {
            await tx.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${`cabinet-email:${email}`}, 0))`,
            );
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
          const prior = (rows.cabinet_report_deletion_tombstones ?? []).find(
            (row) => row.operationId === request.operation_id,
          ) as { operationDigest: string; result: DeleteResult } | undefined;
          if (prior !== undefined) {
            return prior.operationDigest === operationDigest
              ? { status: prior.result }
              : { status: "refused" };
          }
          cleanupOldLinksInMemory(rows, now);
          const result = deleteFromMemory(rows, request.email);
          const tombstones = rows.cabinet_report_deletion_tombstones ?? [];
          rows.cabinet_report_deletion_tombstones = tombstones;
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
          sql`select pg_advisory_xact_lock(hashtextextended(${`cabinet-report-delete:${request.operation_id}`}, 0))`,
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
            sql`select pg_advisory_xact_lock(hashtextextended(${`cabinet-person:${candidate.id}`}, 0))`,
          );
        }
        const row = (
          await tx.select().from(accounts).where(eq(accounts.email, request.email)).for("update")
        )[0];
        const result: DeleteResult =
          row === undefined
            ? "already_absent"
            : row.merchantId === null && row.merchantKey === null
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
          setCookies: first.setCookies,
        };
      }
      for (const one of live) await endSession(one.token);
      console.log(
        `[cabinet] a request carried live sessions of ${owners.size} different people;` +
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
          const row = rows.cabinet_accounts?.find((one) => one.id === personId);
          if (row === undefined) return { status: "person-missing" };
          const person = personFrom(row as PersonRow);
          if (person.merchant !== null) {
            return { status: "already-attached", person: asMerchantPerson(person) };
          }
          const merchant = await register();
          if (merchant === null) {
            return { status: "unavailable", person: asUnattachedPerson(person) };
          }
          row.merchantId = merchant.id;
          row.merchantKey = merchant.key;
          row.updatedAt = new Date();
          return {
            status: "attached",
            person: asMerchantPerson({ ...person, merchant }),
          };
        });
      }

      const db = drizzle(parts.pool, { schema: { accounts } });
      return await db.transaction(async (tx): Promise<AttachMerchantResult> => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`cabinet-person:${personId}`}, 0))`,
        );
        const row = (
          await tx.execute<PersonRow>(sql`
            select id, email, email_verified as "emailVerified", merchant_id as "merchantId",
                   merchant_key as "merchantKey"
            from cabinet_accounts where id = ${personId} for update
          `)
        ).rows[0];
        if (row === undefined) return { status: "person-missing" };
        const person = personFrom(row);
        if (person.merchant !== null) {
          return { status: "already-attached", person: asMerchantPerson(person) };
        }
        const merchant = await register();
        if (merchant === null) {
          return { status: "unavailable", person: asUnattachedPerson(person) };
        }
        const written = await tx
          .update(accounts)
          .set({ merchantId: merchant.id, merchantKey: merchant.key, updatedAt: new Date() })
          .where(
            and(
              eq(accounts.id, personId),
              isNull(accounts.merchantId),
              isNull(accounts.merchantKey),
            ),
          )
          .returning({ id: accounts.id });
        if (written.length !== 1) throw new Error("cabinet_merchant_attachment_lost_lock");
        return {
          status: "attached",
          person: asMerchantPerson({ ...person, merchant }),
        };
      });
    },

    async replaceMerchantKey(personId, expected, fresh) {
      try {
        const written = await (await contextOf()).adapter.update<{ merchantKey?: unknown }>({
          model: "user",
          where: [
            { field: "id", value: personId },
            { field: "merchantKey", value: expected },
          ],
          update: { merchantKey: fresh },
        });
        return written?.merchantKey === fresh ? "replaced" : "not-matched";
      } catch {
        // A connection can fail after PostgreSQL commits the update. The caller
        // must keep both keys when it cannot know which one the row holds.
        console.error(
          "[cabinet] the database could not establish whether a fresh gateway key was written",
        );
        return "unknown";
      }
    },

    async make(rawEmail, merchant) {
      const email = emailAs(rawEmail);
      if (parts.pool === undefined) {
        return await inMemoryTransaction(async (bound) => await makeWith(bound, email, merchant));
      }
      const db = drizzle(parts.pool);
      return await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`cabinet-email:${email}`}, 0))`,
        );
        return await makeWith(
          authFor(drizzleAdapter(tx, { provider: "pg", schema })),
          email,
          merchant,
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
      // renewal here would move their session's end in the database while the
      // cookie lines that tell their browser so are thrown away.
      const kept = new Set((await liveOnesIn(keep, false)).map((one) => one.token));
      const context = await contextOf();
      const people = await context.adapter.findMany<{ id: string }>({
        model: "user",
        where: [{ field: "merchantId", value: merchantId }],
      });
      let ended = 0;
      for (const person of people) {
        for (const session of await context.internalAdapter.listSessions(person.id)) {
          if (!kept.has(session.token)) {
            await endSession(session.token);
            ended += 1;
          }
        }
      }
      return ended;
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
  merchantKey?: unknown;
};

function personFrom(user: PersonRow): Person {
  const idAbsent = user.merchantId === null || user.merchantId === undefined;
  const keyAbsent = user.merchantKey === null || user.merchantKey === undefined;
  if (idAbsent && keyAbsent) {
    return {
      id: user.id,
      email: user.email,
      confirmed: user.emailVerified === true,
      merchant: null,
    };
  }
  if (
    idAbsent !== keyAbsent ||
    typeof user.merchantId !== "string" ||
    typeof user.merchantKey !== "string" ||
    user.merchantId === "" ||
    user.merchantKey === ""
  ) {
    throw new Error("cabinet_account_partial_merchant_binding");
  }
  return {
    id: user.id,
    email: user.email,
    confirmed: user.emailVerified === true,
    merchant: { id: user.merchantId, key: user.merchantKey },
  };
}

/**
 * Whether a row the component read carries the operator flag. Anything but a
 * stored true is no, so a row that predates the flag or lost it grants nothing.
 */
function operatorOn(user: object): boolean {
  return (user as { operator?: unknown }).operator === true;
}

function asMerchantPerson(person: Person): MerchantPerson {
  if (person.merchant === null) throw new Error("cabinet_person_has_no_merchant");
  return person as MerchantPerson;
}

function asUnattachedPerson(person: Person): UnattachedPerson {
  if (person.merchant !== null) throw new Error("cabinet_person_has_a_merchant");
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
 * A claim read back, held to the closed set it was written from.
 *
 * A destination is one of the cabinet's three screens or the report of one
 * named scan, and a request is the scanner's identifier or nothing. A row
 * holding anything else was not written by this file and opens nothing.
 */
function claimOf(value: Record<string, unknown>): LinkClaim | null {
  if (typeof value.email !== "string" || value.email !== emailAs(value.email)) return null;
  const request = value.request ?? null;
  if (request !== null && (typeof request !== "string" || !UUID.test(request))) return null;
  const destination = value.destination;
  if (destination === "default" || destination === "settings" || destination === "woocommerce") {
    return { email: value.email, destination, request };
  }
  if (typeof destination !== "object" || destination === null) return null;
  const keys = Object.keys(destination);
  const report = (destination as { report?: unknown }).report;
  if (keys.length !== 1 || typeof report !== "string" || !UUID.test(report)) return null;
  return { email: value.email, destination: { report }, request };
}

function sameClaim(one: LinkClaim, other: LinkClaim): boolean {
  return (
    one.email === other.email &&
    one.request === other.request &&
    (typeof one.destination === "string" || typeof other.destination === "string"
      ? one.destination === other.destination
      : one.destination.report === other.destination.report)
  );
}

/**
 * Whether a link still in somebody's mailbox goes when their address is
 * deleted at the scanner.
 *
 * A link to a report always goes, because the reports it led to are being
 * deleted. A link into the cabinet goes with the person, and stays for a
 * person who owns a merchant and is kept.
 */
function goesWithTheDeletion(
  claim: LinkClaim | null,
  email: string,
  result: DeleteResult,
): boolean {
  return claim?.email === email && (typeof claim.destination !== "string" || result !== "retained");
}

const rateKey = (secret: string, email: string): string =>
  createHmac("sha256", secret).update(`cabinet-link:${email}`).digest("hex");

type LinkRefusal = Readonly<{ wall: LinkWall; retryAt: Date }>;

/**
 * What the rate rows say about a request: refused, or written down.
 *
 * Both arms carry the moment this address may ask again. For a refusal it is
 * the wall that refused; for a send it is the wall in front of the next link,
 * read off the rows the send has just joined. They are the same computation
 * over the same rows, one moment apart, which is why a screen can be told the
 * wait after an accepted link without the door guessing at it.
 */
type LinkRate =
  | Readonly<{ sent: true; retryAt: Date }>
  | Readonly<{ sent: false; wall: LinkWall; retryAt: Date }>;

/**
 * The two walls in front of a link, read off the sends this address already
 * has, oldest first.
 *
 * The hour is the outer wall: three links to one address, and the fourth waits
 * for the oldest of the three to fall out of the window. The minute is the
 * inner one, and it is what keeps the hour from being spent in five seconds by
 * somebody who has simply not looked in their mailbox yet. A request the
 * minute refuses is not a send and costs nothing — the caller writes no row
 * for it — so the three an hour are three messages that actually went out.
 *
 * Both walls can stand at once, and then the one the answer names is the one
 * that is still there when the other has gone: the later of the two. A page
 * that named the nearer wall would send somebody back to press a button that
 * is still refused, which is the kind of claim ADR-0026's door exists to keep
 * off the screen.
 *
 * Both doors stand on this, the cabinet's and the report's, because both count
 * the same rows. They do not say the same thing about it. The cabinet's own
 * pages are ours to write, so its answer names the wall and the screen has a
 * sentence for each. The report answer crosses a contract the scanner reads,
 * and that contract carries the moment and no wall — so the scanner cannot
 * tell the minute from the hour and must say one sentence that is true of
 * both: come back at this time. Widening the contract to carry the wall is a
 * change to somebody else's reader and is not worth it for a difference in
 * wording; what must not happen is the scanner guessing which wall it was from
 * how far away the moment is.
 */
function refusalIn(sentAt: readonly Date[], now: Date): LinkRefusal | null {
  const newest = sentAt.at(-1);
  const interval =
    newest !== undefined && newest.getTime() > now.getTime() - LINK_MIN_INTERVAL_MS
      ? ({
          wall: "interval",
          retryAt: new Date(newest.getTime() + LINK_MIN_INTERVAL_MS),
        } as const)
      : null;
  let hourly: LinkRefusal | null = null;
  if (sentAt.length >= LINK_RATE_LIMIT) {
    const firstCounted = sentAt[sentAt.length - LINK_RATE_LIMIT];
    // A list long enough to have spent the allowance and no send at the index
    // that proves it is a list this function cannot read. Nothing reaches this
    // today, and the direction is what the line is for: a wall that meets
    // something it cannot explain refuses loudly rather than standing aside
    // quietly, which is how a rate limit becomes no rate limit for one caller.
    if (firstCounted === undefined) throw new Error("cabinet_link_rate_count_inconsistent");
    hourly = { wall: "hourly", retryAt: new Date(firstCounted.getTime() + LINK_RATE_WINDOW_MS) };
  }
  if (interval === null) return hourly;
  if (hourly === null) return interval;
  return hourly.retryAt.getTime() >= interval.retryAt.getTime() ? hourly : interval;
}

/**
 * The wait a send just written leaves in front of the next link.
 *
 * It is the same reading of the same rows, with this send among them: the
 * minute the door keeps between two links, or the rest of the hour when this
 * was the third. There is always a wall — a send a moment old raises the
 * interval by itself — so nothing here can answer "no wait", and if it does
 * the rows disagree with the send that was just written.
 */
function waitAfter(sentAt: readonly Date[], now: Date): Date {
  const next = refusalIn(sentAt, now);
  if (next === null) throw new Error("cabinet_link_rate_interval_missing");
  return next.retryAt;
}

function memoryRate(rows: MemoryRows, emailHash: string, purpose: "cabinet" | "report"): LinkRate {
  const now = new Date();
  const all = (rows.cabinet_link_sends ?? []).filter(
    (row) => new Date(row.expiresAt as Date).getTime() > now.getTime(),
  );
  rows.cabinet_link_sends = all;
  const recent = all
    .filter(
      (row) =>
        row.emailHash === emailHash &&
        row.purpose === purpose &&
        new Date(row.sentAt as Date).getTime() > now.getTime() - LINK_RATE_WINDOW_MS,
    )
    .map((row) => new Date(row.sentAt as Date))
    .sort((one, other) => one.getTime() - other.getTime());
  const refused = refusalIn(recent, now);
  if (refused !== null) return { sent: false, ...refused };
  rows.cabinet_link_sends.push({
    id: randomUUID(),
    emailHash,
    purpose,
    sentAt: now,
    expiresAt: new Date(now.getTime() + LINK_SEND_RETENTION_MS),
  });
  return { sent: true, retryAt: waitAfter([...recent, now], now) };
}

async function postgresRate(
  tx: Parameters<Parameters<ReturnType<typeof drizzle>["transaction"]>[0]>[0],
  emailHash: string,
  purpose: "cabinet" | "report",
): Promise<LinkRate> {
  const now = new Date();
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`cabinet-link-rate:${purpose}:${emailHash}`}, 0))`,
  );
  await tx.delete(linkSends).where(lte(linkSends.expiresAt, now));
  const recent = await tx
    .select({ sentAt: linkSends.sentAt })
    .from(linkSends)
    .where(
      and(
        eq(linkSends.emailHash, emailHash),
        eq(linkSends.purpose, purpose),
        gt(linkSends.sentAt, new Date(now.getTime() - LINK_RATE_WINDOW_MS)),
      ),
    )
    .orderBy(asc(linkSends.sentAt));
  const sentAt = recent.map((row) => row.sentAt);
  const refused = refusalIn(sentAt, now);
  if (refused !== null) return { sent: false, ...refused };
  await tx.insert(linkSends).values({
    id: randomUUID(),
    emailHash,
    purpose,
    sentAt: now,
    expiresAt: new Date(now.getTime() + LINK_SEND_RETENTION_MS),
  });
  return { sent: true, retryAt: waitAfter([...sentAt, now], now) };
}

type CabinetTransaction = Parameters<Parameters<ReturnType<typeof drizzle>["transaction"]>[0]>[0];

async function lockEmail(tx: CabinetTransaction, email: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`cabinet-email:${email}`}, 0))`,
  );
}

function reportDigestKeyInMemory(rows: MemoryRows, now: Date): string {
  const secrets = (rows.cabinet_report_identity_secrets ?? []) as ReportIdentitySecretRow[];
  rows.cabinet_report_identity_secrets = secrets;
  const existing = secrets.find((row) => row.id === REPORT_DIGEST_KEY_ID);
  if (existing !== undefined) return existing.digestKey;
  const digestKey = randomBytes(32).toString("base64url");
  secrets.push({ id: REPORT_DIGEST_KEY_ID, digestKey, createdAt: now });
  return digestKey;
}

async function reportDigestKeyInPostgres(tx: CabinetTransaction, now: Date): Promise<string> {
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
  if (stored === undefined) throw new Error("cabinet_report_digest_key_missing");
  return stored.digestKey;
}

/**
 * Removes the rows of links that ran out more than a week ago.
 *
 * The component deletes a link's row when it is spent; a link nobody pressed
 * stays, holding a hashed token and the claim with an address in it, and this
 * is what bounds how long. In batches, so one request never pays for a backlog.
 */
function cleanupOldLinksInMemory(rows: MemoryRows, now: Date): void {
  const cutoff = now.getTime() - LINK_PROOF_RETENTION_MS;
  let removed = 0;
  rows.cabinet_verifications = (rows.cabinet_verifications ?? []).filter((row) => {
    if (removed < LINK_CLEANUP_BATCH && new Date(row.expiresAt as Date).getTime() <= cutoff) {
      removed += 1;
      return false;
    }
    return true;
  });
}

async function cleanupOldLinksInPostgres(tx: CabinetTransaction, now: Date): Promise<void> {
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
  const account = (rows.cabinet_accounts ?? []).find((row) => row.email === email);
  let result: DeleteResult;
  if (account === undefined) result = "already_absent";
  else {
    const person = personFrom(account as PersonRow);
    result = person.merchant === null ? "deleted" : "retained";
  }
  rows.cabinet_verifications = (rows.cabinet_verifications ?? []).filter(
    (proof) => !goesWithTheDeletion(claimFrom(String(proof.value)), email, result),
  );
  if (result === "deleted" && account !== undefined) {
    const personId = String(account.id);
    rows.cabinet_accounts = (rows.cabinet_accounts ?? []).filter((row) => row.id !== personId);
    rows.cabinet_sessions = (rows.cabinet_sessions ?? []).filter((row) => row.userId !== personId);
    rows.cabinet_credentials = (rows.cabinet_credentials ?? []).filter(
      (row) => row.userId !== personId,
    );
    rows.cabinet_woo_grants = (rows.cabinet_woo_grants ?? []).filter(
      (row) => row.accountId !== personId,
    );
    rows.cabinet_woo_orders = (rows.cabinet_woo_orders ?? []).filter(
      (row) => row.accountId !== personId,
    );
    rows.cabinet_woo_shops = (rows.cabinet_woo_shops ?? []).filter(
      (row) => row.accountId !== personId,
    );
  }
  return result;
}

function cabinetLinkMessage(to: string, link: string): Message {
  const title = "Open your cabinet";
  const lifetime =
    "This link opens once and expires an hour after it was sent. There is nothing here to keep:" +
    " the next time you sign in, ask for a new link.";
  const unasked =
    "If you did not ask for this, ignore the message. Opening the link only shows a page;" +
    " nothing happens unless the button on it is pressed.";
  return {
    to,
    subject: "Sign in to your Agentify cabinet",
    // The URL stands on a line of its own, so that a client that draws no
    // button and a person copying it by hand both get the whole of it.
    body: `Agentify\n\n${title}\n\nSign in with this link:\n\n${link}\n\n${lifetime}\n\n${unasked}`,
    html: transactionalEmailHtml({
      preview: "Press the button to sign in to your cabinet.",
      eyebrow: "Cabinet sign-in",
      title,
      lead: "Press the button below to sign in to your cabinet.",
      action: "Open my cabinet",
      link,
      paragraphs: [lifetime, unasked],
    }),
  };
}
