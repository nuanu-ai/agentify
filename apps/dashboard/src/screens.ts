/**
 * Each screen is a function from the documents the gateway answered with to a
 * page, fetching and deciding nothing, so every claim on it traces to a field
 * in a document. Where a screen would like to say more than the API supports,
 * it says the weaker thing; `words.ts` carries those cases.
 */

import { type Readiness, readinessOf, type SurfaceMode, UNKNOWN } from "@agentify/core";
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
import {
  bare,
  brandLockup,
  type Cell,
  escaped,
  momentCell,
  page,
  type Row,
  state,
  type Tab,
  table,
  when,
} from "./html.js";
import type { PayoutWallet } from "./payout-wallet.js";
// A type-only import, so the two files are not a cycle at run time.
import type { ShopTile } from "./woo-screens.js";
import {
  APPROVAL_PENDING,
  FULFILLMENT_WORDS,
  money,
  needsAttention,
  ORDER_WORDS,
  SELLING_WORDS,
  UNSET_WORDS,
  type Unset,
} from "./words.js";

export interface Viewer {
  /** As derived from its gateway. */
  readonly mode: SurfaceMode;
  /** "" when mounted at the root of its origin. */
  readonly base: string;
  readonly who: string;
  /** An interactive session is always confirmed by the link that opened it. */
  readonly confirmed: boolean;
  /**
   * Where the screen asked the gateway for it. Null is a merchant who has
   * chosen none, and until one is set every card their code publishes is
   * refused. Absent where the screen did not ask (the keys, for the reason
   * `html.ts` gives).
   */
  readonly sellerName?: string | null;
  /** Null where none was given. Present only on the settings screen. */
  readonly sellerSite?: string | null;
  /**
   * Present only where the screen asked the gateway for the address: settings,
   * which draws the block, and the cards, which say what holds a card off sale.
   * A page that did not ask must not tell a merchant they have set no address.
   */
  readonly payout?: PayoutWallet;
  /**
   * Where the screen asked; it matters only on the live channel, where
   * publishing waits for it.
   */
  readonly liveApproval?: boolean;
  /**
   * Where the screen asked. Absent only on a dashboard built with nowhere to
   * keep a connection, which mounts none of those routes. A read that failed is
   * `unread`, not absent, because a block that vanished would read as "no shop
   * is connected" to a merchant who connected one. Several states rather than a
   * flag, because "connect a shop" over a Connect halfway through tells a
   * merchant it failed. `ShopTile` carries only what a screen may know, never
   * the stored row with the shop's key and secret, so a screen cannot leak
   * them.
   */
  readonly shop?: ShopTile;
  /**
   * What became of signing out every other device; present only on the
   * settings screen drawn as the answer to that press.
   */
  readonly accountNotice?: string;
}

/**
 * The rule is the gateway's own (`readinessOf` in the core), so no screen holds
 * an opinion about which setting publishing needs where. What the screen did
 * not read goes in as unknown, the operator's approval included: a page that
 * did not read something must not say anything either way about it.
 */
export const readinessSeenBy = (viewer: Viewer): Readiness =>
  readinessOf(
    {
      sellerName: viewer.sellerName === undefined ? UNKNOWN : viewer.sellerName,
      payoutWallet: viewer.payout === undefined ? UNKNOWN : viewer.payout.wallet,
      liveApproval: viewer.liveApproval === undefined ? UNKNOWN : viewer.liveApproval,
    },
    viewer.mode,
  );

/** As far as this screen knows. */
export const refusedForNoName = (viewer: Viewer): boolean =>
  readinessSeenBy(viewer).missing.includes(MERCHANT_FINDINGS.NO_SELLER_NAME);

/**
 * What is missing that the merchant sets in Settings: everything the rule finds
 * missing except the operator's approval, which nobody sets there (on live,
 * where the cards and settings screens read it, it is said on its own). Nothing
 * else may be dropped, because this is the list a merchant is told to go and
 * set.
 */
export const unsetIn = (door: Readiness): readonly Unset[] =>
  door.missing.filter(
    (finding): finding is Unset => finding !== MERCHANT_FINDINGS.NO_OPERATOR_APPROVAL,
  );

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
    unnamed: refusedForNoName(frame.viewer),
    body: frame.body,
  });

