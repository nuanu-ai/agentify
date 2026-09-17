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
import { createHash, createHmac, randomUUID } from "node:crypto";
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
import { accounts, credentials, linkSends, sessions, verifications } from "./schema.js";

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
  close(): Promise<void>;
}

export const emailAs = (raw: string): string => raw.trim().toLowerCase();

const SESSION_HOURS = 12;
export const LINK_TTL_SECONDS = 60 * 60;
export const LINK_RATE_WINDOW_MS = 60 * 60 * 1000;
export const LINK_RATE_LIMIT = 3;
export const LINK_SEND_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
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

type LinkSend = {
  readonly claim: CabinetClaim;
  handed: "accepted" | "refused";
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
            const claim = cabinetClaim(metadata);
            if (
              active === undefined ||
              claim === null ||
              claim.email !== email ||
              claim.email !== active.claim.email ||
              claim.destination !== active.claim.destination
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
            const action = new URL(`${base}/sign-in/open`);
            action.searchParams.set("token", token);
            active.handed = await postman(cabinetLinkMessage(email, action.toString()));
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

function cabinetClaim(metadata: Record<string, unknown> | undefined): CabinetClaim | null {
  if (metadata === undefined) return null;
  return claimFrom(metadata);
}

function cabinetClaimFrom(value: string): CabinetClaim | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return null;
    return claimFrom(parsed as Record<string, unknown>);
  } catch {
    return null;
  }
}

function claimFrom(value: Record<string, unknown>): CabinetClaim | null {
  if (
    value.purpose !== "cabinet" ||
    typeof value.email !== "string" ||
    value.email !== emailAs(value.email) ||
    (value.destination !== "default" && value.destination !== "settings")
  ) {
    return null;
  }
  return { email: value.email, purpose: "cabinet", destination: value.destination };
}

const tokenHash = (token: string): string => createHash("sha256").update(token).digest("base64url");

const rateKey = (secret: string, email: string): string =>
  createHmac("sha256", secret).update(`cabinet-link:${email}`).digest("hex");

function memoryRate(rows: MemoryRows, emailHash: string, purpose: "cabinet"): Date | null {
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
  purpose: "cabinet",
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
