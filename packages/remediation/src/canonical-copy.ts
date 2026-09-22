const CHECK_LABELS: Readonly<Record<string, string>> = {
  robots: "robots.txt availability",
  ai_policy: "AI crawler policy",
  content_signal: "Content-Signal policy",
  sitemap: "Sitemap",
  json_ld_presence: "Structured data availability",
  vertical_json_ld: "Business-specific structured data",
  markdown_negotiation: "Markdown content negotiation",
  llms_txt: "llms.txt",
  mcp_server_card: "MCP server card",
  ucp_profile: "UCP profile",
  oauth_discovery: "OAuth discovery metadata",
  raw_html_ssr: "Server-rendered content",
  agent_ua_accessibility: "Agent user-agent access",
  page_weight_latency: "Page weight and response time",
  store_feed_signals: "Product feed discovery",
  platform_fingerprint: "Platform fingerprint",
  a2a_agent_card: "A2A agent card",
  hreflang_locales: "Language alternatives",
};

const SUMMARY_COPY: Readonly<Record<string, string>> = {
  a2a_absent:
    "No A2A agent card was found. This optional signal does not reduce the core readiness score.",
  a2a_malformed: "An A2A agent card was found, but it is not valid enough to use reliably.",
  a2a_noncanonical_or_malformed:
    "An A2A declaration was found outside the canonical location or could not be parsed reliably.",
  a2a_unavailable: "The A2A agent-card surface could not be assessed during this scan.",
  a2a_valid: "A valid A2A agent card was found at the canonical public location.",
  agent_ua_blocked:
    "The site served a blocked or unusable response to the declared Agentify user agent.",
  agent_ua_compatible:
    "The site remained publicly readable when requested with the declared Agentify user agent.",
  agent_ua_neutral_unavailable: "The neutral comparison request could not be assessed.",
  agent_ua_partial: "Only part of the agent user-agent comparison remained publicly readable.",
  agent_ua_probe_unavailable: "The agent user-agent request could not be assessed.",
  ai_policy_absent: "robots.txt does not state a clear policy for the supported AI crawler groups.",
  ai_policy_explicit: "robots.txt states an explicit policy for every supported AI crawler group.",
  ai_policy_partial:
    "robots.txt states a policy for some, but not all, supported AI crawler groups.",
  ai_policy_unavailable:
    "The AI crawler policy could not be assessed because robots.txt was unavailable.",
  content_signal_absent: "No parseable Content-Signal policy was found in robots.txt.",
  content_signal_parseable: "A parseable Content-Signal policy was found in robots.txt.",
  content_signal_partial:
    "A Content-Signal declaration was found, but it is incomplete or inconsistent.",
  content_signal_unavailable:
    "The Content-Signal policy could not be assessed because robots.txt was unavailable.",
  feed_discoverable: "A public product-feed declaration was found and could be read.",
  feed_machine_signals_only:
    "Product-like machine-readable signals exist, but no public feed declaration was found.",
  feed_not_store: "Product-feed discovery does not apply to this scan segment.",
  feed_signals_absent:
    "No public product-feed declaration or equivalent machine-readable catalog signal was found.",
  feed_unavailable: "Product-feed discovery could not be assessed during this scan.",
  fingerprint_observed:
    "The detected platform hint is informational and does not affect the score.",
  hreflang_partial:
    "Language-alternative declarations were found, but they are incomplete or inconsistent.",
  hreflang_single_locale:
    "No language alternatives were detected, so hreflang is not required for this scan.",
  hreflang_unavailable: "Language-alternative declarations could not be assessed.",
  hreflang_valid: "Language-alternative declarations are present and internally consistent.",
  jsonld_absent_or_invalid: "No valid JSON-LD structured data was found in the initial HTML.",
  jsonld_partially_parseable:
    "JSON-LD is present, but at least one block could not be parsed reliably.",
  jsonld_present: "Valid JSON-LD structured data was found in the initial HTML.",
  jsonld_unavailable:
    "Structured data could not be assessed because the page response was unavailable.",
  llms_absent: "No llms.txt file was found. This optional signal has limited ecosystem adoption.",
  llms_malformed:
    "llms.txt exists, but it does not contain the minimal expected heading and links.",
  llms_unavailable: "llms.txt could not be assessed during this scan.",
  llms_valid: "llms.txt is present and has the minimal expected structure.",
  markdown_negotiation_absent:
    "The page did not provide a Markdown representation through HTTP content negotiation.",
  markdown_negotiation_partial:
    "A Markdown response was returned, but the negotiation contract or content is incomplete.",
  markdown_negotiation_valid:
    "The page provides a usable Markdown representation through HTTP content negotiation.",
  markdown_unavailable: "Markdown content negotiation could not be assessed.",
  mcp_absent:
    "No public MCP server-card declaration was found at the experimental discovery location.",
  mcp_card_incomplete:
    "An MCP server card was found, but required discovery fields are missing or invalid.",
  mcp_card_valid:
    "A usable MCP server card was found at the experimental public discovery location.",
  mcp_unavailable: "The MCP server-card surface could not be assessed.",
  oauth_metadata_absent:
    "The site declares an authenticated agent surface, but no OAuth authorization-server metadata was found.",
  oauth_metadata_partial: "OAuth discovery metadata was found, but required fields are incomplete.",
  oauth_metadata_valid:
    "OAuth discovery metadata is present and contains the required public fields.",
  oauth_not_declared:
    "No authenticated agent surface was declared, so OAuth discovery is not applicable.",
  oauth_unavailable: "OAuth discovery metadata could not be assessed.",
  page_performance_limit_exceeded:
    "The public page exceeded the scanner's safe response-size or timing limit.",
  page_performance_partial:
    "The public page is readable, but either transfer size or response time is above the preferred budget.",
  page_performance_slow_heavy: "The public page is both heavy and slow for an automated reader.",
  page_performance_unavailable: "Page weight and response time could not be assessed.",
  page_performance_within_budget:
    "The public page stayed within the documented response-size and timing budgets.",
  robots_invalid: "robots.txt was found, but it could not be parsed reliably.",
  robots_missing: "No robots.txt file was found at the standard public location.",
  robots_parseable: "robots.txt is present and parseable.",
  robots_partially_parseable:
    "robots.txt is present, but some directives are malformed or ambiguous.",
  robots_unavailable: "robots.txt could not be assessed during this scan.",
  sitemap_invalid:
    "A sitemap was found, but its format or entries could not be validated reliably.",
  sitemap_missing:
    "No public sitemap could be discovered from robots.txt or the standard location.",
  sitemap_partial: "A sitemap was found, but part of the sitemap set is incomplete or invalid.",
  sitemap_unavailable: "Sitemap discovery could not be assessed.",
  sitemap_valid: "A valid public sitemap was discovered.",
  ssr_content_substantive:
    "The initial HTML contains enough substantive public content for a non-JavaScript reader.",
  ssr_content_thin: "The initial HTML contains only a small amount of substantive public content.",
  ssr_shell_only:
    "The initial HTML is mostly an application shell and depends on JavaScript for the core content.",
  ssr_unavailable: "The initial HTML response could not be assessed.",
  ucp_absent: "No public UCP commerce profile was found for this store scan.",
  ucp_incomplete:
    "A UCP commerce profile was found, but required fields are incomplete or invalid.",
  ucp_not_store: "UCP commerce discovery does not apply to this scan segment.",
  ucp_unavailable: "The UCP commerce profile could not be assessed.",
  ucp_valid: "A usable public UCP commerce profile was found.",
  vertical_jsonld_complete:
    "The structured data contains the key public fields expected for this business segment.",
  vertical_jsonld_incomplete:
    "Business-specific structured data is present, but important public fields are missing.",
  vertical_jsonld_missing:
    "No business-specific structured-data type was found for this scan segment.",
  vertical_jsonld_unavailable: "Business-specific structured data could not be assessed.",
  vertical_jsonld_wrong_type:
    "Structured data exists, but it does not describe the business type expected for this scan segment.",
};

