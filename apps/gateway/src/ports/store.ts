/**
 * Everything the gateway remembers, as the questions the flows ask rather than
 * as tables, so the application logic is testable without Postgres.
 *
 * A method about one merchant's data takes the merchant as a parameter, so a
 * read that forgets whose data it is does not compile; the buying surface, the
 * sweep and the payment claims are deliberately across all merchants. Without
 * the hold `withOrder` takes, two events about one order (a payment and a
 * deadline, an answer and a redelivery) both read it, both decide, and the
 * second write erases the first, which is how an order gets charged twice.
 */

import type { MerchantSelling, Order, OrderState } from "@agentify/core";
import type {
  Card,
  Delivery,
  ParamSpec,
  Receipt,
  ShipTo,
  WorkerEnvelope,
} from "@nuanu-ai/agentify-contracts";
import type { AnalyticsEvent } from "../analytics/events.js";
import type { PayoutSplit } from "../split/parameters.js";
import type { PaymentRecoveryContext } from "./facilitator.js";
import type { Reminder } from "./queue.js";

export type PaymentCompletion =
  | {
      readonly settled: true;
      readonly transaction: string;
      readonly executedAt: number | null;
      readonly source: "facilitator" | "chain";
    }
  | { readonly settled: false; readonly reason: string; readonly source: "facilitator" | "chain" };

/** One submitted charge. A callback and chain recovery must complete this same identity. */
export interface PaymentAttempt {
  readonly id: string;
  readonly startedAt: number;
  readonly recovery?: PaymentRecoveryContext;
  readonly transaction?: string;
  readonly nextBlock?: string;
  readonly completion: PaymentCompletion | null;
}

/**
 * How a merchant's products reach Agentify and their orders are filled: their
 * own code through the API, or a WooCommerce shop the dashboard connected. A
 * merchant sells through one of them at a time.
 */
export const INTEGRATIONS = ["api", "woocommerce"] as const;

export type Integration = (typeof INTEGRATIONS)[number];

/**
 * The states on the open list in which no handler response is pending: late
 * fulfillment, payment for goods already held, and a closed order whose payment
 * completed after the closure. None of them holds a switch of integration
 * (`IntegrationSwitch`).
 */
export const NO_PENDING_HANDLER = [
  "unfulfilled",
  "delivered_unpaid",
  "fulfillment_closed",
] as const satisfies readonly OrderState[];

/**
 * The states of a purchase being priced or priced and not yet paid for. A
 * purchase in one of them whose payment stage is still `none` waits on its
 * buyer, and holds one of its seller's places at the door (`Birth`).
 */
export const WAITING_FOR_PAYMENT = ["created", "quoted"] as const satisfies readonly OrderState[];

/**
 * Whether a purchase waits on its buyer's payment at `at`, and so holds one of
 * its seller's places at the door: being priced or priced, with no payment,
 * and with its price still able to stand. A price holds for the quote's time
 * to live from when it was named, and a question still unanswered may name
 * one until its own window ends; past that the order is over in all but the
 * reminder that closes it, which may fire late or not at all.
 */
export const waitsForPayment = (record: StoredOrder, at: number): boolean => {
  const { order } = record;
  if (!(WAITING_FOR_PAYMENT as readonly string[]).includes(order.state)) return false;
  if (order.payment !== "none") return false;
  const { quoteResponseMs, quoteTtlMs } = order.policy.deadlines;
  return order.state === "quoted"
    ? order.timestamps.quotedAt === null || order.timestamps.quotedAt + quoteTtlMs > at
    : order.timestamps.createdAt + quoteResponseMs + quoteTtlMs > at;
};

/**
 * Whether an order is an attempt that lapsed unpaid: it ended rejected or
 * expired with no payment ever verified, no goods held for its buyer and
 * nothing presented to pay with. Nothing of anybody's money or goods rests on
 * such an order. Whether a receipt or a payment claim names it is the
 * store's to ask besides, at the moment it would forget the order.
 */
export const lapsedAttempt = (record: StoredOrder): boolean =>
  (record.order.state === "rejected" || record.order.state === "expired") &&
  record.order.payment === "none" &&
  !record.order.heldFulfillment &&
  record.payment == null &&
  record.paidBy == null &&
  record.paymentAttempt == null &&
  record.delivery == null;

/**
 * What the birth of a purchase is held to: the integration its card was sold
 * through, which its merchant must still sell through, and how many of that
 * merchant's purchases may wait for payment at once, this one included.
 */
export interface Birth {
  readonly through: Integration;
  readonly waitingAtMost: number;
  /**
   * The reminders that close the order on time, written with it or not at
   * all: a refused birth leaves none behind, and an order written with no
   * clock on it is one nothing would close.
   */
  readonly clocks?: readonly ClockAtBirth[];
}

/** A reminder set at the birth of an order, and how long from now it waits. */
export interface ClockAtBirth {
  readonly reminder: Reminder;
  readonly afterMs: number;
}

/**
 * What became of the birth of a purchase: written, or not written because its
 * merchant has switched to the other integration, or because as many of their
 * purchases as `Birth` allows already wait for payment.
 */
export type Born = "written" | "switched_away" | "too_many_waiting";

