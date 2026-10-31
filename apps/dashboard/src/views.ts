import type { WooCardPause } from "./woo-card-pauses.js";
/**
 * What the cards, orders and receipts screens show, as plain values built from
 * the documents the gateway answered with. Each view is a function that fetches
 * and decides nothing beyond those documents, so every claim on a screen traces
 * to a field in one; the React pages under `app/` only draw them. Where a
 * screen would like to say more than the API supports, it says the weaker
 * thing; `words.ts` carries those cases. A view keeps each number on one line
 * with its unit, in a product's title as in an amount, by a no-break space, so
 * it is for drawing and nothing else, and a search compares its words as typed.
 */

import { percentOf } from "@agentify/core/published";
import type { Integration } from "@agentify/gateway";
import { asTyped, keepUnits, withUnit } from "@agentify/ui/units";
import {
  API_ROUTES,
  expandPath,
  type MerchantCard,
  type MerchantCardList,
  type OrderList,
  type OrderStatus,
  type PaymentStatus,
  type ReceiptList,
} from "@nuanu-ai/agentify-contracts";
import type { AccountNote } from "./account-banner.js";
import { RESUME_ALL_SELLING, STOP_ALL_SELLING } from "./control-labels.js";
import { type Mark, rising } from "./cursor.js";
import type { OrderRecord, UnfulfilledCause } from "./gateway.js";
import {
  askedIn,
  type Listing,
  listingOf,
  PAGE_ROWS,
  placeOf,
  type SegmentRule,
} from "./listing.js";
import { moment, withinDay } from "./moments.js";
import type { OnboardingView } from "./onboarding.js";
import { type SplitTerms, sharesOf } from "./shares.js";
import type { ShopTotal } from "./woo-shops.js";
import type { WooShopView } from "./woo-views.js";
import {
  CARD_WORDS,
  FULFILLMENT_WORDS,
  money,
  needsYou,
  ORDER_WORDS,
  type Word,
  waitsOnTheBuyer,
} from "./words.js";

/**
 * An instant as the screens print it, to the second in the viewer's zone with
 * the zone named after the time: the date and the time as two halves a line
 * may break between and nowhere else. A timestamp that could not be read is
 * shown as it came.
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
  readonly onboarding?: OnboardingView;
}

/** A link to the part of the documentation that carries the mechanism. */
export interface Rest {
  readonly href: string;
  readonly words: string;
}

// --- cards -------------------------------------------------------------------

/** A span of seconds in the largest whole unit that says it exactly, kept on one line. */
export const spanOf = (seconds: number): string => {
  const [count, unit] =
    seconds % 86_400 === 0
      ? [seconds / 86_400, "day"]
      : seconds % 3600 === 0
        ? [seconds / 3600, "hour"]
        : seconds % 60 === 0
          ? [seconds / 60, "minute"]
          : [seconds, "second"];
  return withUnit(count, `${unit}${count === 1 ? "" : "s"}`);
};

/**
 * How the goods come and the window they are owed within: a promise the
 * merchant answers for; an order still without goods at its end is
 * unfulfilled. A card whose goods come later and that names no window is held
 * to Agentify's default deadline, whose length the merchant's list of cards
 * does not carry, so the words name it and link to where it is written rather
 * than print a length the gateway may not be using, or read as no window at
 * all. A parcel's window is the time to hand it to a carrier, not the time it
 * arrives.
 */
type Delivery = Readonly<{ says: string; byDefault: Rest | null }>;

const DEFAULT_WINDOW: Rest = {
  href: "/docs/cards#goods-that-leave-later-than-the-answer",
  words: "default deadline",
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
  return card.fulfillment === "async"
    ? { says: `${word}, within the`, byDefault: DEFAULT_WINDOW }
    : { says: word, byDefault: null };
};

/**
 * The integration the merchant sells through, and their cards that are off
 * sale because the other one published them.
 */
export interface CardsIntegration {
  readonly through: Integration;
  readonly offSale: readonly string[];
}

const cardWord = (entry: MerchantCard): Word =>
  entry.paused
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
  /** The price shown may not be the one paid, so that is said wherever the price is. */
  readonly priceAsked: boolean;
  /** The address an agent buys the card at. */
  readonly buy: string;
  readonly itemId: string;
  readonly price: string;
  readonly delivery: Delivery;
  readonly state: Word;
  /**
   * The card's own switch, kept whatever holds the whole account, because
   * those holds lift at once, the moment the approval lands or a name or a
   * wallet is set: a card paused before then stays paused, and a Resume
   * pressed meanwhile can be taken back.
   */
  readonly verb: "pause" | "resume" | null;
  readonly shopStoppedAt?: MomentView;
}