const FINDING_HEADLINE_COPY: Readonly<Record<string, string>> = {
  a2a_malformed: "Your declared A2A card cannot be used reliably",
  a2a_noncanonical_or_malformed: "Your A2A declaration is misplaced or unreadable",
  agent_ua_blocked: "Your site blocks a declared automated reader",
  agent_ua_partial: "Agents receive only part of your public content",
  ai_policy_absent: "Supported AI crawler groups have no clear robots.txt policy",
  ai_policy_partial: "Some supported AI crawler groups have no clear policy",
  content_signal_absent: "No Content-Signal policy is declared",
  content_signal_partial: "The Content-Signal declaration is incomplete or inconsistent",
  feed_machine_signals_only: "Product signals exist, but no public feed declaration was found",
  feed_signals_absent: "No feed declaration or equivalent catalog signal was found",
  hreflang_partial: "Your language alternatives point inconsistently",
  jsonld_absent_or_invalid: "No readable JSON-LD structured data was found",
  jsonld_partially_parseable: "Part of your structured data cannot be read reliably",
  llms_malformed: "Your llms.txt file cannot guide automated readers reliably",
  markdown_negotiation_absent: "No alternate machine-readable Markdown view was found",
  markdown_negotiation_partial: "Your machine-readable text view is incomplete",
  mcp_absent: "No MCP declaration was found at the assessed locations",
  mcp_card_incomplete: "Your MCP discovery card cannot be used reliably",
  oauth_metadata_absent: "Your declared agent surface has no discoverable authorization setup",
  oauth_metadata_partial: "Your authorization discovery metadata is incomplete",
  page_performance_limit_exceeded: "The page exceeds the scanner's safe response budget",
  page_performance_partial: "Page weight or response time raises agent cost",
  page_performance_slow_heavy: "A slow, heavy page increases automated-reader timeout risk",
  robots_invalid: "Your crawler rules cannot be interpreted reliably",
  robots_missing: "Crawler access rules are missing at the standard location",
  robots_partially_parseable: "Part of your crawler policy is malformed or ambiguous",
  sitemap_invalid: "Your sitemap cannot be used reliably",
  sitemap_missing: "No sitemap was found in robots.txt or the standard location",
  sitemap_partial: "Your sitemap can lead crawlers to incomplete entries",
  ssr_content_thin: "Your initial HTML gives automated readers too little to work with",
  ssr_shell_only: "Your core content is unavailable until JavaScript runs",
  ucp_absent: "No public UCP commerce profile is declared",
  ucp_incomplete: "Your UCP commerce profile is incomplete",
  vertical_jsonld_incomplete: "Business-specific structured data is missing key public facts",
  vertical_jsonld_missing: "No segment-specific structured-data type was found",
  vertical_jsonld_wrong_type: "Your structured data describes the wrong kind of business",
};

