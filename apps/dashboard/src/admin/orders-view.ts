/**
 * What the workspace's Orders, one order's page and the lookup draw, as plain
 * values built from what the operator's reader answered. Every state is worded
 * by the dashboard's own words for the merchant's side and by the wire's own
 * words for the agent's; nothing here says whether a payment went through
 * beyond what the order's record says.
 */

import type {
  Found,
  OperatorOrder,
  OperatorOrderRow,
  OrderMerchant,
  OrderSegment,
  OrderStep,
  OrdersCursor,
  OrdersPage,
  OrdersShown,
} from "@agentify/gateway/operator";
import { type MomentView, merchantOrderWord, momentView, PAYMENT_WORDS, spanOf } from "../views.js";
import { dayOf, FULFILLMENT_WORDS, moment, money, ORDER_WORDS, type Word } from "../words.js";

/** The segments in the order the list shows them, with their names. */
const SEGMENTS: readonly (readonly [OrdersShown, string])[] = [
  ["payment_unknown", "Payment unknown"],
  ["unfulfilled", "Unfulfilled"],
  ["delivered_unpaid", "Held for payment"],
  ["in_progress", "In progress"],
  ["ended", "Ended"],
  ["lapsed", "Lapsed"],
  ["all", "All"],
];

/** A segment named inside a sentence. */
const SEGMENT_NAMES: Readonly<Record<OrderSegment, string>> = {
  payment_unknown: "those whose payment is unknown",
  unfulfilled: "the unfulfilled",
  delivered_unpaid: "those held for payment",
  in_progress: "those in progress",
  ended: "those that ended",
  lapsed: "the lapsed attempts",
};

const EMPTY_SEGMENT: Readonly<Record<OrderSegment, string>> = {
  payment_unknown: "No order's payment outcome is unknown.",
  unfulfilled: "No order is unfulfilled.",
  delivered_unpaid: "No order holds goods for payment.",
  in_progress: "No order is in progress.",
  ended: "No order has ended.",
  lapsed: "No lapsed attempt is kept: the gateway forgets them after thirty days.",
};

export const ORDERS_NOTE =
  "States are written as the merchant's dashboard writes them; each order's page shows the agent's word beside it. Payment is the original payment: paid, not paid or unknown. Lapsed attempts ended with nothing charged; anybody can make one, and the gateway forgets them after thirty days. Nothing on this list can be changed from here.";

export const BOUNDARY =
  "Agentify does not change an order's outcome from here. The merchant closes fulfillment, and a payment's outcome comes from the facilitator or the chain; an operator repeats the order's own word about its payment, never their own reading of the chain.";

export const TIMELINE_NOTE =
  "The order's record keeps the moments of its steps, not a log of every transition. Of repeated hand-overs it keeps the last one and the count; of an ending it keeps the reason but not the time. A caption names an actor only where the record names one.";

/** How long a search may be; the rest is not read. */
const SEARCH_AT_MOST = 200;

/** A cursor as the list's address carries it: the moment, a dot, the identifier. */
const CURSOR = /^(\d{1,16})\.([A-Za-z0-9_-]{1,128})$/;

/** The latest moment a date can hold: a cursor past it names no order. */
const LAST_MOMENT = 8.64e15;

const cursorIn = (query: URLSearchParams): OrdersCursor | null => {
  const matched = CURSOR.exec(query.get("before") ?? "");
  const createdAt = Number(matched?.[1]);
  return matched === null || !Number.isSafeInteger(createdAt) || createdAt > LAST_MOMENT
    ? null
    : { createdAt, id: matched[2] ?? "" };
};

/**
 * A text as an address carried it, without the control characters no
 * identifier, product or site holds and a database refuses, trimmed.
 */
export const typedIn = (text: string | null, atMost: number): string =>
  (text ?? "").replaceAll(CONTROL, "").trim().slice(0, atMost);

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it takes out
const CONTROL = /[\u0000-\u001f\u007f]/g;

const cursorOf = (cursor: OrdersCursor): string => `${cursor.createdAt}.${cursor.id}`;

/** What the list's address asks for. */
export interface OrdersAsked {
  readonly shown: OrdersShown;
  readonly q: string;
  readonly merchantId: string | null;
  readonly before: OrdersCursor | null;
}

