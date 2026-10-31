/**
 * The operator's journal on Postgres. A row is written inside the transaction
 * of the change it records, by the store for a gateway action and by the
 * dashboard for one of its own, so the two commit or neither does; a refused
 * press is a transaction of its own. Unlike an analytics event, a row that
 * cannot be written fails the transaction it was written in: an action the
 * journal cannot record does not happen.
 */

import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  lt,
  notExists,
  type SQL,
  sql,
} from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  checkedJournalEntry,
  type JournalAction,
  type JournalActor,
  type JournalEntry,
  type JournalOutcome,
  type JournalPage,
  type JournalQuery,
  type JournalRow,
  type JournalSubject,
  journalLimitOf,
  merchantOfSubject,
} from "../../ports/journal.js";
import { merchants, operatorJournal } from "./schema.js";

/**
 * A drizzle node-postgres database or a transaction on one, whatever schema it
 * was made with: the store's, or the dashboard's.
 */
export type JournalWriter = Pick<NodePgDatabase, "insert">;

type Columns = typeof operatorJournal.$inferSelect;

/**
 * Writes one row in `tx`, the transaction of the change it records, and hands
 * it back as read. Throws, failing that transaction, on a row the journal's
 * rules refuse.
 */
export async function journalAlong(tx: JournalWriter, entry: JournalEntry): Promise<JournalRow> {
  const checked = checkedJournalEntry(entry);
  const [row] = await tx
    .insert(operatorJournal)
    .values({
      at: new Date(checked.at),
      actorKind: checked.actor.kind,
      actorId: checked.actor.kind === "account" ? checked.actor.id : null,
      action: checked.action,
      subjectKind: checked.subject.kind,
      subjectId: checked.subject.id,
      subjectMerchant: merchantOfSubject(checked.subject),
      reason: checked.reason,
      outcome: checked.outcome.kind,
      refusal: checked.outcome.kind === "refused" ? checked.outcome.code : null,
    })
    .returning();
  if (row === undefined) throw new Error("the journal row was not written");
  return journalRowOf(row);
}

/** The rows a query asks for, newest first, and how many match in all. */
export async function readJournal(
  db: Pick<NodePgDatabase, "select">,
  query: JournalQuery,
): Promise<JournalPage> {
  const filters: SQL[] = [];
  if (query.actions !== undefined) {
    filters.push(
      query.actions.length === 0 ? sql`false` : inArray(operatorJournal.action, [...query.actions]),
    );
  }
  const about = query.about;
  if (about !== undefined) {
    if ("merchant" in about) {
      filters.push(eq(operatorJournal.subjectMerchant, about.merchant));
    } else {
      filters.push(
        eq(operatorJournal.subjectKind, "account"),
        eq(operatorJournal.subjectId, about.account),
      );
    }
  }
  const limit = journalLimitOf(query);
  const from = query.from;
  const back = from !== undefined && "before" in from;
  const past =
    from === undefined
      ? undefined
      : "after" in from
        ? lt(operatorJournal.sequence, from.after)
        : gt(operatorJournal.sequence, from.before);
  // Going on, the rows short of the cursor precede the page; going back, the
  // ones past it are the page and every row before it.
  const ahead = past === undefined ? sql`false` : back ? past : sql`not (${past})`;
  // One more than the page, to tell whether the journal goes on past it.
  const [read, [counted]] = await Promise.all([
    db
      .select()
      .from(operatorJournal)
      .where(and(...filters, past))
      .orderBy(back ? asc(operatorJournal.sequence) : desc(operatorJournal.sequence))
      .limit(limit + 1),
    db
      .select({
        total: count(),
        ahead: sql<number>`(count(*) filter (where ${ahead}))::int`,
      })
      .from(operatorJournal)
      .where(and(...filters)),
  ]);
  const page = read.slice(0, limit).map(journalRowOf);
  if (back) page.reverse();
  const total = counted?.total ?? 0;
  const aheadOf = counted?.ahead ?? 0;
  const newer = back ? aheadOf - page.length : aheadOf;
  const older = back ? total - aheadOf > 0 : read.length > limit;
  return {
    rows: page,
    total,
    newer,
    previous: newer > 0 ? (page[0]?.sequence ?? null) : null,
    next: older ? (page.at(-1)?.sequence ?? null) : null,
  };
}

/**
 * The newest done admission or withdrawal of one merchant, read through the
 * merchant's index, handed back only where it is a withdrawal and the merchant
 * is not admitted now: a grant made with no row still admits.
 */
export async function readStandingWithdrawal(
  db: Pick<NodePgDatabase, "select">,
  merchantId: string,
): Promise<JournalRow | null> {
  const [last] = await db
    .select()
    .from(operatorJournal)
    .where(
      and(
        eq(operatorJournal.subjectMerchant, merchantId),
        eq(operatorJournal.subjectKind, "merchant"),
        eq(operatorJournal.outcome, "done"),
        inArray(operatorJournal.action, ["admit", "withdraw"]),
        notExists(
          db
            .select({ id: merchants.id })
            .from(merchants)
            .where(and(eq(merchants.id, merchantId), isNotNull(merchants.liveApprovedAt))),
        ),
      ),
    )
    .orderBy(desc(operatorJournal.sequence))
    .limit(1);
  return last?.action === "withdraw" ? journalRowOf(last) : null;
}

export function journalRowOf(row: Columns): JournalRow {
  const actor: JournalActor =
    row.actorKind === "account"
      ? { kind: "account", id: row.actorId ?? "" }
      : row.actorKind === "terminal"
        ? { kind: "terminal" }
        : { kind: "configuration" };
  const subject: JournalSubject =
    row.subjectKind === "key"
      ? { kind: "key", id: row.subjectId, merchantId: row.subjectMerchant ?? "" }
      : row.subjectKind === "account"
        ? { kind: "account", id: row.subjectId }
        : { kind: "merchant", id: row.subjectId };
  const outcome: JournalOutcome =
    row.outcome === "refused"
      ? { kind: "refused", code: row.refusal ?? "" }
      : row.outcome === "unchanged"
        ? { kind: "unchanged" }
        : { kind: "done" };
  return {
    sequence: row.sequence,
    at: row.at.getTime(),
    actor,
    action: row.action as JournalAction,
    subject,
    reason: row.reason,
    outcome,
  };
}
