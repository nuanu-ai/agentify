/**
 * The one place wire values become words a merchant reads, so a state does not
 * have one name on the orders screen and another on the receipts screen. Every
 * map is total over its vocabulary and a test walks each one: a status with no
 * word would reach a merchant as `undefined` or a raw wire value, and the
 * states added later are the rare ones a merchant cannot guess.
 *
 * Two words are deliberately weak. `in_progress` folds an order the merchant
 * has taken on with one that was priced and never paid (`order-status.ts` says
 * why), so it reads "In progress" and nothing about fulfilment or delivery,
 * which would show an unpaid request as goods the merchant owes.
 * `payment_unresolved` reads as a question, because we asked the payment
 * network and heard nothing, which is not the same as nothing being charged.
 */

import type { Fulfillment, MerchantFinding, OrderStatus } from "@nuanu-ai/agentify-contracts";

/**
 * `waiting` is a state held until somebody acts, the merchant or the buyer, and
 * nothing is lost meanwhile.
 */
export type Tone = "ok" | "warn" | "busy" | "waiting" | "quiet";

/** Written for display, capitalised, so a word stands on its own beside its dot. */
export interface Word {
  readonly text: string;
  readonly tone: Tone;
}

/**
 * Endings that cost the merchant something are `warn`, those that cost nobody
 * are quiet. Only `delivered` and `shipped` are `ok`: the goods have gone to
 * the buyer and the original payment is recorded. Goods delivered and not paid wait
 * on the buyer, who can pay again.
 */
export const ORDER_WORDS: Readonly<Record<OrderStatus, Word>> = Object.freeze({
  in_progress: { text: "In progress", tone: "busy" },
  delivered: { text: "Delivered", tone: "ok" },
  shipped: { text: "Shipped", tone: "ok" },
  rejected: { text: "Refused", tone: "quiet" },
  payment_unresolved: { text: "Payment outcome unknown", tone: "warn" },
  declined: { text: "Declined at confirmation", tone: "quiet" },
  expired: { text: "Closed on time limit", tone: "quiet" },
  cancelled: { text: "Closed when you left", tone: "quiet" },
  unfulfilled: { text: "Unfulfilled", tone: "warn" },
  fulfillment_closed: { text: "Fulfillment closed", tone: "quiet" },
  delivered_unpaid: { text: "Delivered, not paid", tone: "waiting" },
});

/**
 * The merchant's words: "Immediate" and "Later" say what their operation has to
 * be ready for, where `sync` and `async` say how the call is shaped.
 */
export const FULFILLMENT_WORDS: Readonly<Record<Fulfillment, string>> = Object.freeze({
  sync: "Immediate",
  async: "Later",
  confirm: "After you confirm",
  ship: "By parcel",
});

/** Whether a key still opens the gateway; a revoked one never does again. */
export const KEY_WORDS = Object.freeze({
  works: { text: "Works", tone: "ok" },
  revoked: { text: "Revoked", tone: "quiet" },
} as const satisfies Readonly<Record<string, Word>>);

/**
 * Where a card stands, said from the card's own switch: a card the merchant
 * paused waits on them to resume it; one off sale for anything else is held by
 * something about the whole account, which the banner over the page names.
 */
export const CARD_WORDS = Object.freeze({
  onSale: { text: "On sale", tone: "ok" },
  pausedByYou: { text: "Paused by you", tone: "waiting" },
  offSale: { text: "Off sale", tone: "quiet" },
} as const satisfies Readonly<Record<string, Word>>);

/**
 * Money taken and nothing delivered: the merchant decides what happens next.
 * Goods delivered against a payment that never executed are not here: the
 * merchant owes nobody anything, the buyer can pay again and the order closes
 * when they do, and whether to revoke what was delivered meanwhile is the
 * merchant's own choice. An order merely under way is not here either: it may
 * be the merchant's to deliver, but this API cannot tell it from one created a
 * second ago, so demanding attention for it would be a claim beyond the
 * evidence.
 */
export const needsYou = (status: OrderStatus): boolean => status === "unfulfilled";

/** Goods delivered and held until the buyer's payment goes through. */
export const waitsOnTheBuyer = (status: OrderStatus): boolean => status === "delivered_unpaid";

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
  no_payout_wallet: "the wallet your share of every sale is paid out to",
});

/**
 * The gateway's own words name the call a merchant's code makes; the person
 * here sets the site in Settings.
 */
export const SITE_IN_SETTINGS = "Set your shop's site in Settings, then import again.";

export const APPROVAL_GIVEN = "Agentify has approved your merchant for live sales.";

/**
 * Why the account as a whole is not selling as usual: the merchant left, all
 * sales are paused, something publishing needs is missing, or the cards their
 * own code published are off sale while a WooCommerce shop sells; or that what
 * would say so could not be read.
 */
export type AccountReason =
  | "left"
  | "paused"
  | "not_approved"
  | "no_seller_name"
  | "no_payout_wallet"
  | "through_shop"
  | "unread";

/**
 * A page of the dashboard, named without its prefix, or a whole address
 * elsewhere, and the words that lead there.
 */
export interface Way {
  readonly to: string;
  readonly words: string;
}

/**
 * One title and one sentence each, and the page that puts it right where one
 * does. The approval says what is known, that there is none, and not that a
 * review is under way, since nothing records one. The merchant cannot grant
 * it, so the banner leads to the test channel's own dashboard, where the first
 * sale is made under another account.
 */
export const ACCOUNT_WORDS: Readonly<
  Record<AccountReason, Readonly<{ title: string; says: string; fix: Way | null }>>
> = Object.freeze({
  left: {
    title: "You have left Agentify",
    says: "New sales have stopped. Paid orders left unfulfilled remain recorded; you decide their remedy with the buyer and can close future Agentify fulfillment on Orders.",
    fix: null,
  },
  paused: {
    title: "All sales are paused",
    says: "No new orders are accepted; the orders you have already accepted play out as usual.",
    fix: { to: "/cards", words: "Resume on Cards" },
  },
  not_approved: {
    title: "Not approved for live sales yet",
    says: "Agents cannot buy your cards on the live site until an Agentify administrator approves your merchant. Test sales need no approval; your first test sale happens on the test channel, under an account of its own.",
    fix: { to: "https://test.agentify.ad/dashboard/sign-in", words: "Open the test dashboard" },
  },
  no_seller_name: {
    title: "No seller name yet",
    says: "Your cards are off sale, and every card you publish is refused, until you choose the name buyers see.",
    fix: { to: "/settings", words: "Choose it in Settings" },
  },
  no_payout_wallet: {
    title: "No payout wallet yet",
    says: "Your cards are off sale, and every card you publish is refused, until you set the wallet your share of every sale is paid out to.",
    fix: { to: "/settings", words: "Set it in Settings" },
  },
  through_shop: {
    title: "Selling through your WooCommerce shop",
    says: "The cards your own code published are off sale until you switch back to it on the WooCommerce page.",
    fix: { to: "/woocommerce", words: "Open WooCommerce" },
  },
  unread: {
    title: "Your account could not be checked",
    says: "Whether anything holds your sales could not be read just now, so a reason may be missing here; reload the page to check again.",
    fix: null,
  },
});

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

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/**
 * The day a moment falls on in UTC, written out, for a heading over the
 * moments of that day; each moment under it keeps its time to the second. A
 * timestamp that cannot be read is given as it came.
 */
export const dayOf = (iso: string): string => {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return iso;
  }
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`;
};