export const ordersAskedIn = (query: URLSearchParams): OrdersAsked => {
  const show = (query.get("segment") ?? "all").replaceAll("-", "_");
  const merchant = typedIn(query.get("merchant"), SEARCH_AT_MOST);
  return {
    shown: SEGMENTS.some(([key]) => key === show) ? (show as OrdersShown) : "all",
    q: typedIn(query.get("q"), SEARCH_AT_MOST),
    merchantId: merchant === "" ? null : merchant,
    before: cursorIn(query),
  };
};

/** A segment as an address names it, `payment-unknown`, as every link to it is written. */
export const segmentInAddress = (shown: OrdersShown): string => shown.replaceAll("_", "-");

/** The list's address for a segment, keeping the search and the merchant. */
const placeOf = (asked: OrdersAsked, change: Partial<OrdersAsked>): string => {
  const next = { ...asked, ...change };
  const fields = new URLSearchParams();
  if (next.shown !== "all") fields.set("segment", segmentInAddress(next.shown));
  if (next.q !== "") fields.set("q", next.q);
  if (next.merchantId !== null) fields.set("merchant", next.merchantId);
  if (next.before !== null) fields.set("before", cursorOf(next.before));
  const search = fields.toString();
  return search === "" ? "/admin/orders" : `/admin/orders?${search}`;
};

/** A badge's tone, the dashboard's own, or the dashed one for a fact nobody knows. */
type Tone = Word["tone"] | "unknown";

export interface Toned {
  readonly text: string;
  readonly tone: Tone;
}

const paymentToned = (payment: OperatorOrderRow["payment"]): Toned => ({
  text: PAYMENT_WORDS[payment],
  tone: payment === "paid" ? "ok" : payment === "unresolved" ? "unknown" : "quiet",
});

/** A merchant as the workspace names it: the name they sell under, or their identifier. */
const merchantName = (merchant: OrderMerchant): string => merchant.serviceName ?? merchant.id;

interface OrderRowView {
  readonly id: string;
  readonly to: string;
  /** When the price was set; null where none was. */
  readonly priced: MomentView | null;
  /**
   * The day for the heading over the row: the day its price was set, or the
   * day it was made where it has no price.
   */
  readonly day: string;
  readonly merchant: string;
  readonly product: string;
  readonly amount: string | null;
  readonly state: Word;
  readonly payment: Toned;
}

const at = (ms: number): MomentView => momentView(new Date(ms).toISOString());

const orderRowView = (row: OperatorOrderRow): OrderRowView => ({
  id: row.id,
  to: `/admin/orders/${encodeURIComponent(row.id)}`,
  priced: row.pricedAt === null ? null : at(row.pricedAt),
  day: dayOf(new Date(row.pricedAt ?? row.createdAt).toISOString()),
  merchant: merchantName(row.merchant),
  product: row.product.title ?? row.product.merchantItemId,
  amount: row.price === null ? null : money(row.price),
  state: ORDER_WORDS[row.status],
  payment: paymentToned(row.payment),
});

interface SegmentView {
  readonly key: OrdersShown;
  readonly label: string;
  /** Null where the counts could not be read. */
  readonly count: number | null;
  readonly here: boolean;
  readonly to: string;
}

type OrdersResult =
  | Readonly<{
      kind: "rows";
      rows: readonly OrderRowView[];
      /** "Showing 1–50 of 61, newest first". */
      cut: string;
      earlier: string | null;
      newest: string | null;
    }>
  /** A read that succeeded and found nothing, with why. */
  | Readonly<{ kind: "none"; said: string; clear: string | null }>
  | Readonly<{ kind: "unread" }>;

export interface OrdersListView {
  readonly readAt: string;
  readonly q: string;
  readonly show: OrdersShown;
  readonly merchantId: string | null;
  /** The merchants to filter by; null where the list could not be read. */
  readonly merchants: readonly Readonly<{ id: string; name: string }>[] | null;
  readonly segments: readonly SegmentView[];
  readonly result: OrdersResult;
}