/**
 * What switching a merchant to the other integration came to.
 *
 * Refused while an order still waits on the integration being left — for its
 * first answer, for the payment a price was quoted for, or for the goods it
 * was taken on for — because after the switch nothing of that integration
 * draws the merchant's stream again; `waiting` names those orders. An order
 * with no pending handler response holds nothing (`NO_PENDING_HANDLER`).
 *
 * `sellingPaused` says whether the switch stopped the merchant's selling. A
 * switch back to the API that would put the code's cards back on sale does,
 * because an asynchronous order is paid before the code answers, and the code
 * may not be running.
 */
export type IntegrationSwitch =
  | { readonly switched: true; readonly sellingPaused: boolean }
  | { readonly switched: false; readonly waiting: readonly string[] };

/** A card as its merchant published it, under the catalog identifier we issued. */
export interface StoredCard {
  readonly id: string;
  readonly merchantId: string;
  readonly card: Card;
  /** When this version of the card was published. */
  readonly asOf: number;
  /**
   * Whether this card alone is off sale. It reaches the order machine as the
   * same "paused" word as a paused catalog, so it is refused by the same guard
   * with the same message.
   */
  readonly paused: boolean;
  /**
   * Which integration published it, written at the first publish and never
   * moved by a later one. A card of the integration its merchant is not
   * selling through is off sale the way a paused card is.
   */
  readonly integration: Integration;
}

/**
 * One order: the machine's order plus everything about the purchase the
 * machine has no opinion about. The payment is kept as the opaque string the
 * agent presented because the charge runs later than the verification, in the
 * synchronous mode only after the goods come back.
 */
export interface StoredOrder {
  readonly order: Order;
  /**
   * The merchant whose card the order was made against, fixed when the order
   * is made. It lives on the order because routing its envelopes and checking
   * the asking key happen with no card in hand, and a republished card must
   * not move a sale.
   */
  readonly merchantId: string;
  /** Our catalog identifier for the product. */
  readonly itemId: string;
  readonly merchantItemId: string;
  /**
   * What the payment challenge names this order by, random like the order's
   * identifier and never the same: the challenge goes to the payment
   * facilitator, and a discovery listing can publish it, while the identifier
   * opens the order and its goods. A payment is bound to the order whose
   * reference it carries, and nothing answers a reference with the order's
   * identifier or goods. Every order has one, and no two share one.
   */
  readonly paymentRef: string;
  /**
   * The buyer's key: random, issued with the order, and the only thing the
   * agent's read of its purchase finds the order by. It reaches the buyer
   * inside the status address and nobody else, so it is never written into
   * anything the merchant reads, the payment side is sent, analytics or a
   * log line. It is kept as issued, because a buyer who lost the purchase
   * answer is given the same address again. Every order has one, and no two
   * share one.
   */
  readonly buyerKey: string;
  /**
   * The result the card declared when the order was made; a delivery is held
   * to this, so a later republish changes nothing for the order. Absent on a
   * parcel's order, which is held to a shipment, and on an order stored
   * without it, which is held to the card as it stands.
   */
  readonly result?: ParamSpec;
  readonly params: Readonly<Record<string, unknown>>;
  /**
   * On a parcel's order only: the buyer's whole address while the order needs
   * it, then only the instant it was erased. Absent on every other order.
   */
  readonly shipTo?: ShipTo | { readonly erasedAt: number };
  /**
   * The identifier of the price question asked for a parcel's order. A price
   * question carries the address and names no order, so this is how it is
   * found when the address is erased from the queue. Absent on other orders
   * and where no price was asked of the merchant.
   */
  readonly priceQuestion?: string;
  /** The price question this order was priced by, where one was asked. */
  readonly priceId: string | null;
  readonly delivery: Delivery | null;
  /** What the agent presented to pay with, verbatim, until the charge is done. */
  readonly payment: string | null;
  /** Immutable token and authorization terms established during verification. */
  readonly paymentRecovery?: PaymentRecoveryContext;
  readonly paymentFingerprint?: string;
  readonly paymentAttempt?: PaymentAttempt;
  /**
   * The address the payment was verified against: the merchant's split as
   * recorded then, or, on an order verified before payments went to splits,
   * the wallet itself. The charge must go to the address the payer signed for
   * even if the merchant moves their wallet between verification and charge,
   * which in the synchronous mode spans the whole fulfilment. Null until a
   * payment is verified.
   */
  readonly payTo: string | null;
  /**
   * The order's owner: the payer bound to the first verified authorization,
   * or that payment's fingerprint where the adapter supplies no verified payer.
   * A payment reference is not secret, since a listing can publish it, and the
   * payment route takes no key, so without an owner anyone holding a reference
   * could pay against, take the goods of, or close someone else's order.
   * It is set inside the store's hold on the order, so two racing payments
   * cannot both become the owner.
   */
  readonly paidBy: string | null;
  /**
   * What the payment layer said when the charge went through, kept because the
   * agent's client reads it off the purchase answer. It is the layer's
   * receipt; the order's own record of the money is the machine's payment
   * stage.
   */
  readonly settlement: { readonly transaction: string } | null;
  /**
   * Bounded diagnostics from verification, settlement and recovery. They are
   * never proof of payment or the identity of an attempt.
   */
  readonly paymentWords: readonly PaymentWord[];
  /**
   * How many words fell off the end of `paymentWords`. The list is bounded
   * because anyone may present any number of payments against an order without
   * a key, and the count tells a reader how much more was said than they see.
   */
  readonly paymentWordsDropped: number;
  /**
   * The delivery out with a worker and not yet answered. A reminder acts only
   * on this delivery, so a reminder left against one already answered cannot
   * report the handler as silent and send the order again.
   */
  readonly openDeliveryId: string | null;
}

