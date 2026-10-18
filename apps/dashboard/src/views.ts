/**
 * What the cards, orders and receipts screens show, as plain values built from
 * the documents the gateway answered with. Each view is a function that fetches
 * and decides nothing beyond those documents, so every claim on a screen traces
 * to a field in one; the React pages under `app/` only draw them. Where a
 * screen would like to say more than the API supports, it says the weaker
 * thing; `words.ts` carries those cases.
 */

import { SURFACE_WORDS, type SurfaceMode } from "@agentify/core";
import type { Integration } from "@agentify/gateway";
import {
  API_ROUTES,
  expandPath,
  type MerchantCard,
  type MerchantCardList,
  type OrderList,
  type OrderStatus,
  type ReceiptList,
} from "@nuanu-ai/agentify-contracts";
import type { AccountNote } from "./account-banner.js";
import { RESUME_ALL_SELLING, STOP_ALL_SELLING } from "./control-labels.js";
import type { RefundCause } from "./gateway.js";
import { askedIn, type Listing, listingOf, placeOf, type SegmentRule } from "./listing.js";
import { type Shares, type SplitTerms, sharesOf } from "./shares.js";
import type { Viewer } from "./viewer.js";
import {
  CARD_WORDS,
  dayOf,
  FULFILLMENT_WORDS,
  moment,
  money,
  needsYou,
  ORDER_WORDS,
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
 * What the price beside a card means. A price asked at purchase may not be the
 * one paid, so that is said wherever the price is; a price that stands on the
 * card holds from `as_of`, the one place that moment is shown: a merchant
 * working out why a sale went through at an old price has nowhere else to look.
 */
export type CardPrice = Readonly<{ asked: true }> | Readonly<{ since: MomentView }>;

const cardPrice = (entry: MerchantCard): CardPrice =>
  entry.card.price_check === undefined ? { since: momentView(entry.as_of) } : { asked: true };

/** A span of seconds in the largest whole unit that says it exactly. */
const spanOf = (seconds: number): string => {
  const [count, unit] =
    seconds % 86_400 === 0
      ? [seconds / 86_400, "day"]
      : seconds % 3600 === 0
        ? [seconds / 3600, "hour"]
        : seconds % 60 === 0
          ? [seconds / 60, "minute"]
          : [seconds, "second"];
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
};

/**
 * How the goods come and the window they are owed within: a promise the
 * merchant answers for, since an order still without goods at its end owes
 * the buyer their money back. A card whose goods come later and that names no
 * window is held to Agentify's own, which the merchant's list of cards does
 * not carry, so the words say whose window it is and the link where it is
 * written, rather than reading as no window at all. A parcel's window is the
 * time to hand it to a carrier, not the time it arrives.
 */
type Delivery = Readonly<{ says: string; byDefault: Rest | null }>;

const DEFAULT_WINDOW: Rest = {
  href: "/docs/cards#goods-that-leave-later-than-the-answer",
  words: "Agentify's default window",
};

const deliveryOf = (card: MerchantCard["card"]): Delivery => {
  const word = FULFILLMENT_WORDS[card.fulfillment];
  if (card.ship_within_seconds !== undefined) {
    return {
      says: `${word}, to a carrier within ${spanOf(card.ship_within_seconds)}`,
      byDefault: null,
    };
  }
  if (card.fulfill_deadline_seconds !== undefined) {
    return { says: `${word}, within ${spanOf(card.fulfill_deadline_seconds)}`, byDefault: null };
  }
  return card.fulfillment === "async" || card.fulfillment === "confirm"
    ? { says: `${word}, within`, byDefault: DEFAULT_WINDOW }
    : { says: word, byDefault: null };
};

/**
 * What stands in a card's last column: the card's own switch, or nothing where
 * no switch here would put the card on sale. A card the shop published while
 * the merchant's code sells is the one with words of its own: the banner names
 * no reason for it, and only its row can say which of the cards came from the
 * shop.
 */
export type CardControl =
  | Readonly<{ kind: "switch"; verb: "pause" | "resume" }>
  | Readonly<{ kind: "reason"; text: string }>
  | Readonly<{ kind: "none" }>;

/**
 * The integration the merchant sells through, and their cards that are off
 * sale because the other one published them.
 */
export interface CardsIntegration {
  readonly through: Integration;
  readonly offSale: readonly string[];
}

/**
 * A merchant who has left sells through nothing, so their cards are offered
 * no switch and no reason. A card published by the integration not in use is
 * off sale whatever its own switch says, so it is offered none either. Every
 * other card keeps its own switch whatever holds the whole account: a card
 * paused while all sales are paused or the account lacks something stays
 * paused once the account sells again, and a Resume pressed meanwhile can be
 * taken back.
 */
const cardControl = (
  entry: MerchantCard,
  selling: MerchantCardList["selling"],
  integration: CardsIntegration,
): CardControl => {
  if (selling === "departed") return { kind: "none" };
  if (integration.offSale.includes(entry.id)) {
    return integration.through === "woocommerce"
      ? { kind: "none" }
      : { kind: "reason", text: "Off sale while you sell through your own code" };
  }
  return { kind: "switch", verb: entry.paused ? "resume" : "pause" };
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
  readonly priced: CardPrice;
  /** The address an agent buys the card at. */
  readonly buy: string;
  readonly itemId: string;
  readonly price: string;
  readonly delivery: Delivery;
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
  /**
   * Present only when there are no cards: the sentence, and whether the shop
   * is a way to the first card beside the SDK. What the account lacks to
   * publish is the banner's to say.
   */
  readonly empty: null | Readonly<{ says: string; woo: boolean }>;
  /** The line under the cards about what their switches do, and where the rest is. */
  readonly note: Readonly<{ says: string; rest: Rest }>;
  /** Over the rows, where the search was read as a whole product code, which it says. */
  readonly byCode: string | null;
}

const ALL_THROUGH_THE_CODE: CardsIntegration = { through: "api", offSale: [] };

/**
 * A card on sale is one an agent can buy now; every other card is off sale,
 * paused by the merchant or held by something the banner names.
 */
const CARD_SEGMENTS: readonly SegmentRule<CardRow>[] = [
  { key: "all", label: "All", holds: () => true, none: "" },
  { key: "on-sale", label: "On sale", holds: (row) => !row.off, none: "No card is on sale." },
  { key: "off-sale", label: "Off sale", holds: (row) => row.off, none: "No card is off sale." },
];

const CARD_SEGMENT_KEYS = CARD_SEGMENTS.map((one) => one.key);

/** Where a press on the cards leads back to: the list its form's fields name. */
export const cardsPlace = (fields: URLSearchParams): string =>
  placeOf("/cards", fields, CARD_SEGMENT_KEYS);

export const cardsView = (
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
  const rows = cards.cards.map((entry): CardRow => {
    const state = cardWord(entry, integration);
    return {
      id: entry.id,
      off: state !== CARD_WORDS.onSale,
      title: entry.card.title,
      priced: cardPrice(entry),
      buy: buyingAddress(origin, entry),
      itemId: entry.card.merchant_item_id,
      price: money(entry.card.price),
      delivery: deliveryOf(entry.card),
      state,
      control: cardControl(entry, cards.selling, integration),
    };
  });
  const asked = askedIn(query, CARD_SEGMENT_KEYS);
  // A card is found by its title or by a part of its product code, the two a
  // merchant knows it by, except that a search that is some card's whole
  // product code, as a link to one card writes it, finds that code alone:
  // the card coded 1 is not the card coded 11.
  const code = asked.q.toLocaleLowerCase();
  const coded = rows.filter((row) => row.itemId.toLocaleLowerCase() === code).length;
  const byCode = code !== "" && coded > 0;

  return {
    allSelling: gone
      ? null
      : stopped
        ? { verb: "resume", label: RESUME_ALL_SELLING }
        : { verb: "pause", label: STOP_ALL_SELLING },
    listing: listingOf({
      rows,
      asked,
      path: "/cards",
      segments: CARD_SEGMENTS,
      matches: (row, words) =>
        byCode
          ? row.itemId.toLocaleLowerCase() === words
          : row.title.toLocaleLowerCase().includes(words) ||
            row.itemId.toLocaleLowerCase().includes(words),
      noMatch: (q, within) => {
        const which = within === null ? "No card" : `No card ${within.toLocaleLowerCase()}`;
        return byCode ? `${which} has the product code “${q}”.` : `${which} matches “${q}”.`;
      },
      showAll: "Show all cards",
    }),
    empty:
      cards.cards.length === 0
        ? { says: "You haven't published any cards yet.", woo: wooAvailable }
        : null,
    note: switchesNote(cards.selling),
    byCode: byCode
      ? `Only the ${coded === 1 ? "card" : "cards"} with the product code “${asked.q}”.`
      : null,
  };
};

const WHAT_A_PAUSE_DOES: Rest = {
  href: "/docs/faq#can-i-pause-the-selling",
  words: "What a pause does",
};

/**
 * A pause leaves accepted orders to play out, which the banner says while all
 * sales are paused, so then the line says what resuming leaves alone; leaving
 * closed the open orders, and nothing on this page starts selling again.
 */
const switchesNote = (selling: MerchantCardList["selling"]): CardsView["note"] => {
  switch (selling) {
    case "departed":
      return {
        says: "Selling does not start again from this page.",
        rest: {
          href: "/docs/faq#can-i-leave-altogether",
          words: "What leaving settles and what it does not",
        },
      };
    case "paused":
      return {
        says: `Cards you paused yourself stay paused when you press ${RESUME_ALL_SELLING}.`,
        rest: WHAT_A_PAUSE_DOES,
      };
    case "open":
      return {
        says: "A pause takes a card off sale; orders you have already accepted play out as usual.",
        rest: WHAT_A_PAUSE_DOES,
      };
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
   * Said once over the orders where some are test purchases and no band over
   * the page says the channel's payments are tests; null otherwise.
   */
  readonly testNote: string | null;
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
  mode: SurfaceMode,
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
    testNote: testOrders(orders, mode),
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
 * Orders carry the test flag too, and their sums would otherwise be taken for
 * money that moved: each sum carries the mark, and the page says it once too.
 * Where the band over every page of the channel already says its payments are
 * tests, the page does not say it a second time.
 */
const testOrders = (orders: OrderList, mode: SurfaceMode): string | null => {
  const tests = orders.orders.filter((order) => order.test).length;
  if (tests === 0 || SURFACE_WORDS[mode] !== null) {
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
 * page of them as takings, so where a row is a test the page says so once: in
 * the band over every page of a channel that has one, or else in a sentence.
 */
const testWarning = (receipts: ReceiptList, mode: SurfaceMode): string | null => {
  const tests = receipts.receipts.filter((receipt) => receipt.test).length;
  if (tests === 0 || SURFACE_WORDS[mode] !== null) {
    return null;
  }
  const subject =
    tests === receipts.receipts.length
      ? "Every receipt here is a test purchase"
      : `${countOf(tests, "receipt")} here ${tests === 1 ? "is a test purchase" : "are test purchases"}`;
  return `${subject}: no real money moved.`;
};
