import type { BrowserObservationId } from "@agentify/scanner-contracts";

export type RemediationCatalogEntry = {
  desiredState: string;
  verification: string;
  standard: string;
};

export const BROWSER_REMEDIATION_CATALOG: Record<
  BrowserObservationId,
  RemediationCatalogEntry
> = {
  rendered_content_delta: {
    desiredState:
      "Critical public facts are present in initial HTML as well as the rendered DOM.",
    verification:
      "Fetch the page without JavaScript and compare the main facts with a browser render.",
    standard:
      "https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics",
  },
  accessibility_structure: {
    desiredState:
      "The rendered page has one clear main landmark, ordered headings, and named controls.",
    verification:
      "Run an accessibility tree/axe check and resolve unnamed interactive controls.",
    standard:
      "https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/",
  },
  form_semantics: {
    desiredState:
      "Every public form control has a programmatic label and stable name, with autocomplete declared for identity-like fields.",
    verification:
      "Inspect the rendered form with keyboard and accessibility tooling without submitting it.",
    standard: "https://html.spec.whatwg.org/multipage/forms.html",
  },
  webmcp_surface: {
    desiredState:
      "If WebMCP is exposed, tools have stable names/descriptions and do not mutate state without confirmation.",
    verification:
      "Inspect the declared tool surface without invoking any tool.",
    standard: "https://webmachinelearning.github.io/webmcp/",
  },
  browser_console_health: {
    desiredState: "Public pages render without uncaught application errors.",
    verification:
      "Load representative pages in a clean browser context and assert no uncaught runtime errors.",
    standard: "https://developer.mozilla.org/docs/Web/API/Window/error_event",
  },
  browser_network_health: {
    desiredState:
      "Required public resources load over HTTPS without mixed content or systemic failures.",
    verification:
      "Record network failures in a clean page load and repair required resources first.",
    standard: "https://developer.mozilla.org/docs/Web/Security/Mixed_content",
  },
  rendered_metadata_consistency: {
    desiredState:
      "Canonical, hreflang, and structured metadata stay consistent before and after rendering.",
    verification:
      "Compare initial HTML metadata with rendered DOM metadata on representative pages.",
    standard:
      "https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls",
  },
  public_fact_consistency: {
    desiredState:
      "High-confidence visible currency and availability facts agree with the corresponding rendered structured data.",
    verification:
      "Add deterministic tests that compare rendered facts with the matching structured fields.",
    standard: "https://schema.org/",
  },
  session_or_challenge_wall: {
    desiredState:
      "Public informational pages remain readable without login, CAPTCHA bypass, or prior session state.",
    verification:
      "Open the public URL in a fresh browser context and confirm core facts remain accessible.",
    standard: "https://www.rfc-editor.org/rfc/rfc9309",
  },
  hidden_instruction_risk: {
    desiredState:
      "Hidden/off-screen content does not contain instructions aimed at agents or models.",
    verification:
      "Audit visually hidden content and keep only legitimate accessibility or UI text.",
    standard:
      "https://www.w3.org/WAI/WCAG22/Understanding/info-and-relationships.html",
  },
  api_discovery_surface: {
    desiredState:
      "Declared public API descriptions are fetched in an authorized validation step before they are treated as usable.",
    verification:
      "Validate explicitly linked API Catalog/OpenAPI documents without probing undeclared paths.",
    standard: "https://spec.openapis.org/oas/latest.html",
  },
  content_license_surface: {
    desiredState:
      "Machine-readable content licensing is explicit; declared documents are fetched and parsed before they are treated as valid.",
    verification: "Validate declared license/RSL links and their media types.",
    standard: "https://rslstandard.org/",
  },
  representative_page_consistency: {
    desiredState:
      "Representative same-site pages retain a main landmark, heading structure, and substantive public text.",
    verification:
      "Run the same assertions on the homepage and up to two representative public pages.",
    standard: "https://www.sitemaps.org/protocol.html",
  },
  browser_runtime_cost: {
    desiredState:
      "The public page renders within bounded request, byte, script, DOM, and time budgets.",
    verification:
      "Track browser request/byte/DOM budgets in CI and fail only on reviewed regressions.",
    standard: "https://web.dev/articles/vitals",
  },
};