const IMPACT_COPY: Readonly<Record<string, string>> = {
  a2a_informational:
    "A2A metadata matters only when the site intentionally exposes an A2A-compatible agent.",
  a2a_not_assessed: "No conclusion can be drawn about the optional A2A surface from this scan.",
  a2a_optional:
    "A2A is optional for ordinary websites and should not be added unless a real agent endpoint exists.",
  agent_ua_accessibility:
    "An agent-specific block can hide otherwise public facts from automated readers.",
  agent_ua_not_assessed: "The scan could not compare neutral and declared-agent access reliably.",
  ai_policy_ambiguity:
    "Ambiguous crawler policy makes permitted use unclear to site operators and compliant crawlers.",
  ai_policy_not_assessed:
    "The scan could not determine whether AI crawler access is explicitly declared.",
  content_signal_ambiguity:
    "An absent or incomplete content-use signal leaves machine-readable reuse preferences unclear.",
  content_signal_explicit:
    "A parseable policy makes content-use preferences explicit without relying on inference.",
  content_signal_not_assessed: "The content-use policy could not be evaluated.",
  feed_machine_discovery:
    "A public feed helps commerce agents find current catalog data more reliably than page scraping.",
  feed_machine_discovery_gap:
    "Without a discoverable feed, agents may depend on incomplete or stale page extraction.",
  feed_not_assessed: "The scan could not determine whether a public catalog feed is available.",
  feed_store_only: "Product feeds are evaluated only for store scans.",
  fingerprint_informational:
    "The platform hint only helps tailor remediation; it is not evidence of readiness by itself.",
  hreflang_conditional:
    "Language alternatives matter only when the site publishes equivalent content for multiple locales.",
  hreflang_not_assessed:
    "The scan could not determine whether language alternatives are declared correctly.",
  llms_informational:
    "llms.txt is an optional convention and should not be treated as proof of model visibility.",
  llms_not_assessed: "The optional llms.txt surface could not be evaluated.",
  llms_optional: "Missing llms.txt is not a critical defect because adoption remains limited.",
  locale_discovery:
    "Consistent locale metadata helps automated readers choose the correct language or market version.",
  markdown_absent:
    "Without a negotiated Markdown view, agents must parse the regular HTML representation.",
  markdown_available:
    "A concise Markdown representation can reduce parsing cost while preserving the same public facts.",
  markdown_incomplete:
    "An incomplete negotiation contract can serve the wrong media type or omit important content.",
  markdown_not_assessed:
    "The scan could not determine whether a negotiated Markdown view is available.",
  mcp_callable_gap:
    "No callable capability can be inferred safely without an explicit, valid discovery document.",
  mcp_callable_readiness:
    "A server card can advertise a real MCP endpoint, but it does not prove tool correctness or authorization safety.",
  mcp_not_assessed: "The experimental MCP discovery surface could not be evaluated.",
  oauth_conditional:
    "OAuth metadata is required only when the declared agent surface needs delegated user authorization.",
  oauth_discovery:
    "Valid discovery metadata lets clients configure delegated authorization without guessing endpoints.",
  oauth_discovery_gap:
    "Authenticated agent tools cannot be configured safely when authorization metadata is missing or incomplete.",
  oauth_not_assessed: "The scan could not validate the public authorization metadata.",
  page_performance_agent_cost:
    "Heavy or slow pages increase agent latency, tokenization cost, and timeout risk.",
  page_performance_not_assessed:
    "The scan did not obtain reliable transfer-size and response-time evidence.",
  robots_invalid_impact:
    "Malformed directives can be interpreted differently by crawlers and make access policy unreliable.",
  robots_missing_impact:
    "Without robots.txt, the site has no standard location for crawler access rules or sitemap discovery.",
  robots_not_assessed: "The scanner could not determine the site's public crawler policy.",
  robots_policy_discoverability:
    "A parseable robots.txt gives compliant crawlers one predictable place to read access rules.",
  sitemap_discovery:
    "A valid sitemap helps automated readers discover important public pages efficiently.",
  sitemap_discovery_gap:
    "Without a usable sitemap, discovery depends on link traversal and may miss important pages.",
  sitemap_not_assessed: "The scan could not determine whether a usable sitemap exists.",
  ssr_machine_readability:
    "Substantive initial HTML keeps critical facts available to non-JavaScript agents and crawlers.",
  ssr_not_assessed:
    "The scan could not determine how much meaningful content is available before JavaScript runs.",
  structured_data_machine_readability:
    "Valid JSON-LD provides explicit entities and fields instead of forcing agents to infer them from layout.",
  structured_data_not_assessed:
    "The scan could not determine whether usable structured data is present.",
  ucp_commerce_gap:
    "A store without a UCP profile is not discoverable through that commerce protocol.",
  ucp_commerce_readiness:
    "A valid UCP profile advertises commerce capabilities but does not prove checkout correctness.",
  ucp_not_assessed: "The scan could not validate the public UCP commerce profile.",
  ucp_store_only: "UCP is evaluated only for store scans.",
  vertical_data_gap:
    "Missing key business fields makes products, services, hours, or contact facts harder to use reliably.",
  vertical_data_machine_readability:
    "Complete business-specific fields reduce ambiguity in agent answers and handoffs.",
};

