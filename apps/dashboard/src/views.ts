/**
 * What the cards, orders and receipts screens show, as plain values built from
 * the documents the gateway answered with. Each view is a function that fetches
 * and decides nothing beyond those documents, so every claim on a screen traces
 * to a field in one; the React pages under `app/` only draw them. Where a
 * screen would like to say more than the API supports, it says the weaker
 * thing; `words.ts` carries those cases.
 */

import type { Readiness, SurfaceMode } from "@agentify/core";
import type { Integration } from "@agentify/gateway";
import {
  API_ROUTES,
  expandPath,
  MERCHANT_FINDINGS,
  type MerchantCard,
  type MerchantCardList,
  type OrderList,
  type ReceiptList,
} from "@nuanu-ai/agentify-contracts";
import { RESUME_ALL_SELLING, STOP_ALL_SELLING } from "./control-labels.js";
import type { RefundCause } from "./gateway.js";
import { readinessSeenBy, refusedForNoName, unsetIn, type Viewer } from "./viewer.js";
import {
  APPROVAL_PENDING,
  FULFILLMENT_WORDS,
  moment,
  money,
  needsAttention,
  ORDER_WORDS,
  SELLING_WORDS,
  UNSET_WORDS,
  type Word,
} from "./words.js";

/**
 * An instant as the screens print it: UTC to the second, the date and the time
 * as two halves a line may break between and nowhere else. A timestamp that
 * could not be read is shown as it came.
 */
export type MomentView = Readonly<{ date: string; time: string }> | Readonly<{ text: string }>;

export const momentView = (iso: string): MomentView => {
  const text = moment(iso);
  const [date, ...time] = text.split(" ");
  return time.length === 0 ? { text } : { date: date ?? "", time: time.join(" ") };
};

/** The words at the head of every screen inside the frame. */
export interface FrameView {
  /** Absent where the screen did not read the merchant's selling. */
  readonly selling?: Word;
  /**
   * True draws the line saying nothing can go on sale until a seller name is
   * chosen; only a screen that asked the gateway for the name can say so.
   */
  readonly unnamed: boolean;
}

/** A link to the part of the documentation that carries the mechanism. */
export interface Rest {
  readonly href: string;
  readonly words: string;
}

const frameOf = (viewer: Viewer, selling: MerchantCardList["selling"]): FrameView => ({
  selling: SELLING_WORDS[selling],
  unnamed: refusedForNoName(viewer),
});

const countOf = (many: number, thing: string): string => `${many} ${thing}${many === 1 ? "" : "s"}`;

// --- cards -------------------------------------------------------------------

/**
 * Every fact that applies is listed, not the first one found: a card can both
 * have its price asked at purchase and owe a delivery inside a window, and
 * dropping the deadline because the price check came first would hide a promise
 * the merchant is answerable for. With none, the screen says since when the
 * price on the card holds, the one place `as_of` is shown: a merchant working
 * out why a sale went through at an old price has nowhere else to look.
 */
export type CardAside = Readonly<{ facts: string }> | Readonly<{ since: MomentView }>;

const cardAside = (entry: MerchantCard): CardAside => {
  const facts: string[] = [];

  if (entry.card.price_check !== undefined) {
    facts.push("Price asked at purchase");
  }

  const seconds = entry.card.fulfill_deadline_seconds;
  if (seconds !== undefined) {
    const hours = seconds / 3600;
    facts.push(
      hours >= 1 && Number.isInteger(hours)
        ? `delivery within ${hours} ${hours === 1 ? "hour" : "hours"}`
        : `delivery within ${seconds} seconds`,
    );
  }

  if (facts.length === 0) {
    return { since: momentView(entry.as_of) };
  }

  const line = facts.join(", ");
  return { facts: `${line.charAt(0).toUpperCase()}${line.slice(1)}` };
};

/**
 * What stands in a card's last column. A switch where the card can be switched;
 * otherwise words saying what holds it, and where the merchant lacks something
 * set in Settings, which things, with the way there.
 */
export type CardControl =
  | Readonly<{ kind: "switch"; verb: "pause" | "resume" }>
  | Readonly<{ kind: "words"; text: string }>
  | Readonly<{ kind: "unset"; what: string; waiting: string }>;

