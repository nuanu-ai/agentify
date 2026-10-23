/**
 * The reads the workspace's Orders, one order's page and the lookup make
 * across merchants. Never handed out from here: a buyer's key or status
 * address, a parcel's address, purchase parameter values, delivered goods, or
 * a payer's wallet.
 *
 * Every read answers with facts, never with words a page shows: a state is
 * the order machine's own or the wire's, and the dashboard words it. A read
 * that fails throws; an empty answer is a read that succeeded and found
 * nothing.
 */

import { isOpen, ORDER_STATES, type Order, type OrderState } from "@agentify/core";
import type {
  Fulfillment,
  OrderStatus,
  PaymentStatus,
  Receipt,
} from "@nuanu-ai/agentify-contracts";
import type { WrittenOrderStatus } from "../../app/written.js";
import { lapsedAttempt, type StoredOrder } from "../store.js";

export interface OperatorOrders {
  /**
   * One page of the channel's orders, newest first: at most `ORDERS_PAGE` of
   * the segment shown, under the search and the merchant filter, with every
   * segment's count under the same two.
   */
  orders(query: OrdersQuery): Promise<OrdersPage>;
  /** One order as its page draws it, or null where the channel holds no such order. */
  order(id: string): Promise<OperatorOrder | null>;
  /**
   * The records a pasted text names, none, one or several: an order by its
   * identifier or by a transaction its payment names, a merchant by its
   * identifier, a payout wallet or split address, or the site it sells from.
   * `at` is the moment of reading, which decides which wallet is in force; a
   * split waiting behind a wallet change that has not landed is never found.
   * An email address finds nothing here: accounts are the dashboard's.
   */
  find(text: string, at: number): Promise<readonly Found[]>;
}

/** How many rows one page of the orders list carries. */
export const ORDERS_PAGE = 50;

/**
 * The segments of the orders list, ordered by how unusual they are. Every
 * order is in exactly one of them; `all` is their sum.
 */
export const ORDER_SEGMENTS = [
  "payment_unknown",
  "unfulfilled",
  "delivered_unpaid",
  "in_progress",
  "ended",
  "lapsed",
] as const;

export type OrderSegment = (typeof ORDER_SEGMENTS)[number];

export type OrdersShown = OrderSegment | "all";

/** Where a page of the list starts: the orders made before this one. */
export interface OrdersCursor {
  readonly createdAt: number;
  readonly id: string;
}

export interface OrdersQuery {
  readonly shown: OrdersShown;
  /**
   * Matched, ignoring case, anywhere in the order identifier, the product's
   * title or the merchant's own identifier for it, or a transaction the
   * order's payment names. Blank matches every order.
   */
  readonly search?: string;
  readonly merchantId?: string;
  readonly before?: OrdersCursor;
}

export interface OrdersPage {
  /** Every segment's count, and `all`, under the query's search and merchant filter. */
  readonly counts: Readonly<Record<OrdersShown, number>>;
  /** At most `ORDERS_PAGE` orders of the segment shown, newest first. */
  readonly rows: readonly OperatorOrderRow[];
  /** How many orders of the segment shown are newer than the page: the rows before it. */
  readonly newer: number;
  /** Where the next page of earlier orders starts, or null where the page holds the oldest. */
  readonly earlier: OrdersCursor | null;
  /** The merchants that have any order on the channel, for the filter, by identifier. */
  readonly merchants: readonly OrderMerchant[];
}

export interface OrderMerchant {
  readonly id: string;
  readonly name: string;
  /** The name the merchant sells under, or null where they have none now. */
  readonly serviceName: string | null;
}

export interface OrderProduct {
  /** Our catalog identifier. */
  readonly itemId: string;
  readonly merchantItemId: string;
  /** The card's title as the card stands now, or null where the channel no longer holds it. */
  readonly title: string | null;
}

export interface OrderAmount {
  readonly amount: string;
  readonly currency: string;
}

