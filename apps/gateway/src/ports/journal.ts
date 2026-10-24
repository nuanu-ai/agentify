/**
 * The operator's journal: one row for every administrative action an operator
 * presses after the operator flag confirmed them, and for every press refused
 * after that check. A row names people and merchants by identifier only, never
 * by an address or a name, so erasing a person leaves their rows with an
 * identifier that no longer resolves. The application only ever adds rows.
 *
 * An action and its row commit together: a store method that makes an
 * administrative change takes the row's press and settles its outcome in the
 * same write, "done" where the call changed something and "unchanged" where
 * it found the change already made. A refused press changes nothing and is
 * written on its own.
 */

import { notPlainTextIn } from "@nuanu-ai/agentify-contracts";
import { z } from "zod";

/** The closed list of what an operator can do, as the journal names it. */
export const JOURNAL_ACTIONS = [
  "admit",
  "withdraw",
  "disable_key",
  "end_sessions",
  "grant_operator",
  "remove_operator",
  "forget_account",
  "first_operator",
] as const;

export type JournalAction = (typeof JOURNAL_ACTIONS)[number];

/**
 * Who acted: an account, by identifier; a command typed at the channel's host,
 * which does not know who typed it; or the channel's configuration, which names
 * its first operator.
 */
export type JournalActor =
  | Readonly<{ kind: "account"; id: string }>
  | Readonly<{ kind: "terminal" }>
  | Readonly<{ kind: "configuration" }>;

/** What was acted on. A key carries its merchant, so a merchant's history holds its keys' rows. */
export type JournalSubject =
  | Readonly<{ kind: "merchant"; id: string }>
  | Readonly<{ kind: "account"; id: string }>
  | Readonly<{ kind: "key"; id: string; merchantId: string }>;

export type JournalOutcome =
  | Readonly<{ kind: "done" }>
  | Readonly<{ kind: "unchanged" }>
  | Readonly<{ kind: "refused"; code: string }>;

/** A press as an administrative store write is handed it; the write settles its outcome. */
export interface JournalPress {
  readonly at: number;
  readonly actor: JournalActor;
  readonly action: JournalAction;
  readonly subject: JournalSubject;
  /** What the operator wrote, or null for an action that asks for none (an admission). */
  readonly reason: string | null;
}

export interface JournalEntry extends JournalPress {
  readonly outcome: JournalOutcome;
}

/** A row as it is read back: its place in the journal, which only grows, and what it holds. */
export interface JournalRow extends JournalEntry {
  readonly sequence: number;
}

/** The longest reason, counted as a person counts characters: a merchant's closing message's bound. */
export const JOURNAL_REASON_MAX = 2000;

/**
 * A reason as an operator types it: words, at most `JOURNAL_REASON_MAX`
 * characters, plain text on as many lines as it needs. It is shown back on
 * every page of the journal, so markup and control characters are refused.
 */
export const JournalReasonSchema = z
  .string()
  .regex(/\S/, "a reason contains words")
  .refine(
    (text) => [...text].length <= JOURNAL_REASON_MAX,
    `a reason is at most ${JOURNAL_REASON_MAX} characters`,
  )
  .superRefine((text, ctx) => {
    for (const finding of notPlainTextIn(text, "several lines")) {
      ctx.addIssue({
        code: "custom",
        message: `a reason carries ${finding}, and it is plain text`,
      });
    }
  });

/** A refusal's code: a short word in lower case, which the screen turns into a sentence. */
const REFUSAL_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** An identifier as the product makes them: no spaces, no markup, bounded. */
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Throws on an entry the table would refuse, before anything is written, so
 * both adapters refuse the same entries and a refusal fails the write it was
 * to be recorded with.
 */
export function checkedJournalEntry(entry: JournalEntry): JournalEntry {
  const wrong: string[] = [];
  if (!Number.isFinite(entry.at)) wrong.push("its moment is no moment");
  if (!JOURNAL_ACTIONS.includes(entry.action))
    wrong.push("its action is not one the journal knows");
  if (entry.actor.kind === "account" && !IDENTIFIER.test(entry.actor.id)) {
    wrong.push("its actor is not an account's identifier");
  }
  if (!IDENTIFIER.test(entry.subject.id)) wrong.push("its subject is not an identifier");
  if (entry.subject.kind === "key" && !IDENTIFIER.test(entry.subject.merchantId)) {
    wrong.push("its key's merchant is not an identifier");
  }
  if (entry.reason !== null && !JournalReasonSchema.safeParse(entry.reason).success) {
    wrong.push("its reason is not one an operator can write");
  }
  if (entry.outcome.kind === "refused" && !REFUSAL_CODE.test(entry.outcome.code)) {
    wrong.push("its refusal has no code");
  }
  if (wrong.length > 0) {
    throw new Error(`a journal row was refused: ${wrong.join("; ")}`);
  }
  return entry;
}

/** The merchant a row is about: the merchant itself, or a key's merchant; null for an account. */
export const merchantOfSubject = (subject: JournalSubject): string | null =>
  subject.kind === "merchant" ? subject.id : subject.kind === "key" ? subject.merchantId : null;

/** The entry a store write commits for a press it was handed, by whether the call changed anything. */
export const settledPress = (press: JournalPress, changed: boolean): JournalEntry => ({
  ...press,
  outcome: { kind: changed ? "done" : "unchanged" },
});

/**
 * Which rows to read: about one merchant (its keys' rows included) or one
 * account, of one action, newest first, at most `limit` of them, starting
 * after the row `before` names.
 */
export interface JournalQuery {
  readonly about?: Readonly<{ merchant: string }> | Readonly<{ account: string }>;
  readonly action?: JournalAction;
  readonly limit: number;
  /** The `sequence` of the last row of the page before, whose `next` it is. */
  readonly before?: number;
}

/**
 * One page of the journal: its rows, how many rows match the query in all, and
 * where the next page starts, or null where this page holds the oldest.
 */
export interface JournalPage {
  readonly rows: readonly JournalRow[];
  readonly total: number;
  readonly next: number | null;
}

/** The most rows one read hands back, whatever it asked for. */
export const JOURNAL_PAGE_MAX = 200;

/**
 * A query's limit, held between one and the page's most; one that is no number,
 * as a malformed address gives, reads as the page's most.
 */
export const journalLimitOf = (query: JournalQuery): number =>
  Number.isNaN(query.limit)
    ? JOURNAL_PAGE_MAX
    : Math.max(1, Math.min(JOURNAL_PAGE_MAX, Math.floor(query.limit)));

/** Whether a row answers a query's filters, as the SQL's predicate does. */
export const answersQuery = (row: JournalEntry, query: JournalQuery): boolean => {
  if (query.action !== undefined && row.action !== query.action) return false;
  const about = query.about;
  if (about === undefined) return true;
  return "merchant" in about
    ? merchantOfSubject(row.subject) === about.merchant
    : row.subject.kind === "account" && row.subject.id === about.account;
};
