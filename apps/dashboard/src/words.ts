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

import { withUnit } from "@agentify/ui/units";
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
 * the buyer and the original payment is recorded. Goods the merchant delivered
 * against a charge that then failed have not reached the buyer, who receives
 * them only by paying again, which the word says, so it does not read as goods
 * given away unpaid.
 */
export const ORDER_WORDS: Readonly<Record<OrderStatus, Word>> = Object.freeze({
  in_progress: { text: "In progress", tone: "busy" },
  delivered: { text: "Delivered", tone: "ok" },
  shipped: { text: "Shipped", tone: "ok" },
  rejected: { text: "Refused", tone: "quiet" },
  payment_unresolved: { text: "Payment outcome unknown", tone: "warn" },
  expired: { text: "Closed on time limit", tone: "quiet" },
  unfulfilled: { text: "Unfulfilled", tone: "warn" },
  fulfillment_closed: { text: "Fulfillment closed", tone: "quiet" },
  delivered_unpaid: { text: "Held for payment", tone: "waiting" },
});

/**
 * The merchant's words: "Immediate" and "Later" say what their operation has to
 * be ready for, where `sync` and `async` say how the call is shaped.
 */
export const FULFILLMENT_WORDS: Readonly<Record<Fulfillment, string>> = Object.freeze({
  sync: "Immediate",
  async: "Later",
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
 * Settings, and less the shop's site, which async and parcel cards require.
 * Which of them is required on which channel is the gateway's rule
 * (`readinessOf` in the core), never a screen's.
 */
export type Unset = Exclude<MerchantFinding, "no_operator_approval" | "no_seller_site">;

/**
 * The gateway's own words name the call a merchant's code makes; the person
 * here sets the site in Settings.
 */
export const SITE_IN_SETTINGS = "Set your shop's site in Settings, then import again.";

/**
 * Why the account as a whole is not as usual: a change of the payout wallet
 * waits to apply, all sales are paused, something publishing needs is
 * missing, the products are off sale while their integration is not
 * connected, or new purchases are refused while as many paid orders are left
 * unserved as Agentify allows; or that what would say so could not be read. Selling through a
 * WooCommerce shop is not among them: it holds nothing, and the products it
 * leaves off sale say so on their own rows.
 */
export type AccountReason =
  | "wallet_change"
  | "paused"
  | "not_approved"
  | "no_seller_name"
  | "no_payout_wallet"
  | "out_of_touch"
  | "unserved"
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
 * Each reason's title, which heads the banner when it is the only one, its
 * one line, and the page that puts it right where one does. Each line says
 * who lifts the hold: the merchant at the way it names, Agentify, or nobody,
 * since it lifts by itself. The approval says what is known, that there is
 * none, and not that a review is under way, since nothing records one; the
 * merchant cannot grant it. Practice belongs to the first Products screen,
 * not the account banner.
 */
export const ACCOUNT_WORDS: Readonly<
  Record<AccountReason, Readonly<{ title: string; says: string; fix: Way | null }>>
> = Object.freeze({
  // The banner draws the address and the moment before this line, and its
  // cancel after it.
  wallet_change: {
    title: "Your payout wallet is changing",
    says: "If nobody at your business asked for this, cancel it. Cancelling also signs out every other session on your account.",
    fix: null,
  },
  // Selling stops by the button, by the code's call and by a switch back to
  // code alike, and nothing read here says which, so the line names no cause.
  paused: {
    title: "Sales are paused",
    says: "New orders are refused.",
    fix: { to: "/products", words: "Resume on Products" },
  },
  not_approved: {
    title: "Not approved for live sales yet",
    says: "Agents can buy your products once Agentify approves your account. To ask, write to admin@agentify.ad.",
    fix: null,
  },
  no_seller_name: {
    title: "Your products are off sale",
    says: "Publishing and selling need a seller name.",
    fix: { to: "/settings", words: "Choose one in Settings" },
  },
  no_payout_wallet: {
    title: "Your products are off sale",
    says: "Publishing and selling need a payout wallet.",
    fix: { to: "/settings", words: "Set one in Settings" },
  },
  out_of_touch: {
    title: "Your products are off sale",
    says: "Your integration has not connected yet, so agents don't see your products and new purchases are refused until it does.",
    fix: { to: "/docs/failures#your-integration-has-not-connected", words: "What to check" },
  },
  unserved: {
    title: "All new purchases are refused",
    says: "As many paid orders you were given as Agentify allows are left without delivery or closure, so agents cannot buy anything from you until you deliver or close some of them. Under Needs you, each order that counts says so.",
    fix: { to: "/orders?show=needs", words: "See them on Orders" },
  },
  unread: {
    title: "We could not check your account",
    says: "We don't know right now whether anything holds your sales. Reload the page to check again.",
    fix: null,
  },
});

/** The reasons that each keep every product off sale. */
const KEEP_OFF_SALE: ReadonlySet<AccountReason> = new Set([
  "paused",
  "no_seller_name",
  "no_payout_wallet",
  "not_approved",
  "out_of_touch",
]);

/**
 * The banner's heading. One reason is headed by its own title; several by
 * what they come to together where one of them keeps every product off sale,
 * otherwise by the refused purchases where they hold, since those refuse every
 * product, and otherwise by the first.
 * Here rather than beside the reasons, so the page's script that draws the
 * banner does not carry the rules that find them.
 */
export const headingOf = (
  notes: readonly Readonly<{ reason: AccountReason; title: string }>[],
): string => {
  const [first] = notes;
  if (first === undefined) return "";
  if (notes.length === 1) return first.title;
  if (notes.some((note) => KEEP_OFF_SALE.has(note.reason))) return "Your products are off sale";
  return (notes.find((note) => note.reason === "unserved") ?? first).title;
};

/**
 * Said beside an order under Needs you that counts toward the stop on new
 * purchases: the merchant must find exactly those, since closing an order that
 * does not count lifts nothing.
 */
export const COUNTS_TOWARD_THE_STOP =
  "This order counts toward the stop on your new purchases until you deliver or close it.";

/** The banner's title while Agentify's withdrawal of the merchant's admission stands. */
export const LIVE_SALES_STOPPED = "Live sales are stopped";

/**
 * Its line: since when, and the note Agentify wrote for the merchant, quoted
 * as written, or nothing where there is none.
 */
export const liveSalesStoppedSince = (when: string, note: string | null): string =>
  `Agentify stopped your live sales on ${when}.${note === null ? "" : ` Its note: “${note}”`}`;

/** The out-of-touch reason's line where the integration did connect once, at `when`. */
export const notConnectedSince = (when: string): string =>
  `Your integration has not connected since ${when}, so agents don't see your products and new purchases are refused until it connects again.`;

/**
 * The amount is passed through exactly as it arrived: it is a decimal string on
 * the wire so nothing turns it into a float, and `"5.00"` shown as `$5` is a
 * different number to anybody checking their books. It is kept on one line
 * with its currency, so it is for a page and nothing else.
 */
export const money = (sum: { readonly amount: string; readonly currency: string }): string =>
  withUnit(sum.amount, sum.currency);
