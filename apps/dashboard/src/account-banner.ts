/**
 * The account banner's reasons, from what was read and nothing else: a fact
 * that could not be read names no reason that rests on it, because a guessed
 * "all is well" and a guessed "this is missing" are both claims nothing stands
 * behind, and the banner says instead that it could not check.
 */

import type { Integration } from "@agentify/gateway";
import type { MerchantFinding, SellingState } from "@nuanu-ai/agentify-contracts";
import { readinessSeenBy, type Viewer } from "./viewer.js";
import { ACCOUNT_WORDS, type AccountReason, type Way } from "./words.js";

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

/** The order the banner says them in, broadest first. */
const ORDER: readonly AccountReason[] = [
  "paused",
  "not_approved",
  "no_seller_name",
  "no_payout_wallet",
  "through_shop",
  "unread",
];

const noteOf = (reason: AccountReason): AccountNote => ({ reason, ...ACCOUNT_WORDS[reason] });

/** Empty where the account is selling as usual and every fact was read. */
export const accountOf = (viewer: Viewer, read: AccountRead = {}): readonly AccountNote[] => {
  const found = new Set<AccountReason>(
    readinessSeenBy(viewer).missing.flatMap((finding) =>
      finding === "no_seller_site" ? [] : [FROM_FINDING[finding]],
    ),
  );
  const selling = read.selling === undefined ? null : FROM_SELLING[read.selling];
  if (selling !== null) found.add(selling);
  if (read.through === "woocommerce") found.add("through_shop");
  if (read.unread === true) found.add("unread");
  return ORDER.filter((reason) => found.has(reason)).map(noteOf);
};
