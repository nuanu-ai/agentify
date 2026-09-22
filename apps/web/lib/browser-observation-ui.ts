import type {
  BrowserObservationFinding,
  BrowserObservationId,
  BrowserObservationStatusResponse,
} from "@agentify/scanner-contracts";

const OBSERVATION_LABELS: Record<BrowserObservationId, string> = {
  rendered_content_delta: "Rendered content availability",
  accessibility_structure: "Accessibility structure",
  form_semantics: "Form semantics",
  webmcp_surface: "WebMCP surface",
  browser_console_health: "Browser console health",
  browser_network_health: "Browser network health",
  rendered_metadata_consistency: "Rendered metadata consistency",
  public_fact_consistency: "Public fact consistency",
  session_or_challenge_wall: "Session or challenge wall",
  hidden_instruction_risk: "Hidden instruction risk",
  api_discovery_surface: "API discovery surface",
  content_license_surface: "Content licensing surface",
  representative_page_consistency: "Representative page readability",
  browser_runtime_cost: "Browser runtime cost",
};

const OBSERVATION_IMPACTS: Record<BrowserObservationId, string> = {
  rendered_content_delta:
    "Critical facts that exist only after JavaScript runs can be missed by simpler automated readers.",
  accessibility_structure:
    "Clear landmarks, headings, and control names help automated readers identify content and possible actions reliably.",
  form_semantics:
    "Programmatic labels, stable names, and relevant autocomplete values reduce ambiguity when software interprets a form.",
  webmcp_surface:
    "A declared WebMCP surface can advertise optional browser tools, but absence is not a site defect and no tool was invoked here.",
  browser_console_health:
    "Uncaught runtime errors can prevent public content or controls from working after the page renders.",
  browser_network_health:
    "Failed required resources or mixed content can leave automated and human visitors with an incomplete page.",
  rendered_metadata_consistency:
    "Metadata that changes after rendering can give different consumers conflicting discovery or identity signals.",
  public_fact_consistency:
    "Conflicting visible and structured business facts can cause downstream systems to repeat the wrong price or availability.",
  session_or_challenge_wall:
    "A blocking login or challenge can prevent ordinary public facts from being read without an interactive session.",
  hidden_instruction_risk:
    "Hidden agent-directed instructions can manipulate automated readers and require human review before they are trusted.",
  api_discovery_surface:
    "A declared discovery document can help software locate a public API, but declaration alone does not validate that API.",
  content_license_surface:
    "A machine-readable policy can clarify permitted automated use, but declaration alone does not validate its legal meaning.",
  representative_page_consistency:
    "Consistent semantic structure across public templates makes important pages easier to interpret reliably.",
  browser_runtime_cost:
    "High request or transfer cost increases the chance that bounded automated readers stop before critical facts load.",
};

const PRIVATE_EVIDENCE_KEY =
  /(?:^|_)(?:url|uri|host|domain|ip|header|endpoint|path|body|html|text|token|cookie|authorization|trace|run_id|actor|provider)(?:_|$)/i;
const PRIVATE_EVIDENCE_VALUE =
  /(?:https?:\/\/|www\.|(?:^|\s)(?:\d{1,3}\.){3}\d{1,3}(?:\s|$)|(?:^|\s)\/[^\s;]{1,200}|[\w.-]+\.[a-z]{2,}(?:\/|\s|$))/i;
const INSTRUCTION_LIKE_VALUE =
  /(?:ignore (?:all|any|the|previous)|system prompt|developer message|assistant\s*:|execute (?:this|the following)|reveal (?:a |the )?(?:secret|token|prompt))/i;
const REGISTRY_CODE = /^[a-z0-9][a-z0-9_:-]{0,199}$/i;

export type SafeEvidenceEntry = Readonly<{
  key: string;
  label: string;
  value: string;
}>;

export function browserObservationLabel(id: BrowserObservationId): string {
  return OBSERVATION_LABELS[id];
}

