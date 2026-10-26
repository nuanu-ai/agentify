/**
 * The account banner's reasons, from what was read and nothing else: a fact
 * that could not be read names no reason that rests on it, because a guessed
 * "all is well" and a guessed "this is missing" are both claims nothing stands
 * behind, and the banner says instead that it could not check.
 */

import type { MerchantFinding, SellingState } from "@nuanu-ai/agentify-contracts";
import { readinessSeenBy, type Viewer } from "./viewer.js";
import {
  ACCOUNT_WORDS,
  type AccountReason,
  LIVE_SALES_STOPPED,
  liveSalesStoppedSince,
  moment,
  notConnectedSince,
  OFF_SALE,
  type Way,
} from "./words.js";

/** One reason as the banner says it. */
export interface AccountNote {
  readonly reason: AccountReason;
  readonly title: string;
  readonly says: string;
  readonly fix: Way | null;
}

/** What was read beside the viewer; absent is not read. */
export interface AccountRead {
  readonly selling?: SellingState;
  /** True where a read was asked for and failed. */
  readonly unread?: boolean;
  /**
   * Present while purchases that charge before delivery are refused because
   * the merchant's integration has not connected: when it last did, as an ISO
   * instant, or null where it never has.
   */
  readonly outOfTouch?: { readonly since: string | null };
  /** True while as many purchases wait for payment as Agentify allows, so new ones are refused. */
  readonly busy?: boolean;
  /**
   * Present while Agentify's withdrawal of the merchant's admission to live
   * sales stands: when, as an ISO instant, and the note written for them.
   */
  readonly withdrawn?: { readonly at: string; readonly note: string | null };
}

/**
 * Total by its type, so a code added to the contract does not compile here
 * until somebody says which reason it is.
 */
const FROM_FINDING: Readonly<Record<Exclude<MerchantFinding, "no_seller_site">, AccountReason>> = {
  no_operator_approval: "not_approved",
  no_seller_name: "no_seller_name",
  no_payout_wallet: "no_payout_wallet",
};

const FROM_SELLING: Readonly<Record<SellingState, AccountReason | null>> = {
  open: null,
  paused: "paused",
};

/**
 * The order the banner says them in: what the merchant puts right themselves
 * first, then what Agentify lifts, then what lifts by itself, and last that
 * something could not be read.
 */
const ORDER: readonly AccountReason[] = [
  "paused",
  "no_seller_name",
  "no_payout_wallet",
  "out_of_touch",
  "not_approved",
  "busy",
  "unread",
];

/** The reasons that each keep every product off sale. */
const KEEP_OFF_SALE: ReadonlySet<AccountReason> = new Set([
  "paused",
  "no_seller_name",
  "no_payout_wallet",
  "not_approved",
]);

const noteOf = (reason: AccountReason, read: AccountRead): AccountNote => {
  const since = read.outOfTouch?.since;
  if (reason === "out_of_touch" && typeof since === "string") {
    return { reason, ...ACCOUNT_WORDS[reason], says: notConnectedSince(moment(since)) };
  }
  // Not approved because Agentify stopped the merchant's live sales: said as
  // that, with its moment and the note, in place of "not approved yet".
  if (reason === "not_approved" && read.withdrawn !== undefined) {
    return {
      reason,
      title: LIVE_SALES_STOPPED,
      says: liveSalesStoppedSince(moment(read.withdrawn.at), read.withdrawn.note),
      fix: null,
    };
  }
  return { reason, ...ACCOUNT_WORDS[reason] };
};

/** Empty where the account is selling as usual and every fact was read. */
export const accountOf = (viewer: Viewer, read: AccountRead = {}): readonly AccountNote[] => {
  const found = new Set<AccountReason>(
    readinessSeenBy(viewer).missing.flatMap((finding) =>
      finding === "no_seller_site" ? [] : [FROM_FINDING[finding]],
    ),
  );
  const selling = read.selling === undefined ? null : FROM_SELLING[read.selling];
  if (selling !== null) found.add(selling);
  if (read.outOfTouch !== undefined) found.add("out_of_touch");
  if (read.busy === true) found.add("busy");
  if (read.unread === true) found.add("unread");
  return ORDER.filter((reason) => found.has(reason)).map((reason) => noteOf(reason, read));
};

/**
 * One reason is headed by its own title; several by what they come to
 * together where one of them keeps every product off sale, and otherwise by
 * the first.
 */
export const headingOf = (notes: readonly AccountNote[]): string => {
  const [first] = notes;
  if (first === undefined) return "";
  return notes.length > 1 && notes.some((note) => KEEP_OFF_SALE.has(note.reason))
    ? OFF_SALE
    : first.title;
};
