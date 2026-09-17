/**
 * Cabinet identity behind one emailed-link door.
 *
 * Better Auth owns token consumption, people and sessions. Its generated HTTP
 * routes stay unmounted: the cabinet sends the link itself and calls the
 * component only from the same-origin POST owned by the SSR server. Production
 * verification runs on a transaction-bound Drizzle adapter; the deterministic
 * memory store runs the same component against an isolated transaction copy.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  type AcknowledgeReportLinkRequest,
  type AcknowledgeReportLinkResponse,
  type ConsumeReportLinkRequest,
  type ConsumeReportLinkResponse,
  type DeleteUnattachedPersonRequest,
  type DeleteUnattachedPersonResponse,
  type IssueCabinetLinkRequest,
  type IssueCabinetLinkResponse,
  reportIdentityTokenHash,
  type SendReportLinkRequest,
  type SendReportLinkResponse,
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
  LinkRequestResult,
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
  reportReceipts,
  sessions,
  verifications,
} from "./schema.js";

export type {
  AccountMerchant,
  AttachMerchantResult,
  CabinetDestination,
  CabinetIdentity,
  CabinetLinkResult,
  LinkRequestResult,
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
}

/** Operator-only operations kept out of the page-facing identity port. */
export interface Identity extends CabinetIdentity {
  make(email: string, merchant: AccountMerchant): Promise<Person | null>;
  byEmail(email: string): Promise<Person | null>;
  byId(personId: string): Promise<Person | null>;
  endEverySessionFor(email: string): Promise<number>;
  list(now: Date): Promise<readonly AccountSummary[]>;
  sendReportLink(request: SendReportLinkRequest): Promise<SendReportLinkResponse>;
  consumeReportLink(request: ConsumeReportLinkRequest): Promise<ConsumeReportLinkResponse>;
  acknowledgeReportLink(
    request: AcknowledgeReportLinkRequest,
  ): Promise<AcknowledgeReportLinkResponse>;
  issueCabinetLink(request: IssueCabinetLinkRequest): Promise<IssueCabinetLinkResponse>;
  deleteUnattachedPerson(
    request: DeleteUnattachedPersonRequest,
  ): Promise<DeleteUnattachedPersonResponse>;
  close(): Promise<void>;
}

export const emailAs = (raw: string): string => raw.trim().toLowerCase();

const SESSION_HOURS = 12;
export const LINK_TTL_SECONDS = 60 * 60;
export const LINK_RATE_WINDOW_MS = 60 * 60 * 1000;
export const LINK_RATE_LIMIT = 3;
export const LINK_SEND_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const REPORT_COMPLETION_MS = 5 * 60 * 1000;
export const REPORT_EVIDENCE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const REPORT_CLEANUP_BATCH = 100;
const REPORT_DIGEST_KEY_ID = "digest-v1";
const RAW_TOKEN = /^[A-Za-z0-9]{32}$/;

type MemoryRows = Record<string, Record<string, unknown>[]>;

export interface IdentityParts {
  readonly pool?: Pool;
  readonly rows?: MemoryRows;
  readonly postman?: Postman;
}

type CabinetClaim = Readonly<{
  email: string;
  purpose: "cabinet";
  destination: CabinetDestination;
}>;

type ReportClaim = Readonly<{
  email: string;
  purpose: "report";
  intentKind: "registration" | "recovery";
  state: string;
}>;

type IdentityClaim = CabinetClaim | ReportClaim;

type LinkSend = {
  readonly claim: IdentityClaim;
  handed: "accepted" | "refused";
  tokenHash?: string;
};