/** One row of the orders list. */
export interface OperatorOrderRow {
  readonly id: string;
  readonly createdAt: number;
  /** When the price was set, or null where none was. */
  readonly pricedAt: number | null;
  readonly merchant: OrderMerchant;
  readonly product: OrderProduct;
  /** What the order sells for, or null where nobody named a price. */
  readonly price: OrderAmount | null;
  /** The status the merchant's Orders and the agent both read. */
  readonly status: OrderStatus;
  /** The original payment, as the wire says it: paid, not paid, or unresolved. */
  readonly payment: PaymentStatus;
  readonly segment: OrderSegment;
  readonly test: boolean;
}

/** One order, everything its page draws from the gateway's record. */
export interface OperatorOrder extends OperatorOrderRow {
  /** The order machine's own state. */
  readonly state: OrderState;
  readonly fulfillment: Fulfillment;
  /** How long the card gave its merchant to fulfill, on an order fulfilled later. */
  readonly fulfillmentMs: number;
  readonly quoteSource: Order["quoteSource"];
  readonly agent: AgentReads;
  /** What the merchant reads in their Orders. */
  readonly merchantReads: MerchantReads;
  /** The steps the order went through, oldest first; a step the record keeps no time for has none. */
  readonly timeline: readonly OrderStep[];
  readonly paid: OrderPayment;
  /** The receipt the gateway issued, or null where it issued none. */
  readonly receipt: Receipt | null;
  /** What the order holds and the page never shows, said as whether it exists. */
  readonly withheld: Withheld;
}

/**
 * What the agent reads about its purchase, field for field as the wire writes
 * it: never its status address, which carries the buyer's key, nor its goods
 * or shipment.
 */
export type AgentReads = Pick<
  WrittenOrderStatus,
  | "status"
  | "payment_status"
  | "seller"
  | "transaction"
  | "reason"
  | "refusal"
  | "merchant_closure"
  | "ship_by"
>;

export interface MerchantReads {
  readonly status: OrderStatus;
  readonly payment_status: PaymentStatus;
  readonly merchant_closure?: { readonly closed_at: string; readonly message?: string };
  /** Whether a restarted worker's open list carries it. */
  readonly onOpenList: boolean;
  /** Whether it is listed apart, as an attempt that lapsed unpaid. */
  readonly lapsed: boolean;
}

/**
 * One step of an order's story. `at` is the moment the record keeps for it,
 * and null where the record keeps none: such a step is placed after the steps
 * it follows in the order's life, never at a time worked out from a deadline.
 */
export type OrderStep =
  | { readonly kind: "created"; readonly at: number }
  | { readonly kind: "priced"; readonly at: number | null; readonly price: OrderAmount }
  | { readonly kind: "charge_sent"; readonly at: number }
  | { readonly kind: "paid"; readonly at: number }
  | ({ readonly kind: "facilitator_said" } & SaidWord)
  /** The charge's answer, and who gave it: the facilitator, or recovery reading the chain. */
  | {
      readonly kind: "payment_completed";
      readonly at: number | null;
      readonly settled: boolean;
      readonly source: "facilitator" | "chain";
    }
  /** The last hand-over to the merchant, how many there were, and whether one was taken on. */
  | {
      readonly kind: "handed_over";
      readonly at: number;
      readonly times: number;
      readonly takenOn: boolean;
    }
  | { readonly kind: "goods_delivered"; readonly at: null }
  | { readonly kind: "shipment_recorded"; readonly at: number }
  | { readonly kind: "ended"; readonly at: null; readonly closure: Order["closure"] }
  /** By the merchant, the one actor this step names. */
  | { readonly kind: "closed_by_merchant"; readonly at: number; readonly withMessage: boolean }
  | { readonly kind: "paid_after_closure"; readonly at: number }
  | { readonly kind: "address_erased"; readonly at: number };

/** One thing the facilitator said, a wallet's address in it replaced by "a wallet". */
export interface SaidWord {
  readonly at: number;
  readonly about: "verify" | "settle";
  readonly said: string;
}

