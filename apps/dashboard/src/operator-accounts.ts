/**
 * The accounts as the operator's workspace reads and changes them: who can
 * sign in, which of them hold the operator flag, and whose sessions are open;
 * ending a person's sessions, granting or removing the flag, and on the test
 * channel forgetting an account. Each change runs as statements on the
 * transaction it is handed, the one the journal's row is written in, so the
 * change and its row commit together or neither does.
 *
 * Every change of who holds the flag, and every forgetting, first takes one
 * lock for the whole channel, so whether an operator is the last one is
 * decided with nobody else deciding it at the same moment: two removals
 * pressed at once cannot both pass.
 */

import { type SQL, sql } from "drizzle-orm";
import type { JournalTransaction } from "./admin/journal.js";
import { rateKey } from "./identity.js";

/** One account as the workspace lists it. */
export interface AccountSummary {
  readonly id: string;
  readonly email: string;
  readonly createdAt: Date;
  readonly merchantId: string | null;
  readonly operator: boolean;
  /** Sessions that have not expired. */
  readonly openSessions: number;
  /** When the newest open session was signed in, or null where none is open. */
  readonly newestSession: Date | null;
}

/**
 * The accounts that made a merchant or hold the flag, and how many others
 * only signed in: those are counted, never listed.
 */
export interface AccountsListing {
  readonly listed: readonly AccountSummary[];
  readonly unlisted: number;
}

/** What a change of the flag found. */
export type FlagChange = "changed" | "unchanged" | "no-account" | "last-operator";

/** What forgetting an account found, and what it removed. */
export type Forgetting =
  | Readonly<{ kind: "no-account" }>
  | Readonly<{ kind: "operator" }>
  | Readonly<{ kind: "money-history"; merchantId: string; orders: number; receipts: number }>
  | Readonly<{ kind: "shared-merchant"; merchantId: string; others: number }>
  | Readonly<{
      kind: "forgotten";
      email: string;
      merchant: Readonly<{ id: string; present: boolean; cards: number }> | null;
    }>;

/** A transaction's way of running statements. */
export type Statements = Pick<JournalTransaction, "execute">;

/** The one lock every change of who holds the flag takes first. */
const OPERATORS_LOCK = "dashboard-operators";

const rowsOf = async <T extends Record<string, unknown>>(
  tx: Statements,
  query: SQL,
): Promise<T[]> => (await tx.execute(query)).rows as T[];