type ReportReceiptRow = {
  id: string;
  tokenHash: string;
  emailHash: string;
  stateHash: string;
  intentKind: "registration" | "recovery";
  status: "pending" | "completed" | "invalidated";
  consumedAt: Date;
  completionDeadline: Date;
  completedAt: Date | null;
  invalidatedAt: Date | null;
  issueAttemptedAt: Date | null;
  issuedLinkExpiresAt: Date | null;
  retentionUntil: Date;
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
      cabinet_report_receipts: [],
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
        },
      },
      session: {
        modelName: "cabinet_sessions",
        expiresIn: SESSION_HOURS * 60 * 60,
        disableSessionRefresh: true,
      },
      account: { modelName: "cabinet_credentials" },
      verification: { modelName: "cabinet_verifications" },
      advanced: {
        cookiePrefix: "agentify",
        defaultCookieAttributes: {
          path: config.basePath === "" ? "/" : config.basePath,
          sameSite: "strict",
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
            const claim = identityClaim(metadata);
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
            active.tokenHash = reportIdentityTokenHash(token);
            if (claim.purpose === "cabinet") {
              const action = new URL(`${base}/sign-in/open`);
              action.searchParams.set("token", token);
              active.handed = await postman(cabinetLinkMessage(email, action.toString()));
              return;
            }
            const action = new URL(`${config.publicBaseUrl}/auth/callback`);
            action.hash = new URLSearchParams({ state: claim.state, token }).toString();
            active.handed = await postman(
              reportLinkMessage(email, claim.intentKind, action.toString()),
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
  ): Promise<LinkRequestResult> => {
    const active: LinkSend = {
      claim: { email, purpose: "cabinet", destination },
      handed: "refused",
    };
    await sending.run(active, async () => {
      await bound.api.signInMagicLink({
        headers: originHeaders,
        body: { email, metadata: active.claim },
      });
    });
    if (active.handed !== "accepted") throw new DeliveryRefused();
    return { status: "accepted" };
  };

  const requestReportWith = async (
    bound: typeof auth,
    request: SendReportLinkRequest,
  ): Promise<SendReportLinkResponse> => {
    const claim: ReportClaim = {
      email: request.email,
      purpose: "report",
      intentKind: request.intent_kind,
      state: request.state,
    };
    const active: LinkSend = { claim, handed: "refused" };
    await sending.run(active, async () => {
      await bound.api.signInMagicLink({
        headers: originHeaders,
        body: { email: request.email, metadata: claim },
      });
    });
    if (active.handed !== "accepted" || active.tokenHash === undefined) {
      throw new DeliveryRefused();
    }
    return { status: "accepted", token_hash: active.tokenHash };
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
    const claim = cabinetClaimFrom(stored.value);
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
    return {
      status: "opened",
      person: personFrom(opened.response.user),
      destination: claim.destination,
      setCookies: opened.headers.getSetCookie(),
    };
  };

  const consumeReportAuthWith = async (
    bound: typeof auth,
    request: ConsumeReportLinkRequest,
  ): Promise<Person | null> => {
    if (!RAW_TOKEN.test(request.token)) return null;
    const context = await bound.$context;
    const stored = await context.adapter.findOne<StoredVerification>({
      model: "verification",
      where: [{ field: "identifier", value: reportIdentityTokenHash(request.token) }],
    });
    if (stored === null || new Date(stored.expiresAt).getTime() <= Date.now()) return null;
    const claim = reportClaimFrom(stored.value);
    if (
      claim === null ||
      claim.email !== request.email ||
      claim.intentKind !== request.intent_kind ||
      claim.state !== request.state
    ) {
      return null;
    }

    let opened: Awaited<ReturnType<typeof bound.api.magicLinkVerify>>;
    try {
      opened = await bound.api.magicLinkVerify({
        query: { token: request.token },
        headers: originHeaders,
      });
    } catch (thrown) {
      if (thrown instanceof APIError) return null;
      throw thrown;
    }
    if (opened.user.email !== claim.email || opened.user.emailVerified !== true) return null;
    await context.internalAdapter.deleteSession(opened.session.token);
    return personFrom(opened.user);
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
  const liveOnesIn = async (
    cookieHeader: string | undefined,
  ): Promise<readonly { token: string; person: Person }[]> => {
    const live: { token: string; person: Person }[] = [];
    for (const value of valuesIn(cookieHeader)) {
      const found = await auth.api.getSession({ headers: asHeaders(value) });
      if (found !== null) live.push({ token: found.session.token, person: personFrom(found.user) });
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
            const limited = memoryRate(rows, rateKey(config.authSecret, email), "cabinet");
            if (limited !== null) return { status: "cooldown", retryAt: limited };
            return await requestWith(bound, email, destination);
          });
        }
        const db = drizzle(parts.pool, {
          schema: { accounts, credentials, linkSends, sessions, verifications },
        });
        return await db.transaction(async (tx) => {
          await lockEmail(tx, email);
          const limited = await postgresRate(tx, rateKey(config.authSecret, email), "cabinet");
          if (limited !== null) return { status: "cooldown", retryAt: limited };
          return await requestWith(
            authFor(drizzleAdapter(tx, { provider: "pg", schema })),
            email,
            destination,
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
            cleanupReportEvidenceInMemory(rows, now);
            const digestKey = reportDigestKeyInMemory(rows, now);
            const limited = memoryRate(rows, rateKey(digestKey, request.email), "report");
            if (limited !== null) {
              return { status: "cooldown", retry_at: limited.toISOString() };
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
            reportReceipts,
            sessions,
            verifications,
          },
        });
        return await db.transaction(async (tx) => {
          const now = new Date();
          const digestKey = await reportDigestKeyInPostgres(tx, now);
          await cleanupReportEvidenceInPostgres(tx, now);
          await lockEmail(tx, request.email);
          const limited = await postgresRate(tx, rateKey(digestKey, request.email), "report");
          if (limited !== null) {
            return { status: "cooldown", retry_at: limited.toISOString() };
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

    async consumeReportLink(request) {
      const tokenHash = reportIdentityTokenHash(request.token);
      const stateHash = reportIdentityTokenHash(request.state);
      if (parts.pool === undefined) {
        return await inMemoryTransaction(async (bound, rows) => {
          const now = new Date();
          cleanupReportEvidenceInMemory(rows, now);
          const digestKey = reportDigestKeyInMemory(rows, now);
          const emailHash = reportEmailKey(digestKey, request.email);
          const existing = (rows.cabinet_report_receipts ?? []).find(
            (row) => row.tokenHash === tokenHash,
          ) as ReportReceiptRow | undefined;
          if (existing !== undefined) {
            return pendingRetry(existing, emailHash, stateHash, request.intent_kind, now);
          }
          const person = await consumeReportAuthWith(bound, request);
          if (person === null) return { status: "refused" };
          const deadline = new Date(now.getTime() + REPORT_COMPLETION_MS);
          const receipt: ReportReceiptRow = {
            id: randomUUID(),
            tokenHash,
            emailHash,
            stateHash,
            intentKind: request.intent_kind,
            status: "pending",
            consumedAt: now,
            completionDeadline: deadline,
            completedAt: null,
            invalidatedAt: null,
            issueAttemptedAt: null,
            issuedLinkExpiresAt: null,
            retentionUntil: new Date(deadline.getTime() + REPORT_EVIDENCE_RETENTION_MS),
          };
          const receipts = rows.cabinet_report_receipts ?? [];
          rows.cabinet_report_receipts = receipts;
          receipts.push(receipt);
          return pendingResponse(receipt);
        });
      }

      const db = drizzle(parts.pool, {
        schema: {
          accounts,
          credentials,
          reportIdentitySecrets,
          reportReceipts,
          sessions,
          verifications,
        },
      });
      return await db.transaction(async (tx) => {
        const now = new Date();
        const digestKey = await reportDigestKeyInPostgres(tx, now);
        await cleanupReportEvidenceInPostgres(tx, now);
        await lockEmail(tx, request.email);
        const emailHash = reportEmailKey(digestKey, request.email);
        const existing = (
          await tx
            .select()
            .from(reportReceipts)
            .where(eq(reportReceipts.tokenHash, tokenHash))
            .for("update")
        )[0] as ReportReceiptRow | undefined;
        if (existing !== undefined) {
          return pendingRetry(existing, emailHash, stateHash, request.intent_kind, now);
        }
        const person = await consumeReportAuthWith(
          authFor(drizzleAdapter(tx, { provider: "pg", schema })),
          request,
        );
        if (person === null) return { status: "refused" };
        const deadline = new Date(now.getTime() + REPORT_COMPLETION_MS);
        const receipt: ReportReceiptRow = {
          id: randomUUID(),
          tokenHash,
          emailHash,
          stateHash,
          intentKind: request.intent_kind,
          status: "pending",
          consumedAt: now,
          completionDeadline: deadline,
          completedAt: null,
          invalidatedAt: null,
          issueAttemptedAt: null,
          issuedLinkExpiresAt: null,
          retentionUntil: new Date(deadline.getTime() + REPORT_EVIDENCE_RETENTION_MS),
        };
        await tx.insert(reportReceipts).values(receipt);
        return pendingResponse(receipt);
      });
    },

    async acknowledgeReportLink(request) {
      if (parts.pool === undefined) {
        return await inMemoryTransaction(async (_bound, rows) => {
          const now = new Date();
          cleanupReportEvidenceInMemory(rows, now);
          const receipt = (rows.cabinet_report_receipts ?? []).find(
            (row) => row.id === request.receipt_id && row.tokenHash === request.token_hash,
          ) as ReportReceiptRow | undefined;
          return acknowledgeReceipt(receipt, now);
        });
      }
      const db = drizzle(parts.pool, { schema: { reportReceipts, verifications } });
      return await db.transaction(async (tx) => {
        const now = new Date();
        await cleanupReportEvidenceInPostgres(tx, now);
        const receipt = (
          await tx
            .select()
            .from(reportReceipts)
            .where(
              and(
                eq(reportReceipts.id, request.receipt_id),
                eq(reportReceipts.tokenHash, request.token_hash),
              ),
            )
            .for("update")
        )[0] as ReportReceiptRow | undefined;
        const result = acknowledgeReceipt(receipt, now);
        if (result.status === "completed" && receipt?.status === "completed") {
          await tx
            .update(reportReceipts)
            .set({
              status: receipt.status,
              completedAt: receipt.completedAt,
              retentionUntil: receipt.retentionUntil,
            })
            .where(eq(reportReceipts.id, receipt.id));
        }
        return result;
      });
    },

    async issueCabinetLink(request) {
      if (parts.pool === undefined) {
        return await inMemoryTransaction(async (_bound, rows) => {
          const now = new Date();
          cleanupReportEvidenceInMemory(rows, now);
          const digestKey = reportDigestKeyInMemory(rows, now);
          const receipt = (rows.cabinet_report_receipts ?? []).find(
            (row) => row.id === request.receipt_id && row.tokenHash === request.token_hash,
          ) as ReportReceiptRow | undefined;
          const preliminary = issueStatus(receipt, now);
          if (preliminary !== null) return preliminary;
          if (receipt === undefined) return { status: "refused" };
          const email = emailForReceipt(rows.cabinet_accounts ?? [], receipt, digestKey);
          if (email === null) return { status: "refused" };
          return issueFor(rows, receipt, email, base, now);
        });
      }
      const db = drizzle(parts.pool, {
        schema: { accounts, reportIdentitySecrets, reportReceipts, verifications },
      });
      return await db.transaction(async (tx) => {
        const beforeLock = new Date();
        const digestKey = await reportDigestKeyInPostgres(tx, beforeLock);
        await cleanupReportEvidenceInPostgres(tx, beforeLock);
        const emails = await tx.select({ email: accounts.email }).from(accounts);
        const receiptBeforeLock = (
          await tx
            .select()
            .from(reportReceipts)
            .where(
              and(
                eq(reportReceipts.id, request.receipt_id),
                eq(reportReceipts.tokenHash, request.token_hash),
              ),
            )
        )[0] as ReportReceiptRow | undefined;
        const resolvedEmail =
          receiptBeforeLock === undefined
            ? null
            : emailForReceipt(emails, receiptBeforeLock, digestKey);
        if (resolvedEmail === null) return { status: "refused" };
        await lockEmail(tx, resolvedEmail);
        const receipt = (
          await tx
            .select()
            .from(reportReceipts)
            .where(
              and(
                eq(reportReceipts.id, request.receipt_id),
                eq(reportReceipts.tokenHash, request.token_hash),
              ),
            )
            .for("update")
        )[0] as ReportReceiptRow | undefined;
        const now = new Date();
        const preliminary = issueStatus(receipt, now);
        if (preliminary !== null) return preliminary;
        const owner = await tx
          .select({ id: accounts.id })
          .from(accounts)
          .where(eq(accounts.email, resolvedEmail));
        if (owner.length !== 1 || receipt?.emailHash !== reportEmailKey(digestKey, resolvedEmail)) {
          return { status: "refused" };
        }
        const issued = issuedCabinetLink(resolvedEmail, base, now);
        await tx.insert(verifications).values(issued.verification);
        await tx
          .update(reportReceipts)
          .set({
            issueAttemptedAt: now,
            issuedLinkExpiresAt: issued.expiresAt,
            retentionUntil: new Date(issued.expiresAt.getTime() + REPORT_EVIDENCE_RETENTION_MS),
          })
          .where(eq(reportReceipts.id, receipt.id));
        return { status: "issued", action_url: issued.actionUrl };
      });
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
          cleanupReportEvidenceInMemory(rows, now);
          const result = deleteFromMemory(rows, request.email, digestKey, now);
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
          reportReceipts,
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
        await cleanupReportEvidenceInPostgres(tx, now);
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
        const emailHash = reportEmailKey(digestKey, request.email);
        await tx
          .update(reportReceipts)
          .set({
            status: "invalidated",
            invalidatedAt: now,
            retentionUntil: sql`greatest(
              ${reportReceipts.retentionUntil},
              ${new Date(now.getTime() + REPORT_EVIDENCE_RETENTION_MS)}
            )`,
          })
          .where(eq(reportReceipts.emailHash, emailHash));
        const proofs = await tx
          .select({ id: verifications.id, value: verifications.value })
          .from(verifications);
        for (const proof of proofs) {
          const claim = identityClaimFrom(proof.value);
          if (
            claim?.email === request.email &&
            (claim.purpose === "report" || result !== "retained")
          ) {
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

    async whoIs(cookieHeader) {
      const live = await liveOnesIn(cookieHeader);
      if (live.length === 0) return null;
      const owners = new Set(live.map((one) => one.person.id));
      if (owners.size === 1) return live[0]?.person ?? null;
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

function asMerchantPerson(person: Person): MerchantPerson {
  if (person.merchant === null) throw new Error("cabinet_person_has_no_merchant");
  return person as MerchantPerson;
}

function asUnattachedPerson(person: Person): UnattachedPerson {
  if (person.merchant !== null) throw new Error("cabinet_person_has_a_merchant");
  return person as UnattachedPerson;
}

function identityClaim(metadata: Record<string, unknown> | undefined): IdentityClaim | null {
  if (metadata === undefined) return null;
  return identityClaimOf(metadata);
}

function cabinetClaimFrom(value: string): CabinetClaim | null {
  const claim = identityClaimFrom(value);
  return claim?.purpose === "cabinet" ? claim : null;
}

function reportClaimFrom(value: string): ReportClaim | null {
  const claim = identityClaimFrom(value);
  return claim?.purpose === "report" ? claim : null;
}

function identityClaimFrom(value: string): IdentityClaim | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return null;
    return identityClaimOf(parsed as Record<string, unknown>);
  } catch {
    return null;
  }
}

function identityClaimOf(value: Record<string, unknown>): IdentityClaim | null {
  if (typeof value.email !== "string" || value.email !== emailAs(value.email)) return null;
  if (value.purpose === "cabinet") {
    if (value.destination !== "default" && value.destination !== "settings") return null;
    return { email: value.email, purpose: "cabinet", destination: value.destination };
  }
  if (
    value.purpose === "report" &&
    (value.intentKind === "registration" || value.intentKind === "recovery") &&
    typeof value.state === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(value.state)
  ) {
    return {
      email: value.email,
      purpose: "report",
      intentKind: value.intentKind,
      state: value.state,
    };
  }
  return null;
}

function sameClaim(one: IdentityClaim, other: IdentityClaim): boolean {
  if (one.purpose !== other.purpose || one.email !== other.email) return false;
  return one.purpose === "cabinet" && other.purpose === "cabinet"
    ? one.destination === other.destination
    : one.purpose === "report" && other.purpose === "report"
      ? one.intentKind === other.intentKind && one.state === other.state
      : false;
}

const tokenHash = reportIdentityTokenHash;

const rateKey = (secret: string, email: string): string =>
  createHmac("sha256", secret).update(`cabinet-link:${email}`).digest("hex");

function memoryRate(
  rows: MemoryRows,
  emailHash: string,
  purpose: "cabinet" | "report",
): Date | null {
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
    .sort(
      (one, other) =>
        new Date(one.sentAt as Date).getTime() - new Date(other.sentAt as Date).getTime(),
    );
  if (recent.length >= LINK_RATE_LIMIT) {
    return new Date(
      new Date(recent[recent.length - LINK_RATE_LIMIT]?.sentAt as Date).getTime() +
        LINK_RATE_WINDOW_MS,
    );
  }
  rows.cabinet_link_sends.push({
    id: randomUUID(),
    emailHash,
    purpose,
    sentAt: now,
    expiresAt: new Date(now.getTime() + LINK_SEND_RETENTION_MS),
  });
  return null;
}

async function postgresRate(
  tx: Parameters<Parameters<ReturnType<typeof drizzle>["transaction"]>[0]>[0],
  emailHash: string,
  purpose: "cabinet" | "report",
): Promise<Date | null> {
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
  if (recent.length >= LINK_RATE_LIMIT) {
    const firstCounted = recent[recent.length - LINK_RATE_LIMIT];
    if (firstCounted === undefined) {
      throw new Error("cabinet_link_rate_count_inconsistent");
    }
    return new Date(firstCounted.sentAt.getTime() + LINK_RATE_WINDOW_MS);
  }
  await tx.insert(linkSends).values({
    id: randomUUID(),
    emailHash,
    purpose,
    sentAt: now,
    expiresAt: new Date(now.getTime() + LINK_SEND_RETENTION_MS),
  });
  return null;
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

function cleanupReportEvidenceInMemory(rows: MemoryRows, now: Date): void {
  let removedReceipts = 0;
  rows.cabinet_report_receipts = (rows.cabinet_report_receipts ?? []).filter((row) => {
    if (
      removedReceipts < REPORT_CLEANUP_BATCH &&
      new Date(row.retentionUntil as Date).getTime() <= now.getTime()
    ) {
      removedReceipts += 1;
      return false;
    }
    return true;
  });

  const verificationCutoff = now.getTime() - REPORT_EVIDENCE_RETENTION_MS;
  let removedVerifications = 0;
  rows.cabinet_verifications = (rows.cabinet_verifications ?? []).filter((row) => {
    if (
      removedVerifications < REPORT_CLEANUP_BATCH &&
      new Date(row.expiresAt as Date).getTime() <= verificationCutoff &&
      reportClaimFrom(String(row.value)) !== null
    ) {
      removedVerifications += 1;
      return false;
    }
    return true;
  });
}

async function cleanupReportEvidenceInPostgres(tx: CabinetTransaction, now: Date): Promise<void> {
  const expiredReceipts = await tx
    .select({ id: reportReceipts.id })
    .from(reportReceipts)
    .where(lte(reportReceipts.retentionUntil, now))
    .orderBy(asc(reportReceipts.retentionUntil), asc(reportReceipts.id))
    .limit(REPORT_CLEANUP_BATCH);
  for (const receipt of expiredReceipts) {
    await tx.delete(reportReceipts).where(eq(reportReceipts.id, receipt.id));
  }

  const verificationCutoff = new Date(now.getTime() - REPORT_EVIDENCE_RETENTION_MS);
  const expiredReportProofs = await tx
    .select({ id: verifications.id, value: verifications.value })
    .from(verifications)
    .where(
      and(
        lte(verifications.expiresAt, verificationCutoff),
        sql`${verifications.value} like ${'%"purpose":"report"%'}`,
      ),
    )
    .orderBy(asc(verifications.expiresAt), asc(verifications.id))
    .limit(REPORT_CLEANUP_BATCH);
  for (const proof of expiredReportProofs) {
    if (reportClaimFrom(proof.value) !== null) {
      await tx.delete(verifications).where(eq(verifications.id, proof.id));
    }
  }
}

const reportEmailKey = (secret: string, email: string): string =>
  createHmac("sha256", secret).update(`report-email\0${email}`).digest("base64url");

const reportDeleteDigest = (secret: string, operationId: string, email: string): string =>
  createHmac("sha256", secret)
    .update(`report-delete\0${operationId}\0${email}`)
    .digest("base64url");

function pendingResponse(receipt: ReportReceiptRow): ConsumeReportLinkResponse {
  return {
    status: "pending",
    receipt_id: receipt.id,
    completion_deadline: receipt.completionDeadline.toISOString(),
  };
}

function pendingRetry(
  receipt: ReportReceiptRow,
  emailHash: string,
  stateHash: string,
  intentKind: "registration" | "recovery",
  now: Date,
): ConsumeReportLinkResponse {
  if (
    receipt.retentionUntil.getTime() <= now.getTime() ||
    receipt.status !== "pending" ||
    receipt.completionDeadline.getTime() <= now.getTime() ||
    receipt.emailHash !== emailHash ||
    receipt.stateHash !== stateHash ||
    receipt.intentKind !== intentKind
  ) {
    return { status: "refused" };
  }
  return pendingResponse(receipt);
}

function acknowledgeReceipt(
  receipt: ReportReceiptRow | undefined,
  now: Date,
): AcknowledgeReportLinkResponse {
  if (
    receipt === undefined ||
    receipt.retentionUntil.getTime() <= now.getTime() ||
    receipt.status === "invalidated"
  ) {
    return { status: "refused" };
  }
  if (receipt.status === "completed") return { status: "completed" };
  if (receipt.completionDeadline.getTime() <= now.getTime()) return { status: "refused" };
  receipt.status = "completed";
  receipt.completedAt = now;
  receipt.retentionUntil = laterDate(
    receipt.retentionUntil,
    new Date(now.getTime() + REPORT_EVIDENCE_RETENTION_MS),
  );
  return { status: "completed" };
}

function issueStatus(
  receipt: ReportReceiptRow | undefined,
  now: Date,
): IssueCabinetLinkResponse | null {
  if (
    receipt === undefined ||
    receipt.retentionUntil.getTime() <= now.getTime() ||
    receipt.status !== "completed" ||
    receipt.invalidatedAt !== null
  ) {
    return { status: "refused" };
  }
  if (receipt.issueAttemptedAt !== null) return { status: "already_attempted" };
  if (receipt.completionDeadline.getTime() <= now.getTime()) return { status: "refused" };
  return null;
}

function emailForReceipt(
  accountRows: readonly Record<string, unknown>[],
  receipt: ReportReceiptRow,
  secret: string,
): string | null {
  const matches = accountRows
    .map((row) => row.email)
    .filter((email): email is string => typeof email === "string")
    .filter((email) => reportEmailKey(secret, email) === receipt.emailHash);
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function issuedCabinetLink(email: string, base: string, now: Date) {
  const rawToken = randomBearerToken();
  const expiresAt = new Date(now.getTime() + LINK_TTL_SECONDS * 1000);
  const action = new URL(`${base}/sign-in/open`);
  action.searchParams.set("token", rawToken);
  return {
    actionUrl: action.toString(),
    expiresAt,
    verification: {
      id: randomUUID(),
      identifier: tokenHash(rawToken),
      value: JSON.stringify({ email, purpose: "cabinet", destination: "default" }),
      expiresAt,
      createdAt: now,
      updatedAt: now,
    },
  };
}

function issueFor(
  rows: MemoryRows,
  receipt: ReportReceiptRow,
  email: string,
  base: string,
  now: Date,
): IssueCabinetLinkResponse {
  const issued = issuedCabinetLink(email, base, now);
  const proofs = rows.cabinet_verifications ?? [];
  rows.cabinet_verifications = proofs;
  proofs.push(issued.verification);
  receipt.issueAttemptedAt = now;
  receipt.issuedLinkExpiresAt = issued.expiresAt;
  receipt.retentionUntil = new Date(issued.expiresAt.getTime() + REPORT_EVIDENCE_RETENTION_MS);
  return { status: "issued", action_url: issued.actionUrl };
}

function randomBearerToken(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let token = "";
  while (token.length < 32) {
    for (const byte of randomBytes(32)) {
      if (byte >= 248) continue;
      token += alphabet[byte % alphabet.length];
      if (token.length === 32) return token;
    }
  }
  return token;
}

type DeleteResult = "deleted" | "already_absent" | "retained";

function deleteFromMemory(
  rows: MemoryRows,
  email: string,
  secret: string,
  now: Date,
): DeleteResult {
  const account = (rows.cabinet_accounts ?? []).find((row) => row.email === email);
  let result: DeleteResult;
  if (account === undefined) result = "already_absent";
  else {
    const person = personFrom(account as PersonRow);
    result = person.merchant === null ? "deleted" : "retained";
  }
  const emailHash = reportEmailKey(secret, email);
  for (const receipt of (rows.cabinet_report_receipts ?? []) as ReportReceiptRow[]) {
    if (receipt.emailHash !== emailHash) continue;
    receipt.status = "invalidated";
    receipt.invalidatedAt = now;
    receipt.retentionUntil = laterDate(
      receipt.retentionUntil,
      new Date(now.getTime() + REPORT_EVIDENCE_RETENTION_MS),
    );
  }
  rows.cabinet_verifications = (rows.cabinet_verifications ?? []).filter((proof) => {
    const claim = identityClaimFrom(String(proof.value));
    return !(claim?.email === email && (claim.purpose === "report" || result !== "retained"));
  });
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

function laterDate(one: Date, two: Date): Date {
  return one.getTime() >= two.getTime() ? one : two;
}

function cabinetLinkMessage(to: string, link: string): Message {
  const subject = "Open your Agentify cabinet";
  const lead = "Use this secure link to open your merchant cabinet.";
  const lifetime = "The link expires in one hour and can be used once.";
  return {
    to,
    subject,
    body: `Agentify\n\n${lead}\n\nOpen my cabinet: ${link}\n\n${lifetime}`,
    html: transactionalEmailHtml({
      preview: lead,
      eyebrow: "Cabinet access",
      title: "Open your cabinet",
      lead,
      action: "Open my cabinet",
      link,
      paragraphs: [lifetime, "If you did not request this link, you can ignore this message."],
    }),
  };
}