export function browserObservationImpact(id: BrowserObservationId): string {
  return OBSERVATION_IMPACTS[id];
}

export function isExperimentalBrowserObservation(id: BrowserObservationId): boolean {
  return [
    "webmcp_surface",
    "hidden_instruction_risk",
    "api_discovery_surface",
    "content_license_surface",
  ].includes(id);
}

export function isActionableBrowserFinding(finding: BrowserObservationFinding): boolean {
  return (
    finding.status === "fail" || (finding.status === "partial" && Boolean(finding.remediation_code))
  );
}

const REGISTRY_COPY: Readonly<Record<string, string>> = {
  accessibility_many_unnamed_controls:
    "Many interactive controls do not have a reliable accessible name.",
  accessibility_structure_clear:
    "The rendered page has a clear main landmark, headings, and named controls.",
  accessibility_structure_incomplete:
    "The rendered page is missing a clear main landmark, heading structure, or names for some controls.",
  api_discovery_declared_unverified:
    "A public API-discovery link was declared, but this passive version did not fetch or validate its document.",
  api_discovery_not_declared: "No explicit public API-discovery link was observed.",
  browser_console_errors_observed:
    "The public page produced one or more categories of browser runtime errors.",
  browser_console_multiple_error_categories:
    "The public page produced several categories of browser runtime errors.",
  browser_console_no_errors_observed:
    "No uncaught browser runtime error category was observed during the passive render.",
  browser_network_healthy:
    "Required public resources loaded without an observed mixed-content or systemic network failure.",
  browser_network_mixed_content: "The HTTPS page attempted to load insecure mixed content.",
  browser_network_policy_limited:
    "Some browser requests were blocked by the passive scanner's safety policy; this is not automatically a site defect.",
  browser_network_resource_failures:
    "One or more categories of required public resources failed to load.",
  browser_observation_unavailable:
    "The passive browser layer could not produce reliable evidence for this observation.",
  browser_runtime_byte_budget_exceeded:
    "The public render exceeded the passive scanner's transfer budget.",
  browser_runtime_near_budget:
    "The public render used at least 80% of the passive scanner's request or transfer budget.",
  browser_runtime_request_budget_exceeded:
    "The public render exceeded the passive scanner's request budget.",
  browser_runtime_within_budget:
    "The public render stayed within the documented request and transfer budgets.",
  content_license_declared_unverified:
    "A content-license link was declared, but this passive version did not fetch or validate the policy document.",
  content_license_not_declared: "No explicit machine-readable content-license link was observed.",
  forms_many_unlabeled_controls:
    "Many public form controls lack a programmatic label, stable name, or relevant autocomplete declaration.",
  forms_not_present: "No public form controls were present on the assessed pages.",
  forms_semantics_clear:
    "The assessed public form controls have programmatic labels, stable names, and relevant autocomplete declarations.",
  forms_some_unlabeled_controls:
    "Some public form controls lack a programmatic label, stable name, or relevant autocomplete declaration.",
  hidden_agent_instructions_not_observed:
    "No hidden instruction-like text aimed at agents was observed in the bounded sample.",
  hidden_agent_instructions_observed:
    "Hidden instruction-like text aimed at agents was observed and requires manual review.",
  public_fact_sample_consistent:
    "The comparable visible currency or availability sample agrees with the rendered structured data.",
  public_facts_contradict:
    "A comparable visible currency or availability signal conflicts with the rendered structured data.",
  public_facts_not_comparable:
    "The assessed pages did not expose a high-confidence visible and structured fact pair that could be compared safely.",
  public_page_challenge_observed:
    "A public login, bot challenge, or blocking consent wall prevented ordinary reading.",
  public_page_no_challenge_observed:
    "No public login or bot challenge blocked the bounded passive render.",
  rendered_canonical_changed: "The canonical URL declaration changed after JavaScript rendering.",
  rendered_content_csr_dependent:
    "Most substantive public content appeared only after JavaScript rendering.",
  rendered_content_material_delta:
    "JavaScript materially changed the amount of public text available to an automated reader.",
  rendered_content_stable:
    "The initial HTML and rendered page expose a comparable amount of substantive public text.",
  rendered_metadata_changed: "hreflang or JSON-LD declarations changed after JavaScript rendering.",
  rendered_metadata_consistent:
    "Canonical, hreflang, and JSON-LD declarations stayed stable after rendering.",
  representative_pages_consistent:
    "The assessed representative pages all retained a basic main landmark, heading, and substantive public text.",
  representative_pages_inconsistent:
    "At least one assessed representative page lacked a basic main landmark, heading, or substantive public text.",
  representative_pages_not_assessed:
    "Fewer than two representative pages were available, so cross-page readability was not assessed.",
  webmcp_surface_absent: "No WebMCP surface was observed. This experimental surface is optional.",
  webmcp_surface_declared:
    "A WebMCP surface was observed; tool behavior was not invoked or certified.",
  align_representative_page_facts:
    "Make the core public content and semantic structure readable across the representative page templates.",
  align_visible_and_structured_facts:
    "Make visible currency and availability facts match the corresponding structured data.",
  fix_public_resource_failures:
    "Repair required public resource failures and remove mixed-content requests.",
  fix_public_runtime_errors:
    "Fix reproducible uncaught errors on the assessed public page templates.",
  improve_accessible_structure:
    "Add a clear main landmark, ordered headings, and reliable accessible names for interactive controls.",
  label_public_form_controls:
    "Give public form controls programmatic labels and stable names, and declare autocomplete where relevant.",
  provide_public_non_challenge_content:
    "Keep critical public facts readable without login or a blocking challenge, while preserving security controls.",
  reduce_public_browser_runtime_cost:
    "Reduce public request and transfer cost without hiding critical facts behind client-only rendering.",
  remove_hidden_agent_instructions:
    "Remove hidden agent-directed instructions unless they are legitimate, visible, and reviewable product content.",
  render_critical_content_server_side:
    "Render critical public facts in the initial HTML and use JavaScript as progressive enhancement.",
  stabilize_server_rendered_metadata:
    "Keep canonical, hreflang, and structured metadata consistent before and after rendering.",
};

