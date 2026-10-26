/**
 * The account banner's reasons, from what was read and nothing else: a fact
 * that could not be read names no reason that rests on it, because a guessed
 * "all is well" and a guessed "this is missing" are both claims nothing stands
 * behind, and the banner says instead that it could not check.
 */

import type { MerchantFinding, SellingState } from "@nuanu-ai/agentify-contracts";
import { moment } from "./moments.js";
import { readinessSeenBy, type Viewer } from "./viewer.js";
import { type MomentView, momentView } from "./views.js";
import {
  ACCOUNT_WORDS,
  type AccountReason,
  LIVE_SALES_STOPPED,
  liveSalesStoppedSince,
  notConnectedSince,
  type Way,
} from "./words.js";

/**
 * A change of the payout wallet that waits to apply: the address it goes to,
 * when, and the wallet paid now, which its cancel carries back with the
 * change, so a press that arrives after the change applied is not taken for
 * a cancel.
 */
export interface WalletChangeNote {
  readonly wallet: string;
  readonly from: MomentView;
  readonly takesEffectAt: string;
  readonly paid: string | null;
}

/** One reason as the banner says it. */
export interface AccountNote {
  readonly reason: AccountReason;
  readonly title: string;
  readonly says: string;
  readonly fix: Way | null;
  /** On the waiting change of the wallet alone. */
  readonly change?: WalletChangeNote;
}

/** What was read beside the viewer; absent is not read. */
export interface AccountRead {
  readonly selling?: SellingState;
  /** True where a read was asked for and failed. */
  readonly unread?: boolean;
  /**
   * Present while the merchant's cards are off sale because their
   * integration has not connected: when it last did, as an ISO instant, or
   * null where it never has.
   */
  readonly outOfTouch?: { readonly since: string | null };
  /** True while as many purchases wait for payment as Agentify allows, so new ones are refused. */
  readonly busy?: boolean;
  /** True while as many paid orders are left unserved as Agentify allows, so new purchases are refused. */
  readonly unserved?: boolean;
  /**
   * Present while Agentify's withdrawal of the merchant's admission to live
   * sales stands: when, as an ISO instant, and the note written for them.
   */
  readonly withdrawn?: { readonly at: string; readonly note: string | null };
  /** Present while a change of the payout wallet waits: to what, and when it applies, as an ISO instant. */
  readonly walletChange?: { readonly wallet: string; readonly takesEffectAt: string };
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
 * The order the banner says them in: a waiting change of the wallet first,
 * since it is the one a stranger with a session would want unseen, then what
 * the merchant puts right themselves, then what Agentify lifts, then what
 * lifts by itself, and last that something could not be read.
 */
const ORDER: readonly AccountReason[] = [
  "wallet_change",
  "paused",
  "no_seller_name",
  "no_payout_wallet",
  "out_of_touch",
  "not_approved",
  "busy",
  "unserved",
  "unread",
];

const noteOf = (reason: AccountReason, read: AccountRead, paid: string | null): AccountNote => {
  const change = read.walletChange;
  if (reason === "wallet_change" && change !== undefined) {
    return {
      reason,
      ...ACCOUNT_WORDS[reason],
      change: { ...change, from: momentView(change.takesEffectAt), paid },
    };
  }
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
  if (read.unserved === true) found.add("unserved");
  if (read.unread === true) found.add("unread");
  if (read.walletChange !== undefined) found.add("wallet_change");
  return ORDER.filter((reason) => found.has(reason)).map((reason) =>
    noteOf(reason, read, viewer.payout?.wallet ?? null),
  );
};