/** One thing the payment layer said, and when. */
export interface PaymentWord {
  readonly at: number;
  readonly about: "verify" | "settle";
  readonly said: string;
}

/**
 * One write that lands with the order or not at all. These are effects that
 * cannot be re-driven once the order has moved past the transition that asked
 * for them, so no retry repairs an order that says the merchant was handed the
 * work with no envelope written. The caller describes the writes and each
 * adapter makes them atomic its own way, so the port never holds a transaction.
 *
 * Landing with the order is not the same as being safe to write again: the
 * sweep re-drives order envelopes and receipts, but an event envelope is
 * delivered at most once and must never be sent a second time.
 */
export type WithTheOrder =
  | { readonly kind: "retain_payment"; readonly fingerprint: string; readonly orderId: string }
  | {
      readonly kind: "envelope";
      readonly merchantId: string;
      readonly envelope: WorkerEnvelope;
      /** How long the stream holds it back, where something asked it to wait. */
      readonly afterMs?: number;
    }
  | { readonly kind: "receipt"; readonly merchantId: string; readonly receipt: Receipt }
  /**
   * Deletes every envelope on the merchant's stream that carries any of a
   * parcel's address (the order's hand-overs and its price question) in
   * whatever state it is in, since a queue keeps a finished envelope for days
   * and drawn is not gone. Events about the order carry no address and stay.
   */
  | {
      readonly kind: "forget";
      readonly merchantId: string;
      readonly orderId: string;
      readonly priceQuestion: string | null;
    };

/**
 * What `withOrder` decided: the order to write back, if any, the writes that go
 * with it, and the caller's answer. Leaving `save` out says the read changed
 * nothing. `alongside` does not depend on `save`: a decision that throws writes
 * none of them, and one that returns writes all of them.
 */
export interface OrderChange<T> {
  readonly save?: StoredOrder;
  readonly alongside?: readonly WithTheOrder[];
  readonly result: T;
}

/**
 * The product analytics events a saved change to an order amounts to, each
 * with the instant it happened at, read off the order as the hold found it and
 * as it was saved.
 */
export type OrderAnalytics = (
  before: StoredOrder,
  after: StoredOrder,
) => readonly { readonly event: AnalyticsEvent; readonly at: number }[];

/**
 * The result of running something only if nobody else is running it. Finding
 * it taken is an ordinary outcome, not a failure.
 */
export type Ran<T> = { readonly ran: true; readonly result: T } | { readonly ran: false };

/**
 * An agent asking about an order that never existed is ordinary, so not finding
 * one is a value rather than a thrown error.
 */
export type OrderLookup<T> =
  | { readonly found: true; readonly result: T }
  | { readonly found: false };

/**
 * The order holding a payment's claim, and whether it kept the claim because
 * the payment was taken for it.
 */
export interface ClaimHolder {
  readonly orderId: string;
  readonly retained: boolean;
}

/** Whether a payment is this order's to spend. */
export type PaymentClaim =
  | { readonly claimed: true }
  | { readonly claimed: false; readonly heldBy: string };

/**
 * A payout split as the registry holds it: every parameter it was recorded
 * with, and the instant it was first recorded. A recorded split is never
 * changed or deleted, by this code or by hand, and outlives its merchant,
 * because until its first payout nothing else holds its parameters and money
 * paid to it could not be paid out without them.
 */
export interface RecordedPayoutSplit extends PayoutSplit {
  readonly recordedAt: number;
}

/**
 * Where a merchant is paid, as a write is compared against it: the address
 * and the waiting replacement as they were read. A change is recorded only
 * where the row still holds exactly this, the instant included.
 */
export interface PayoutWalletRead {
  readonly address: string | null;
  readonly pending: { readonly address: string; readonly takesEffectAt: number } | null;
}

/**
 * A wallet change that has been announced to the merchant and has not taken
 * effect yet, with the split it is paid through once it does. Address and
 * moment both or neither: the table refuses half of one.
 */
interface PendingPayoutWallet {
  readonly address: string;
  /** When it replaces the address paid now, counted from the announcement. */
  readonly takesEffectAt: number;
  /** The split recorded for this address, or null where none is: a defect, read as no wallet. */
  readonly split: RecordedPayoutSplit | null;
}

/**
 * Where a merchant is paid, as their row holds it: `address` as of the last
 * write (null where none was ever set) with the split recorded for it, and a
 * `pending` replacement with its own, or null. The address and the waiting
 * change are one value because they are written and compared together; the
 * splits travel with them so a wallet and the split it is paid through are
 * read at one instant, in one read.
 *
 * The splits are the ones recorded on the network the store was opened for,
 * the deployment's, so a row of another network is never read as one.
 */
