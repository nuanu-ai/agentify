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

import type { MerchantSelling, Order } from "@agentify/core";
import type {
  Card,
  Delivery,
  ParamSpec,
  Receipt,
  ShipTo,
  WorkerEnvelope,
} from "@nuanu-ai/agentify-contracts";

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
  /**
   * The address the payment was verified against. The charge must go to the
   * address the payer signed for even if the merchant moves their wallet
   * between verification and charge, which in the synchronous mode spans the
   * whole fulfilment. Null until a payment is verified, and on the sandbox,
   * which settles against no address.
   */
  readonly payTo: string | null;
  /**
   * The order's owner: the payer the payment layer named when it verified the
   * first payment for the order (never the address a payment declares of
   * itself), or that payment's fingerprint where the layer names none. Order
   * ids are not secret and the payment route takes no key, so without an owner
   * anyone holding an id could pay against, take the goods of, or close
   * someone else's order. It is set inside the store's hold on the order, so
   * two racing payments cannot both become the owner.
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
   * Everything the payment layer has said about this order, in its own words
   * and in order. The machine keeps only a coarse verdict, and this is what an
   * operator reconciles a charge that went quiet from.
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

/** Whether a payment is this order's to spend. */
export type PaymentClaim =
  | { readonly claimed: true }
  | { readonly claimed: false; readonly heldBy: string };

/**
 * A wallet change that has been announced to the merchant and has not taken
 * effect yet. Both fields or neither: the table refuses half of one.
 */
export interface PendingPayoutWallet {
  readonly address: string;
  /** When it replaces the address paid now, counted from the announcement. */
  readonly takesEffectAt: number;
}

/**
 * Where a merchant is paid, as their row holds it: `address` as of the last
 * write (null where none was ever set) and a `pending` replacement, or null.
 * They are one value because they are written and compared together: a change
 * is recorded only where the row still holds the pair read before it was
 * announced.
 */
export interface StoredPayoutWallet {
  readonly address: string | null;
  readonly pending: PendingPayoutWallet | null;
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
   * Where this merchant's sales are paid: buyers' agents pay this address
   * directly, and it is the `payTo` of every payment request for the
   * merchant's cards. It is stored in the mixed-case spelling a wallet
   * displays, so one address is never two strings. A null `address` means
   * nobody has said where the money goes, and it is never filled in from the
   * gateway's own configured address, which is the operator's.
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
}

/** One card in the public catalog, with the word its own merchant sells under. */
export interface CatalogEntry {
  readonly card: StoredCard;
  readonly merchant: MerchantSelling;
  /**
   * Where the card's merchant is paid, carried because a card whose merchant
   * has no address cannot be sold where the money is real. It is as the row
   * holds it: the address paid now is asked of `payoutWalletAt` with the clock.
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
}

/** Which merchant an order belongs to, where a read is one merchant's alone. */
export interface MerchantScope {
  readonly merchantId: string;
}

export interface Store {
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
   * Records the one operator grant that admits a merchant to live sales. The
   * first call writes `at`; every later call returns the original instant with
   * `changed:false`. Null means the merchant is absent. It does not move the
   * merchant's `updated_at`.
   */
  grantLiveApproval(
    id: string,
    at: number,
  ): Promise<{ readonly merchant: StoredMerchant; readonly changed: boolean } | null>;

  /** Every merchant, for the command that lists them. */
  merchants(): Promise<readonly StoredMerchant[]>;

  /**
   * Sets or clears one merchant's listing name and returns the merchant as they
   * now stand, or null where there is no such merchant. The value must already
   * be validated, by `setServiceName` in `app/merchants.ts`.
   */
  setServiceName(
    id: string,
    serviceName: string | null,
    at: number,
  ): Promise<StoredMerchant | null>;

  /**
   * Sets one merchant's shop site and returns the merchant as they now stand,
   * or null where there is no such merchant. The value must already be
   * validated, by `setSellerSite` in `app/merchants.ts`.
   */
  setSellerSite(id: string, sellerSite: string, at: number): Promise<StoredMerchant | null>;

