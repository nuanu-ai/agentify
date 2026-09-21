/**
 * The three screens: the cards, the orders, the receipts.
 *
 * Each one is a function from the documents the gateway answered with to a
 * page, and none of them fetches anything or decides anything. That is what
 * lets the tests read the page a merchant would actually be looking at, and it
 * is why every claim on these screens can be traced to a field in a document
 * rather than to something the cabinet worked out on its own.
 *
 * Where a screen would like to say more than the API can support, it says the
 * weaker thing. `words.ts` carries those cases and the reasons.
 */

import type { SurfaceMode } from "@agentify/commerce-core";
import {
  API_ROUTES,
  expandPath,
  type MerchantCard,
  type MerchantCardList,
  type OrderList,
  type ReceiptList,
} from "@nuanu-ai/agentify-contracts";
import { escaped, page, state, type Tab, table } from "./html.js";
import type { PayoutWallet } from "./payout-wallet.js";
// A type and nothing else, so this leaves no import behind once it is compiled
// and the two files are not a cycle at run time. The shape belongs beside the
// screen that draws a shop, and the viewer that carries it belongs here.
import type { ShopTile } from "./woo-screens.js";
import {
  FULFILLMENT_WORDS,
  moment,
  money,
  needsAttention,
  ORDER_WORDS,
  SELLING_WORDS,
} from "./words.js";

/**
 * Who is looking at a page, and where the cabinet is mounted.
 *
 * The person is here rather than at the edge because every page says who is
 * signed in. That is not decoration: until ADR-0009 there was no person in the
 * system at all — there was a merchant key — and a screen that cannot name who
 * is looking at it is a screen nobody can be held to.
 */
export interface Viewer {
  /** Which stack this person is looking at, as derived from its gateway. */
  readonly mode: SurfaceMode;
  /** Where the cabinet is mounted, "" when it is at the root of its origin. */
  readonly base: string;
  /** The address of the person signed in. */
  readonly who: string;
  /**
   * Whether that address has been confirmed. A passwordless interactive
   * session is always confirmed by the link that opened it.
   */
  readonly confirmed: boolean;
  /**
   * The name buyers read beside this merchant's products, where the screen
   * asked the gateway for it.
   *
   * Null is a merchant who has chosen none, and it is what the line at the top
   * of these three screens is drawn from: until a name is set, a card their
   * code publishes is refused. Absent where the screen did not ask — the keys,
   * for the reason `html.ts` gives beside the selling word.
   */
  readonly sellerName?: string | null;
  /**
   * The address this merchant's money arrives at, and anything wrong with what
   * was just typed into the box for it.
   *
   * The refusal travels with the address because one block on one screen draws
   * both, and a screen holding one of them without the other cannot draw that
   * block at all. Absent everywhere the block is not drawn, which today is
   * every screen but the settings — a page that did not ask the gateway must
   * not tell a merchant they have set no address.
   */
  readonly payout?: PayoutWallet;
  /**
   * Where this account's WooCommerce channel has got to, where the screen
   * asked.
   *
   * Absent is only a cabinet built with nowhere to keep a connection — it
   * mounts none of those routes, which is a deliberate absence rather than a
   * failure, and a link into them would be the settings screen offering
   * something that answers "there is no such page". That is the one case that
   * draws no block about a shop. A read that failed is not absent: it is the
   * fifth case, `unread`, and the block says so, because a block that vanishes
   * reads as "no shop is connected" to a merchant who connected one.
   *
   * Four states rather than a flag, because a block saying "connect a shop"
   * over a Connect that is halfway through is not a missing detail: it is the
   * page telling a merchant their Connect failed. `ShopState` carries only what
   * a screen may know, never the stored row — the row also holds the shop's key
   * and its secret, and a screen with no way to reach them cannot leak them
   * (ADR-0023).
   */
  readonly shop?: ShopTile;
}

interface Frame {
  readonly viewer: Viewer;
  readonly tab: Tab;
  readonly title: string;
  readonly selling: MerchantCardList["selling"];
  readonly body: string;
}

const framed = (frame: Frame): string =>
  page({
    mode: frame.viewer.mode,
    base: frame.viewer.base,
    who: frame.viewer.who,
    confirmed: frame.viewer.confirmed,
    tab: frame.tab,
    title: frame.title,
    selling: SELLING_WORDS[frame.selling],
    unnamed: frame.viewer.sellerName === null,
    body: frame.body,
  });