/**
 * The integration the merchant sells through, and their cards that are off
 * sale because the other one published them.
 */
export interface CardsIntegration {
  readonly through: Integration;
  readonly offSale: readonly string[];
}

/**
 * With all selling stopped every card reads paused, and resuming one changes
 * nothing visible, so this says which switch holds it. A third reason, which
 * the document does not name: the merchant lacks something the gateway asks of
 * every merchant, which it folds into every card's word. Then the control names
 * what is missing, with the words and link the other screens use, and never
 * says selling was stopped. A missing live approval is said as such; a card
 * paused where the rule finds nothing missing (only a change between two reads
 * can do that) is said to be off sale and no more.
 *
 * A card published by the integration not in use is off sale for that reason
 * whatever else holds it, and that is said first: neither resuming it nor
 * anything set in Settings would put it on sale.
 */
const cardControl = (
  entry: MerchantCard,
  merchant: MerchantCardList["selling"],
  door: Readiness,
  integration: CardsIntegration,
): CardControl => {
  if (integration.offSale.includes(entry.id)) {
    return {
      kind: "words",
      text:
        integration.through === "woocommerce"
          ? "Off sale while you sell through your WooCommerce shop"
          : "Off sale while you sell through your own code",
    };
  }
  if (entry.paused) {
    return { kind: "switch", verb: "resume" };
  }
  if (entry.selling === "open") {
    return { kind: "switch", verb: "pause" };
  }
  if (merchant !== "open") {
    return { kind: "words", text: "All selling is stopped" };
  }
  const unset = unsetIn(door);
  const waiting = door.missing.includes(MERCHANT_FINDINGS.NO_OPERATOR_APPROVAL)
    ? ` ${APPROVAL_PENDING}`
    : "";
  if (unset.length > 0) {
    return { kind: "unset", what: unset.map((one) => UNSET_WORDS[one]).join(" and "), waiting };
  }
  return { kind: "words", text: `Not on sale.${waiting}` };
};

/**
 * Built from the route table, not written out, so the two cannot drift. The
 * origin is the one the deployment is reached at, not the internal gateway
 * address. The identifier is our catalog one, not the merchant's own: a
 * merchant who pasted their `merchant_item_id` into it would get a 404 from a
 * working gateway. Cut at each separator, so a wrapped address breaks between
 * its parts rather than mid-word, and the parts joined back are the address.
 */
const buyingAddress = (origin: string, entry: MerchantCard): readonly string[] => {
  const [first, ...segments] = `${origin}${expandPath(API_ROUTES.purchase_item.path, {
    item_id: entry.id,
  })}`.split(/(?<!\/)\/(?!\/)/);
  return [first ?? "", ...segments.map((segment) => `/${segment}`)];
};

export interface CardRow {
  readonly id: string;
  /** Off sale for whatever reason, which the screen draws as a quieter row. */
  readonly off: boolean;
  readonly title: string;
  readonly aside: CardAside;
  readonly buy: readonly string[];
  readonly itemId: string;
  readonly price: string;
  readonly delivery: string;
  readonly state: Word;
  readonly control: CardControl;
}

export interface CardsView {
  readonly frame: FrameView;
  readonly published: number;
  readonly pausedByYou: number;
  /**
   * The control that stops or restarts all selling; absent for a merchant who
   * has left, who is offered no way back on sale here.
   */
  readonly allSelling: null | Readonly<{ verb: "pause" | "resume"; label: string }>;
  readonly rows: readonly CardRow[];
  /** Present only when there are no cards: why, and the two ways to the first. */
  readonly empty: null | Readonly<{ why: string; woo: boolean }>;
  readonly sellingNote: string;
  readonly sellingRest: Rest;
}

const ALL_THROUGH_THE_CODE: CardsIntegration = { through: "api", offSale: [] };

/**
 * The SDK comes first and the WooCommerce connector after it, only where this
 * dashboard has one. While no name is set, everything published is refused, so
 * the line says so rather than leaving a merchant to work out why their card
 * never arrived.
 */