async function lockOperators(tx: Statements): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${OPERATORS_LOCK}, 0))`);
}

type SummaryRow = {
  id: string;
  email: string;
  createdAt: Date;
  merchantId: string | null;
  operator: boolean;
  openSessions: number;
  newestSession: Date | null;
};

const summaryOf = (row: SummaryRow): AccountSummary => ({
  id: row.id,
  email: row.email,
  createdAt: new Date(row.createdAt),
  merchantId: row.merchantId,
  operator: row.operator === true,
  openSessions: Number(row.openSessions),
  newestSession: row.newestSession === null ? null : new Date(row.newestSession),
});

const summaries = (where: SQL, now: Date): SQL => sql`
  select a.id, a.email, a.created_at as "createdAt", a.merchant_id as "merchantId", a.operator,
         count(s.id) filter (where s.expires_at > ${now})::int as "openSessions",
         max(s.created_at) filter (where s.expires_at > ${now}) as "newestSession"
    from dashboard_accounts a left join dashboard_sessions s on s.user_id = a.id
   where ${where}
   group by a.id`;

export async function listedIn(tx: Statements, now: Date): Promise<AccountsListing> {
  const listed = await rowsOf<SummaryRow>(
    tx,
    summaries(sql`a.merchant_id is not null or a.operator`, now),
  );
  const [counted] = await rowsOf<{ n: number }>(
    tx,
    sql`select count(*)::int as n from dashboard_accounts
         where merchant_id is null and not operator`,
  );
  return { listed: listed.map(summaryOf), unlisted: counted?.n ?? 0 };
}

export async function summaryIn(
  tx: Statements,
  accountId: string,
  now: Date,
): Promise<AccountSummary | null> {
  const [row] = await rowsOf<SummaryRow>(tx, summaries(sql`a.id = ${accountId}`, now));
  return row === undefined ? null : summaryOf(row);
}

/** Ends every session of one account, or says it has none open or there is no such account. */
export async function endSessionsIn(
  tx: Statements,
  accountId: string,
  now: Date,
): Promise<"ended" | "none" | "no-account"> {
  const [account] = await rowsOf<{ id: string }>(
    tx,
    sql`select id from dashboard_accounts where id = ${accountId} for update`,
  );
  if (account === undefined) return "no-account";
  const ended = await rowsOf<{ live: boolean }>(
    tx,
    sql`delete from dashboard_sessions where user_id = ${accountId}
        returning expires_at > ${now} as live`,
  );
  return ended.some((row) => row.live) ? "ended" : "none";
}

/** Who holds the flag, under the operators' lock the caller took. */
async function operatorsIn(
  tx: Statements,
): Promise<readonly Readonly<{ id: string; email: string }>[]> {
  return await rowsOf<{ id: string; email: string }>(
    tx,
    sql`select id, email from dashboard_accounts where operator order by id`,
  );
}

/**
 * Sets the flag of one account, under the operators' lock. `tell` runs after
 * the flag is written and before the transaction commits, handed who held
 * the flag before and the account changed; a throw from it rolls the change
 * back.
 */
export async function setFlagIn(
  tx: Statements,
  accountId: string,
  on: boolean,
  tell: (
    before: readonly Readonly<{ id: string; email: string }>[],
    changed: Readonly<{ id: string; email: string }>,
  ) => Promise<void>,
): Promise<FlagChange> {
  await lockOperators(tx);
  const [account] = await rowsOf<{ id: string; email: string; operator: boolean }>(
    tx,
    sql`select id, email, operator from dashboard_accounts where id = ${accountId} for update`,
  );
  if (account === undefined) return "no-account";
  if (account.operator === on) return "unchanged";
  const before = await operatorsIn(tx);
  if (!on && before.every((one) => one.id === accountId)) return "last-operator";
  await tx.execute(
    sql`update dashboard_accounts set operator = ${on}, updated_at = now() where id = ${accountId}`,
  );
  await tell(before, { id: account.id, email: account.email });
  return "changed";
}

/**
 * Removes one account and the merchant it names, so the address next signs
 * in as a newcomer. The account row takes its sessions, credentials,
 * WooCommerce rows and reports to the ad tracker by cascade; the merchant's
 * cards go first, because the gateway does not let a merchant with cards go,
 * and its keys go with it; the waits before the address's next links are
 * cleared; the product analytics events naming the account or the merchant
 * go from the outbox, sent or not. A merchant's recorded payout splits stay,
 * since money may still sit at one.
 *
 * Refused, removing nothing, for an account that holds the operator flag
 * (removing the flag first takes its mail and its check for the last
 * operator), for a merchant with an order or a receipt (money history is
 * never deleted to make a test repeatable), and for a merchant another
 * account names too.
 */
export async function forgetIn(
  tx: Statements,
  accountId: string,
  authSecret: string,
): Promise<Forgetting> {
  await lockOperators(tx);
  const [found] = await rowsOf<{ email: string }>(
    tx,
    sql`select email from dashboard_accounts where id = ${accountId}`,
  );
  if (found === undefined) return { kind: "no-account" };
  // The lock a link request and a sign-in for this address take, so neither
  // lands between the reads below and the deletes after them.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`dashboard-email:${found.email}`}, 0))`,
  );
  const [account] = await rowsOf<{
    id: string;
    email: string;
    merchantId: string | null;
    operator: boolean;
  }>(
    tx,
    sql`select id, email, merchant_id as "merchantId", operator
          from dashboard_accounts where id = ${accountId} for update`,
  );
  if (account === undefined) return { kind: "no-account" };
  if (account.operator) return { kind: "operator" };

  let merchant: Extract<Forgetting, { kind: "forgotten" }>["merchant"] = null;
  if (account.merchantId !== null) {
    const id = account.merchantId;
    // Locked, so an order or a card written for this merchant meanwhile waits
    // rather than slipping in after the count.
    const present =
      (await rowsOf(tx, sql`select id from merchants where id = ${id} for update`)).length === 1;
    const [history] = await rowsOf<{ orders: number; receipts: number }>(
      tx,
      sql`select (select count(*) from orders where merchant_id = ${id})::int as orders,
                 (select count(*) from receipts where merchant_id = ${id})::int as receipts`,
    );
    if (history === undefined) throw new Error("dashboard_forget_count_missing");
    if (history.orders > 0 || history.receipts > 0) {
      return { kind: "money-history", merchantId: id, ...history };
    }
    const [others] = await rowsOf<{ n: number }>(
      tx,
      sql`select count(*)::int as n from dashboard_accounts
           where merchant_id = ${id} and id <> ${account.id}`,
    );
    if ((others?.n ?? 0) > 0)
      return { kind: "shared-merchant", merchantId: id, others: others?.n ?? 0 };

    const cards = await rowsOf(tx, sql`delete from cards where merchant_id = ${id} returning id`);
    await tx.execute(sql`delete from merchants where id = ${id}`);
    merchant = { id, present, cards: cards.length };
  }

  await tx.execute(
    sql`delete from commerce_analytics_events
         where refs ->> 'person' = ${account.id} or refs ->> 'merchant' = ${account.merchantId}`,
  );
  await tx.execute(sql`delete from dashboard_accounts where id = ${account.id}`);
  // Sign-in sends are keyed with the dashboard's secret and report-link sends
  // with the digest key kept in the database; a database that never sent a
  // report link has no digest key and no such rows.
  const digestKeys = await rowsOf<{ digestKey: string }>(
    tx,
    sql`select digest_key as "digestKey" from dashboard_report_identity_secrets`,
  );
  const hashes = [authSecret, ...digestKeys.map((row) => row.digestKey)].map((secret) =>
    rateKey(secret, account.email),
  );
  await tx.execute(
    sql`delete from dashboard_link_sends where email_hash in (${sql.join(
      hashes.map((hash) => sql`${hash}`),
      sql`, `,
    )})`,
  );
  return { kind: "forgotten", email: account.email, merchant };
}

