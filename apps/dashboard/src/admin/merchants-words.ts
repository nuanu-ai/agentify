/**
 * What the workspace's Merchants list and a merchant's page say, in the
 * dashboard's vocabulary. It imports nothing that runs on the server, so the
 * screens can import it.
 */

import { inChannel } from "@agentify/ui/workspace-view";
import type { Word } from "../words.js";

/** The list's segments, in the order the row of segments draws them. */
export const SEGMENT_WORDS = Object.freeze({
  all: "All",
  waiting: "Waiting for admission",
  selling: "Selling",
  setting_up: "Setting up",
  paused: "Paused",
} as const);

/** A merchant's state, as the list's last column and a merchant's head draw it. */
export const STATE_WORDS = Object.freeze({
  waiting: { text: "Waiting for admission", tone: "waiting" },
  selling: { text: "Selling", tone: "ok" },
  setting_up: { text: "Setting up", tone: "quiet" },
  paused: { text: "Paused", tone: "quiet" },
} as const satisfies Readonly<Record<string, Word>>);

/** A merchant whose admission an operator withdrew, while that stands. */
export const WITHDRAWN_WORD: Word = { text: "Admission withdrawn", tone: "warn" };

/** The checks a sale is held to, in the order the live channel runs them. */
export const CHECK_WORDS = Object.freeze({
  no_seller_name: "seller name",
  no_payout_wallet: "wallet",
  no_operator_approval: "admission",
} as const);

/** What a merchant lacks before it can sell, in words, or that it lacks nothing. */
export const missingSaid = (missing: readonly string[]): string => {
  if (missing.length === 0) return "Nothing";
  const named = missing.join(", ");
  return `${named.slice(0, 1).toUpperCase()}${named.slice(1)}`;
};

/** Said under a merchant listed by its site or address, having chosen no name. */
export const NO_SELLER_NAME = "No seller name";

/** Under the list: which rows of how many. */
export const SORTED = "Sorted by what needs you, then by the last sale";

/** Where the search of addresses stopped at the most it reads. */
export const ACCOUNTS_CUT =
  "Many accounts' addresses hold these words, and the search looked at the first two hundred only; type more of the address to find the rest.";

/** Where the search could not look at accounts' addresses. */
export const ACCOUNTS_UNREAD =
  "Account emails could not be read, so they are missing here and the search skipped them. Read the page again to try again.";

/** The withdrawal's note box: the merchant reads it. */
export const WITHDRAWAL_NOTE = Object.freeze({
  label: "Note to the merchant",
  hint: "The merchant sees this note on their dashboard, and it stays in the journal. Say what they can do. Do not name a buyer or paste their details.",
  missing: "Write a note for the merchant. Nothing was changed.",
});

/** Why a press on a merchant was refused, as the sentence under its button. */
export const REFUSED_WORDS: Readonly<Record<string, string>> = Object.freeze({
  not_live_channel: `Admission is decided ${inChannel("live")}, and none is asked here. Nothing was changed.`,
  no_such_merchant: "There is no such merchant any more. Nothing was changed.",
  no_such_key: "That key is not one of this merchant's. Nothing was changed.",
});