/**
 * The line under a card's title: everything about this card that the merchant's
 * own operation has to be ready for.
 *
 * Every fact that applies is listed, not the first one found. A card can both
 * have its price asked at purchase and owe a delivery inside a window, and an
 * earlier version of this showed only the price check — so a merchant read the
 * row and never saw the deadline they are held to. Dropping a promise a
 * merchant is answerable for, because another promise happened to be checked
 * first, is the kind of truncation that has to be said or not done.
 */
/**
 * The link at the end of a sentence the portal finishes.
 *
 * These screens say the consequence — the part a merchant acts on while they
 * are looking at the control — and the portal carries the mechanism. Written
 * out rather than escaped because both halves are this file's own literals;
 * everything that came from a document still goes through `escaped`.
 */
const restOf = (href: string, words: string): string => ` <a href="${href}">${words}</a>.`;

const cardAside = (entry: MerchantCard): string => {
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
    // Neither a price check nor a delivery window, so the one fact left is when
    // the price on the card started being the price. It is `as_of`, and this is
    // the only screen that shows it — a merchant working out why a sale went
    // through at an old number has nowhere else to look.
    return `Price on the card since ${moment(entry.as_of)}`;
  }

  const line = facts.join(", ");
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}`;
};

/**
 * Which switch is holding a card off sale.
 *
 * This is the sentence the contract's own document warns about: with all
 * selling stopped every card reads paused, and resuming one of them changes
 * nothing a merchant can see. Saying which switch is holding it is the whole
 * reason the document carries two fields instead of one.
 */
const cardControl = (base: string, entry: MerchantCard): string => {
  if (entry.paused) {
    return `<form class="inline" method="post" action="${escaped(base)}/cards/${encodeURIComponent(entry.id)}/resume">
<button class="button button-compact button-primary" type="submit">Resume</button></form>`;
  }
  if (entry.selling !== "open") {
    return '<span class="quiet">All selling is stopped</span>';
  }
  return `<form class="inline" method="post" action="${escaped(base)}/cards/${encodeURIComponent(entry.id)}/pause">
<button class="button button-compact button-secondary" type="submit">Pause</button></form>`;
};

/**
 * The address an agent buys one card at.
 *
 * Built from the route table rather than written out here, for the reason the
 * cabinet's client gives: a second transcription of the surface is a second
 * chance for it to come apart. What goes in front of it is the origin the
 * deployment is reached at, which is not the gateway address the cabinet itself
 * calls — that one is inside the compose network and means nothing to anybody
 * outside it.
 *
 * The identifier is our catalog one and not the merchant's own. They are two
 * different strings and only one of them is in this address: a merchant who
 * pasted their own `merchant_item_id` into it would be handed a 404 by a
 * gateway that is working perfectly.
 */
const buyingAddress = (origin: string, entry: MerchantCard): string =>
  `${origin}${expandPath(API_ROUTES.purchase_item.path, { item_id: entry.id })}`;

/**
 * One address, marked up so that it wraps where a reader expects it to.
 *
 * An address is longer than the column it sits in, so it wraps; left to the
 * browser it wraps mid-word — "…/pur" above "chase" — which reads as a broken
 * string rather than a wrapped one. `<wbr>` before each separator says where
 * the breaks may fall, so a wrapped address breaks between its parts.
 *
 * It is a zero-width mark and not a soft hyphen: nothing is added to the text,
 * so a merchant who selects this and copies it gets the address and not a
 * hyphenated version of it that no client would accept.
 */
const wrappable = (address: string): string => {
  const [origin, ...segments] = address.split(/(?<!\/)\/(?!\/)/);
  return [escaped(origin ?? "")]
    .concat(segments.map((segment) => `<wbr>/${escaped(segment)}`))
    .join("");
};

export const cardsScreen = (
  viewer: Viewer,
  cards: MerchantCardList,
  origin: string,
  wooAvailable = false,
): string => {
  const { base } = viewer;
  const paused = cards.cards.filter((entry) => entry.paused).length;
  // Three words and not two. Folding "departed" into "stopped" would offer a
  // merchant who has left a button that puts them back on sale and a note
  // saying their accepted orders are playing out — and leaving closed those
  // orders and left refunds owed. The whole of `selling.ts` is an argument
  // that this fold is the one not to make.
  const gone = cards.selling === "departed";
  const stopped = cards.selling === "paused";

  const rows = cards.cards.map(
    (entry) => `<tr class="${entry.selling === "open" ? "" : "off"}">