export interface CardsView {
  readonly shop?: WooShopView;
  /** The control that stops or restarts all selling. */
  readonly allSelling: Readonly<{ verb: "pause" | "resume"; label: string }>;
  /**
   * The cards the address asked for, at most a page of them: what was searched
   * for, the segments with their counts, how much was cut, and why none is
   * drawn where the merchant has some.
   */
  readonly listing: Listing<CardRow>;
  /**
   * Present only when the integration in use has published no card: the
   * sentence, and the ways to its first card. What the account lacks to
   * publish is the banner's to say.
   */
  readonly empty: null | Readonly<{
    says: string;
    /** The SDK's guide, and the words of the way to the WooCommerce page where this dashboard has one. */
    ways: Readonly<{ sdk: boolean; woo: string | null }>;
  }>;
  /** Under the cards, how many the integration not in use published, which are not listed. */
  readonly elsewhere: string | null;
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
  { key: "on-sale", label: "On sale", holds: (row) => !row.off, none: "No product is on sale." },
  { key: "off-sale", label: "Off sale", holds: (row) => row.off, none: "No product is off sale." },
];

const CARD_SEGMENT_KEYS = CARD_SEGMENTS.map((one) => one.key);

/** Where a press on the cards leads back to: the list its form's fields name. */
export const cardsPlace = (fields: URLSearchParams): string =>
  placeOf("/products", fields, CARD_SEGMENT_KEYS);

export const cardsView = (
  cards: MerchantCardList & { readonly integrationPauses?: Readonly<Record<string, WooCardPause>> },
  origin: string,
  wooAvailable = false,
  integration: CardsIntegration = ALL_THROUGH_THE_CODE,
  query: URLSearchParams = new URLSearchParams(),
): CardsView => {
  const stopped = cards.selling === "paused";
  // A card the other integration published goes on sale only when the
  // merchant switches integration, which no switch of its own can do, so it is
  // counted under the list rather than listed beside the cards that sell.
  const listed = cards.cards.filter((entry) => !integration.offSale.includes(entry.id));
  const elsewhere = cards.cards.length - listed.length;
  const rows = listed.map((entry): CardRow => {
    const withdrew = cards.integrationPauses?.[entry.id];
    const state: Word =
      withdrew === undefined
        ? cardWord(entry)
        : {
            text:
              withdrew.reason === "stopped_selling"
                ? "Off sale: your shop stopped selling it"
                : "Off sale: it changed in your shop, and Agentify can't sell it now",
            tone: "warn",
          };
    return {
      id: entry.id,
      off: state !== CARD_WORDS.onSale,
      title: keepUnits(entry.card.title),
      priceAsked: entry.card.price_check !== undefined,
      buy: buyingAddress(origin, entry),
      itemId: entry.card.merchant_item_id,
      price: money(entry.card.price),
      delivery: deliveryOf(entry.card),
      state,
      verb: withdrew === undefined ? (entry.paused ? "resume" : "pause") : null,
      ...(withdrew === undefined
        ? {}
        : { shopStoppedAt: momentView(new Date(withdrew.at).toISOString()) }),
    };
  });
  const asked = askedIn(query, CARD_SEGMENT_KEYS);
  // The oldest published first, as the gateway lists them; a card republished
  // moves to the end.
  const marks = new Map(
    cards.cards.map((entry) => [entry.id, { key: [momentKey(entry.as_of)], id: entry.id }]),
  );
  // A card is found by its title or by a part of its product code, the two a
  // merchant knows it by, except that a search that is some card's whole
  // product code, as a link to one card writes it, finds that code alone:
  // the card coded 1 is not the card coded 11.
  const code = asked.q.toLocaleLowerCase();
  const coded = rows.filter((row) => row.itemId.toLocaleLowerCase() === code).length;
  const byCode = code !== "" && coded > 0;

  return {
    allSelling: stopped
      ? { verb: "resume", label: RESUME_ALL_SELLING }
      : { verb: "pause", label: STOP_ALL_SELLING },
    listing: listingOf({
      rows,
      asked,
      path: "/products",
      segments: CARD_SEGMENTS,
      markOf: (row) => marks.get(row.id) ?? { key: [UNREAD_MOMENT], id: row.id },
      oldestFirst: true,
      matches: (row, words) =>
        byCode
          ? row.itemId.toLocaleLowerCase() === words
          : asTyped(row.title).toLocaleLowerCase().includes(words) ||
            row.itemId.toLocaleLowerCase().includes(words),
      noMatch: (q, within) => {
        const which = within === null ? "No product" : `No product ${within.toLocaleLowerCase()}`;
        return byCode ? `${which} has the product code “${q}”.` : `${which} matches “${q}”.`;
      },
      showAll: "Show all products",
    }),
    empty: listed.length > 0 ? null : emptyOf(integration.through, elsewhere, wooAvailable),
    elsewhere: elsewhereOf(integration.through, elsewhere),
    note: switchesNote(cards.selling),
    byCode: byCode
      ? `Only the ${coded === 1 ? "product" : "products"} with the product code “${asked.q}”.`
      : null,
  };
};