export interface StoredPayoutWallet {
  readonly address: string | null;
  /** The split recorded for `address`, or null where none is: a defect, read as no wallet. */
  readonly split: RecordedPayoutSplit | null;
  readonly pending: PendingPayoutWallet | null;
}

/**
 * A wallet as a write records it: the address with its split and the waiting
 * replacement with its own, each computed for this merchant by the network's
 * payout split. The splits are a required part of the write so that no
 * caller can save a wallet whose payments would have no recorded parameters.
 */
export interface PayoutWalletWrite {
  readonly address: string;
  readonly split: PayoutSplit;
  readonly pending: {
    readonly address: string;
    readonly takesEffectAt: number;
    readonly split: PayoutSplit;
  } | null;
}

/** A wallet write that landed: the merchant as they now stand and the splits recorded by it for the first time. */
export interface WalletWritten {
  readonly merchant: StoredMerchant;
  readonly recorded: readonly RecordedPayoutSplit[];
}

/**
 * A merchant. `name` is for a person reading a list at a terminal and never
 * goes on the wire. No email address, password or sign-up record is kept here:
 * an account on the other side of the boundary names the merchant.
 */
export interface StoredMerchant {
  readonly id: string;
  readonly name: string;
  /**
   * The name this seller is listed under in a discovery catalog, or null where
   * nobody has named one, in which case nothing about the seller goes out. It
   * is separate from `name` because the catalog carries at most thirty-two
   * characters of printable ASCII and silently drops the rest, and it is never
   * filled in from `name`: a name that happens to fit is not one anybody chose
   * to trade under.
   */
  readonly serviceName: string | null;
  /**
   * The https origin of this merchant's own shop, where an agent takes what an
   * order cannot answer, or null where none was given. `setSellerSite` in
   * `app/merchants.ts` validates it before it is written.
   */
  readonly sellerSite: string | null;
  /**
   * Where this merchant's share of a sale arrives, with the split buyers pay
   * into: the `payTo` of every payment request for the merchant's cards is the
   * split recorded for the wallet in force. The gateway writes it in the
   * mixed-case spelling a wallet displays; a row in lower case is the same
   * wallet, and is read with the same split. A null
   * `address` means nobody has said where the money goes, and it is never
   * filled in from the gateway's own configured address, which is the
   * operator's.
   *
   * This is the row as written: a pending change whose moment has passed is
   * already the address, so anything deciding where a sale goes asks
   * `payoutWalletAt` in `app/runtime.ts` with the clock and never reads
   * `address` off this.
   */
  readonly payoutWallet: StoredPayoutWallet;
  /**
   * When the operator admitted this merchant to live sales, or null where that
   * has never happened. A repeated grant never moves it, and test deployments
   * ignore it.
   */
  readonly liveApprovedAt: number | null;
  readonly selling: MerchantSelling;
  /** The integration this merchant sells through now. */
  readonly integration: Integration;
  readonly createdAt: number;
}

/**
 * One key a merchant opens the door with. Only the SHA-256 digest of the secret
 * is kept and a request is resolved by looking the digest up, so the secret
 * never comes back out of the store.
 */
export interface StoredKey {
  readonly id: string;
  readonly merchantId: string;
  readonly label: string;
  readonly createdAt: number;
  /** When it was revoked, or null while it still opens the door. */
  readonly disabledAt: number | null;
  /**
   * Roughly when the key was last used. It is refreshed only once the stored
   * instant has gone stale, so the door does not write on every request on the
   * money path. Null means nothing was recorded, not that the key was never
   * called, and nothing on the row tells the two apart.
   */
  readonly lastUsedAt: number | null;
  /**
   * What the call behind `lastUsedAt` said it runs, from its `user-agent`
   * header, or null where it said nothing or nothing was recorded. It is the
   * caller's own claim, so it tells the team which release a merchant runs and
   * proves nothing.
   */
  readonly lastUserAgent: string | null;
}

/** One card in the public catalog, with the word its own merchant sells under. */
export interface CatalogEntry {
  readonly card: StoredCard;
  readonly merchant: MerchantSelling;
  /**
   * Where the card's merchant is paid, with the splits recorded for it,
   * carried because a card whose merchant has no split to be paid at cannot be
   * sold. It is as the row holds it: the address paid now is asked of
   * `payoutWalletAt` with the clock.
   */
  readonly payoutWallet: StoredPayoutWallet;
  /**
   * The merchant's listing name, or null. A payment request names the seller,
   * so a card whose merchant has no name cannot be offered either.
   */
  readonly serviceName: string | null;
  /**
   * That merchant's shop's site, or null where none was given: an agent reads
   * it beside the name on every card in the catalog.
   */
  readonly sellerSite: string | null;
  /** The operator's live grant, or null; ignored outside the live surface. */
  readonly liveApprovedAt: number | null;
  /** The integration that merchant sells through, which their cards are read against. */
  readonly integration: Integration;
}

/**
 * The analytics a store method that commits a fact records with it: an event,
 * or one made from what the method committed, where null records none.
 */
export type AnalyticsOf<R> = AnalyticsEvent | ((committed: R) => AnalyticsEvent | null);