<td><div class="title">${escaped(entry.card.title)}</div><div class="under">${escaped(cardAside(entry))}</div><div class="buy">${wrappable(buyingAddress(origin, entry))}</div></td>
<td class="key">${escaped(entry.card.merchant_item_id)}</td>
<td class="amount">${escaped(money(entry.card.price))}</td>
<td class="quiet">${escaped(FULFILLMENT_WORDS[entry.card.fulfillment])}</td>
<td>${state(SELLING_WORDS[entry.selling])}</td>
<td class="control">${cardControl(base, entry)}</td>
</tr>`,
  );

  const body = `
  <div class="lede">
    <div>
      <h1>Product cards</h1>
      <p>${escaped(`${countOf(cards.cards.length, "card")} published, ${paused} paused. ${sellingNote(cards.selling)}`)}${sellingRest(cards.selling)}</p>
    </div>
    <div class="actions">
      ${
        gone
          ? ""
          : `<form class="inline" method="post" action="${escaped(base)}/selling/${stopped ? "resume" : "pause"}">
        <button class="button ${stopped ? "button-primary" : "button-secondary"}" type="submit">${stopped ? "Start selling again" : "Stop all selling"}</button>
      </form>`
      }
    </div>
  </div>
${table(
  ["Product", "Your key", "Price", "Delivery", "State", ""],
  rows,
  // Why an empty catalogue is empty while no name is set is said once, in the
  // banner at the top of this very page, which is drawn in exactly that case.
  // Saying it twice on one screen is the shape Dmitry named on 2026-09-21.
  "No cards yet. Your code publishes them.",
)}
${
  cards.cards.length === 0
    ? `<p><a href="/docs/quickstart">Publish your first card →</a>${
        wooAvailable
          ? ` · <a href="${escaped(base)}/woocommerce">Try the experimental WooCommerce path →</a>`
          : ""
      }</p>`
    : ""
}
  <p class="note">${escaped(
    // Text and not a link, and the reason is what happens when you press one.
    // Asking for this address without paying is answered with a demand for
    // payment that travels in a header, so a browser is handed a blank page
    // and a merchant who clicked reads that as their card being broken.
    "The address under each product is for an agent, not a browser: it answers with a demand for" +
      " payment.",
  )}${restOf("/docs/quickstart#_6-walk-a-test-purchase", "Walking a test purchase")}</p>
`;

  return framed({ viewer, tab: "cards", title: "Product cards", selling: cards.selling, body });
};

/**
 * What the merchant's selling word means for the orders they already have.
 *
 * A pause and a departure differ in exactly the thing a merchant needs to know
 * here, and the difference is not one of degree: a pause leaves the accepted
 * orders to play out, and leaving closed them and left the money for anything
 * paid for and not delivered to be returned. One sentence for both would be
 * wrong for one of them.
 *
 * One sentence each, in the counts line beside the control they are about,
 * rather than a paragraph under the table. The rest of what each word means is
 * the link at the end of that line.
 */
const sellingNote = (selling: MerchantCardList["selling"]): string => {
  switch (selling) {
    case "departed":
      return "You have left: the open orders closed with you, and anything paid for and not delivered is yours to return.";
    case "paused":
      return "All selling is stopped; the orders you already accepted play out.";
    case "open":
      return "A pause takes a card off sale; the orders you already accepted play out.";
  }
};

/** Where the rest of what each of those words means is written out. */
const sellingRest = (selling: MerchantCardList["selling"]): string =>
  selling === "departed"
    ? restOf("/docs/faq#can-i-leave-altogether", "What leaving settles and what it does not")
    : restOf("/docs/faq#can-i-pause-the-selling", "What a pause does to the orders you have");

export const ordersScreen = (
  viewer: Viewer,
  cards: MerchantCardList,
  orders: OrderList,
  open: boolean,
): string => {
  const { base } = viewer;
  const titles = new Map(
    cards.cards.map((entry) => [entry.card.merchant_item_id, entry.card.title]),
  );
  const wanting = orders.orders.filter((order) => needsAttention(order.status));

  const rows = orders.orders.map((order) => {
    const word = ORDER_WORDS[order.status];
    return `<tr class="${needsAttention(order.status) ? "needs-you" : ""}">
<td class="ident">${escaped(order.id)}</td>
<td><div>${escaped(titles.get(order.merchant_item_id) ?? order.merchant_item_id)}</div><div class="under mono">${escaped(order.merchant_item_id)}</div></td>
<td class="amount">${escaped(money(order.price))}${sum(order.test)}</td>
<td>${state(word)}</td>
<td class="quiet">${escaped(moment(order.price.at))}</td>
</tr>`;
  });

  const body = `
  <div class="lede">
    <div>
      <h1>Orders</h1>
      <p>${escaped(ordersLede(orders, open))}</p>
      ${testOrders(orders)}
    </div>
    <div class="filter">
      ${open ? '<span class="here">Open</span>' : `<a href="${escaped(base)}/orders?open=true">Open</a>`}
      ${open ? `<a href="${escaped(base)}/orders">All</a>` : '<span class="here">All</span>'}
    </div>
  </div>