/**
 * A merchant on the shop gets their first products by importing them on the
 * WooCommerce page, not from the SDK. One back on their code with only the
 * shop's products is told their code has published none, since a sentence
 * that they published nothing would contradict the count under it.
 */
const emptyOf = (
  through: Integration,
  elsewhere: number,
  wooAvailable: boolean,
): NonNullable<CardsView["empty"]> =>
  through === "woocommerce"
    ? {
        says: "Your shop's products haven't been imported yet.",
        ways: { sdk: false, woo: wooAvailable ? "Open WooCommerce page" : null },
      }
    : {
        says:
          elsewhere === 0
            ? "You haven't published any products yet."
            : "Your code hasn't published any products yet.",
        ways: { sdk: true, woo: wooAvailable ? "Connect a WooCommerce shop" : null },
      };

/**
 * They come back on sale only when the merchant switches integration, which
 * is the integration pages' to offer; the switch takes the other
 * integration's products off sale, so it is not one to make in passing here.
 */
const elsewhereOf = (through: Integration, count: number): string | null => {
  if (count === 0) return null;
  const products = withUnit(count, count === 1 ? "product" : "products");
  const are = count === 1 ? "is" : "are";
  return through === "woocommerce"
    ? `${products} your code published ${are} off sale while you sell through WooCommerce.`
    : `${products} imported from your shop ${are} off sale while you sell through your own code.`;
};

const WHAT_A_PAUSE_DOES: Rest = {
  href: "/docs/faq#can-i-pause-the-selling",
  words: "What a pause does",
};

/**
 * A pause stops new orders and leaves the accepted ones to be delivered;
 * while all sales are paused, the line says instead what resuming leaves
 * alone.
 */
const switchesNote = (selling: MerchantCardList["selling"]): CardsView["note"] => {
  switch (selling) {
    case "paused":
      return {
        says: `Products you paused one by one stay paused when you press ${RESUME_ALL_SELLING}.`,
        rest: WHAT_A_PAUSE_DOES,
      };
    case "open":
      return { says: "A pause stops new orders only.", rest: WHAT_A_PAUSE_DOES };
  }
};

// --- orders ------------------------------------------------------------------

/**
 * The transfer that paid an order, on its receipt or on the order itself,
 * reported by the facilitator or verified from chain evidence: a link to the
 * chain's page where this deployment has one and the name is a transaction
 * hash, the name as written otherwise. The view holds it whole, for the copy
 * button and the link: a shortened hash is a different string to whoever
 * pastes it. An absent transaction means none was recorded on that document;
 * it does not establish that no transfer occurred.
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

interface OrderRow {
  readonly id: string;
  /** The card's title where the merchant still has the card, its code otherwise. */
  readonly product: string;
  /** The product's code: the row does not print it, and a search finds the order by it. */
  readonly itemId: string;
  readonly amount: string;
  /** Null where the payment did not go into one of the merchant's payout splits. */
  readonly share: string | null;
  readonly state: Word;
  /** The day it was priced and its zone, for the heading over that day's orders. */
  readonly day: string;
  /** The time of that moment within its day, in the zone the heading names. */
  readonly time: string;
  /** What happened to the order and when, in the order it happened. */
  readonly facts: readonly OrderFact[];
  /** What happened that the merchant or the buyer still has to act on, and what can be done; null otherwise. */
  readonly why: string | null;
  readonly rest: Rest | null;
  readonly payment: string;
  readonly paymentUnresolved: boolean;
  /** The transfer that paid the order, which a receipt names only once the goods are out. */
  readonly transfer: TransferView;
  /**
   * Where the documentation says how money goes back to the buyer, on a paid
   * order that ended without its goods; null otherwise.
   */
  readonly refund: Rest | null;
  readonly opened: boolean;
  /** The merchant's closure, with their explanation where they wrote one; its moment is among the facts. */
  readonly closure: Readonly<{ message?: string }> | null;
  /** Whether the closure form is offered, and whether it closes the order a second time. */
  readonly closing: "first" | "again" | null;
  /**
   * What the order the merchant's shop made for the sale totals, where that is
   * not what the buyer paid; null otherwise.
   */
  readonly shopTotal: string | null;
  /**
   * For a sale from a shop in another currency: what the shop's order totals
   * there, what the buyer paid and the rate they paid at; null otherwise.
   */
  readonly inTheShop: string | null;
}

