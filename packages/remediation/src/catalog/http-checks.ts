export type HttpRemediationCatalogEntry = Readonly<{
  labelCode: string;
  desiredState: string;
  verification: string;
  standard: string;
}>;

export const HTTP_CHECK_CATALOG: Readonly<
  Record<string, HttpRemediationCatalogEntry>
> = {
  "1": {
    labelCode: "robots",
    desiredState:
      "A parseable /robots.txt states the intended public crawler policy and declares the canonical sitemap.",
    verification:
      "Fetch /robots.txt as text, parse every applicable group, then re-run canonical check 1.",
    standard: "https://www.rfc-editor.org/rfc/rfc9309",
  },
  "2": {
    labelCode: "ai_policy",
    desiredState:
      "robots.txt explicitly allows or disallows every supported AI crawler group without contradictory rules.",
    verification:
      "Evaluate the effective rule for each documented AI crawler and re-run canonical check 2.",
    standard: "https://developers.openai.com/api/docs/bots",
  },
  "3": {
    labelCode: "content_signal",
    desiredState:
      "A parseable Content-Signal declaration reflects the operator's actual search, AI-input, and training policy.",
    verification:
      "Parse the final robots.txt declaration and re-run canonical check 3; do not infer consent from absence.",
    standard: "https://blog.cloudflare.com/content-signals-policy/",
  },
  "4": {
    labelCode: "sitemap",
    desiredState:
      "A public sitemap contains canonical, indexable URLs and is declared in robots.txt or the standard location.",
    verification:
      "Validate sitemap XML, indexes, same-site locations, and representative entries, then re-run check 4.",
    standard: "https://www.sitemaps.org/protocol.html",
  },
  "5": {
    labelCode: "json_ld_presence",
    desiredState:
      "Initial HTML contains valid JSON-LD for the same public entities and facts shown on the page.",
    verification:
      "Parse every application/ld+json block from the raw HTML and re-run canonical check 5.",
    standard: "https://schema.org/docs/gs.html",
  },
  "6": {
    labelCode: "vertical_json_ld",
    desiredState:
      "The appropriate Product, LocalBusiness, Article, Organization, or WebSite node contains the required public fields for this segment.",
    verification:
      "Validate the selected node and compare its values with the visible source facts before re-running check 6.",
    standard:
      "https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data",
  },
  "7": {
    labelCode: "markdown_negotiation",
    desiredState:
      "Accept: text/markdown returns a non-empty, fact-equivalent Markdown representation with the correct media type and Vary: Accept.",
    verification:
      "Compare neutral and Markdown requests, media types, Vary behavior, and substantive content, then re-run check 7.",
    standard:
      "https://developer.mozilla.org/docs/Web/HTTP/Guides/Content_negotiation",
  },
  "8": {
    labelCode: "llms_txt",
    desiredState:
      "If the optional llms.txt convention is used, it has a clear heading and links to maintained public sources without claiming model support.",
    verification:
      "Parse /llms.txt as the optional informational surface and re-run check 8.",
    standard: "https://llmstxt.org/",
  },
  "9": {
    labelCode: "mcp_server_card",
    desiredState:
      "Only sites with a real MCP endpoint publish a complete server card, clearly labeled as an experimental discovery convention.",
    verification:
      "Validate the declared JSON fields without invoking tools, then re-run check 9 and keep tool execution out of scope.",
    standard:
      "https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1649",
  },
  "10": {
    labelCode: "ucp_profile",
    desiredState:
      "A store publishes a UCP profile only for production-supported commerce capabilities and keeps it synchronized with real behavior.",
    verification:
      "Validate the public profile schema without calling commerce actions, then re-run check 10.",
    standard: "https://ucp.dev/latest/specification/overview/",
  },
  "11": {
    labelCode: "oauth_discovery",
    desiredState:
      "A declared authenticated agent surface publishes consistent HTTPS OAuth authorization-server and protected-resource metadata.",
    verification:
      "Validate issuer, resource, endpoints, and required fields without authenticating, then re-run check 11.",
    standard: "https://www.rfc-editor.org/rfc/rfc8414",
  },
  "12": {
    labelCode: "raw_html_ssr",
    desiredState:
      "Critical business facts and navigation are present in the initial HTML without requiring JavaScript.",
    verification:
      "Fetch with JavaScript disabled, inspect substantive text and segment facts, then re-run check 12.",
    standard:
      "https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics",
  },
  "13": {
    labelCode: "agent_ua_accessibility",
    desiredState:
      "Declared agent user agents receive the same public, non-challenge facts as a neutral client unless an explicit policy says otherwise.",
    verification:
      "Compare bounded neutral and declared-agent GET responses without bypassing WAF controls, then re-run check 13.",
    standard: "https://www.rfc-editor.org/rfc/rfc9110",
  },
  "14": {
    labelCode: "page_weight_latency",
    desiredState:
      "The public HTML response stays within the documented byte and regional response-time budgets.",
    verification:
      "Measure decoded bytes, TTFB, and total response time from the scanner region, then re-run check 14.",
    standard: "https://web.dev/articles/vitals",
  },
  "15": {
    labelCode: "store_feed_signals",
    desiredState:
      "A store exposes a discoverable, maintained catalog feed with stable identifiers and current price, currency, and availability.",
    verification:
      "Validate the declared feed and compare a sample against the source catalog without checkout, then re-run check 15.",
    standard: "https://developers.openai.com/commerce/specs/feed/",
  },
  "16": {
    labelCode: "platform_fingerprint",
    desiredState:
      "Platform hints remain informational and never substitute for repository or runtime evidence.",
    verification:
      "Confirm the hint against the owned deployment before applying platform-specific remediation.",
    standard: "https://www.rfc-editor.org/rfc/rfc9110",
  },
  "17": {
    labelCode: "a2a_agent_card",
    desiredState:
      "Only sites with a real A2A-compatible agent publish a valid card at the canonical location.",
    verification:
      "Validate the card document without invoking the agent, then re-run informational check 17.",
    standard: "https://a2a-protocol.org/latest/specification/",
  },
  "18": {
    labelCode: "hreflang_locales",
    desiredState:
      "Equivalent locale pages use valid language or market codes and reciprocal hreflang declarations.",
    verification:
      "Validate locale codes, canonicals, and reciprocal declarations, then re-run check 18.",
    standard:
      "https://developers.google.com/search/docs/specialty/international/localized-versions",
  },
};
