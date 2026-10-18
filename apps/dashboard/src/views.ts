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
  type OrderStatus,
  type ReceiptList,
} from "@nuanu-ai/agentify-contracts";
import type { AccountNote } from "./account-banner.js";
import { RESUME_ALL_SELLING, STOP_ALL_SELLING } from "./control-labels.js";
import type { RefundCause } from "./gateway.js";
import { askedIn, type Listing, listingOf, type SegmentRule } from "./listing.js";
import { type Shares, type SplitTerms, sharesOf } from "./shares.js";
import { readinessSeenBy, refusedForNoName, unsetIn, type Viewer } from "./viewer.js";
import {
  APPROVAL_PENDING,
  CARD_WORDS,
  dayOf,
  FULFILLMENT_WORDS,
  moment,
  money,
  needsYou,
  ORDER_WORDS,
  UNSET_WORDS,
  type Word,
  waitsOnTheBuyer,
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

/**
 * What the frame draws over every page about a merchant's selling, read once
 * by their pages' layout rather than by each screen, so the banner says the
 * same on every section.
 */
export interface FrameView {
  /** The orders that need the merchant; null where they could not be counted, which is not none. */
  readonly needYou: number | null;
  /** The banner's reasons, empty where the account sells as usual and everything was read. */
  readonly account: readonly AccountNote[];
}

/** A link to the part of the documentation that carries the mechanism. */
export interface Rest {
  readonly href: string;
  readonly words: string;
}

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
 * A card published by the integration not in use is off sale whatever its own
 * switch says, so it never reads paused by the merchant: resuming it would not
 * put it on sale.
 */
const cardWord = (entry: MerchantCard, integration: CardsIntegration): Word =>
  integration.offSale.includes(entry.id)
    ? CARD_WORDS.offSale
    : entry.paused
      ? CARD_WORDS.pausedByYou
      : entry.selling === "open"
        ? CARD_WORDS.onSale
        : CARD_WORDS.offSale;

/**
 * Built from the route table, not written out, so the two cannot drift. The
 * origin is the one the deployment is reached at, not the internal gateway
 * address. The identifier is our catalog one, not the merchant's own: a
 * merchant who pasted their `merchant_item_id` into it would get a 404 from a
 * working gateway.
 */
const buyingAddress = (origin: string, entry: MerchantCard): string =>
  `${origin}${expandPath(API_ROUTES.purchase_item.path, { item_id: entry.id })}`;

interface CardRow {
  readonly id: string;
  /** Off sale for whatever reason, which the screen draws as a quieter row. */
  readonly off: boolean;
  readonly title: string;
  readonly aside: CardAside;
  /** The address an agent buys the card at. */
  readonly buy: string;
  readonly itemId: string;
  readonly price: string;
  readonly delivery: string;
  readonly state: Word;
  readonly control: CardControl;
}

export interface CardsView {
  /**
   * The control that stops or restarts all selling; absent for a merchant who
   * has left, who is offered no way back on sale here.
   */
  readonly allSelling: null | Readonly<{ verb: "pause" | "resume"; label: string }>;
  /**
   * The cards the address asked for, at most a page of them: what was searched
   * for, the segments with their counts, how much was cut, and why none is
   * drawn where the merchant has some.
   */
  readonly listing: Listing<CardRow>;
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

/**
 * A card on sale is one an agent can buy now; every other card is off sale,
 * paused by the merchant or held by something the banner names.
 */
const CARD_SEGMENTS: readonly SegmentRule<CardRow>[] = [
  { key: "all", label: "All", holds: () => true, none: "" },
  { key: "on-sale", label: "On sale", holds: (row) => !row.off, none: "No card is on sale." },
  { key: "off-sale", label: "Off sale", holds: (row) => row.off, none: "No card is off sale." },
];

export const cardsView = (
  viewer: Viewer,
  cards: MerchantCardList,
  origin: string,
  wooAvailable = false,
  integration: CardsIntegration = ALL_THROUGH_THE_CODE,
  query: URLSearchParams = new URLSearchParams(),
): CardsView => {
  // "Departed" is not folded into "stopped": that would offer a merchant who
  // has left a button back on sale and a note saying accepted orders are
  // playing out, when leaving closed those orders and left refunds owed
  // (`selling.ts` explains).
  const gone = cards.selling === "departed";
  const stopped = cards.selling === "paused";
  const door = readinessSeenBy(viewer);

  return {
    allSelling: gone
      ? null
      : stopped
        ? { verb: "resume", label: RESUME_ALL_SELLING }
        : { verb: "pause", label: STOP_ALL_SELLING },
    listing: listingOf({
      rows: cards.cards.map((entry): CardRow => {
        const state = cardWord(entry, integration);
        return {
          id: entry.id,
          off: state !== CARD_WORDS.onSale,
          title: entry.card.title,
          aside: cardAside(entry),
          buy: buyingAddress(origin, entry),
          itemId: entry.card.merchant_item_id,
          price: money(entry.card.price),
          delivery: FULFILLMENT_WORDS[entry.card.fulfillment],
          state,
          control: cardControl(entry, cards.selling, door, integration),
        };
      }),
      asked: askedIn(
        query,
        CARD_SEGMENTS.map((one) => one.key),
      ),
      path: "/cards",
      segments: CARD_SEGMENTS,
      // Found by its title or its product code, the two a merchant knows it by.
      matches: (row, words) =>
        row.title.toLocaleLowerCase().includes(words) ||
        row.itemId.toLocaleLowerCase().includes(words),
      noMatch: (q, within) =>
        within === null
          ? `No card matches “${q}”.`
          : `No card ${within.toLocaleLowerCase()} matches “${q}”.`,
      showAll: "Show all cards",
    }),
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

interface OrderRow {
  readonly id: string;
  /** The card's title where the merchant still has the card, its code otherwise. */
  readonly product: string;
  /** The product's code: the row does not print it, and a search finds the order by it. */
  readonly itemId: string;
  readonly amount: string;
  /**
   * An unmarked sum for a test purchase is a payment that never happened, so
   * every test sum carries the mark.
   */
  readonly test: boolean;
  /** Null where the payment did not go into one of the merchant's payout splits. */
  readonly shares: Shares | null;
  readonly state: Word;
  readonly priceSet: MomentView;
  /** The day of `priceSet`, for the heading over that day's orders. */
  readonly day: string;
}

/** An order said in a row of its own: what happened to it, and what is the merchant's to do. */
interface OrderNeed extends OrderRow {
  readonly why: string;
  readonly rest: Rest | null;
}

export interface OrdersView {
  /** The gateway lists no order at all, so there is nothing to search or narrow. */
  readonly none: boolean;
  /**
   * The orders the address asked for, newest first and at most a page of
   * them: what was searched for, the segments with their counts, how much was
   * cut, and why none is drawn where the merchant has some.
   */
  readonly listing: Listing<OrderRow>;
  /** The refunds due the search finds: the orders the merchant has to act on. */
  readonly needsYou: readonly OrderNeed[];
  /** Goods delivered and held until the buyer pays: nothing for the merchant to do. */
  readonly waitsOnTheBuyer: readonly OrderNeed[];
}

/** The terms of the payout split each order's charge went into, by order. */
export type PaidIntoSplits = Readonly<Record<string, SplitTerms>>;

/**
 * Open is the gateway's own narrowing, read beside the whole list rather than
 * worked out from it: a status does not say whether an order is open, since
 * "In progress" reads the same for an order the merchant was handed and for a
 * price nobody paid.
 */
const orderSegments = (open: OrderList): readonly SegmentRule<OrderRow>[] => {
  const ids = new Set(open.orders.map((order) => order.id));
  return [
    { key: "all", label: "All", holds: () => true, none: "" },
    {
      key: "open",
      label: "Open",
      holds: (row) => ids.has(row.id),
      none: "Nothing is open: no order is owed goods or money. A purchase still at its price question or waiting to be paid is not counted as open.",
    },
  ];
};

/** What stands between the two halves of an identifier shown short: its ellipsis, or dots typed for it. */
const ELLIPSIS = /…|\.{2,}/;

/** A character no order ID holds. */
const NOT_OF_AN_ID = /[^a-z0-9_]/;

/** How many characters of an ID the page shows on each side of the ellipsis. */
const HALF = 4;

/** A run of an ID's characters this long does not turn up in another order's ID by chance. */
const RUN = 8;

/**
 * Which orders a search finds, worked out once from the words searched for,
 * since a pasted search can be long. An order is found by its product's title
 * or code; by its ID where the words hold the whole of it, begin it (its
 * prefix may be left off) or end it, at least as many characters as the page
 * shows of each side, or are a run of it too long to turn up by chance; and by
 * the short form the page shows it in, `ord_17ff…7de3`, which finds an ID that
 * begins with what stands before the ellipsis and ends with what stands after.
 * A few characters from the middle of an ID, which the page never shows, find
 * nothing: they would list orders whose rows show nothing of what was searched
 * for.
 */
const orderSearch = (words: string): ((row: OrderRow) => boolean) => {
  const parts = words.split(ELLIPSIS).map((part) => part.trim());
  // The short form's halves are the run of an ID's characters on each side,
  // so the words or marks a paste brings around it are left out.
  const head = (parts[0] ?? "").split(NOT_OF_AN_ID).at(-1) ?? "";
  const tail = (parts[1] ?? "").split(NOT_OF_AN_ID)[0] ?? "";
  const short = parts.length === 2 && head + tail !== "";
  return (row) => {
    if (
      row.product.toLocaleLowerCase().includes(words) ||
      row.itemId.toLocaleLowerCase().includes(words)
    ) {
      return true;
    }
    const id = row.id.toLocaleLowerCase();
    if (words.includes(id)) {
      return true;
    }
    const rest = id.slice(id.indexOf("_") + 1);
    const begins = (part: string) => id.startsWith(part) || rest.startsWith(part);
    if (short) {
      return begins(head) && id.endsWith(tail);
    }
    return (
      (words.length >= HALF && (begins(words) || id.endsWith(words))) ||
      (words.length >= RUN && id.includes(words))
    );
  };
};

/** When an order's price was set, to sort by; a moment that cannot be read goes last. */
const setAt = (order: OrderList["orders"][number]): number => {
  const at = Date.parse(order.price.at);
  return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
};

export const ordersView = (
  cards: MerchantCardList,
  orders: OrderList,
  open: OrderList,
  query: URLSearchParams = new URLSearchParams(),
  owed: Readonly<Record<string, RefundCause>> = {},
  paidInto: PaidIntoSplits = {},
): OrdersView => {
  const titles = new Map(
    cards.cards.map((entry) => [entry.card.merchant_item_id, entry.card.title]),
  );
  // Newest first, whatever order the gateway lists them in, so the page a long
  // list opens on holds what just happened and a day's orders sit together.
  const listed = [...orders.orders]
    .sort((one, other) => setAt(other) - setAt(one) || 0)
    .map((order) => ({
      order,
      row: {
        id: order.id,
        product: titles.get(order.merchant_item_id) ?? order.merchant_item_id,
        itemId: order.merchant_item_id,
        amount: money(order.price),
        test: order.test,
        shares: sharesIn(order.price, paidInto[order.id]),
        state: ORDER_WORDS[order.status],
        priceSet: momentView(order.price.at),
        day: dayOf(order.price.at),
      } satisfies OrderRow,
    }));
  const segments = orderSegments(open);
  const asked = askedIn(
    query,
    segments.map((one) => one.key),
  );
  const finds = orderSearch(asked.q.toLocaleLowerCase());
  const found = asked.q === "" ? listed : listed.filter(({ row }) => finds(row));
  const told = (which: (status: OrderStatus) => boolean): readonly OrderNeed[] =>
    found
      .filter(({ order }) => which(order.status))
      .map(({ order, row }) => ({
        ...row,
        why: whatHappened(order, owed[order.id], paidInto[order.id] !== undefined),
        rest: whereTheRestIs(order.status),
      }));
  return {
    none: orders.orders.length === 0,
    listing: listingOf({
      rows: listed.map(({ row }) => row),
      asked,
      path: "/orders",
      segments,
      matches: finds,
      noMatch: (q, within) =>
        within === null
          ? `No order matches “${q}”.`
          : `No ${within.toLocaleLowerCase()} order matches “${q}”.`,
      showAll: "Show all orders",
    }),
    needsYou: told(needsYou),
    waitsOnTheBuyer: told(waitsOnTheBuyer),
  };
};

/**
 * How a refund came to be owed, said as it happened. Where the cause could not
 * be read the sentence says only what holds for every debt, rather than
 * guessing the commonest cause.
 */
const OWED_BECAUSE: Readonly<Record<RefundCause, string>> = {
  refused: "Paid, then your integration refused the order, so nothing was delivered.",
  deadline_passed: "Paid, but the delivery window ran out before the product was delivered.",
  merchant_left: "Paid, and the order closed undelivered when you left Agentify.",
  charge_confirmed_late:
    "Paid, but the payment network confirmed the payment only after we had stopped waiting for it and closed the order, so nothing was delivered.",
};

/**
 * A refund owes the buyer the whole price, though a payout split paid the
 * merchant only their share of it: the split gives Agentify's commission back
 * to nobody. The sum is a test purchase's where it is one, since an unmarked
 * sum reads as money that moved. Held goods are released by the buyer's own
 * second payment for the same order, never by a new purchase, which would
 * deliver twice.
 */
const whatHappened = (
  order: OrderList["orders"][number],
  cause: RefundCause | undefined,
  intoASplit: boolean,
): string =>
  order.status === "refund_due"
    ? `${cause === undefined ? "Paid, and the product was not delivered." : OWED_BECAUSE[cause]} Return the full price${order.test ? " of this test purchase" : ""}, ${money(order.price)}, to the buyer from your own wallet${intoASplit ? "; the commission stays with Agentify" : ""}. A late delivery still clears the debt.`
    : "Your integration delivered, but the payment failed, so the goods are held. The buyer can pay again for this same order; if that payment settles, the goods are released and the order closes.";

const sharesIn = (
  price: { readonly amount: string; readonly currency: string },
  terms: SplitTerms | undefined,
): Shares | null => (terms === undefined ? null : sharesOf(price, terms));

/**
 * How a refund is made is linked once, over the refunds. Held goods are not
 * the merchant's to act on: what can still happen is a payment somebody else
 * makes, and the documentation says what settles it.
 */
const whereTheRestIs = (status: OrderStatus): Rest | null =>
  status === "refund_due"
    ? null
    : {
        href: "/docs/orders#you-delivered-and-the-payment-did-not-execute",
        words: "What can still happen",
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

interface ReceiptRow {
  readonly id: string;
  readonly orderId: string;
  readonly needsYou: boolean;
  readonly product: string;
  readonly amount: string;
  readonly test: boolean;
  /** Null where the payment did not go into one of the merchant's payout splits. */
  readonly shares: Shares | null;
  readonly outcome: Word;
  readonly paid: MomentView;
  readonly priceSet: MomentView;
  readonly priceAsOf: MomentView;
  readonly transfer: TransferView;
}

export interface ReceiptsView {
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
  paidInto: PaidIntoSplits = {},
): ReceiptsView => {
  const titles = new Map(cards.cards.map((entry) => [entry.id, entry.card.title]));
  return {
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
    // The latest payment first, whatever order the gateway lists them in.
    rows: [...receipts.receipts]
      .sort((one, other) => Date.parse(other.paid_at) - Date.parse(one.paid_at))
      .map((receipt) => ({
        id: receipt.id,
        orderId: receipt.order_id,
        needsYou: needsYou(receipt.outcome),
        product: titles.get(receipt.item_id) ?? receipt.item_id,
        amount: money(receipt.price),
        test: receipt.test,
        shares: sharesIn(receipt.price, paidInto[receipt.order_id]),
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