const emptyCatalogue = (viewer: Viewer): string =>
  refusedForNoName(viewer)
    ? "You haven't published any cards yet. Choose your seller name in Settings first. Cards can't be published without it."
    : readinessSeenBy(viewer).missing.includes(MERCHANT_FINDINGS.NO_OPERATOR_APPROVAL)
      ? `You haven't published any cards yet. ${APPROVAL_PENDING}`
      : "You haven't published any cards yet. Your code publishes them through the SDK, and each card it publishes appears here.";

export const cardsView = (
  viewer: Viewer,
  cards: MerchantCardList,
  origin: string,
  wooAvailable = false,
  integration: CardsIntegration = ALL_THROUGH_THE_CODE,
): CardsView => {
  // "Departed" is not folded into "stopped": that would offer a merchant who
  // has left a button back on sale and a note saying accepted orders are
  // playing out, when leaving closed those orders and left refunds owed
  // (`selling.ts` explains).
  const gone = cards.selling === "departed";
  const stopped = cards.selling === "paused";
  const door = readinessSeenBy(viewer);

  return {
    frame: frameOf(viewer, cards.selling),
    published: cards.cards.length,
    pausedByYou: cards.cards.filter((entry) => entry.paused).length,
    allSelling: gone
      ? null
      : stopped
        ? { verb: "resume", label: RESUME_ALL_SELLING }
        : { verb: "pause", label: STOP_ALL_SELLING },
    rows: cards.cards.map((entry) => ({
      id: entry.id,
      off: entry.selling !== "open",
      title: entry.card.title,
      aside: cardAside(entry),
      buy: buyingAddress(origin, entry),
      itemId: entry.card.merchant_item_id,
      price: money(entry.card.price),
      delivery: FULFILLMENT_WORDS[entry.card.fulfillment],
      state: SELLING_WORDS[entry.selling],
      control: cardControl(entry, cards.selling, door, integration),
    })),
    empty: cards.cards.length === 0 ? { why: emptyCatalogue(viewer), woo: wooAvailable } : null,
    sellingNote: sellingNote(cards.selling),
    sellingRest:
      cards.selling === "departed"
        ? {
            href: "/docs/faq#can-i-leave-altogether",
            words: "What leaving settles and what it does not",
          }
        : {
            href: "/docs/faq#can-i-pause-the-selling",
            words: "What a pause does to the orders you have",
          },
  };
};

/**
 * A pause leaves accepted orders to play out; leaving closed them and owes back
 * the money for anything paid for and not delivered. One sentence cannot be
 * true of both.
 */
const sellingNote = (selling: MerchantCardList["selling"]): string => {
  switch (selling) {
    case "departed":
      return "You have left. The orders that were open closed with you, and the money for anything paid for and not delivered is yours to return. Selling does not start again from this page.";
    case "paused":
      return "All sales are paused: no new orders are accepted, and the orders you have already accepted play out as usual. Cards you paused yourself stay paused when you resume.";
    case "open":
      return "A pause takes the card off sale without abandoning orders: the ones you have already accepted play out as usual.";
  }
};

// --- orders ------------------------------------------------------------------

export interface OrderRow {
  readonly id: string;
  readonly needsYou: boolean;
  /** The card's title where the merchant still has the card, its code otherwise. */
  readonly product: string;
  readonly itemId: string;
  readonly amount: string;
  /**
   * An unmarked sum for a test purchase is a payment that never happened, so
   * every test sum carries the mark.
   */
  readonly test: boolean;
  readonly state: Word;
  readonly priceSet: MomentView;
}

/** One order that needs the merchant, said in full under the table. */
export interface OrderCallout {
  readonly id: string;
  readonly state: string;
  readonly why: string;
  readonly rest: Rest | null;
}

export interface OrdersView {
  readonly frame: FrameView;
  readonly open: boolean;
  /** Null when there is no order to count. */
  readonly lede: string | null;
  /** Null when no order is a test purchase. */
  readonly testNote: string | null;
  readonly rows: readonly OrderRow[];
  readonly empty: string;
  readonly callouts: readonly OrderCallout[];
}