/** The orders list, from a page the reader answered, or from none where the read failed. */
export function ordersListView(
  asked: OrdersAsked,
  page: OrdersPage | null,
  readAt: Date,
): OrdersListView {
  const segments = SEGMENTS.map(([key, label]) => ({
    key,
    label,
    count: page === null ? null : page.counts[key],
    here: key === asked.shown,
    to: placeOf(asked, { shown: key, before: null }),
  }));
  const common = {
    readAt: `Read ${moment(readAt.toISOString())}`,
    q: asked.q,
    show: asked.shown,
    merchantId: asked.merchantId,
    segments,
  };
  if (page === null) return { ...common, merchants: null, result: { kind: "unread" } };
  const merchants = page.merchants.map((one) => ({ id: one.id, name: merchantName(one) }));
  const of = page.counts[asked.shown];
  const narrowed = asked.q !== "" || asked.merchantId !== null;
  if (page.rows.length === 0) {
    const clear = narrowed ? placeOf(asked, { q: "", merchantId: null, before: null }) : null;
    const said =
      page.counts.all === 0
        ? !narrowed
          ? "No order has been made on this channel yet."
          : asked.q === ""
            ? "This merchant has no order on this channel."
            : `No order matches “${asked.q}”.`
        : asked.before !== null || asked.shown === "all"
          ? "No earlier order is in this segment."
          : narrowed
            ? `No order among ${SEGMENT_NAMES[asked.shown]} matches ${
                asked.q === "" ? "this merchant" : `“${asked.q}”`
              }.`
            : EMPTY_SEGMENT[asked.shown];
    return { ...common, merchants, result: { kind: "none", said, clear } };
  }
  const from = page.newer + 1;
  const to = page.newer + page.rows.length;
  return {
    ...common,
    merchants,
    result: {
      kind: "rows",
      rows: page.rows.map(orderRowView),
      cut: `Showing ${from}–${to} of ${of}, newest first`,
      earlier: page.earlier === null ? null : placeOf(asked, { before: page.earlier }),
      newest: asked.before === null ? null : placeOf(asked, { before: null }),
    },
  };
}

// --- one order --------------------------------------------------------------

export interface StepView {
  /** What kind of step, and who acted where the record names an actor. */
  readonly who: string;
  readonly what: string;
  readonly said: string | null;
  /** Null where the record keeps no time for it: "time not recorded". */
  readonly at: MomentView | null;
  readonly dot: "pass" | "fail" | "partial" | "progress" | null;
}

/** A value the screen shows short and opening to its whole, with its explorer page. */
export interface IdentView {
  readonly whole: string;
  readonly page: string | null;
}

export interface OrderView {
  readonly kind: "order";
  readonly readAt: string;
  readonly id: string;
  readonly title: string;
  readonly state: Word;
  readonly amount: string | null;
  readonly merchant: Readonly<{ name: string; to: string }>;
  /** "Card esim-7d · Later, within 1 hour". */
  readonly card: string;
  readonly agent: Readonly<{
    status: string;
    paymentStatus: string;
    reason: string | null;
    sellerWords: string | null;
  }>;
  readonly merchantSide: Readonly<{
    heading: string;
    state: Word;
    payment: string;
    lines: readonly string[];
  }>;
  readonly timeline: readonly StepView[];
  readonly payment: Readonly<{
    head: Toned;
    amount: string | null;
    paidInto: IdentView | null;
    transaction: IdentView | null;
    attempt: string;
    words: readonly string[];
    dropped: string;
    unknown: string | null;
    /** What recovery has recorded, where the outcome is unknown. */
    recovery: Readonly<{ hint: IdentView | null; nextBlock: string | null }> | null;
  }>;
  readonly receipt: Readonly<{
    head: string;
    facts: readonly Readonly<{ label: string; value: string }>[];
    said: string | null;
  }>;
  readonly withheld: string;
}

export type OrderPageView =
  | OrderView
  | Readonly<{ kind: "none"; id: string }>
  | Readonly<{ kind: "unread"; id: string }>;

/** Where the channel's explorer shows a transaction and an address; null where it has none. */
export interface Explorer {
  readonly transactionPage: string | null;
  readonly addressPage: string | null;
}

const identOf = (whole: string, page: string | null): IdentView => ({
  whole,
  page: page === null ? null : `${page}${whole}`,
});

const DEADLINES: Readonly<Record<string, string>> = {
  quote_response: "time the merchant's price check had to answer",
  quote_expiry: "time the price stood",
  settle_response: "time to hear whether the charge went through",
  sync_response: "time an immediate delivery had",
  async_fulfillment: "delivery window",
};

