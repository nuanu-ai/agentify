/**
 * The one place wire values become words a merchant reads, so a state does not
 * have one name on the orders screen and another on the receipts screen. Every
 * map is total over its vocabulary and a test walks each one: a status with no
 * word would reach a merchant as `undefined` or a raw wire value, and the
 * states added later are the rare ones a merchant cannot guess.
 *
 * Two words are deliberately weak. `in_progress` folds an order the merchant
 * has taken on with one that was priced and never paid (`order-status.ts` says
 * why), so it reads "in progress" and nothing about fulfilment or delivery,
 * which would show an unpaid request as goods the merchant owes.
 * `payment_unresolved` reads as a question, because we asked the payment
 * network and heard nothing, which is not the same as nothing being charged.
 */

import type {
  Fulfillment,
  MerchantFinding,
  OrderStatus,
  SellingState,
} from "@nuanu-ai/agentify-contracts";

export type Tone = "ok" | "warn" | "busy" | "quiet";

export interface Word {
  readonly text: string;
  readonly tone: Tone;
}

/**
 * Endings that cost the merchant something are `warn`, those that cost nobody
 * are quiet. Only `delivered` and `shipped` are `ok`: the goods have gone to
 * the buyer and the money is the merchant's.
 */
export const ORDER_WORDS: Readonly<Record<OrderStatus, Word>> = Object.freeze({
  in_progress: { text: "in progress", tone: "busy" },
  delivered: { text: "delivered", tone: "ok" },
  shipped: { text: "shipped", tone: "ok" },
  rejected: { text: "refused", tone: "quiet" },
  payment_unresolved: { text: "payment outcome unknown", tone: "warn" },
  declined: { text: "declined at confirmation", tone: "quiet" },
  expired: { text: "closed on time limit", tone: "quiet" },
  cancelled: { text: "closed when you left", tone: "quiet" },
  refund_due: { text: "refund due", tone: "warn" },
  refunded: { text: "refunded", tone: "quiet" },
  delivered_unpaid: { text: "delivered, not paid", tone: "warn" },
});

/**
 * The merchant's words: "immediate" and "later" say what their operation has to
 * be ready for, where `sync` and `async` say how the call is shaped.
 */
export const FULFILLMENT_WORDS: Readonly<Record<Fulfillment, string>> = Object.freeze({
  sync: "immediate",
  async: "later",
  confirm: "after you confirm",
  ship: "by parcel",
});

export const SELLING_WORDS: Readonly<Record<SellingState, Word>> = Object.freeze({
  open: { text: "sales enabled", tone: "ok" },
  paused: { text: "sales paused", tone: "warn" },
  departed: { text: "left", tone: "quiet" },
});

/**
 * Money taken and nothing delivered, and goods delivered against a payment that
 * never executed. An order merely under way is not here: it may be the
 * merchant's to deliver, but this API cannot tell it from one created a second
 * ago, so demanding attention for it would be a claim beyond the evidence.
 */
export const NEEDS_ATTENTION: readonly OrderStatus[] = Object.freeze([
  "refund_due",
  "delivered_unpaid",
]);

export const needsAttention = (status: OrderStatus): boolean => NEEDS_ATTENTION.includes(status);

/**
 * The gateway's own codes, less the operator's approval, which nobody sets in
 * Settings, and less the shop's site, which is asked only of a parcel's card.
 * Which of them is required on which channel is the gateway's rule
 * (`readinessOf` in the core), never a screen's. Total by its type: a code
 * added to the contract does not compile here until it has words or is
 * excluded.
 */
export type Unset = Exclude<MerchantFinding, "no_operator_approval" | "no_seller_site">;

export const UNSET_WORDS: Readonly<Record<Unset, string>> = Object.freeze({
  no_seller_name: "the name your products are sold under",
  no_payout_wallet: "the wallet address your money arrives at",
});

/**
 * The gateway's own words name the call a merchant's code makes; the person
 * here sets the site in Settings.
 */
export const SITE_IN_SETTINGS = "Set your shop's site in Settings, then import again.";

/**
 * Says what is known, that there is no approval, and not that a review is under
 * way, since nothing records one.
 */
export const APPROVAL_PENDING =
  "Agentify has not approved your merchant for live sales yet, so your cards are refused on the live channel. If an Agentify operator is coordinating your pilot, ask them for the approval.";

export const APPROVAL_GIVEN = "Agentify has approved your merchant for live sales.";

/**
 * The amount is passed through exactly as it arrived: it is a decimal string on
 * the wire so nothing turns it into a float, and `"5.00"` shown as `$5` is a
 * different number to anybody checking their books.
 */
export const money = (sum: { readonly amount: string; readonly currency: string }): string =>
  `${sum.amount} ${sum.currency}`;

/**
 * UTC, said beside every moment, because nothing in the request carries the
 * reader's zone and the server's zone would be off by hours with nothing to say
 * so. To the second, because receipts are reconciled against a wallet and two
 * payments a few seconds apart must not look like one line twice.
 */
export const moment = (iso: string): string => {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    // A timestamp we cannot read is shown raw: it is what we were told, and an
    // invented date would put a moment on a receipt that nothing stands behind.
    return iso;
  }
  const date = at.toISOString();
  return `${date.slice(0, 10)} ${date.slice(11, 19)} UTC`;
};