  /**
   * Writes the merchant's payout wallet only where the row still holds
   * `expected`, compared by both halves and the instant, and returns the
   * merchant as they now stand; `"moved"` means the row changed meanwhile and
   * nothing was written, null means no such merchant. It is a compare-and-set
   * rather than a lock because a live change is announced to the merchant
   * between the read and the write, and a lock across that call would hold a
   * row on the money path for seconds.
   *
   * Addresses must already be in the checksummed spelling `payoutWalletFrom`
   * in `app/merchants.ts` produces. A set address cannot be cleared, as the
   * type of `next` says; ending sales is the pause.
   */
  setPayoutWallet(
    id: string,
    expected: StoredPayoutWallet,
    next: StoredPayoutWallet & { readonly address: string },
    at: number,
  ): Promise<StoredMerchant | "moved" | null>;

  /** Writes one key of one merchant; only its digest is kept. */
  addKey(
    key: {
      readonly id: string;
      readonly merchantId: string;
      readonly label: string;
      readonly digest: string;
    },
    at: number,
  ): Promise<StoredKey>;

  /**
   * Records that a call came in on this key at this instant. The caller writes
   * only once the stored instant has gone stale and swallows a failure here,
   * since no purchase depends on it. The mark never goes backwards: two gateway
   * processes write it from two clocks without serialising. A key that is not
   * there is not an error, and nothing is written.
   */
  noteKeyUse(id: string, at: number): Promise<void>;

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
   */
  publishCard(merchantId: string, card: Card, at: number): Promise<StoredCard>;

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
   */
  setCardPaused(merchantId: string, id: string, paused: boolean): Promise<StoredCard | null>;

  /**
   * Whether this merchant is taking new orders, the word the order machine is
   * given when an order is made against their cards. A merchant never paused
   * is selling; there is no "unknown" answer.
   */
  selling(merchantId: string): Promise<MerchantSelling>;

  /** Stops this merchant's selling, or starts it again. */
  setSelling(merchantId: string, selling: MerchantSelling): Promise<void>;

  // --- orders ---------------------------------------------------------------

  /** Writes an order that is not there yet. The record says whose it is. */
  addOrder(record: StoredOrder): Promise<void>;

  /**
   * One order by its identifier, whoever it belongs to. Unscoped because its
   * callers have no merchant: the payment route, which takes no key; the
   * agent's read of its own purchase; and the gateway's own clocks. The answer
   * the agent gets names no merchant, which keeps this from being a read
   * across merchants. A merchant's own read is {@link merchantOrder}.
   */
  orderById(id: string): Promise<StoredOrder | null>;

  /** One of this merchant's orders. Another merchant's order is not found. */
  merchantOrder(merchantId: string, id: string): Promise<StoredOrder | null>;

  /** This merchant's orders, or with `open` only the ones still owed work or money. */
  orders(merchantId: string, query?: { readonly open?: boolean }): Promise<readonly StoredOrder[]>;

  /**
   * Every order still owed work or money, whoever it belongs to, for the
   * sweep, which asks the orders what they are missing rather than keeping a
   * second record of what was meant to happen. It stays bounded because every
   * open order waits on a deadline that closes it.
   */
  openOrders(): Promise<readonly StoredOrder[]>;

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
   */
  withOrder<T>(
    id: string,
    change: (found: StoredOrder) => Promise<OrderChange<T>> | OrderChange<T>,
    scope?: MerchantScope,
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
   * Lets go of a claim this order took and then could not use because the
   * ownership decision turned the presentation away and no money moved; left
   * behind, it would answer that live authorisation's next attempt "already
   * spent". Only the holder can release: a fingerprint claimed by another order
   * is left as it is.
   */
  releaseClaim(fingerprint: string, orderId: string): Promise<void>;

  /**
   * Forgets claims older than an instant and returns how many went. Anyone can
   * make claims without a key, so the table must be pruned; a claim only
   * matters between verification and charge, after which the token itself
   * refuses a second use.
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