function endingOf(
  closure: Extract<OrderStep, { kind: "ended" }>["closure"],
): Readonly<{ what: string; said: string }> {
  switch (closure?.cause) {
    case "unavailable":
      return {
        what: "Not available",
        said: "The merchant's price check said it is not available.",
      };
    case "quote_silent":
      return {
        what: "Price check unanswered",
        said: "The merchant's price check gave no price this purchase could use.",
      };
    case "payment_not_verified":
      return {
        what: "Payment not verified",
        said: `The payment did not pass verification: ${closure.reason.replaceAll("_", " ")}.`,
      };
    case "payment_not_settled":
      return {
        what: "Charge did not go through",
        said: "The payment layer said the charge did not go through.",
      };
    case "payment_outcome_unknown":
      return {
        what: "Charge went unanswered",
        said: "Nobody said whether the money moved when Agentify stopped waiting.",
      };
    case "merchant_refused":
      return {
        what: "Refused by the merchant",
        said: `With the code ${closure.code}, in the merchant's own words to the agent.`,
      };
    case "deadline_expired":
      return {
        what: "Time ran out",
        said: `The ${DEADLINES[closure.deadline] ?? closure.deadline} ran out.`,
      };
    default:
      return { what: "Ended", said: "The record keeps no reason." };
  }
}

function stepView(step: OrderStep, order: OperatorOrder, merchant: string): StepView {
  const when = step.at === null ? null : at(step.at);
  const sync = order.fulfillment === "sync";
  switch (step.kind) {
    case "created":
      return {
        who: "Purchase",
        what: "Order created",
        said: `An agent asked to buy ${order.product.title ?? order.product.merchantItemId} from ${merchant}.`,
        at: when,
        dot: null,
      };
    case "priced":
      return {
        who: "Price",
        what: `Priced at ${money(step.price)}`,
        said:
          order.quoteSource === "merchant_answer"
            ? "The merchant's price check named it."
            : "The card's own price.",
        at: when,
        dot: null,
      };
    case "payment_word":
      return {
        who: "Payment · words recorded",
        what: step.about === "verify" ? "About the verification" : "About the charge",
        said: `“${step.said}”`,
        at: when,
        dot: null,
      };
    case "charge_sent":
      return {
        who: "Payment",
        what: "Charge sent",
        said: sync
          ? "Sent for execution after the goods came back, as an immediate card asks."
          : "Sent for execution before the order went to the merchant.",
        at: when,
        dot: "progress",
      };
    case "paid":
      return sync
        ? {
            who: "Payment",
            what: "Payment verified",
            said: "The order went to the merchant; the money moves once the goods come back.",
            at: when,
            dot: null,
          }
        : {
            who: "Payment",
            what: "Paid",
            said: "The order's record says the money moved.",
            at: when,
            dot: "pass",
          };
    case "payment_completed":
      return {
        who: `Payment · by ${step.source === "facilitator" ? "the facilitator's answer" : "recovery reading the chain"}`,
        what: step.settled ? "Charge settled" : "Charge did not go through",
        said: null,
        at: when,
        dot: step.settled ? "pass" : "fail",
      };
    case "handed_over":
      return {
        who: "Hand-over",
        what: `Handed to ${merchant}`,
        said: `${step.times === 1 ? "One hand-over." : `The last of ${step.times} hand-overs.`}${
          step.takenOn ? " The merchant took the order on." : ""
        }`,
        at: when,
        dot: null,
      };
    case "goods_delivered":
      return {
        who: "Delivery",
        what: "Goods delivered",
        said: "The merchant's goods came back; they are the buyer's and not shown here.",
        at: null,
        dot: "pass",
      };
    case "shipment_recorded":
      return {
        who: "Delivery",
        what: "Shipment recorded",
        said: "The merchant recorded that a carrier has the parcel.",
        at: when,
        dot: "pass",
      };
    case "ended": {
      const ending = endingOf(step.closure);
      // An unfulfilled order keeps the reason it became so, and stays open to a late delivery.
      return {
        who:
          order.state === "unfulfilled" ? "Unfulfilled · still open to a late delivery" : "Ending",
        what: ending.what,
        said: ending.said,
        at: null,
        dot: "fail",
      };
    }
    case "closed_by_merchant":
      return {
        who: "Closure · by the merchant",
        what: `Fulfillment closed by ${merchant}`,
        said: step.withMessage
          ? "With a message to the buyer, shown to the agent as the merchant's own words."
          : "With no message to the buyer.",
        at: when,
        dot: "partial",
      };
    case "paid_after_closure":
      return {
        who: "Payment",
        what: "Paid after the closure",
        said: "The payment completed after the merchant had closed fulfillment.",
        at: when,
        dot: "partial",
      };
    case "address_erased":
      return {
        who: "Address",
        what: "Delivery address erased",
        said: "Agentify no longer holds the buyer's address.",
        at: when,
        dot: null,
      };
  }
}

