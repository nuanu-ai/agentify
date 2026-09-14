export const EVIDENCE_CLASSES = ["FACT", "HYP", "ANECDOTE"] as const;

export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

export type Source = Readonly<{
  id: string;
  title: string;
  publisher: string;
  publishedAt: string;
  url: `https://${string}`;
  evidenceClass: EvidenceClass;
  caveat: string;
}>;

export const SOURCES = {
  adobeRetailAiTraffic: {
    id: "adobe-retail-ai-traffic-2025",
    title: "Generative AI-powered shopping rises with traffic to retail sites",
    publisher: "Adobe Digital Insights",
    publishedAt: "2025-08-21",
    url: "https://business.adobe.com/blog/generative-ai-powered-shopping-rises-with-traffic-to-retail-sites",
    evidenceClass: "FACT",
    caveat:
      "Adobe Analytics retail data and a US consumer survey; not evidence about every store.",
  },
  squarespaceOwnerStudy: {
    id: "squarespace-ai-search-business-owners-2026",
    title: "AI search for business owners",
    publisher: "Squarespace",
    publishedAt: "2026-06-17",
    url: "https://www.squarespace.com/blog/ai-search-for-business-owners",
    evidenceClass: "FACT",
    caveat: "Vendor-commissioned survey of 1,041 US small-business owners.",
  },
  pewAiSummaryClicks: {
    id: "pew-ai-summary-clicks-2025",
    title:
      "Google users are less likely to click on links when an AI summary appears",
    publisher: "Pew Research Center",
    publishedAt: "2025-07-22",
    url: "https://www.pewresearch.org/short-reads/2025/07/22/google-users-are-less-likely-to-click-on-links-when-an-ai-summary-appears-in-the-results/",
    evidenceClass: "FACT",
    caveat:
      "Observed Google browsing behavior; it does not measure agent transactions.",
  },
  metorikWooBenchmarks: {
    id: "metorik-woo-statistics-2026",
    title: "WooCommerce statistics and benchmarks",
    publisher: "Metorik",
    publishedAt: "2026-01-01",
    url: "https://metorik.com/woocommerce-statistics",
    evidenceClass: "FACT",
    caveat:
      "An anonymized Metorik dataset; participating stores may differ from all Woo stores.",
  },
  opentableOwnerExample: {
    id: "restaurant-owner-booking-fee-example-2026",
    title: "OpenTable takes $1 for every Google referral",
    publisher: "Reddit r/restaurantowners",
    publishedAt: "2026-03-16",
    url: "https://www.reddit.com/r/restaurantowners/comments/1rvlbc2/opentable_takes_1_for_every_google_referral/",
    evidenceClass: "ANECDOTE",
    caveat:
      "A single owner-reported example, not a market-average fee estimate.",
  },
} as const satisfies Record<string, Source>;

export type SourceId = (typeof SOURCES)[keyof typeof SOURCES]["id"];

const sourcesById = new Map<SourceId, Source>(
  Object.values(SOURCES).map((source) => [source.id, source]),
);

export function getSource(sourceId: SourceId): Source {
  const source = sourcesById.get(sourceId);
  if (!source) throw new Error(`Unknown source id: ${sourceId}`);
  return source;
}