export const ordersView = (
  viewer: Viewer,
  cards: MerchantCardList,
  orders: OrderList,
  open: boolean,
  owed: Readonly<Record<string, RefundCause>> = {},
): OrdersView => {
  const titles = new Map(
    cards.cards.map((entry) => [entry.card.merchant_item_id, entry.card.title]),
  );
  return {
    frame: frameOf(viewer, cards.selling),
    open,
    lede: orders.orders.length === 0 ? null : ordersLede(orders, open),
    testNote: testOrders(orders),
    rows: orders.orders.map((order) => ({
      id: order.id,
      needsYou: needsAttention(order.status),
      product: titles.get(order.merchant_item_id) ?? order.merchant_item_id,
      itemId: order.merchant_item_id,
      amount: money(order.price),
      test: order.test,
      state: ORDER_WORDS[order.status],
      priceSet: momentView(order.price.at),
    })),
    empty: open
      ? "Nothing is open: no order is owed goods or money. A purchase still at its price question or waiting to be paid is not listed here; All shows it."
      : "No orders yet.",
    callouts: orders.orders
      .filter((order) => needsAttention(order.status))
      .map((order) => ({
        id: order.id,
        state: ORDER_WORDS[order.status].text,
        why: whyItNeedsYou(order.status, owed[order.id]),
        rest: whereTheRestIs(order.status),
      })),
  };
};

/**
 * Counts only what it can stand behind. "Open" is the gateway's filter; "needs
 * you" is `NEEDS_ATTENTION`, and the sentence is scoped to those two endings
 * rather than to owing in general: an order merely under way may already be
 * money taken against goods not sent. What each order needs is said per order
 * in the callouts.
 */
const ordersLede = (orders: OrderList, open: boolean): string => {
  const wanting = orders.orders.filter((order) => needsAttention(order.status)).length;
  const scope = open ? "open" : "";
  const listed = `${countOf(orders.orders.length, `${scope} order`.trim())} listed.`;

  if (wanting === 0) {
    return `${listed} No refunds are due, and nothing was delivered without payment.`;
  }
  return `${listed} ${countOf(wanting, "order")} ${wanting === 1 ? "needs" : "need"} you, and each one is set out below.`;
};

/**
 * Orders carry the test flag too, and their sums would otherwise be taken for
 * money that moved.
 */
const testOrders = (orders: OrderList): string | null => {
  const tests = orders.orders.filter((order) => order.test).length;
  if (tests === 0) {
    return null;
  }
  return tests === orders.orders.length
    ? "Every order here is a test purchase: no real money moved."
    : `${countOf(tests, "order")} here ${tests === 1 ? "is a test purchase" : "are test purchases"}: no real money moved for ${tests === 1 ? "it" : "those"}.`;
};

/**
 * How a refund came to be owed, said as it happened. Where the cause could not
 * be read the sentence says only what holds for every debt, rather than
 * guessing the commonest cause.
 */
const OWED_BECAUSE: Readonly<Record<RefundCause, string>> = {
  refused:
    "The payment was received, then your integration refused the order, so the product was not delivered.",
  deadline_passed:
    "The payment was received, the delivery window ran out, and the product was not delivered.",
  merchant_left:
    "The payment was received, and the order closed undelivered when you left Agentify.",
  charge_confirmed_late:
    "The payment network confirmed the payment only after we had stopped waiting for it and closed the order, so the product was not delivered.",
};

const whyItNeedsYou = (
  status: OrderList["orders"][number]["status"],
  cause: RefundCause | undefined,
): string =>
  status === "refund_due"
    ? `${cause === undefined ? "The payment was received and the product was not delivered." : OWED_BECAUSE[cause]} You return it from your own wallet — we recorded the amount and the order. A late delivery still clears the debt.`
    : "Your integration returned the product, but the payment did not go through, so the product was not released to the buyer. The order stays open.";

/**
 * A refund is a thing to go and do, and the sentence before says all of it.
 * Held goods are not: what can still happen is a payment somebody else makes,
 * and the portal says what settles it.
 */
const whereTheRestIs = (status: OrderList["orders"][number]["status"]): Rest | null =>
  status === "refund_due"
    ? null
    : {
        href: "/docs/orders#you-delivered-and-the-payment-did-not-execute",
        words: "What can still happen to it",
      };

// --- receipts ----------------------------------------------------------------