/**
 * These screens say the consequence and the portal carries the mechanism. Not
 * escaped because both halves are this file's own literals; everything from a
 * document still goes through `escaped`.
 */
const restOf = (href: string, words: string): string => ` <a href="${href}">${words}</a>.`;

/**
 * Every fact that applies is listed, not the first one found: a card can both
 * have its price asked at purchase and owe a delivery inside a window, and
 * dropping the deadline because the price check came first would hide a promise
 * the merchant is answerable for.
 */
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
    // The only screen that shows `as_of`: a merchant working out why a sale
    // went through at an old price has nowhere else to look.
    return `Price on the card since ${when(entry.as_of)}`;
  }

  const line = facts.join(", ");
  return escaped(`${line.charAt(0).toUpperCase()}${line.slice(1)}`);
};

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
  base: string,
  entry: MerchantCard,
  merchant: MerchantCardList["selling"],
  door: Readiness,
  integration: CardsIntegration,
): string => {
  if (integration.offSale.includes(entry.id)) {
    return integration.through === "woocommerce"
      ? '<span class="quiet">Off sale while you sell through your WooCommerce shop</span>'
      : '<span class="quiet">Off sale while you sell through your own code</span>';
  }
  if (entry.paused) {
    return `<form class="inline" method="post" action="${escaped(base)}/cards/${encodeURIComponent(entry.id)}/resume">
<button class="button button-compact button-primary" type="submit">Resume</button></form>`;
  }
  if (entry.selling === "open") {
    return `<form class="inline" method="post" action="${escaped(base)}/cards/${encodeURIComponent(entry.id)}/pause">
<button class="button button-compact button-secondary" type="submit">Pause</button></form>`;
  }
  if (merchant !== "open") {
    return '<span class="quiet">All selling is stopped</span>';
  }
  const unset = unsetIn(door);
  const waiting = door.missing.includes(MERCHANT_FINDINGS.NO_OPERATOR_APPROVAL)
    ? ` ${APPROVAL_PENDING}`
    : "";
  if (unset.length > 0) {
    const what = unset.map((one) => UNSET_WORDS[one]).join(" and ");
    return `<span class="quiet">Not on sale until you set ${escaped(what)} in <a href="${escaped(base)}/settings">Settings</a>.${escaped(waiting)}</span>`;
  }
  return `<span class="quiet">Not on sale.${escaped(waiting)}</span>`;
};

/**
 * Built from the route table, not written out, so the two cannot drift. The
 * origin is the one the deployment is reached at, not the internal gateway
 * address. The identifier is our catalog one, not the merchant's own: a
 * merchant who pasted their `merchant_item_id` into it would get a 404 from a
 * working gateway.
 */
const buyingAddress = (origin: string, entry: MerchantCard): string =>
  `${origin}${expandPath(API_ROUTES.purchase_item.path, { item_id: entry.id })}`;

/**
 * `<wbr>` before each separator, so a wrapped address breaks between its parts
 * rather than mid-word. Zero-width rather than a soft hyphen, so a copied
 * address is the address.
 */
const wrappable = (address: string): string => {
  const [origin, ...segments] = address.split(/(?<!\/)\/(?!\/)/);
  return [escaped(origin ?? "")]
    .concat(segments.map((segment) => `<wbr>/${escaped(segment)}`))
    .join("");
};

/**
 * The SDK comes first and the WooCommerce connector after it, only where this
 * dashboard has one. While no name is set, everything published is refused, so
 * the line says so rather than leaving a merchant to work out why their card
 * never arrived.
 */
const emptyCatalogue = (viewer: Viewer, wooAvailable: boolean): string => {
  const why = refusedForNoName(viewer)
    ? "You haven't published any cards yet. Choose your seller name in Settings first. Cards can't be published without it."
    : readinessSeenBy(viewer).missing.includes(MERCHANT_FINDINGS.NO_OPERATOR_APPROVAL)
      ? `You haven't published any cards yet. ${APPROVAL_PENDING}`
      : "You haven't published any cards yet. Your code publishes them through the SDK, and each card it publishes appears here.";
  return `<div class="empty-start">
    <p>${escaped(why)}</p>
    <div class="connect-actions">
      <a class="button button-primary" href="/docs/quickstart">Publish your first card through the SDK</a>
      ${wooAvailable ? `<a class="button button-secondary" href="${escaped(viewer.base)}/woocommerce">Connect a WooCommerce shop</a>` : ""}
    </div>
  </div>`;
};