const durationOf = (ms: number): string => {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hours`;
  return `${Math.floor(hours / 24)} days`;
};

const cardOf = (order: OperatorOrder): string => {
  const how = FULFILLMENT_WORDS[order.fulfillment];
  const within =
    order.fulfillment === "async"
      ? `, within ${spanOf(Math.round(order.fulfillmentMs / 1000))}`
      : "";
  return `Card ${order.product.merchantItemId} · ${how}${within}`;
};

function merchantSideOf(order: OperatorOrder, merchant: string): OrderView["merchantSide"] {
  const reads = order.merchantReads;
  const reopened =
    reads.status === "fulfillment_closed" &&
    reads.payment_status === "paid" &&
    reads.merchant_closure !== undefined &&
    reads.onOpenList;
  const lines: string[] = [];
  if (reads.merchant_closure !== undefined) {
    lines.push(
      `They closed fulfillment on ${moment(reads.merchant_closure.closed_at)}, ${
        reads.merchant_closure.message === undefined
          ? "with no message to the buyer"
          : "with their message to the buyer"
      }.`,
    );
  }
  if (order.price === null) {
    lines.push(
      "Their list leaves it out: it has no price. Read by its identifier, it says what became of it.",
    );
  } else if (reads.lapsed) {
    lines.push("Listed apart, among the attempts that lapsed unpaid.");
  }
  lines.push(
    reads.onOpenList
      ? "It is on the open list their worker reads."
      : "It is not on the open list their worker reads.",
  );
  return {
    heading: `What ${merchant} reads in its Orders`,
    state: merchantOrderWord(reads, reopened),
    payment: PAYMENT_WORDS[reads.payment_status],
    lines,
  };
}

function paymentPanelOf(
  order: OperatorOrder,
  explorer: Explorer,
  readAt: Date,
): OrderView["payment"] {
  const { paid } = order;
  const attempt = paid.attempt;
  const completion = attempt?.completion ?? null;
  return {
    head: paymentToned(paid.status),
    amount: order.price === null ? null : money(order.price),
    paidInto: paid.paidInto === null ? null : identOf(paid.paidInto, explorer.addressPage),
    transaction:
      paid.transaction === null ? null : identOf(paid.transaction, explorer.transactionPage),
    attempt:
      attempt === null
        ? "No charge was sent."
        : completion === null
          ? `One charge sent ${moment(new Date(attempt.startedAt).toISOString())}; no answer is recorded.`
          : `One charge, ${completion.settled ? "settled" : "not settled"} by ${
              completion.source === "facilitator"
                ? "the facilitator's answer"
                : "recovery reading the chain"
            }.`,
    words: paid.words.map(
      (word) => `${moment(new Date(word.at).toISOString())} ${word.about}: ${word.said}`,
    ),
    dropped:
      paid.wordsDropped === 0
        ? "None dropped."
        : `${paid.wordsDropped} more fell off the end of the list.`,
    unknown:
      paid.unknownSince === null
        ? null
        : `Unknown since ${moment(new Date(paid.unknownSince).toISOString())}, for ${durationOf(
            readAt.getTime() - paid.unknownSince,
          )}.`,
    recovery:
      attempt === null || paid.unknownSince === null
        ? null
        : {
            hint:
              attempt.searchHint === null
                ? null
                : identOf(attempt.searchHint, explorer.transactionPage),
            nextBlock: attempt.nextBlock,
          },
  };
}

function withheldOf(order: OperatorOrder): string {
  const said = [
    "The buyer's key and the status address that carries it, and the payer's wallet, which the transaction already names where money moved.",
  ];
  said.push(
    order.withheld.buyerEntered
      ? "The values the buyer entered at purchase are held and not shown."
      : "The buyer entered no values at purchase.",
  );
  const address = order.withheld.address;
  said.push(
    address === null
      ? "This card asks for no delivery address, so the order holds none."
      : address === "held"
        ? "The order holds the buyer's delivery address until the merchant has it; it is not shown."
        : `The buyer's delivery address was erased ${moment(new Date(address.erasedAt).toISOString())}.`,
  );
  if (order.withheld.goods)
    said.push("The goods the merchant delivered are the buyer's and not shown.");
  return said.join(" ");
}

