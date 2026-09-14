/** Independent market observations, not Agentify results or x402 transaction volume. */
export const AGENTIC_SHOP_RESEARCH = {
  sourceUrl:
    "https://business.adobe.com/blog/ai-traffic-surge-retail-sites-not-machine-readable",
  publisher: "Adobe Digital Insights",
  publishedAt: "2026-04-16",
  checkedAt: "2026-09-09",
  traffic: {
    geography: "U.S. retail",
    period: "Q1 2026 vs Q1 2025",
    growthPercent: 393,
    baselineIndex: 100,
    comparisonIndex: 493,
  },
  conversion: {
    geography: "U.S. retail",
    period: "March 2026",
    relativeLiftPercent: 42,
    comparison: "AI-referred visits vs non-AI visits",
  },
} as const;
