/**
 * The sentences every screen of the operator's workspace says the same way.
 * An area's own sentences live with its screen.
 */

/** A press whose answer was lost: the change may have been made or not. */
export const LOST_ANSWER =
  "The answer was lost, so we don't know if this went through. Pressing again is safe.";

/** A figure the application failed to read, never drawn as a zero. */
export const COULD_NOT_BE_READ = "Could not be read";

/** Under every box that asks for a reason. */
export const REASON_IS_KEPT =
  "Saved in the journal for every operator. Do not name a buyer or paste their details.";

/** A press whose consequence box was left unticked. */
export const NOT_CONFIRMED = "Tick the box to confirm. Nothing was changed.";

/** A press that asks for a reason and was sent without one. */
export const NO_REASON = "Write the reason. Nothing was changed.";

/** After every press that went through: where it is recorded. */
export const IN_THE_JOURNAL = "Recorded in the journal.";