/**
 * Gives the channel's configured first operator the flag, under the
 * operators' lock: only while no account holds it and the flag has never been
 * granted, removed or given by the configuration before, as the journal
 * shows, so the configuration counts once and never again, even on a channel
 * that later lost every operator. Hands back the account given the flag, or
 * null where nothing was given.
 */
export async function firstOperatorIn(tx: Statements, email: string): Promise<string | null> {
  await lockOperators(tx);
  if ((await operatorsIn(tx)).length > 0) return null;
  const touched = await rowsOf(
    tx,
    sql`select 1 from operator_journal
         where action in ('first_operator', 'grant_operator', 'remove_operator') limit 1`,
  );
  if (touched.length > 0) return null;
  const [given] = await rowsOf<{ id: string }>(
    tx,
    sql`update dashboard_accounts set operator = true, updated_at = now()
         where email = ${email} returning id`,
  );
  return given?.id ?? null;
}

// In memory, for tests: the same reads and changes over the sign-in
// component's rows, run inside its queued copy of them, which stands in for
// the transaction and its lock. Only the dashboard's own rows are here; the
// gateway's merchant stays in the memory store, which has no way to remove
// one, so a memory forgetting leaves it there.

type Rows = Record<string, Record<string, unknown>[]>;

const accountRows = (rows: Rows) => rows.dashboard_accounts ?? [];

const liveAt = (session: Record<string, unknown>, now: Date): boolean =>
  new Date(session.expiresAt as Date).getTime() > now.getTime();