export function orderPageView(
  id: string,
  order: OperatorOrder | null | "unread",
  explorer: Explorer,
  readAt: Date,
): OrderPageView {
  if (order === "unread") return { kind: "unread", id };
  if (order === null) return { kind: "none", id };
  const merchant = merchantName(order.merchant);
  const agent = order.agent;
  return {
    kind: "order",
    readAt: `Read ${moment(readAt.toISOString())}`,
    id: order.id,
    title: order.product.title ?? order.product.merchantItemId,
    state: ORDER_WORDS[order.status],
    amount: order.price === null ? null : money(order.price),
    merchant: { name: merchant, to: `/admin/merchants/${encodeURIComponent(order.merchant.id)}` },
    card: cardOf(order),
    agent: {
      status: agent.status,
      paymentStatus: agent.payment_status,
      reason: agent.reason?.message ?? null,
      sellerWords:
        agent.refusal !== undefined
          ? `${agent.refusal.code}: ${agent.refusal.message}`
          : (agent.merchant_closure?.message ?? null),
    },
    merchantSide: merchantSideOf(order, merchant),
    timeline: order.timeline.map((step) => stepView(step, order, merchant)),
    payment: paymentPanelOf(order, explorer, readAt),
    receipt:
      order.receipt === null
        ? {
            head: "None",
            facts: [],
            said: "No receipt is issued yet: one is written once a delivered or shipped order's payment is recorded.",
          }
        : {
            head: "Issued",
            facts: [
              { label: "Receipt", value: order.receipt.id },
              { label: "Outcome", value: order.receipt.outcome },
              { label: "Paid at", value: moment(order.receipt.paid_at) },
              ...(order.receipt.transaction === undefined
                ? []
                : [{ label: "Transaction", value: order.receipt.transaction }]),
            ],
            said: null,
          },
    withheld: withheldOf(order),
  };
}

// --- the lookup --------------------------------------------------------------

/** A record the lookup found, said as a line that opens it. */
interface FoundView {
  readonly kind: "Order" | "Merchant" | "Account";
  readonly label: string;
  /** The record's identifier, shown short. */
  readonly id: string;
  /** What in the record matched the text. */
  readonly by: string;
  readonly to: string;
}

export type FindView =
  /** Opened with nothing asked: what the box reads. */
  | Readonly<{ kind: "asked"; q: "" }>
  | Readonly<{ kind: "none"; q: string; said: string; unknown: string | null }>
  | Readonly<{ kind: "several"; q: string; found: readonly FoundView[] }>
  | Readonly<{ kind: "unread"; q: string }>;

export const FIND_READS =
  "Paste an order ID, a merchant ID, a transaction, a wallet or split address, an email address or a shop's site; one match opens its record.";

const BY: Readonly<Record<string, string>> = {
  id: "its identifier",
  transaction: "a transaction its payment names",
  wallet: "its payout wallet",
  split: "a split a payment has gone to",
  site: "the site it sells from",
  email: "its email address",
};

const foundView = (found: Found | AccountFound): FoundView => {
  if (found.kind === "account") {
    return {
      kind: "Account",
      label: found.email,
      id: found.id,
      by: BY.email ?? "",
      to: `/admin/accounts/${encodeURIComponent(found.id)}`,
    };
  }
  if (found.kind === "order") {
    const row = orderRowView(found.order);
    return {
      kind: "Order",
      label: `${row.product} · ${row.merchant}`,
      id: row.id,
      by: BY[found.by] ?? found.by,
      to: row.to,
    };
  }
  return {
    kind: "Merchant",
    label: merchantName(found.merchant),
    id: found.merchant.id,
    by: BY[found.by] ?? found.by,
    to: `/admin/merchants/${encodeURIComponent(found.merchant.id)}`,
  };
};

/** An account the dashboard's identity found by its address. */
export interface AccountFound {
  readonly kind: "account";
  readonly id: string;
  readonly email: string;
}

/** What the lookup answers for what it found: none, one to open, or several to list. */
export function findView(
  q: string,
  found: readonly (Found | AccountFound)[] | "unread",
  isTransaction: boolean,
): FindView | Readonly<{ kind: "open"; to: string }> {
  if (q === "") return { kind: "asked", q: "" };
  if (found === "unread") return { kind: "unread", q };
  const first = found[0];
  if (found.length === 1 && first !== undefined) return { kind: "open", to: foundView(first).to };
  if (found.length > 1) return { kind: "several", q, found: found.map(foundView) };
  return isTransaction
    ? {
        kind: "none",
        q,
        said: `No order on this channel names the transaction “${q}” yet.`,
        unknown:
          "An order whose payment outcome is unknown may hold no transaction yet; the orders whose payment is unknown are listed apart.",
      }
    : { kind: "none", q, said: `Nothing on this channel matches “${q}”.`, unknown: null };
}