${table(
  // "Price set" and not "Bought": the moment in the row is when we fixed the
  // price for this sale, and on a card whose price is checked at the purchase
  // the buyer may pay well after it. A column headed "Bought" would have a
  // merchant reconciling money against a minute nothing happened in.
  ["Order", "Product", "Amount", "State", "Price set"],
  rows,
  open ? "Nothing is open. Every order you have is finished." : "No orders yet.",
)}
  <p class="note">${escaped(
    // The truncation this table cannot avoid: every row carries the price the
    // order sold at, and an order that closed before anybody named a price has
    // none. It was a paragraph working through which purchases those are; the
    // portal's own page on how an order can end does that, and this says the
    // part a merchant reading the table has to know.
    "Orders that closed before a price was named are not listed. Nothing was charged for them.",
  )}${restOf("/docs/orders#how-an-order-can-end", "How an order can end")}</p>
${wanting
  .map(
    (order) => `  <div class="callout">
    <div class="what">Order <span class="mono">${escaped(order.id)}</span> ${escaped(ORDER_WORDS[order.status].text)}</div>
    <div class="why">${escaped(whyItNeedsYou(order.status))}${whereTheRestIs(order.status)}</div>
  </div>
`,
  )
  .join("")}`;

  return framed({ viewer, tab: "orders", title: "Orders", selling: cards.selling, body });
};

/**
 * The sentence at the top of the orders screen.
 *
 * It counts what it can stand behind and says only that. "Open" is the
 * gateway's own filter; "needs you" is `NEEDS_ATTENTION` — the two endings that
 * stay open with something concrete owed — and the sentence is scoped to those
 * two rather than to owing in general.
 *
 * Two earlier versions of this line said more than the code knew. "None of them
 * is owed money or goods by you" was false for an order merely under way, which
 * in the asynchronous mode is money already taken against goods not yet sent.
 * And "the money was taken and the goods have not gone out" described only
 * `refund_due`, while the count beside it also included `delivered_unpaid`,
 * which is the exact inverse. Neither is here now: the count is scoped, and
 * what each order actually needs is said per order in the callouts below,
 * where it can be right.
 */
const ordersLede = (orders: OrderList, open: boolean): string => {
  const wanting = orders.orders.filter((order) => needsAttention(order.status)).length;
  const scope = open ? "open" : "";
  const listed = `${countOf(orders.orders.length, `${scope} order`.trim())} listed.`;

  if (wanting === 0) {
    return `${listed} None owes a refund, and none was delivered without payment.`;
  }
  return `${listed} ${countOf(wanting, "order")} ${wanting === 1 ? "needs" : "need"} you, below.`;
};

/**
 * The same warning as on the receipts screen, for the same reason.
 *
 * An order carries the flag too, and the sums in this table are sums a merchant
 * would otherwise take for money that moved.
 */
const testOrders = (orders: OrderList): string => {
  const tests = orders.orders.filter((order) => order.test).length;
  if (tests === 0) {
    return "";
  }
  return `<p class="problem">${escaped(
    tests === orders.orders.length
      ? "Every order here is a test purchase: no real money moved."
      : `${countOf(tests, "order")} here ${tests === 1 ? "is a test purchase" : "are test purchases"}: no real money moved for ${tests === 1 ? "it" : "those"}.`,
  )}</p>`;
};

const whyItNeedsYou = (status: OrderList["orders"][number]["status"]): string =>
  status === "refund_due"
    ? "The money was taken and nothing shipped in time. Return it from your own wallet, or deliver late and clear the debt that way."
    : "You returned the goods, payment did not settle, and the goods were not released to the buyer. The order stays open.";

/**
 * Where the rest of it is written, for the one of the two that has a rest.
 *
 * A refund is a thing to go and do, and the sentence above is the whole of what
 * there is to know before doing it. Held goods are not: what can still happen
 * to that order is a payment somebody else makes, and the portal's page on it
 * carries what settles and what does not.
 */
const whereTheRestIs = (status: OrderList["orders"][number]["status"]): string =>
  status === "refund_due"
    ? ""
    : restOf(
        "/docs/orders#you-delivered-and-the-payment-did-not-execute",
        "What can still happen to it",
      );

export const receiptsScreen = (
  viewer: Viewer,
  cards: MerchantCardList,
  receipts: ReceiptList,
): string => {
  const titles = new Map(cards.cards.map((entry) => [entry.id, entry.card.title]));
  const delivered = receipts.receipts.filter((receipt) => receipt.outcome === "delivered").length;

  const rows = receipts.receipts.map((receipt) => {
    const word = ORDER_WORDS[receipt.outcome];
    return `<tr class="${receipt.outcome === "refund_due" ? "needs-you" : ""}">
