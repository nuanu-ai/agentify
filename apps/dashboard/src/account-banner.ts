/**
 * The account banner's reasons, from what was read and nothing else: a fact
 * that could not be read names no reason that rests on it, because a guessed
 * "all is well" and a guessed "this is missing" are both claims nothing stands
 * behind, and the banner says instead that it could not check.
 */

import type { Integration } from "@agentify/gateway";
import type { MerchantFinding, SellingState } from "@nuanu-ai/agentify-contracts";
import { readinessSeenBy, type Viewer } from "./viewer.js";
import { ACCOUNT_WORDS, type AccountReason, moment, notConnectedSince, type Way } from "./words.js";

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
  readonly through?: Integration;
  /** True where a read was asked for and failed. */
  readonly unread?: boolean;
  /**
   * Present while purchases that charge before delivery are refused because
   * the merchant's integration has not connected: when it last did, as an ISO
   * instant, or null where it never has.
   */
  readonly outOfTouch?: { readonly since: string | null };
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
  departed: "left",
};

/** The order the banner says them in, broadest first. */
const ORDER: readonly AccountReason[] = [
  "paused",
  "not_approved",
  "no_seller_name",
  "no_payout_wallet",
  "out_of_touch",
  "through_shop",
  "unread",
];

const noteOf = (reason: AccountReason, read: AccountRead): AccountNote => {
  const since = read.outOfTouch?.since;
  return reason === "out_of_touch" && typeof since === "string"
    ? { reason, ...ACCOUNT_WORDS[reason], says: notConnectedSince(moment(since)) }
    : { reason, ...ACCOUNT_WORDS[reason] };
};

/**
 * Empty where the account is selling as usual and every fact was read.
 * Leaving is said alone: nothing else on the list would put a card back on
 * sale once a merchant has left.
 */
export const accountOf = (viewer: Viewer, read: AccountRead = {}): readonly AccountNote[] => {
  if (read.selling === "departed") return [noteOf("left", read)];
  const found = new Set<AccountReason>(
    readinessSeenBy(viewer).missing.flatMap((finding) =>
      finding === "no_seller_site" ? [] : [FROM_FINDING[finding]],
    ),
  );
  const selling = read.selling === undefined ? null : FROM_SELLING[read.selling];
  if (selling !== null) found.add(selling);
  if (read.through === "woocommerce") found.add("through_shop");
  if (read.outOfTouch !== undefined) found.add("out_of_touch");
  if (read.unread === true) found.add("unread");
  return ORDER.filter((reason) => found.has(reason)).map((reason) => noteOf(reason, read));
};
