/**
 * The merchant's tariff, on the settings screen, ahead of the backend for it.
 *
 * No price is approved and nothing stores which tariff a merchant is on, so the
 * block is drawn only when SHOWN_TARIFF names one of the six candidates. They
 * are the same six as the landing's pricing section (its `data-tariffs` switch),
 * word for word, so the two pages cannot promise different things. When the
 * backend knows a merchant's tariff, the viewer carries it and this constant
 * goes away.
 */

import { escaped } from "./html.js";

export type TariffId = "t1" | "t2" | "t3" | "t4" | "t5" | "t6";

/** The one switch: which candidate the settings show, or null for none. */
export const SHOWN_TARIFF: TariffId | null = null;

type Tariff = Readonly<{ name: string; price: string; note: string; includes: readonly string[] }>;

const PLATFORM = [
  "Catalog connection through WooCommerce or the SDK",
  "Product cards in the Agentify catalog",
  "Orders and receipts in your dashboard",
  "Payments straight to your wallet",
];

const AGENT_READY = [
  "A review of your store: what keeps AI agents from buying",
  "Fixes for what the review finds",
  "A catalog export for AI agents",
  "Connecting your store to Agentify",
  "A test purchase by our agent, with a report",
];

const TARIFFS: Readonly<Record<TariffId, Tariff>> = {
  t1: {
    name: "Free",
    price: "$0",
    note: "No monthly fee and no commission on sales",
    includes: PLATFORM,
  },
  t2: {
    name: "Pay per order",
    price: "$0 + 1%",
    note: "Free to connect, 1% of every paid order",
    includes: PLATFORM,
  },
  t3: {
    name: "Subscription",
    price: "$29 a month",
    note: "Starts on day one, cancel anytime",
    includes: [
      ...AGENT_READY,
      "Catalog updates",
      "Checks that the sales channel is working",
      "Orders in your dashboard",
    ],
  },
  t4: {
    name: "Getting ready for AI agent marketplaces",
    price: "$49",
    note: "One-time",
    includes: AGENT_READY,
  },
  t5: {
    name: "Getting ready for AI agent marketplaces",
    price: "$99",
    note: "One-time",
    includes: AGENT_READY,
  },
  t6: {
    name: "Getting ready for AI agent marketplaces",
    price: "$149",
    note: "One-time",
    includes: AGENT_READY,
  },
};

/** The settings panel for a tariff, or nothing when none is shown. */
export const tariffBlock = (shown: TariffId | null = SHOWN_TARIFF): string => {
  if (shown === null) return "";
  const tariff = TARIFFS[shown];
  return `
  <div class="lede">
    <div>
      <h2>Your plan</h2>
      <p class="tariff-name"><span>${escaped(tariff.name)}</span> · <b>${escaped(tariff.price)}</b></p>
      <p class="quiet">${escaped(tariff.note)}</p>
    </div>
  </div>
  <ul class="tariff-includes">${tariff.includes.map((line) => `<li>${escaped(line)}</li>`).join("")}</ul>
  <div class="connect-actions tariff-actions">
    <a class="button button-secondary" href="/#pricing">Compare plans</a>
  </div>`;
};