/**
 * The transfer behind a receipt, as the payment layer named it: a link to the
 * chain's page for it where this deployment has one and the name is a
 * transaction hash, the name as written otherwise. Written out whole, because a
 * shortened hash is a different string to whoever pastes it. A receipt without
 * one says only that this receipt does not carry it, not that there was no
 * transfer: older receipts and payments an operator recorded by hand had one
 * all the same.
 */
export type TransferView =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "link"; href: string; text: string }>
  | Readonly<{ kind: "text"; text: string }>;

const transferOf = (transaction: string | undefined, page: string | null): TransferView => {
  if (transaction === undefined) {
    return { kind: "none" };
  }
  return page !== null && /^0x[0-9a-fA-F]{64}$/.test(transaction)
    ? { kind: "link", href: `${page}${transaction}`, text: transaction }
    : { kind: "text", text: transaction };
};

export interface ReceiptRow {
  readonly id: string;
  readonly orderId: string;
  readonly needsYou: boolean;
  readonly product: string;
  readonly amount: string;
  readonly test: boolean;
  readonly outcome: Word;
  readonly paid: MomentView;
  readonly priceSet: MomentView;
  readonly priceAsOf: MomentView;
  readonly transfer: TransferView;
}

export interface ReceiptsView {
  readonly frame: FrameView;
  /** Null when no receipt is a test purchase. */
  readonly testWarning: string | null;
  readonly count: number;
  readonly sums: string;
  readonly delivered: number;
  readonly ofCount: string;
  readonly rows: readonly ReceiptRow[];
}

export const receiptsView = (
  viewer: Viewer,
  cards: MerchantCardList,
  receipts: ReceiptList,
  transactionPage: string | null = null,
): ReceiptsView => {
  const titles = new Map(cards.cards.map((entry) => [entry.id, entry.card.title]));
  return {
    frame: frameOf(viewer, cards.selling),
    testWarning: testWarning(receipts, viewer.mode),
    count: receipts.receipts.length,
    sums: sumsOf(receipts),
    // A shipped parcel is a sale as much as goods handed over: the money is the
    // merchant's and the receipt is written. The tile says both words, because
    // a parcel with a carrier has not been delivered.
    delivered: receipts.receipts.filter(
      (receipt) => receipt.outcome === "delivered" || receipt.outcome === "shipped",
    ).length,
    ofCount: `of ${countOf(receipts.receipts.length, "receipt")}`,
    rows: receipts.receipts.map((receipt) => ({
      id: receipt.id,
      orderId: receipt.order_id,
      needsYou: receipt.outcome === "refund_due",
      product: titles.get(receipt.item_id) ?? receipt.item_id,
      amount: money(receipt.price),
      test: receipt.test,
      outcome: ORDER_WORDS[receipt.outcome],
      paid: momentView(receipt.paid_at),
      priceSet: momentView(receipt.price.at),
      priceAsOf: momentView(receipt.price.as_of),
      transfer: transferOf(receipt.transaction, transactionPage),
    })),
  };
};

/**
 * Amounts are never added up: they are exact decimal strings so nothing turns
 * them into a float, and a total computed here would be the one number on the
 * screen that had been through one. The currencies present are named instead.
 */
const sumsOf = (receipts: ReceiptList): string => {
  const currencies = [...new Set(receipts.receipts.map((receipt) => receipt.price.currency))];
  if (currencies.length === 0) {
    return "nothing sold yet";
  }
  return `priced in ${currencies.sort().join(", ")}`;
};

/**
 * A mark per row tells two rows apart but does not stop a merchant reading a
 * page of them as takings, so when every row is a test the page says so once.
 */
const testWarning = (receipts: ReceiptList, mode: SurfaceMode): string | null => {
  const tests = receipts.receipts.filter((receipt) => receipt.test).length;
  if (tests === 0) {
    return null;
  }
  const subject =
    tests === receipts.receipts.length
      ? "Every receipt here is a test purchase"
      : `${countOf(tests, "receipt")} here ${tests === 1 ? "is a test purchase" : "are test purchases"}`;
  const consequence =
    mode === "test"
      ? "test funds settled on Base Sepolia, but no real money moved."
      : mode === "sandbox"
        ? "no payment settled and no real money moved."
        : "no real money moved.";
  return `${subject}: ${consequence}`;
};
