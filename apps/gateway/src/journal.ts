/**
 * The operator's journal as the dashboard uses it: the shape of a row, the
 * rule a reason is held to, and the write a dashboard action makes inside its
 * own transaction, so the change and its row commit together. Gateway actions
 * take their row into the store's own transaction instead.
 */

export { type JournalWriter, journalAlong } from "./adapters/postgres/journal.js";
export {
  checkedJournalEntry,
  JOURNAL_ACTIONS,
  JOURNAL_PAGE_MAX,
  JOURNAL_REASON_MAX,
  type JournalAction,
  type JournalActor,
  type JournalEntry,
  type JournalOutcome,
  type JournalPage,
  type JournalPress,
  type JournalQuery,
  JournalReasonSchema,
  type JournalRow,
  type JournalSubject,
  merchantOfSubject,
  settledPress,
} from "./ports/journal.js";
