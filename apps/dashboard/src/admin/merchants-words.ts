/**
 * What the workspace's Merchants list and a merchant's page say, in the
 * dashboard's vocabulary. It imports nothing that runs on the server, so the
 * screens can import it.
 */

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

/** The setup's dots, in the order the live channel checks them. */
export const CHECK_WORDS = Object.freeze({
  no_seller_name: "name",
  no_payout_wallet: "wallet",
  no_operator_approval: "admission",
} as const);

/** What the dots say in words: every check held, or which are missing. */
export const checksSaid = (missing: readonly string[], asked: number): string => {
  if (missing.length === 0)
    return asked === 3 ? "All three hold" : asked === 2 ? "Both hold" : "It holds";
  const named = missing.join(", ");
  return `${named.slice(0, 1).toUpperCase()}${named.slice(1)} missing`;
};

export const NO_SELLER_NAME = "Seller name not set";

/** Under the list: which rows of how many. */
export const SORTED = "Sorted by what needs you, then by the last sale";

export const DOTS_EXPLAINED_LIVE =
  "The three dots are the checks the live channel runs before it sells a merchant's card, in order: seller name, payout wallet, admission. A hollow dot is missing; the words beside the dots say which.";

export const DOTS_EXPLAINED_TEST =
  "The two dots are the checks this channel runs before it sells a merchant's card, in order: seller name and payout wallet. A hollow dot is missing; the words beside the dots say which. Admission is the live channel's alone.";

export const DOT_EXPLAINED_SANDBOX =
  "The dot is the one check the sandbox runs before it sells a merchant's card: the seller name. A hollow dot is missing.";

/** Where the search of addresses stopped at the most it reads. */
export const ACCOUNTS_CUT =
  "Many accounts' addresses hold these words, and the search looked at the first two hundred only; type more of the address to find the rest.";

/** Where the search could not look at accounts' addresses. */
export const ACCOUNTS_UNREAD =
  "The accounts could not be read just now, so addresses are not shown and the search did not look at them. Read the page again to try.";

/** The panel's sentence over the checks, by channel. */
export const READY_SAID_LIVE =
  "The first two and the last are the checks the gateway runs at every live sale";
export const READY_SAID_TEST = "The first two are the checks the gateway runs at every sale here";

/** Under every merchant's page: what it never does. */
export const boundSaid = (name: string): string =>
  `This page edits nothing ${name} chose and no order. Its wallet, cards and the name it picks change in ${name}'s own dashboard; an operator can disable a key and admit or withdraw the admission, each behind a fresh sign-in.`;

/** The withdrawal's note box: the merchant reads it. */
export const WITHDRAWAL_NOTE = Object.freeze({
  label: "Note to the merchant",
  hint: "The merchant reads this on their own dashboard while the withdrawal stands, and it is kept in the journal. Say what they can do about it; do not name a buyer or paste their details.",
  missing:
    "Write the note to the merchant; they read it on their dashboard while the withdrawal stands. Nothing was changed.",
});

/** Why a press on a merchant was refused, as the sentence under its button. */
export const REFUSED_WORDS: Readonly<Record<string, string>> = Object.freeze({
  not_live_channel:
    "Admission is decided on the live channel; this channel asks none. Nothing was changed.",
  no_such_merchant: "There is no such merchant any more. Nothing was changed.",
  no_such_key: "That key is not one of this merchant's. Nothing was changed.",
});