/** The event `analytics` makes of what was committed, or null. */
export const analyticsEventOf = <R>(
  analytics: AnalyticsOf<R> | undefined,
  committed: R,
): AnalyticsEvent | null =>
  analytics === undefined
    ? null
    : typeof analytics === "function"
      ? analytics(committed)
      : analytics;

/** Which merchant an order belongs to, where a read is one merchant's alone. */
export interface MerchantScope {
  readonly merchantId: string;
}

export interface Store {
  /**
   * The network whose split of a wallet this store reads as the one the
   * wallet is paid through: the deployment's, so a row of another network is
   * never read as a wallet's split.
   */
  readonly network: string;

  // --- product analytics ----------------------------------------------------

  /**
   * Records a product analytics event that has no business write of its own,
   * such as a publish refused before anything was written, outside any
   * transaction. It never rejects: a failure is one line in the log.
   *
   * A fact that must be recorded together with a business write is recorded by
   * the store method that commits the write. That method takes an optional last
   * argument `analytics?: AnalyticsEvent | ((committed: R) => AnalyticsEvent |
   * null)`, where `R` is what the method resolves with, and records the event
   * in the same transaction only when the write committed something, nothing
   * when the function returns null; the memory store keeps it beside the
   * events this method records.
   */
  recordAnalytics(event: AnalyticsEvent, at: number | Date): Promise<void>;

  // --- merchants and their keys ---------------------------------------------

  /**
   * Writes a merchant that is not there yet. Null means the identifier is
   * taken and nothing was overwritten; the sandbox seed relies on that at every
   * start after the first.
   */
  addMerchant(
    merchant: { readonly id: string; readonly name: string },
    at: number,
  ): Promise<StoredMerchant | null>;

  merchantById(id: string): Promise<StoredMerchant | null>;

  /**
   * Records the operator grant that admits a merchant to live sales. The first
   * call writes `at`; every later call while the grant stands returns the
   * original instant with `changed:false`. Null means the merchant is absent.
   * It does not move the merchant's `updated_at`. `analytics` is recorded only
   * with a call that writes the grant.
   */
  grantLiveApproval(
    id: string,
    at: number,
    analytics?: AnalyticsOf<{ readonly merchant: StoredMerchant; readonly changed: boolean }>,
  ): Promise<{ readonly merchant: StoredMerchant; readonly changed: boolean } | null>;

  /**
   * Clears the operator's grant, so the merchant stands as one never approved.
   * A call that finds no grant changes nothing and says `changed:false`. Null
   * means the merchant is absent. It does not move the merchant's `updated_at`.
   */
  withdrawLiveApproval(
    id: string,
  ): Promise<{ readonly merchant: StoredMerchant; readonly changed: boolean } | null>;

  /** Every merchant, for the command that lists them. */
  merchants(): Promise<readonly StoredMerchant[]>;

  /**
   * Sets or clears one merchant's listing name and returns the merchant as they
   * now stand, or null where there is no such merchant. The value must already
   * be validated, by `setServiceName` in `app/merchants.ts`. `analytics` is
   * recorded only when the name the row held is a different one.
   */
  setServiceName(
    id: string,
    serviceName: string | null,
    at: number,
    analytics?: AnalyticsOf<StoredMerchant>,
  ): Promise<StoredMerchant | null>;

  /**
   * Sets one merchant's shop site and returns the merchant as they now stand,
   * or null where there is no such merchant. The value must already be
   * validated, by `setSellerSite` in `app/merchants.ts`. `analytics` is
   * recorded only when the site the row held is a different one.
   */
  setSellerSite(
    id: string,
    sellerSite: string,
    at: number,
    analytics?: AnalyticsOf<StoredMerchant>,
  ): Promise<StoredMerchant | null>;

  /**
   * Writes the merchant's payout wallet only where the row still holds
   * `expected`, compared by both halves and the instant, and records the split
   * of each address in `next` that has none, in the same write: both land or
   * neither. Returns the merchant as they now stand and the splits recorded
   * for the first time; `"moved"` means the row changed meanwhile and nothing
   * was written, split included; null means no such merchant. It is a
   * compare-and-set rather than a lock because a live change is announced to
   * the merchant between the read and the write, and a lock across that call
   * would hold a row on the money path for seconds.
   *
   * A split already recorded is kept as recorded, with its first instant.
   * Refuses, writing nothing, a split that is not this merchant's for the
   * address it is given with on the store's network, and one whose merchant,
   * wallet and network are recorded at another address. A wallet and its
   * split's wallet are matched in either spelling. A set address cannot be
   * cleared, as the type of `next` says; ending sales is the pause.
   * `analytics` is asked only of a write that landed, and since the row held
   * `expected`, comparing that with what was written tells whether it changed.
   */
  setPayoutWallet(
    id: string,
    expected: PayoutWalletRead,
    next: PayoutWalletWrite,
    at: number,
    analytics?: AnalyticsOf<WalletWritten>,
  ): Promise<WalletWritten | "moved" | null>;

  // --- the payout splits ----------------------------------------------------