<td class="ident">${escaped(receipt.id)}</td>
<td class="ident">${escaped(receipt.order_id)}</td>
<td>${escaped(titles.get(receipt.item_id) ?? receipt.item_id)}</td>
<td class="amount">${escaped(money(receipt.price))}${sum(receipt.test)}</td>
<td>${state(word)}</td>
<td class="quiet">${escaped(moment(receipt.paid_at))}</td>
<td class="quiet">${escaped(moment(receipt.price.at))}</td>
<td class="quiet">${escaped(moment(receipt.price.as_of))}</td>
</tr>`;
  });

  const body = `
  <div class="lede">
    <div>
      <h1>Receipts</h1>
      ${testWarning(receipts, viewer.mode)}
    </div>
  </div>
  <div class="summary">
    <div class="tile">
      <div class="label">Receipts</div>
      <div class="figure">${receipts.receipts.length}</div>
      <div class="aside">${escaped(sumsOf(receipts))}</div>
    </div>
    <div class="tile">
      <!-- Two tiles and not three. A third counting what is paid for and not
           yet delivered would read nought forever — this gateway writes a
           receipt only when goods are released — and a nought is a positive
           claim that there is none, printed on the screen where a merchant
           looks for money they are owed. What cannot be counted here is the
           footnote under the table instead, with the place it can be. -->
      <div class="label">Delivered</div>
      <div class="figure${delivered === 0 ? "" : " ok"}">${delivered}</div>
      <div class="aside">of ${countOf(receipts.receipts.length, "receipt")}</div>
    </div>
  </div>
${table(
  ["Receipt", "Order", "Product", "Amount", "Outcome", "Paid", "Price set", "Price true as of"],
  rows,
  "No receipts yet.",
)}
  <p class="note">${escaped(
    // What this page cannot show, in the words the fifth gate asks for: a
    // merchant reading a list of receipts as their money is reading a list
    // that is short of the two things they are owed something on. Both live on
    // Orders, and until they end there they are nowhere on this screen.
    "Not the whole of the money: purchases paid for but not delivered, and refunds you owe, are on Orders.",
  )}${restOf("/docs/money#what-proves-a-sale-happened", "What a receipt records")}</p>
`;

  return framed({ viewer, tab: "receipts", title: "Receipts", selling: cards.selling, body });
};

/**
 * What was sold, by currency.
 *
 * Amounts are not added up across currencies and are not added up at all: they
 * are exact decimal strings on the wire so that nothing turns a price into a
 * float, and a total computed here in JavaScript would be the one number on
 * this screen that had been through one. The currencies present are named
 * instead, which is a fact rather than an arithmetic claim.
 */
const sumsOf = (receipts: ReceiptList): string => {
  const currencies = [...new Set(receipts.receipts.map((receipt) => receipt.price.currency))];
  if (currencies.length === 0) {
    return "nothing sold yet";
  }
  return `priced in ${currencies.sort().join(", ")}`;
};

/**
 * The mark beside a sum that was not real money.
 *
 * A receipt is proof of a payment, and the contract says in as many words that
 * an unmarked receipt for a test purchase is proof of a payment that never
 * happened. Stage one marks every order as a test, so today every row on both
 * screens carries this — which is exactly the situation in which leaving it out
 * would be worst: a merchant would be reading a ledger of payments that did not
 * happen, laid out as a ledger of payments.
 */
const sum = (test: boolean): string => (test ? ' <span class="tag">test</span>' : "");

/**
 * The sentence that says the whole screen is test money, when it is.
 *
 * A mark per row is enough to tell two rows apart. It is not enough to stop a
 * merchant reading a full page of them as their takings, so when every row is a
 * test the page says so once, in a sentence, above the table.
 */
const testWarning = (receipts: ReceiptList, mode: Viewer["mode"]): string => {
  const tests = receipts.receipts.filter((receipt) => receipt.test).length;
  if (tests === 0) {
    return "";
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
  return `<p class="problem">${escaped(`${subject}: ${consequence}`)}</p>`;
};

const countOf = (many: number, thing: string): string => `${many} ${thing}${many === 1 ? "" : "s"}`;