export interface OrderPayment {
  /** The order machine's payment stage. */
  readonly stage: Order["payment"];
  readonly status: PaymentStatus;
  /** The split the payment was verified against, or null before a verified payment. */
  readonly paidInto: string | null;
  /** The transaction that paid the order, where money moved. */
  readonly transaction: string | null;
  readonly attempt: OrderAttempt | null;
  readonly words: readonly SaidWord[];
  /** How many of the facilitator's words fell off the end of the bounded list. */
  readonly wordsDropped: number;
  /** Since when the outcome has been unknown, where it is. */
  readonly unknownSince: number | null;
}

/** The submitted charge, without the authorization it carries. */
export interface OrderAttempt {
  readonly startedAt: number;
  readonly completion: {
    readonly settled: boolean;
    readonly executedAt: number | null;
    readonly source: "facilitator" | "chain";
  } | null;
  /** A transaction recovery was told to look for: a hint, never evidence that money moved. */
  readonly searchHint: string | null;
  /** The next block recovery will read, as its last search left it. */
  readonly nextBlock: string | null;
}

export interface Withheld {
  /** Whether the buyer entered values at purchase. */
  readonly buyerEntered: boolean;
  /** A parcel's address: held, erased at a moment, or null where the order never had one. */
  readonly address: "held" | { readonly erasedAt: number } | null;
  /** Whether the merchant delivered goods the order keeps. */
  readonly goods: boolean;
}

/** A record a pasted text names, and what in it matched. */
export type Found =
  | { readonly kind: "order"; readonly by: "id" | "transaction"; readonly order: OperatorOrderRow }
  | {
      readonly kind: "merchant";
      readonly by: "id" | "wallet" | "split" | "site";
      readonly merchant: OrderMerchant;
    };

/**
 * A payment whose outcome nobody has said yet: a charge still settling, or one
 * whose answer was lost, as the agent's `unresolved` reads. The one predicate
 * the overview's count and the Payment unknown segment both use; on Postgres
 * it is `PAYMENT_UNKNOWN` in `adapters/postgres/operator/predicates.ts`, which
 * reads through the orders table's partial index for it.
 */
export const paymentUnknown = (record: StoredOrder): boolean =>
  record.order.payment === "settling" || record.order.payment === "outcome_unknown";

/** The open states of an order on its way: priced or being priced, paid, handed over, fulfilled. */
export const IN_PROGRESS_STATES: readonly OrderState[] = ORDER_STATES.filter(
  (state) => isOpen(state) && state !== "unfulfilled" && state !== "delivered_unpaid",
);

/** The states in which Agentify no longer expects fulfillment. */
export const ENDED_STATES: readonly OrderState[] = ORDER_STATES.filter((state) => !isOpen(state));

// Each segment below leaves out the orders whose payment is unknown, which
// that segment holds whatever their state; `ENDED` also leaves out the lapsed
// attempts, which have a segment of their own. Their Postgres twins carry the
// same name in capitals in `adapters/postgres/operator/predicates.ts`.

/** Paid with no delivery recorded, open to late fulfillment. */
export const unfulfilledOrder = (record: StoredOrder): boolean =>
  record.order.state === "unfulfilled" && !paymentUnknown(record);

/** Goods made after a charge that did not go through, waiting for the buyer to pay again. */
export const deliveredNotPaid = (record: StoredOrder): boolean =>
  record.order.state === "delivered_unpaid" && !paymentUnknown(record);

export const inProgress = (record: StoredOrder): boolean =>
  IN_PROGRESS_STATES.includes(record.order.state) && !paymentUnknown(record);

export const endedOrder = (record: StoredOrder): boolean =>
  ENDED_STATES.includes(record.order.state) && !paymentUnknown(record) && !lapsedAttempt(record);

/** The one segment an order is in. Lapsed attempts are `lapsedAttempt`, the orders table's `lapsed`. */
export function segmentOf(record: StoredOrder): OrderSegment {
  if (paymentUnknown(record)) return "payment_unknown";
  if (lapsedAttempt(record)) return "lapsed";
  if (unfulfilledOrder(record)) return "unfulfilled";
  if (deliveredNotPaid(record)) return "delivered_unpaid";
  if (inProgress(record)) return "in_progress";
  return "ended";
}