/**
 * The integration the merchant sells through, and their cards that are off
 * sale because the other one published them.
 */
export interface CardsIntegration {
  readonly through: Integration;
  readonly offSale: readonly string[];
}

const ALL_THROUGH_THE_CODE: CardsIntegration = { through: "api", offSale: [] };

export const cardsScreen = (
  viewer: Viewer,
  cards: MerchantCardList,
  origin: string,
  wooAvailable = false,
  integration: CardsIntegration = ALL_THROUGH_THE_CODE,
): string => {
  const { base } = viewer;
  const paused = cards.cards.filter((entry) => entry.paused).length;
  // "Departed" is not folded into "stopped": that would offer a merchant who
  // has left a button back on sale and a note saying accepted orders are
  // playing out, when leaving closed those orders and left refunds owed
  // (`selling.ts` explains).
  const gone = cards.selling === "departed";
  const stopped = cards.selling === "paused";
  const door = readinessSeenBy(viewer);

  const rows = cards.cards.map(
    (entry): Row => ({
      ...(entry.selling === "open" ? {} : { mark: "off" }),
      cells: [
        {
          html: `<div class="title">${escaped(entry.card.title)}</div><div class="under">${cardAside(entry)}</div><div class="buy">${wrappable(buyingAddress(origin, entry))}</div>`,
        },
        { kind: "key", html: escaped(entry.card.merchant_item_id) },
        { kind: "amount", html: escaped(money(entry.card.price)) },
        { kind: "quiet", html: escaped(FULFILLMENT_WORDS[entry.card.fulfillment]) },
        { html: state(SELLING_WORDS[entry.selling]) },
        { kind: "control", html: cardControl(base, entry, cards.selling, door, integration) },
      ],
    }),
  );

  const body = `
  <div class="lede">
    <div>
      <h1>Product cards</h1>
      <div class="stat-pills">
        <span class="stat-pill">Published <b>${cards.cards.length}</b></span>
        <span class="stat-pill">Paused by you <b>${paused}</b></span>
      </div>
    </div>
    <div class="actions">
      ${
        gone
          ? ""
          : `<form class="inline" method="post" action="${escaped(base)}/selling/${stopped ? "resume" : "pause"}">
        <button class="button ${stopped ? "button-primary" : "button-secondary"}" type="submit">${stopped ? RESUME_ALL_SELLING : STOP_ALL_SELLING}</button>
      </form>`
      }
    </div>
  </div>
${
  cards.cards.length === 0
    ? emptyCatalogue(viewer, wooAvailable)
    : table(["Product", "Product code", "Price", "Delivery", "State", ""], rows, "")
}
  <p class="note">${escaped(sellingNote(cards.selling))}${sellingRest(cards.selling)}</p>
  <p class="note">${escaped(
    // Text, not a link: asking for this address without paying is answered with
    // a payment demand in a header, so a browser shows a blank page and the
    // card looks broken.
    "The line under each product is the address an agent buys it at. It is meant for an agent or a" +
      " test from a terminal: without payment it returns a payment request, not a web page. A card" +
      " that is off sale cannot be bought there.",
  )}</p>
`;

  return framed({ viewer, tab: "cards", title: "Product cards", selling: cards.selling, body });
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

const sellingRest = (selling: MerchantCardList["selling"]): string =>
  selling === "departed"
    ? restOf("/docs/faq#can-i-leave-altogether", "What leaving settles and what it does not")
    : restOf("/docs/faq#can-i-pause-the-selling", "What a pause does to the orders you have");

export const ordersScreen = (
  viewer: Viewer,
  cards: MerchantCardList,
  orders: OrderList,
  open: boolean,
  owed: Readonly<Record<string, RefundCause>> = {},
): string => {
  const { base } = viewer;
  const titles = new Map(
    cards.cards.map((entry) => [entry.card.merchant_item_id, entry.card.title]),
  );
  const wanting = orders.orders.filter((order) => needsAttention(order.status));

  const rows = orders.orders.map(
    (order): Row => ({
      ...(needsAttention(order.status) ? { mark: "needs-you" } : {}),
      cells: [
        { kind: "ident", html: escaped(order.id) },
        {
          html: `<div>${escaped(titles.get(order.merchant_item_id) ?? order.merchant_item_id)}</div><div class="under mono">${escaped(order.merchant_item_id)}</div>`,
        },
        { kind: "amount", html: `${escaped(money(order.price))}${sum(order.test)}` },
        { html: state(ORDER_WORDS[order.status]) },
        momentCell(order.price.at),
      ],
    }),
  );

  const body = `
  <div class="lede">
    <div>
      <h1>Orders</h1>
      ${orders.orders.length === 0 ? "" : `<p>${escaped(ordersLede(orders, open))}</p>`}
      ${testOrders(orders)}
    </div>
    <div class="filter">
      ${open ? '<span class="here">Open</span>' : `<a href="${escaped(base)}/orders?open=true">Open</a>`}
      ${open ? `<a href="${escaped(base)}/orders">All</a>` : '<span class="here">All</span>'}
    </div>
  </div>
${table(
  // "Price set", not "Bought": the moment is when the price was fixed, and
  // where the price is checked at purchase the buyer may pay well after it.
  ["Order", "Product", "Amount", "State", "Price set"],
  rows,
  open
    ? "Nothing is open: no order is owed goods or money. A purchase still at its price question or waiting to be paid is not listed here; All shows it."
    : "No orders yet.",
)}
  <p class="note">${escaped(
    "Purchases that closed before they had a price do not appear here: for example, you said the product was out of stock, or you did not answer a price request. No money was charged for them.",
  )}</p>
${wanting
  .map(
    (order) => `  <div class="callout">
    <div class="what">Order <span class="mono">${escaped(order.id)}</span> ${escaped(ORDER_WORDS[order.status].text)}</div>
    <div class="why">${escaped(whyItNeedsYou(order.status, owed[order.id]))}${whereTheRestIs(order.status)}</div>
  </div>
`,
  )
  .join("")}`;

  return framed({ viewer, tab: "orders", title: "Orders", selling: cards.selling, body });
};

/**
 * Counts only what it can stand behind. "Open" is the gateway's filter; "needs
 * you" is `NEEDS_ATTENTION`, and the sentence is scoped to those two endings
 * rather than to owing in general: an order merely under way may already be
 * money taken against goods not sent. What each order needs is said per order
 * in the callouts below.
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
 * A refund is a thing to go and do, and the sentence above says all of it. Held
 * goods are not: what can still happen is a payment somebody else makes, and
 * the portal says what settles it.
 */
const whereTheRestIs = (status: OrderList["orders"][number]["status"]): string =>
  status === "refund_due"
    ? ""
    : restOf(
        "/docs/orders#you-delivered-and-the-payment-did-not-execute",
        "What can still happen to it",
      );

/**
 * The transfer behind a receipt, as the payment layer named it: a link to the
 * chain's page for it where this deployment has one and the name is a
 * transaction hash, the name as written otherwise. Written out whole, because
 * a shortened hash is a different string to whoever pastes it. A receipt
 * without one says only that this receipt does not carry it, not that there
 * was no transfer: older receipts and payments an operator recorded by hand
 * had one all the same.
 */
const transferCell = (transaction: string | undefined, page: string | null): Cell => {
  if (transaction === undefined) {
    return { kind: "quiet", html: "Not on this receipt" };
  }
  return page !== null && /^0x[0-9a-fA-F]{64}$/.test(transaction)
    ? {
        kind: "ident",
        html: `<a href="${escaped(`${page}${transaction}`)}" rel="noreferrer">${escaped(transaction)}</a>`,
      }
    : { kind: "ident", html: escaped(transaction) };
};

export const receiptsScreen = (
  viewer: Viewer,
  cards: MerchantCardList,
  receipts: ReceiptList,
  transactionPage: string | null = null,
): string => {
  const titles = new Map(cards.cards.map((entry) => [entry.id, entry.card.title]));
  // A shipped parcel is a sale as much as goods handed over: the money is the
  // merchant's and the receipt is written. The tile says both words, because a
  // parcel with a carrier has not been delivered.
  const delivered = receipts.receipts.filter(
    (receipt) => receipt.outcome === "delivered" || receipt.outcome === "shipped",
  ).length;

  const rows = receipts.receipts.map(
    (receipt): Row => ({
      ...(receipt.outcome === "refund_due" ? { mark: "needs-you" } : {}),
      cells: [
        { kind: "ident", html: escaped(receipt.id) },
        { kind: "ident", html: escaped(receipt.order_id) },
        { html: escaped(titles.get(receipt.item_id) ?? receipt.item_id) },
        { kind: "amount", html: `${escaped(money(receipt.price))}${sum(receipt.test)}` },
        { html: state(ORDER_WORDS[receipt.outcome]) },
        momentCell(receipt.paid_at),
        momentCell(receipt.price.at),
        momentCell(receipt.price.as_of),
        transferCell(receipt.transaction, transactionPage),
      ],
    }),
  );

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
           looks for money they are owed. What cannot be counted here is said in
           words above the table instead, with the place it can be counted. -->
      <div class="label">Delivered or shipped</div>
      <div class="figure${delivered === 0 ? "" : " ok"}">${delivered}</div>
      <div class="aside">of ${countOf(receipts.receipts.length, "receipt")}</div>
    </div>
  </div>
  <div class="summary-text">
    <p>A receipt appears when the product is released to the buyer, or a parcel is handed to a carrier. It shows the amount and three times. Paid is when the payment went through. Price set is when Agentify fixed the price for this sale. Price as of is when that price was true: the moment your price check said it held from, or, for a card sold at its own price, when the card was published with it. When the price is checked at the purchase, these times can be minutes apart.${restOf(
      "/docs/money#what-proves-a-sale-happened",
      "What a receipt records, and which moment each column is",
    )}</p>
    <p>This page does not show all of your money. Payments for products not yet delivered and refunds you owe are on Orders. A purchase that was never paid leaves no receipt, and no receipt appears while it is unknown whether the buyer was charged.</p>
  </div>
${table(
  [
    "Receipt",
    "Order",
    "Product",
    "Amount",
    "Outcome",
    "Paid",
    "Price set",
    "Price as of",
    "Transfer",
  ],
  rows,
  "No receipts yet. One appears when a product is released to the buyer.",
)}
`;

  return framed({ viewer, tab: "receipts", title: "Receipts", selling: cards.selling, body });
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
 * An unmarked receipt for a test purchase is proof of a payment that never
 * happened, so every test sum carries the mark.
 */
const sum = (test: boolean): string => (test ? ' <span class="tag">test</span>' : "");

/**
 * A mark per row tells two rows apart but does not stop a merchant reading a
 * page of them as takings, so when every row is a test the page says so once.
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

/**
 * In the dashboard's own frame: the person is still in their dashboard, and the
 * logo and the one button lead back to the cards.
 */
export const notFoundScreen = (viewer: Viewer): string =>
  page({
    mode: viewer.mode,
    base: viewer.base,
    who: viewer.who,
    confirmed: viewer.confirmed,
    tab: null,
    title: "There is no such page",
    home: `${viewer.base}/cards`,
    body: `
  <div class="lede">
    <div>
      <h1>There is no such page</h1>
      <p>The link may have a typo or be out of date. Every section of your dashboard is in the menu.</p>
    </div>
  </div>
  <div class="connect-actions">
    <a class="button button-primary" href="${escaped(viewer.base)}/cards">Back to the dashboard</a>
  </div>
`,
  });

/**
 * Nothing the form sent was done. It says the page could not be matched rather
 * than that it was drawn for somebody else, because an old tab pressed by its
 * own owner gets this too. It names the address signed in now, never the one
 * the form claimed, and is a bare page because the person now signed in may own
 * no merchant.
 */
export const notDrawnForYouScreen = (
  base: string,
  mode: SurfaceMode,
  who: string,
  start: string,
): string =>
  bare(
    base,
    "Nothing was changed",
    `<div class="gate">
${brandLockup("/")}
<div class="gate-card">
  <h1>Nothing was changed</h1>
  <p>What you pressed was not done, because the page it came from could not be matched to the address signed in on this browser now, <strong>${escaped(who)}</strong>. Open the screen again to make the change as this address.</p>
  <a class="button button-primary" href="${escaped(start)}">Continue</a>
</div>
</div>`,
    mode,
    null,
  );
