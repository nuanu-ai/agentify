/**
 * The operator's journal as the dashboard uses it: the shape of a row, the
 * rule a reason is held to, and the write a dashboard action makes inside its
 * own transaction, so the change and its row commit together. Gateway actions
 * take their row into the store's own transaction instead.
 */

export { journalAlong } from "./adapters/postgres/journal.js";
export {
  checkedJournalEntry,
  type JournalAction,
  type JournalEntry,
  type JournalPage,
  type JournalPress,
  JournalReasonSchema,
  type JournalRow,
  type JournalSubject,
  settledPress,
} from "./ports/journal.js";