  /**
   * Records each split that has no row yet, at `at`, and returns those it
   * recorded; one already recorded is left as it is. Two callers recording one
   * split at once record it once. Refuses, writing nothing, a split whose
   * merchant, wallet and network are recorded at another address. No merchant
   * is touched: this is how a wallet found without its split gets one.
   */
  recordPayoutSplits(
    splits: readonly PayoutSplit[],
    at: number,
  ): Promise<readonly RecordedPayoutSplit[]>;

  /**
   * The split recorded at this address, in either spelling, whoever's it is,
   * or null. Across merchants because no wallet may be any merchant's split;
   * nothing reachable from a request may hand its answer to a caller.
   */
  payoutSplitAt(address: string): Promise<RecordedPayoutSplit | null>;

  /** Every network the registry holds a split of, each once. */
  networksWithPayoutSplits(): Promise<readonly string[]>;

  /**
   * One merchant's splits on this network that can hold money: the split of
   * the wallet in force at `at`, and every recorded split one of their
   * orders was verified against, in the order they were recorded (address
   * breaking a tie). An order verified against a wallet itself names no
   * split, and a waiting split that never took effect and was never paid
   * holds nothing.
   */
  splitsToPayOutFor(
    network: string,
    merchantId: string,
    at: number,
  ): Promise<readonly RecordedPayoutSplit[]>;

  /**
   * Every split recorded on this network, every merchant's and a forgotten
   * merchant's, in the order they were recorded (address breaking a tie), for
   * the operator's payout and the start's check. A split no wallet is in force
   * for and no order names may still hold money: a restore carries such rows
   * over, and anybody may send USDC to any split. Never reachable from a
   * request.
   */
  payoutSplitsOn(network: string): Promise<readonly RecordedPayoutSplit[]>;

  /** Writes one key of one merchant; only its digest is kept. */
  addKey(
    key: {
      readonly id: string;
      readonly merchantId: string;
      readonly label: string;
      readonly digest: string;
    },
    at: number,
    analytics?: AnalyticsOf<StoredKey>,
  ): Promise<StoredKey>;

  /**
   * Records that a call came in on this key at this instant, and what it said
   * it runs. The caller writes only once the stored instant has gone stale and
   * swallows a failure here, since no purchase depends on it. The mark never
   * goes backwards, and the user agent moves with it: two gateway processes
   * write it from two clocks without serialising. A key that is not there is
   * not an error, and nothing is written.
   */
  noteKeyUse(id: string, at: number, userAgent: string | null): Promise<void>;

  /**
   * Records that one of this merchant's processes polled their stream at this
   * instant. The mark never goes backwards, since two gateway processes write
   * it from two clocks without serialising, and it outlives a restart: a
   * restarted gateway that knew of no poll would refuse every prepaid sale
   * until each merchant's process polled again. A merchant that is not there
   * is not an error, and nothing is written.
   */
  noteContact(merchantId: string, at: number): Promise<void>;

  /** The latest poll recorded for this merchant, or null where none ever was. */
  lastContact(merchantId: string): Promise<number | null>;

  /**
   * The key a request presented, found by its digest, or null where there is no
   * such key or it is disabled; the two answers must stay the same, so the door
   * never confirms which guesses were once real keys. Looking a digest up by
   * index, rather than comparing secrets, keeps the check constant-time. It
   * returns the whole row because a merchant cannot disable the key their own
   * call was made with, and only the door knows which key that was.
   */
  workingKey(digest: string): Promise<StoredKey | null>;

  /**
   * The key with this digest, working or not, for the command that must not
   * issue a second key with a digest already taken. Never reachable from a
   * request.
   */
  keyByDigest(digest: string): Promise<StoredKey | null>;

  /**
   * Every key of one merchant, disabled ones included, never their secrets.
   * Oldest first with the identifier settling a tie, so a list on a merchant's
   * screen is stable between visits and both adapters agree.
   */
  keysOf(merchantId: string): Promise<readonly StoredKey[]>;

  /**
   * Stops one key working and returns it as it now stands, or null where there
   * is no such key. A key already disabled keeps its first revocation instant.
   * It names no merchant, which is safe only because nothing reachable from a
   * request calls it; the dashboard calls {@link disableKeyOf}.
   */
  disableKey(id: string, at: number): Promise<StoredKey | null>;

  /**
   * Stops one of this merchant's keys working and returns it as it now stands,
   * or null where this merchant has no such key. That null must stay the same
   * as for a key that exists nowhere, or a merchant walking identifiers would
   * learn which belong to others. The merchant is in the write's predicate
   * rather than checked after a read, so there is no window between learning
   * whose a key is and writing to it. A key already disabled keeps its first
   * revocation instant.
   */
  disableKeyOf(merchantId: string, id: string, at: number): Promise<StoredKey | null>;

  // --- the catalog ----------------------------------------------------------

  /**
   * Publishes one card for one merchant. Republishing under the same
   * `merchant_item_id` updates that merchant's card in place, keeping its
   * catalog identifier. `merchant_item_id` is unique within one merchant's
   * catalog only: two merchants may both sell a "sku-1".
   *
   * A card stays with the integration that first published it, the API where
   * none is named: a publish through the other integration under the same
   * identifier changes nothing and answers the card as it stands, whose
   * `integration` says whose it is.
   *
   * `analytics` is recorded only when this call made a new card, as the write
   * itself decides it: of publishes racing with one new identifier, one makes
   * the card and the rest update it.
   */
  publishCard(
    merchantId: string,
    card: Card,
    at: number,
    integration?: Integration,
    analytics?: AnalyticsOf<StoredCard>,
  ): Promise<StoredCard>;

