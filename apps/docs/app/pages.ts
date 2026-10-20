/**
 * Where each page of the documentation is written and what its head says
 * beyond its own heading. The pages and their order are `DOCS_GROUPS` in
 * `@agentify/ui/docs`; every page there has its Markdown here, which the build
 * checks. The merchant pages are read where the portal's tests read them, at
 * the top of this application; the scanner's are under `scanner/`.
 */

import { DOCS_PAGES } from "@agentify/ui/docs";

type PageSource = Readonly<{
  /** The Markdown file, relative to this application's directory. */
  file: string;
  /** The page's own title in the window's bar and a link's card, where it is not its heading. */
  title?: string;
  /** What a search result and a link's card say of the page, where it is not the documentation's. */
  description?: string;
  /**
   * The scanner's pages were the scanner's own before they joined the
   * documentation, and keep what the scanner's pages carry: the site's
   * picture on a link's card and the site's description for a crawler.
   */
  site?: true;
}>;

const SOURCES: Readonly<Record<string, PageSource>> = {
  "/": {
    file: "index.md",
    description:
      "Learn how to sell through Agentify, what your business needs to connect, and how the SDK and the WooCommerce connector differ.",
  },
  "/money": {
    file: "money.md",
    title: "Merchant payments, USDC and payouts",
    description:
      "Understand USDC payments, your payout contract, Agentify's commission, payment timing, receipts and merchant remedies for unfulfilled orders.",
  },
  "/payout": {
    file: "payout.md",
    title: "Sending a payout from your payout contract",
    description:
      "Pay out what has accumulated in your Agentify payout contract, with a Coinbase Wallet or any wallet that can send a transaction with data.",
  },
  "/woocommerce": {
    file: "woocommerce.md",
    title: "WooCommerce connector: importing, parcels and disconnecting",
    description:
      "Connect a WooCommerce shop to Agentify without code: what can be imported, how parcels are shipped and paid for, and what disconnecting does.",
  },
  "/faq": {
    file: "faq.md",
    title: "Questions about selling to AI agents",
    description:
      "Answers for business owners and engineers about connecting to Agentify, costs, product cards, payments, orders and integration limits.",
  },
  "/quickstart": {
    file: "quickstart.md",
    title: "SDK quickstart: your first test sale",
    description:
      "Set up your merchant account, publish a product card with the Agentify SDK, fulfill an order and verify a purchase in the test channel.",
  },
  "/cards": {
    file: "cards.md",
    title: "Product cards: fields, prices and publishing",
    description:
      "Define and publish Agentify product cards: product descriptions, prices, buyer inputs, delivery results, fulfillment modes and updates.",
  },
  "/orders": {
    file: "orders.md",
    description:
      "Handle synchronous and asynchronous Agentify orders, and test parcel fulfillment. Understand order states, deadlines and duplicate handling.",
  },
  "/failures": {
    file: "failures.md",
    title: "Order failures and recovery",
    description:
      "Handle price-check failures, unavailable goods, crashed handlers, delivery timeouts and repeated orders in an Agentify integration.",
  },
  "/scanner": {
    file: "scanner/index.md",
    title: "Scanner identity",
    description:
      "Identity, behavior, safety limits, retention, and opt-out details for agentify-scanner.",
    site: true,
  },
  "/scanner/methodology": {
    file: "scanner/methodology.md",
    title: "Scanner methodology and diagnostic limits",
    description: "How the Agentify public-HTTP agent-readiness diagnostic works and its limits.",
    site: true,
  },
};

/** What the documentation says of itself where a page says nothing of its own. */
export const DOCS_DESCRIPTION =
  "Selling to AI agents with Agentify: connecting, cards, money and what can go wrong.";

/**
 * Where the build writes a page's Markdown beside the page, which is also its
 * address under `/docs`: `/money` as `money.md`, the front page as `index.md`.
 */
export const markdownFileOf = (path: string): string =>
  path === "/" ? "index.md" : `${path.slice(1)}.md`;

/** The address the build draws the page for a missing one at, which Caddy answers with. */
export const NOT_FOUND_PATH = "/404";

/** The search index, written by the build beside the pages. */
export const SEARCH_INDEX_PATH = "/search-index.json";

/** Each page in the order of the contents, with where it is written. */
export const PAGES = DOCS_PAGES.map((page) => {
  const source = SOURCES[page.path];
  if (source === undefined) throw new Error(`the documentation lists ${page.path} unwritten`);
  return { ...page, ...source };
});

for (const path of Object.keys(SOURCES)) {
  if (!PAGES.some((page) => page.path === path)) {
    throw new Error(
      `${SOURCES[path]?.file} is written for ${path}, which the documentation does not list`,
    );
  }
}

export type Page = (typeof PAGES)[number];