/**
 * Something that happened to an order, or the deadline it is held to, at the
 * moment the order's record keeps for it.
 */
interface OrderFact {
  readonly label: string;
  readonly at: MomentView;
}

/** An order said in a row of its own: what happened to it, and what is the merchant's to do. */
interface OrderNeed extends OrderRow {
  /** Whether it counts toward the stop on the merchant's new purchases. */
  readonly stops: boolean;
  /**
   * Where the row's own line in the list opens: the page as it is where the
   * line is on it, the order found by its ID where it is not. Named by the
   * press waiting there.
   */
  readonly opens: Readonly<{ search: string; words: string }>;
}

/** Orders told in full, the newest first and at most a page of them, and how many there are. */
export interface ToldOrders {
  readonly rows: readonly OrderNeed[];
  readonly of: number;
}

/**
 * What became of a closure pressed on this page that the page cannot simply
 * show: said beside the order's form, with what was typed kept in its box.
 */
export interface ClosurePressed {
  readonly id: string;
  /** What became of the closure, said over the form; null where only the explanation was refused. */
  readonly note: string | null;
  /** Why the explanation typed was refused, said under its box. */
  readonly refusal: string | null;
  readonly typed: string;
}

/**
 * What became of a closure, drawn where the lists beside it could not be
 * read: the press's own answer stands, and the lists are offered again.
 */
export interface ClosureUnlisted {
  readonly pressed: ClosurePressed;
  /** The list the closure was pressed on, the order opened there. */
  readonly again: string;
}

export interface OrdersView {
  /** The gateway lists no order at all, so there is nothing to search or narrow. */
  readonly none: boolean;
  /** What became of a closure the merchant just pressed, where the page cannot simply show it. */
  readonly pressed: ClosurePressed | null;
  /**
   * The orders the address asked for, newest first and at most a page of
   * them: what was searched for, the segments with their counts, how much was
   * cut, and why none is drawn where the merchant has some.
   */
  readonly listing: Listing<OrderRow>;
  /**
   * The orders that need the merchant that the search finds: the newest of
   * them over the list, or, where the list shown is of them, its page.
   */
  readonly needsYou: ToldOrders;
  /**
   * Goods delivered and held until the buyer pays: nothing owed by the
   * merchant, who decides whether to revoke what they delivered or to wait.
   */
  readonly waitsOnTheBuyer: ToldOrders;
  /**
   * The order the address opens where the list does not draw it and the
   * merchant closed it, as a closure leaves the Needs you list it was pressed
   * on, with the way to it; null otherwise.
   */
  readonly closedElsewhere: Readonly<{ id: string; opens: string }> | null;
}

/** The terms of the payout split each order's charge went into, by order. */
export type PaidIntoSplits = Readonly<Record<string, SplitTerms>>;

/**
 * Open is the gateway's own narrowing, read beside the whole list rather than
 * worked out from it: a status does not say whether an order is open, since
 * "In progress" reads the same for an order the merchant was handed and for a
 * price nobody paid.
 */