export function formatRegistryCode(value: string | undefined): string {
  if (!value || !REGISTRY_CODE.test(value)) return "No public summary available";
  if (REGISTRY_COPY[value]) return REGISTRY_COPY[value];
  return value
    .replaceAll(":", " ")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function safeEvidenceEntries(
  evidence: BrowserObservationFinding["evidence"],
): SafeEvidenceEntry[] {
  return Object.entries(evidence).flatMap(([key, value]) => {
    if (!REGISTRY_CODE.test(key) || PRIVATE_EVIDENCE_KEY.test(key)) return [];
    const rendered = renderSafeEvidenceValue(value);
    if (!rendered) return [];
    return [
      {
        key,
        label: formatRegistryCode(key),
        value: rendered,
      },
    ];
  });
}

export function browserObservationSummary(data: BrowserObservationStatusResponse): string {
  switch (data.status) {
    case "queued":
      return "Browser analysis queued";
    case "running":
      return "Rendering public pages safely";
    case "completed":
      return "Passive browser observations complete";
    case "partial":
      return "Browser observations complete with unavailable surfaces";
    case "blocked":
      return "Browser rendering stopped at a public access boundary";
    case "unavailable":
      return "Browser observations are temporarily unavailable";
  }
}

function renderSafeEvidenceValue(value: string | number | boolean | string[]): string | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) {
    const safe = value.filter(isSafeEvidenceText).slice(0, 20);
    return safe.length > 0 ? safe.join(", ") : undefined;
  }
  return isSafeEvidenceText(value) ? value : undefined;
}

function isSafeEvidenceText(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 200 &&
    !hasControlCharacters(value) &&
    !PRIVATE_EVIDENCE_VALUE.test(value) &&
    !INSTRUCTION_LIKE_VALUE.test(value)
  );
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}