const FIX_COPY: Readonly<Record<string, string>> = {
  add_markdown_negotiation:
    "Add standards-based HTTP content negotiation for a fact-equivalent Markdown representation.",
  allow_agent_user_agents:
    "Review CDN and WAF rules so the declared scanner user agent can read the same public facts as a neutral client.",
  complete_mcp_card:
    "Complete the MCP server card with valid discovery fields, and label the convention experimental.",
  complete_oauth_metadata:
    "Complete the OAuth authorization-server metadata using the applicable RFC fields and HTTPS endpoints.",
  complete_ucp_profile:
    "Complete the UCP profile with the required public commerce fields and validate it against the current specification.",
  complete_vertical_jsonld:
    "Add the missing business-specific JSON-LD fields using facts already visible and maintained on the site.",
  declare_ai_policy:
    "Declare an explicit allow or disallow policy for each supported AI crawler group in robots.txt.",
  improve_sitemap: "Repair incomplete sitemap entries and keep only canonical, public URLs.",
  publish_content_signal:
    "Publish a valid Content-Signal declaration in robots.txt that reflects the site's actual policy.",
  publish_mcp_card:
    "Publish an MCP server card only if a real public MCP endpoint exists; keep the experimental status explicit.",
  publish_oauth_metadata:
    "Publish OAuth authorization-server metadata for the declared authenticated agent surface.",
  publish_product_feed:
    "Publish and link a current product feed with stable identifiers, price, currency, availability, and update discipline.",
  publish_robots: "Publish a valid robots.txt at the standard root location.",
  publish_sitemap: "Publish a valid sitemap and declare it in robots.txt.",
  publish_ucp_profile:
    "Publish a UCP profile only for real supported commerce capabilities and keep it synchronized with production behavior.",
  publish_valid_jsonld:
    "Add valid JSON-LD that describes the same public entities and facts shown on the page.",
  publish_vertical_jsonld:
    "Add the appropriate business-specific JSON-LD type and its key public fields.",
  reduce_page_weight_latency:
    "Reduce public response time and transfer size without hiding critical facts behind client-only rendering.",
  render_substantive_html:
    "Render the core public facts in the initial HTML and preserve progressive enhancement.",
  repair_a2a_card:
    "Repair the A2A agent card only if the site exposes a real A2A-compatible agent endpoint.",
  repair_content_signal:
    "Make the Content-Signal declaration parseable, complete, and consistent with the site's policy.",
  repair_hreflang:
    "Repair locale codes and reciprocal hreflang links across equivalent language or market pages.",
  repair_llms:
    "Give llms.txt a minimal valid heading and links, while keeping the same public facts as the website.",
  repair_markdown_negotiation:
    "Return the correct Markdown media type, Vary header, and fact-equivalent content for negotiated requests.",
  repair_robots:
    "Repair malformed robots.txt directives and validate the final crawler groups and sitemap declarations.",
  repair_sitemap:
    "Repair the sitemap format and remove invalid, private, redirected, or non-canonical entries.",
};