  /**
   * One card by its catalog identifier, whoever published it. Unscoped because
   * a buying agent has no key and no merchant; the card carries its merchant,
   * which is how a purchase reaches the right one.
   */
  cardById(id: string): Promise<StoredCard | null>;

  /** The cards one merchant published, and nobody else's. */
  cards(merchantId: string): Promise<readonly StoredCard[]>;

  /**
   * Every card the gateway holds, each with the word its own merchant is
   * selling under, for the public catalog. The word is per merchant, so one
   * merchant stopping takes only their own cards out.
   */
  catalogEntries(): Promise<readonly CatalogEntry[]>;

  /**
   * Takes one of this merchant's cards off sale, or puts it back, and returns
   * the card as it now stands; null where this merchant has no such card, the
   * same answer as no such card anywhere. Republishing does not clear a pause,
   * so editing a price never puts a product taken off sale back on it.
   * `analytics` is recorded only when the card was not already as asked.
   */
  setCardPaused(
    merchantId: string,
    id: string,
    paused: boolean,
    analytics?: AnalyticsOf<StoredCard>,
  ): Promise<StoredCard | null>;

  /**
   * Whether this merchant is taking new orders, the word the order machine is
   * given when an order is made against their cards. A merchant never paused
   * is selling; there is no "unknown" answer.
   */
  selling(merchantId: string): Promise<MerchantSelling>;

  /**
   * Stops this merchant's selling, or starts it again. `analytics` is recorded
   * only when the merchant was not already selling as asked.
   */
  setSelling(
    merchantId: string,
    selling: MerchantSelling,
    analytics?: AnalyticsEvent,
  ): Promise<void>;

  /**
   * Moves this merchant to the other integration, or says which orders hold
   * it where it is (`IntegrationSwitch`). Switching to the one they already
   * sell through changes nothing and is not refused.
   *
   * One transaction, holding the merchant's row against the birth of an
   * order (`addOrder` with a `Birth`), so no order can be made for a card in
   * the moment it goes off sale.
   *
   * `analytics` is recorded in that transaction only when the switch stopped
   * the merchant's selling.
   */
  switchIntegration(
    merchantId: string,
    to: Integration,
    analytics?: AnalyticsEvent,
  ): Promise<IntegrationSwitch>;

  // --- orders ---------------------------------------------------------------

  /**
   * How many of this merchant's purchases wait for payment at `at`
   * (`waitsForPayment`), counted up to `atMost` and no further.
   */
  waitingForPayment(merchantId: string, at: number, atMost: number): Promise<number>;

  /**
   * Writes an order that is not there yet. The record says whose it is. An
   * identifier or a payment reference another order already has is refused.
   *
   * Given a `Birth`, the write is made only while its merchant still sells
   * through the integration named and fewer than `waitingAtMost` of their
   * purchases wait for payment at the order's own birth (`waitsForPayment`);
   * the count and the write
   * are one step against every other birth for that merchant, and the write and
   * `switchIntegration` wait for each other on the merchant. Its clocks are
   * written in the same step, so a birth refused for either reason writes
   * nothing. A purchase always names one; without one the write is
   * unconditional, which is how a test sets an order down.
   *
   * `analytics` is recorded in the same write, dated when the order was made,
   * and only when the order was written.
   */
  addOrder(record: StoredOrder, birth?: Birth, analytics?: AnalyticsEvent): Promise<Born>;

  /**
   * One order by its identifier, whoever it belongs to. Unscoped because its
   * callers have no merchant: the payment route, which takes no key, and the
   * gateway's own clocks. A merchant's own read is {@link merchantOrder}.
   */
  orderById(id: string): Promise<StoredOrder | null>;

  /**
   * The order a buyer's key opens, whoever it belongs to. Only the agent's
   * read of its own purchase asks: the answer it gets names no merchant, which
   * keeps this from being a read across merchants.
   */
  orderByBuyerKey(buyerKey: string): Promise<StoredOrder | null>;

  /**
   * The order a payment is for, by the reference its challenge carried,
   * whoever it belongs to; unscoped for the same reason as `orderById`. Only
   * the payment route asks it: a reference is not an order's identifier, and
   * no other route reads one.
   */
  orderByPaymentRef(paymentRef: string): Promise<StoredOrder | null>;

  /** One of this merchant's orders. Another merchant's order is not found. */
  merchantOrder(merchantId: string, id: string): Promise<StoredOrder | null>;

  /**
   * This merchant's orders, or with `open` only the ones still owed work or
   * money and the closed ones whose payment completed after the closure. With
   * `leaveOutLapsed`, the attempts that lapsed unpaid (`lapsedAttempt`) are
   * not read at all.
   */
  orders(
    merchantId: string,
    query?: { readonly open?: boolean; readonly leaveOutLapsed?: boolean },
  ): Promise<readonly StoredOrder[]>;