const summaryInMemory = (
  rows: Rows,
  account: Record<string, unknown>,
  now: Date,
): AccountSummary => {
  const open = (rows.dashboard_sessions ?? []).filter(
    (session) => session.userId === account.id && liveAt(session, now),
  );
  const newest = Math.max(...open.map((session) => new Date(session.createdAt as Date).getTime()));
  return {
    id: String(account.id),
    email: String(account.email),
    createdAt: new Date(account.createdAt as Date),
    merchantId: typeof account.merchantId === "string" ? account.merchantId : null,
    operator: account.operator === true,
    openSessions: open.length,
    newestSession: open.length === 0 ? null : new Date(newest),
  };
};

export function listedInMemory(rows: Rows, now: Date): AccountsListing {
  const all = accountRows(rows);
  const listing = (account: Record<string, unknown>) =>
    typeof account.merchantId === "string" || account.operator === true;
  return {
    listed: all.filter(listing).map((account) => summaryInMemory(rows, account, now)),
    unlisted: all.filter((account) => !listing(account)).length,
  };
}

export function summaryInMemoryOf(rows: Rows, accountId: string, now: Date): AccountSummary | null {
  const account = accountRows(rows).find((one) => one.id === accountId);
  return account === undefined ? null : summaryInMemory(rows, account, now);
}

export function endSessionsInMemory(
  rows: Rows,
  accountId: string,
  now: Date,
): "ended" | "none" | "no-account" {
  if (!accountRows(rows).some((one) => one.id === accountId)) return "no-account";
  const sessions = rows.dashboard_sessions ?? [];
  const ending = sessions.filter((session) => session.userId === accountId);
  rows.dashboard_sessions = sessions.filter((session) => session.userId !== accountId);
  return ending.some((session) => liveAt(session, now)) ? "ended" : "none";
}

const operatorsInMemory = (rows: Rows) =>
  accountRows(rows)
    .filter((one) => one.operator === true)
    .map((one) => ({ id: String(one.id), email: String(one.email) }));

export async function setFlagInMemory(
  rows: Rows,
  accountId: string,
  on: boolean,
  tell: Parameters<typeof setFlagIn>[3],
): Promise<FlagChange> {
  const account = accountRows(rows).find((one) => one.id === accountId);
  if (account === undefined) return "no-account";
  if ((account.operator === true) === on) return "unchanged";
  const before = operatorsInMemory(rows);
  if (!on && before.every((one) => one.id === accountId)) return "last-operator";
  account.operator = on;
  account.updatedAt = new Date();
  await tell(before, { id: String(account.id), email: String(account.email) });
  return "changed";
}

export function forgetInMemory(rows: Rows, accountId: string): Forgetting {
  const account = accountRows(rows).find((one) => one.id === accountId);
  if (account === undefined) return { kind: "no-account" };
  if (account.operator === true) return { kind: "operator" };
  const merchantId = typeof account.merchantId === "string" ? account.merchantId : null;
  if (merchantId !== null) {
    const others = accountRows(rows).filter(
      (one) => one.merchantId === merchantId && one.id !== accountId,
    ).length;
    if (others > 0) return { kind: "shared-merchant", merchantId, others };
  }
  for (const [table, column] of [
    ["dashboard_accounts", "id"],
    ["dashboard_sessions", "userId"],
    ["dashboard_credentials", "userId"],
  ] as const) {
    rows[table] = (rows[table] ?? []).filter((row) => row[column] !== accountId);
  }
  rows.dashboard_link_sends = [];
  return {
    kind: "forgotten",
    email: String(account.email),
    merchant: merchantId === null ? null : { id: merchantId, present: true, cards: 0 },
  };
}

/** The account the configured first operator's flag goes to, given here, or null where none is due. */
export function firstOperatorInMemory(
  rows: Rows,
  email: string,
  flagTouched: boolean,
): string | null {
  if (flagTouched || operatorsInMemory(rows).length > 0) return null;
  const account = accountRows(rows).find((one) => one.email === email);
  if (account === undefined) return null;
  account.operator = true;
  return String(account.id);
}