const FALLBACK_ACRONYMS: Readonly<Record<string, string>> = {
  a2a: "A2A",
  ai: "AI",
  api: "API",
  html: "HTML",
  hreflang: "hreflang",
  jsonld: "JSON-LD",
  llms: "llms.txt",
  mcp: "MCP",
  oauth: "OAuth",
  robots: "robots.txt",
  ssr: "SSR",
  ua: "user agent",
  ucp: "UCP",
};

function fallback(value: string): string {
  const words = value
    .replaceAll(":", "_")
    .split("_")
    .filter(Boolean)
    .map((word) => FALLBACK_ACRONYMS[word.toLowerCase()] ?? word.toLowerCase());
  if (words.length === 0) return "No public summary is available.";
  const text = words.join(" ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

export function canonicalCheckLabel(labelCode: string): string {
  return CHECK_LABELS[labelCode] ?? fallback(labelCode).replace(/\.$/, "");
}

export function canonicalSummaryCopy(code: string | null | undefined): string {
  if (!code) return "No public evidence summary is available.";
  return SUMMARY_COPY[code] ?? fallback(code);
}

export function canonicalFindingHeadline(code: string | null | undefined): string {
  if (!code) return "A public signal needs attention";
  return FINDING_HEADLINE_COPY[code] ?? canonicalSummaryCopy(code);
}

export function canonicalImpactCopy(code: string | null | undefined): string {
  if (!code) return "See the methodology for the scope and limits of this check.";
  return IMPACT_COPY[code] ?? fallback(code);
}

export function canonicalFixCopy(code: string | null | undefined): string {
  if (!code) return "No change is recommended from this result alone.";
  return FIX_COPY[code] ?? fallback(code);
}