const orderSegments = (
  open: OrderList,
  needing: ReadonlySet<string>,
): readonly SegmentRule<OrderRow>[] => {
  const ids = new Set(open.orders.map((order) => order.id));
  return [
    { key: "all", label: "All", holds: () => true, none: "" },
    {
      key: "open",
      label: "Open",
      holds: (row) => ids.has(row.id),
      none: "Nothing is open. A purchase still at its price question or waiting to be paid is not counted as open.",
    },
    {
      key: "needs",
      label: "Needs you",
      holds: (row) => needing.has(row.id),
      none: "Nothing needs you.",
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
      asTyped(row.product).toLocaleLowerCase().includes(words) ||
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

/** The earliest moment a date can hold, which a moment that cannot be read is sorted as. */
const UNREAD_MOMENT = -8.64e15;

/** A moment as the lists sort by it, to the millisecond. */
const momentKey = (iso: string): number => {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? UNREAD_MOMENT : at;
};

/**
 * Where an order stands in the list: newest first by when its price was set,
 * a tie broken by its identifier.
 */
const orderMark = (order: OrderList["orders"][number]): Mark => ({
  key: [momentKey(order.price.at)],
  id: order.id,
});

const inTheShopOf = (paid: string, shop: ShopTotal | undefined): string | null => {
  const converted = shop?.converted;
  if (shop === undefined || converted == null) return null;
  const { inTheShop, rate } = converted;
  return (
    `${money({ amount: shop.total, currency: inTheShop.currency })} in your shop, paid as` +
    ` ${withUnit(paid, "USDC")} at your rate of ${withUnit(rate.rate, inTheShop.currency)} per US dollar, set` +
    ` ${moment(rate.setAt)}`
  );
};

/**
 * Where an order stands as the merchant's Orders words it: paid after their
 * closure while it is still on their open list (`reopened`), closed by them,
 * or the status's own word.
 */
export const merchantOrderWord = (
  order: Pick<OrderList["orders"][number], "status" | "merchant_closure">,
  reopened: boolean,
): Word =>
  reopened
    ? { text: "Paid after closure", tone: "warn" }
    : order.status === "fulfillment_closed" && order.merchant_closure !== undefined
      ? { text: "Closed by you", tone: "quiet" }
      : ORDER_WORDS[order.status];

/** The original payment, as the merchant's Orders says it. */
export const PAYMENT_WORDS: Readonly<Record<PaymentStatus, string>> = Object.freeze({
  paid: "Paid",
  unresolved: "Outcome unknown",
  not_paid: "Not paid",
});

/**
 * The moments an order's record keeps, each named for what happened then. A
 * moment the record does not keep is left out, never stood in for by another.
 */
const factsOf = (kept: {
  readonly priced: string;
  readonly record?: OrderRecord | undefined;
  readonly closed?: string | undefined;
}): OrderFact[] => {
  const facts: { label: string; at: string }[] = [];
  const add = (label: string, at: string | null | undefined) => {
    if (at != null) facts.push({ label, at });
  };
  add("Price set", kept.priced);
  add("Paid", kept.record?.paidAt);
  const deadline = kept.record?.deadline ?? null;
  add(deadline?.passed ? "Delivery deadline passed" : "Delivery deadline", deadline?.at);
  add("Closed by you", kept.closed);
  // In the order they happened; two of one moment keep the order of the steps above.
  return facts
    .sort((one, other) => Date.parse(one.at) - Date.parse(other.at))
    .map(({ label, at }) => ({ label, at: momentView(at) }));
};

export const ordersView = (
  cards: MerchantCardList,
  orders: OrderList,
  open: OrderList,
  query: URLSearchParams = new URLSearchParams(),
  records: Readonly<Record<string, OrderRecord>> = {},
  paidInto: PaidIntoSplits = {},
  shopTotals: Readonly<Record<string, ShopTotal>> = {},
  connector: Readonly<Record<string, ConnectorSale>> = {},
  stopping: ReadonlySet<string> = new Set(),
  transactionPage: string | null = null,
): OrdersView => {
  const titles = new Map(
    cards.cards.map((entry) => [entry.card.merchant_item_id, keepUnits(entry.card.title)]),
  );
  const reopened = paidAfterClosureIn(open);
  const needing = (order: OrderList["orders"][number]) => needsYou(order.status) || reopened(order);
  const rowOf = (order: OrderList["orders"][number]): OrderRow => ({
    id: order.id,
    product: titles.get(order.merchant_item_id) ?? order.merchant_item_id,
    itemId: order.merchant_item_id,
    amount: money(order.price),
    share: shareIn(order.price, paidInto[order.id]),
    state: merchantOrderWord(order, reopened(order)),
    paymentUnresolved: order.payment_status === "unresolved",
    opened: query.get("details") === order.id,
    payment: PAYMENT_WORDS[order.payment_status],
    transfer: transferOf(order.transaction, transactionPage),
    refund:
      order.payment_status === "paid" &&
      (order.status === "unfulfilled" || order.status === "fulfillment_closed")
        ? REFUND
        : null,
    closure:
      order.merchant_closure === undefined
        ? null
        : {
            ...(order.merchant_closure.message === undefined
              ? {}
              : { message: keepUnits(order.merchant_closure.message) }),
          },
    closing: reopened(order) ? "again" : closable(order) ? "first" : null,
    shopTotal:
      shopTotals[order.id] === undefined ||
      shopTotals[order.id]?.converted != null ||
      shopTotals[order.id]?.total === order.price.amount
        ? null
        : money({ amount: shopTotals[order.id]?.total ?? "", currency: order.price.currency }),
    inTheShop: inTheShopOf(order.price.amount, shopTotals[order.id]),
    ...withinDay(order.price.at),
    facts: factsOf({
      priced: order.price.at,
      record: records[order.id],
      closed: order.merchant_closure?.closed_at,
    }),
    ...(reopened(order)
      ? { why: PAID_AFTER_CLOSURE, rest: null }
      : needsYou(order.status) || waitsOnTheBuyer(order.status)
        ? wayOn(
            order,
            records[order.id]?.unfulfilled ?? null,
            connector[order.id],
            records[order.id]?.soldThrough ?? null,
          )
        : { why: null, rest: null }),
  });
  // Newest first, whatever order the gateway lists them in, so the page a long
  // list opens on holds what just happened and a day's orders sit together.
  const listed = [...orders.orders]
    .sort((one, other) => rising(orderMark(other), orderMark(one)))
    .map((order) => ({ order, row: rowOf(order), mark: orderMark(order) }));
  const marks = new Map(listed.map((one) => [one.row.id, one.mark]));
  const needed = new Set(orders.orders.filter(needing).map((order) => order.id));
  const asked = askedIn(
    query,
    orderSegments(open, needed).map((one) => one.key),
  );
  const segments = orderSegments(open, needed);
  const finds = orderSearch(asked.q.toLocaleLowerCase());
  const found = asked.q === "" ? listed : listed.filter(({ row }) => finds(row));
  const listing = listingOf({
    rows: listed.map(({ row }) => row),
    asked,
    path: "/orders",
    segments,
    markOf: (row) => marks.get(row.id) ?? { key: [UNREAD_MOMENT], id: row.id },
    matches: finds,
    noMatch: (q, within) =>
      within === null
        ? `No order matches “${q}”.`
        : asked.show === "needs"
          ? `No order that needs you matches “${q}”.`
          : `No ${within.toLocaleLowerCase()} order matches “${q}”.`,
    showAll: "Show all orders",
  });
  const needsHere = asked.show === "needs";
  const onPage = new Set(listing.rows.map((row) => row.id));
  const opens = (row: OrderRow) => {
    const search = new URLSearchParams(onPage.has(row.id) ? query : { q: row.id });
    search.set("details", row.id);
    return {
      search: `?${search}`,
      words:
        row.closing === "first"
          ? "Close fulfillment"
          : row.closing === "again"
            ? "Close again"
            : "Details",
    };
  };
  const tell = ({ order, row }: (typeof listed)[number]): OrderNeed => ({
    ...row,
    stops: order.status === "unfulfilled" && stopping.has(order.id),
    opens: opens(row),
  });
  const told = (which: (order: OrderList["orders"][number]) => boolean): ToldOrders => {
    const all = found.filter(({ order }) => which(order));
    return { rows: all.slice(0, PAGE_ROWS).map(tell), of: all.length };
  };
  const byId = new Map(listed.map((one) => [one.row.id, one]));
  return {
    none: orders.orders.length === 0,
    pressed: null,
    listing,
    needsYou: needsHere
      ? {
          rows: listing.rows.flatMap((row) => {
            const one = byId.get(row.id);
            return one === undefined ? [] : [tell(one)];
          }),
          of: listing.segments.find((one) => one.here)?.count ?? 0,
        }
      : told(needing),
    waitsOnTheBuyer: told((order) => waitsOnTheBuyer(order.status)),
    closedElsewhere: closedElsewhere(query.get("details"), onPage, orders),
  };
};

const closedElsewhere = (
  id: string | null,
  onPage: ReadonlySet<string>,
  orders: OrderList,
): OrdersView["closedElsewhere"] =>
  id === null ||
  onPage.has(id) ||
  orders.orders.find((order) => order.id === id)?.merchant_closure === undefined
    ? null
    : { id, opens: `?${new URLSearchParams({ q: id, details: id })}` };

/** Where a closure leads back to: the list its form's fields name. */
export const ordersPlace = (fields: URLSearchParams): string =>
  placeOf(
    "/orders",
    fields,
    orderSegments({ orders: [] }, new Set()).map((one) => one.key),
  );

/**
 * A closure press the page cannot simply show: a write whose answer was lost
 * and whose reread did not show it, or a closure that arrived after the order
 * ended.
 */
export const CLOSURE_NOTES = {
  unconfirmed:
    "Agentify could not confirm the closure. Close the order again: closing it twice does no harm.",
  ended: "Nothing was closed: this order had already ended.",
} as const;

/**
 * A closure is recorded where the order is closed by its merchant and no
 * longer open: an order paid after its closure still carries that closure,
 * and is open again until it is closed a second time.
 */
export const closedForGood = (
  order: Pick<OrderList["orders"][number], "id" | "status" | "merchant_closure">,
  open: OrderList,
): boolean =>
  order.status === "fulfillment_closed" &&
  order.merchant_closure !== undefined &&
  !open.orders.some((one) => one.id === order.id);

/** Whether the orders drawn show this one closed for good, by the rule above. */
export const drawnClosedForGood = (view: OrdersView, id: string): boolean =>
  view.listing.rows.some((row) => row.id === id && row.closure !== null && row.closing === null);

/**
 * Closure stops what Agentify would still deliver, so it is offered only where
 * something is left to stop: a paid or possibly paid order that has not ended,
 * and goods held for a payment the buyer may still make. An order that ended
 * with nothing charged has nothing to stop, and closing it would only replace
 * the ending its buyer's agent reads.
 */
const STOPPABLE: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  "in_progress",
  "payment_unresolved",
  "unfulfilled",
  "delivered_unpaid",
]);

export const closable = (
  order: Pick<OrderList["orders"][number], "status" | "payment_status" | "merchant_closure">,
): boolean =>
  order.merchant_closure === undefined &&
  STOPPABLE.has(order.status) &&
  !(order.status === "in_progress" && order.payment_status === "not_paid");

/**
 * An order the merchant closed, now paid, that the gateway still lists as
 * open: its payment completed after the closure, and it stays open until the
 * merchant closes it again.
 */
const paidAfterClosureIn = (open: OrderList) => {
  const listed = new Set(open.orders.map((order) => order.id));
  return (
    order: Pick<
      OrderList["orders"][number],
      "id" | "status" | "payment_status" | "merchant_closure"
    >,
  ): boolean =>
    order.status === "fulfillment_closed" &&
    order.payment_status === "paid" &&
    order.merchant_closure !== undefined &&
    listed.has(order.id);
};

const REFUND: Rest = {
  href: "/docs/money#if-the-buyer-did-not-get-the-goods",
  words: "If the buyer did not get the goods",
};

const PAID_AFTER_CLOSURE =
  "The buyer's payment arrived after you closed this order, so they paid and nothing was delivered through Agentify. Close it again with a note that says what you did.";

/** Missing cause means unknown cause, rather than a guessed missed deadline. */
const UNFULFILLED_BECAUSE: Readonly<Record<UnfulfilledCause, string>> = {
  refused: "Paid, but your integration refused the order, so nothing was delivered.",
  deadline_passed: "Paid, but not delivered before the delivery deadline.",
  charge_confirmed_late:
    "Paid, but the payment was confirmed after Agentify had stopped waiting for it, so the order never reached your integration.",
};

/**
 * How an order the shop connector holds can still be delivered: a parcel by
 * marking its shop order Completed in WooCommerce, where that order was
 * placed; a download by the connector's recovery, where it can still deliver
 * one.
 */
export type ConnectorSale =
  | Readonly<{ kind: "parcel"; placed: boolean }>
  | Readonly<{ kind: "download"; recover: string | null }>;

const CLOSE = "close fulfillment with a note to the buyer";

const PARCELS: Rest = { href: "/docs/woocommerce#parcels", words: "Parcels" };

/**
 * What happened to an order that waits on the merchant or the buyer, and the
 * ways on that suit who holds the sale. A late delivery happens in the
 * merchant's integration, never on this page, so it is linked where there is
 * one; closure is linked once over all of them. Held goods owe nobody
 * anything: what can still happen is a payment the buyer makes.
 */
const wayOn = (
  order: OrderList["orders"][number],
  cause: UnfulfilledCause | null,
  sale: ConnectorSale | undefined,
  soldThrough: OrderRecord["soldThrough"],
): Readonly<{ why: string; rest: Rest | null }> => {
  if (order.status !== "unfulfilled") {
    return {
      why: "Your integration delivered, then the payment failed, so the buyer does not get the goods yet. This is rare and happens only with immediate delivery: the payment is checked before delivery and made after it, and the money can leave the buyer's wallet in between. If the buyer pays again for this same order and that payment goes through, the goods are released. Whether to revoke what you delivered or wait is up to you.",
      rest: {
        href: "/docs/orders#you-delivered-and-the-payment-did-not-execute",
        words: "What can still happen",
      },
    };
  }
  const said =
    cause === null ? "Paid, and the product was not delivered." : UNFULFILLED_BECAUSE[cause];
  if (sale?.kind === "parcel") {
    // Only a placed parcel whose seven days ran out can still be marked
    // Completed; one the connector refused or never confirmed may hold a shop
    // order it could not confirm.
    return cause === "deadline_passed" && sale.placed
      ? {
          why: `${said} You can still ship it: mark the order Completed in WooCommerce within thirty days of it being placed, or ${CLOSE}.`,
          rest: PARCELS,
        }
      : {
          why: `${said} Do not ship it: ${CLOSE}, and settle any order your shop holds for it by your own policy.`,
          rest: PARCELS,
        };
  }
  // A sale made through the shop that the connector never received, such as
  // a charge confirmed after Agentify stopped waiting, has nothing to deliver
  // it with.
  if (sale === undefined && soldThrough === "woocommerce") {
    return { why: `${said} Close fulfillment with a note to the buyer.`, rest: null };
  }
  if (sale?.kind === "download") {
    return sale.recover === null
      ? { why: `${said} Close fulfillment with a note to the buyer.`, rest: null }
      : {
          why: `${said} You can still deliver it late, or ${CLOSE}.`,
          rest: { href: sale.recover, words: "Recover WooCommerce delivery" },
        };
  }
  return {
    why: `${said} You can still deliver it late, or ${CLOSE}.`,
    rest: {
      href: "/docs/orders#confirming-a-delivery-with-a-separate-call",
      words: "Delivering late",
    },
  };
};

/**
 * The merchant's share of a payment into their payout split, after
 * Agentify's part. It is said as about so much: the split divides what has
 * gathered in it when it is paid out, rounding each share down, so no single
 * payment has an exact share.
 */
const shareIn = (
  price: { readonly amount: string; readonly currency: string },
  terms: SplitTerms | undefined,
): string | null => {
  if (terms === undefined) return null;
  const { merchant } = sharesOf(price, terms);
  const fee = percentOf(terms.commissionAllocation, terms.totalAllocation);
  return keepUnits(`${merchant.replace(/^≈ /, "about ")}, after Agentify's ${fee}`);
};

// --- receipts ----------------------------------------------------------------

interface ReceiptRow {
  readonly id: string;
  readonly orderId: string;
  readonly needsYou: boolean;
  readonly product: string;
  readonly amount: string;
  /** Null where the payment did not go into one of the merchant's payout splits. */
  readonly share: string | null;
  readonly outcome: Word;
  readonly paid: MomentView;
  readonly priceSet: MomentView;
  readonly priceAsOf: MomentView;
  /** The day of `paid` and its zone, for the heading over that day's receipts. */
  readonly day: string;
  /** The time of `paid` within that day, in the zone its heading names. */
  readonly time: string;
  readonly transfer: TransferView;
}

export interface ReceiptsView {
  /** The receipts the address asks for, the latest payment first, a page at a time. */
  readonly listing: Listing<ReceiptRow>;
}

/** The receipts are one list with no search, so they are read a page at a time and no more. */
const ALL_RECEIPTS: readonly SegmentRule<ReceiptRow>[] = [
  { key: "all", label: "All", holds: () => true, none: "" },
];

export const receiptsView = (
  cards: MerchantCardList,
  receipts: ReceiptList,
  transactionPage: string | null = null,
  paidInto: PaidIntoSplits = {},
  query: URLSearchParams = new URLSearchParams(),
): ReceiptsView => {
  const titles = new Map(cards.cards.map((entry) => [entry.id, keepUnits(entry.card.title)]));
  // The latest payment first, whatever order the gateway lists them in.
  const marks = new Map(
    receipts.receipts.map((one) => [one.id, { key: [momentKey(one.paid_at)], id: one.id }]),
  );
  const rows = receipts.receipts.map(
    (receipt): ReceiptRow => ({
      id: receipt.id,
      orderId: receipt.order_id,
      needsYou: needsYou(receipt.outcome),
      product: titles.get(receipt.item_id) ?? receipt.item_id,
      amount: money(receipt.price),
      share: shareIn(receipt.price, paidInto[receipt.order_id]),
      outcome: ORDER_WORDS[receipt.outcome],
      paid: momentView(receipt.paid_at),
      priceSet: momentView(receipt.price.at),
      priceAsOf: momentView(receipt.price.as_of),
      ...withinDay(receipt.paid_at),
      transfer: transferOf(receipt.transaction, transactionPage),
    }),
  );
  return {
    listing: listingOf({
      rows,
      asked: {
        ...askedIn(
          query,
          ALL_RECEIPTS.map((one) => one.key),
        ),
        q: "",
        cut: false,
      },
      path: "/receipts",
      segments: ALL_RECEIPTS,
      markOf: (row) => marks.get(row.id) ?? { key: [UNREAD_MOMENT], id: row.id },
      matches: () => true,
      noMatch: () => "",
      showAll: "Show all receipts",
    }),
  };
};