  /**
   * One page of this merchant's attempts that lapsed unpaid, priced or not,
   * the newest first, and how many such attempts they have in all. A `limit`
   * of nothing reads only the count.
   */
  lapsedAttempts(
    merchantId: string,
    page: { readonly offset: number; readonly limit: number },
  ): Promise<{ readonly orders: readonly StoredOrder[]; readonly of: number }>;

  /**
   * Every order still owed work or money, whoever it belongs to, for the
   * sweep, which asks the orders what they are missing rather than keeping a
   * second record of what was meant to happen. It stays bounded because every
   * open order waits on a deadline that closes it.
   */
  openOrders(): Promise<readonly StoredOrder[]>;

  /** Unanswered charges, including closed purchases, in bounded identifier order. */
  unresolvedPayments(afterId?: string, limit?: number): Promise<readonly StoredOrder[]>;

  /** Saved authorizations, bounded, for detecting ambiguous ownership before old charges are recovered. */
  paymentOrders(afterId?: string, limit?: number): Promise<readonly StoredOrder[]>;

  /**
   * Runs `work` only if nothing anywhere in the gateway is running the work
   * called `name`, and otherwise returns at once without running it. The sweep
   * needs this across processes: it reads the world and then acts, so two
   * overlapping runs (a run that outlasts the queue's expiry is offered again
   * to another process) would both find an envelope missing and hand the order
   * over twice. It is a lock held by a connection, not a record: if the
   * connection dies while the work carries on, the next caller is told the
   * name is free and starts beside it.
   */
  runAlone<T>(name: string, work: () => Promise<T>): Promise<Ran<T>>;

  /**
   * Deletes at most `limit` attempts that lapsed unpaid (`lapsedAttempt`),
   * whoever they belong to, that were last written before `instant` and that
   * no receipt and no payment claim names, and returns how many went. An
   * order deleted is answered after as one that never existed. Bounded, so
   * each call is a short statement however many have piled up.
   */
  forgetLapsedBefore(instant: number, limit: number): Promise<number>;

  /**
   * Every order that ended delivered with no receipt, whoever it belongs to.
   * The receipt is written with the order, so this should always be empty; it
   * is checked because a delivered order without a receipt is a sale the
   * merchant cannot reconcile their wallet against.
   */
  deliveredWithoutReceipt(): Promise<readonly StoredOrder[]>;

  /**
   * Holds one order, hands it to `change`, and writes back whatever `change`
   * asks; nothing else touches the order in between. Given a `scope`, another
   * merchant's order is not found: ownership is checked in the same read as the
   * lock, so there is no window between checking whose it is and acting on it.
   *
   * Where `change` saves the order, `analytics` is asked what the order as
   * found and as saved amount to, and what it answers is recorded in the same
   * write; it is not asked when nothing is saved, and nothing it answered
   * stays when the write fails.
   */
  withOrder<T>(
    id: string,
    change: (found: StoredOrder) => Promise<OrderChange<T>> | OrderChange<T>,
    scope?: MerchantScope,
    analytics?: OrderAnalytics,
  ): Promise<OrderLookup<T>>;

  // --- payments -------------------------------------------------------------

  /**
   * Binds one payment to one order for good. A signed payment authorises an
   * amount to an address and names no purchase, and a second presentation is
   * invisible to the payment layer until its charge fails, so without this one
   * signature could buy two orders at the same price and both be delivered.
   * The first order to present a payment owns it. The claim is taken after the
   * payment verifies, so a payment that never checked out claims nothing, and
   * the same payment for any other order is refused before anything is
   * dispatched or charged. It is
   * deliberately across the whole gateway: a claim per merchant would let one
   * authorisation be spent once at each merchant.
   */
  claimPayment(fingerprint: string, orderId: string): Promise<PaymentClaim>;

  /**
   * Who holds the claim on a payment, or null where nobody does; it claims
   * nothing. A payment checked without the payment layer is refused when
   * another order holds it, or this order kept it, before anything about the
   * order is compared with it.
   */
  paymentClaimHolder(fingerprint: string): Promise<ClaimHolder | null>;

  /**
   * Lets go of a claim this order took and then could not use because the
   * ownership decision turned the presentation away and no money moved; left
   * behind, it would answer that live authorisation's next attempt "already
   * spent". Only the holder can release: a fingerprint claimed by another order
   * is left as it is.
   */
  releaseClaim(fingerprint: string, orderId: string): Promise<void>;

  /**
   * Forgets unaccepted claims older than an instant. Accepted authorizations
   * remain tied to their order permanently, including when their charge is unknown.
   */
  forgetClaimsBefore(instant: number): Promise<number>;

  /** Writes down one merchant's receipt for one order. */
  putReceipt(merchantId: string, receipt: Receipt): Promise<void>;

  /**
   * The receipt for one order, whoever it belongs to. Only tests read a
   * receipt this way. The read is not scoped to a merchant, so anything that
   * serves its answer to a caller has to settle whose order it is first.
   */
  receiptForOrder(orderId: string): Promise<Receipt | null>;

  /** This merchant's receipts, and nobody else's. */
  receipts(merchantId: string): Promise<readonly Receipt[]>;
}
