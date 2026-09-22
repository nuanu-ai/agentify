import type {
  BrowserObservationFinding,
  BrowserObservationSignals,
} from "@agentify/scanner-contracts";
import { BROWSER_OBSERVATION_IDS } from "@agentify/scanner-contracts";

import type { PageSignals } from "./browser-signals.js";

export type ObservationRuntime = {
  pages: readonly PageSignals[];
  consoleErrorCategories: readonly string[];
  failedResourceCategories: readonly string[];
  mixedContentCount: number;
  requestCount: number;
  transferredBytes: number;
  blockedMutationCount: number;
  blockedDestinationCount: number;
  byteBudgetExceeded: boolean;
  requestBudgetExceeded: boolean;
  pageFailureCount: number;
  maxTotalBytes: number;
  maxRequests: number;
};

const addCounts = (
  pages: readonly PageSignals[],
  field: "landmarkCounts" | "headingLevelCounts",
): Record<string, number> => {
  const result: Record<string, number> = {};
  for (const page of pages) {
    for (const [name, count] of Object.entries(page[field])) {
      result[name] = (result[name] ?? 0) + count;
    }
  }
  return Object.fromEntries(
    Object.entries(result).sort(([left], [right]) => left.localeCompare(right)),
  );
};

const sum = (
  pages: readonly PageSignals[],
  field:
    | "renderedTextChars"
    | "rawTextChars"
    | "interactiveControlCount"
    | "unnamedControlCount"
    | "formControlCount"
    | "unlabeledFormControlCount"
    | "webmcpToolCount"
    | "domNodeCount"
    | "scriptCount",
): number => pages.reduce((total, page) => total + page[field], 0);

export const aggregateBrowserSignals = (runtime: ObservationRuntime): BrowserObservationSignals => {
  const renderedTextChars = Math.min(5_000_000, sum(runtime.pages, "renderedTextChars"));
  const rawTextChars = sum(runtime.pages, "rawTextChars");
  return {
    rendered_text_chars: renderedTextChars,
    raw_to_rendered_ratio:
      renderedTextChars > 0
        ? Math.min(100, Number((rawTextChars / renderedTextChars).toFixed(4)))
        : null,
    landmark_counts: addCounts(runtime.pages, "landmarkCounts"),
    heading_level_counts: addCounts(runtime.pages, "headingLevelCounts"),
    interactive_control_count: Math.min(100_000, sum(runtime.pages, "interactiveControlCount")),
    unnamed_control_count: Math.min(100_000, sum(runtime.pages, "unnamedControlCount")),
    form_control_count: Math.min(100_000, sum(runtime.pages, "formControlCount")),
    unlabeled_form_control_count: Math.min(
      100_000,
      sum(runtime.pages, "unlabeledFormControlCount"),
    ),
    webmcp_present: runtime.pages.some((page) => page.webmcpPresent),
    webmcp_tool_count: Math.min(10_000, sum(runtime.pages, "webmcpToolCount")),
    console_error_categories: [...new Set(runtime.consoleErrorCategories)].sort().slice(0, 20),
    failed_resource_categories: [...new Set(runtime.failedResourceCategories)].sort().slice(0, 20),
    mixed_content_count: runtime.mixedContentCount,
    dom_node_count: Math.min(5_000_000, sum(runtime.pages, "domNodeCount")),
    script_count: Math.min(100_000, sum(runtime.pages, "scriptCount")),
    request_count: runtime.requestCount,
    transferred_bytes: runtime.transferredBytes,
    challenge_kind: runtime.pages.find((page) => page.challengeKind)?.challengeKind ?? null,
  };
};

const finding = (value: BrowserObservationFinding): BrowserObservationFinding => value;

const overlaps = (left: readonly string[], right: readonly string[]): boolean =>
  left.some((value) => right.includes(value));

const metadataComparison = (pages: readonly PageSignals[]) => {
  let canonicalChanges = 0;
  let hreflangChanges = 0;
  let jsonLdChanges = 0;
  let currencyContradictions = 0;
  let availabilityContradictions = 0;
  let structuredFactChanges = 0;
  for (const page of pages) {
    if (page.rawMetadata.canonical !== page.renderedMetadata.canonical) {
      canonicalChanges += 1;
    }
    if (page.rawMetadata.hreflangCount !== page.renderedMetadata.hreflangCount) {
      hreflangChanges += 1;
    }
    if (page.rawMetadata.jsonLdCount !== page.renderedMetadata.jsonLdCount) {
      jsonLdChanges += 1;
    }
    if (
      page.rawMetadata.currencies.length > 0 &&
      page.renderedMetadata.currencies.length > 0 &&
      !overlaps(page.rawMetadata.currencies, page.renderedMetadata.currencies)
    ) {
      currencyContradictions += 1;
    }
    if (
      page.rawMetadata.availability.length > 0 &&
      page.renderedMetadata.availability.length > 0 &&
      !overlaps(page.rawMetadata.availability, page.renderedMetadata.availability)
    ) {
      availabilityContradictions += 1;
    }
    if (
      page.rawMetadata.priceCount !== page.renderedMetadata.priceCount ||
      page.rawMetadata.hasContact !== page.renderedMetadata.hasContact ||
      page.rawMetadata.hasOpeningHours !== page.renderedMetadata.hasOpeningHours
    ) {
      structuredFactChanges += 1;
    }
  }
  return {
    canonicalChanges,
    hreflangChanges,
    jsonLdChanges,
    currencyContradictions,
    availabilityContradictions,
    structuredFactChanges,
  };
};

const representativeInconsistencies = (pages: readonly PageSignals[]): number => {
  return pages.filter((page) => {
    const headingCount = Object.values(page.headingLevelCounts).reduce(
      (total, count) => total + count,
      0,
    );
    return (
      page.renderedTextChars < 150 || (page.landmarkCounts.main ?? 0) === 0 || headingCount === 0
    );
  }).length;
};

const visibleFactComparison = (pages: readonly PageSignals[]) => {
  let comparableFactKinds = 0;
  let contradictionCount = 0;
  for (const page of pages) {
    const comparisons = [
      [page.renderedMetadata.currencies, page.visibleFacts.currencies],
      [page.renderedMetadata.availability, page.visibleFacts.availability],
    ] as const;
    for (const [structured, visible] of comparisons) {
      if (structured.length === 0 || visible.length === 0) continue;
      comparableFactKinds += 1;
      if (!overlaps(structured, visible)) contradictionCount += 1;
    }
  }
  return { comparableFactKinds, contradictionCount };
};

export const buildObservations = (runtime: ObservationRuntime): BrowserObservationFinding[] => {
  if (runtime.pages.length === 0) {
    const unavailable = (id: BrowserObservationFinding["id"]): BrowserObservationFinding =>
      finding({
        id,
        status: "unavailable",
        summary_code: "browser_observation_unavailable",
        evidence: {},
      });
    return BROWSER_OBSERVATION_IDS.map((id) => unavailable(id));
  }

  const signals = aggregateBrowserSignals(runtime);
  const metadata = metadataComparison(runtime.pages);
  const rawRatio = signals.raw_to_rendered_ratio;
  const unnamedRatio =
    signals.interactive_control_count > 0
      ? signals.unnamed_control_count / signals.interactive_control_count
      : 0;
  const formSemanticIssueCount = runtime.pages.reduce(
    (total, page) => total + page.formSemanticIssueCount,
    0,
  );
  const formSemanticIssueRatio =
    signals.form_control_count > 0 ? formSemanticIssueCount / signals.form_control_count : 0;
  const headingCount = Object.values(signals.heading_level_counts).reduce(
    (total, count) => total + count,
    0,
  );
  const hasMain = (signals.landmark_counts.main ?? 0) > 0;
  const consoleCount = signals.console_error_categories.length;
  const networkFailureCount = signals.failed_resource_categories.length;
  const visibleFacts = visibleFactComparison(runtime.pages);
  const hiddenInstructionCount = runtime.pages.reduce(
    (total, page) => total + page.hiddenInstructionCount,
    0,
  );
  const apiDiscoveryCount = runtime.pages.reduce(
    (total, page) => total + page.apiDiscoveryCount,
    0,
  );
  const licenseLinkCount = runtime.pages.reduce((total, page) => total + page.licenseLinkCount, 0);
  const representativeIssues = representativeInconsistencies(runtime.pages);
  const requestRatio = runtime.maxRequests > 0 ? runtime.requestCount / runtime.maxRequests : 0;
  const byteRatio =
    runtime.maxTotalBytes > 0 ? runtime.transferredBytes / runtime.maxTotalBytes : 0;

  return [
    finding({
      id: "rendered_content_delta",
      status:
        signals.rendered_text_chars === 0 ||
        (rawRatio !== null && rawRatio < 0.15 && signals.rendered_text_chars >= 500)
          ? "fail"
          : rawRatio !== null && rawRatio < 0.6
            ? "partial"
            : "pass",
      summary_code:
        rawRatio !== null && rawRatio < 0.15
          ? "rendered_content_csr_dependent"
          : rawRatio !== null && rawRatio < 0.6
            ? "rendered_content_material_delta"
            : "rendered_content_stable",
      remediation_code:
        rawRatio !== null && rawRatio < 0.6 ? "render_critical_content_server_side" : undefined,
      evidence: {
        rendered_character_count: signals.rendered_text_chars,
        render_ratio: rawRatio ?? 0,
        pages_assessed: runtime.pages.length,
      },
    }),
    finding({
      id: "accessibility_structure",
      status:
        unnamedRatio > 0.25 || (!hasMain && headingCount === 0)
          ? "fail"
          : unnamedRatio > 0 || !hasMain || headingCount === 0
            ? "partial"
            : "pass",
      summary_code:
        unnamedRatio > 0.25
          ? "accessibility_many_unnamed_controls"
          : !hasMain || headingCount === 0
            ? "accessibility_structure_incomplete"
            : "accessibility_structure_clear",
      remediation_code:
        unnamedRatio > 0 || !hasMain || headingCount === 0
          ? "improve_accessible_structure"
          : undefined,
      evidence: {
        heading_count: headingCount,
        main_landmark_count: signals.landmark_counts.main ?? 0,
        interactive_control_count: signals.interactive_control_count,
        unnamed_control_count: signals.unnamed_control_count,
      },
    }),
    finding({
      id: "form_semantics",
      status:
        signals.form_control_count === 0
          ? "not_applicable"
          : formSemanticIssueRatio > 0.25
            ? "fail"
            : formSemanticIssueRatio > 0
              ? "partial"
              : "pass",
      summary_code:
        signals.form_control_count === 0
          ? "forms_not_present"
          : formSemanticIssueRatio > 0.25
            ? "forms_many_unlabeled_controls"
            : formSemanticIssueRatio > 0
              ? "forms_some_unlabeled_controls"
              : "forms_semantics_clear",
      remediation_code: formSemanticIssueRatio > 0 ? "label_public_form_controls" : undefined,
      evidence: {
        form_control_count: signals.form_control_count,
        unlabeled_form_control_count: signals.unlabeled_form_control_count,
        semantic_issue_count: formSemanticIssueCount,
      },
    }),
    finding({
      id: "webmcp_surface",
      status: signals.webmcp_present ? "pass" : "not_applicable",
      summary_code: signals.webmcp_present ? "webmcp_surface_declared" : "webmcp_surface_absent",
      evidence: {
        webmcp_present: signals.webmcp_present,
        webmcp_tool_count: signals.webmcp_tool_count,
      },
    }),
    finding({
      id: "browser_console_health",
      status: consoleCount > 3 ? "fail" : consoleCount > 0 ? "partial" : "pass",
      summary_code:
        consoleCount > 3
          ? "browser_console_multiple_error_categories"
          : consoleCount > 0
            ? "browser_console_errors_observed"
            : "browser_console_no_errors_observed",
      remediation_code: consoleCount > 0 ? "fix_public_runtime_errors" : undefined,
      evidence: {
        error_category_count: consoleCount,
        error_categories: signals.console_error_categories,
      },
    }),
    finding({
      id: "browser_network_health",
      status:
        signals.mixed_content_count > 0 || networkFailureCount > 5
          ? "fail"
          : networkFailureCount > 0 ||
              runtime.blockedMutationCount > 0 ||
              runtime.blockedDestinationCount > 0
            ? "partial"
            : "pass",
      summary_code:
        signals.mixed_content_count > 0
          ? "browser_network_mixed_content"
          : networkFailureCount > 0
            ? "browser_network_resource_failures"
            : runtime.blockedMutationCount > 0 || runtime.blockedDestinationCount > 0
              ? "browser_network_policy_limited"
              : "browser_network_healthy",
      remediation_code:
        signals.mixed_content_count > 0 || networkFailureCount > 0
          ? "fix_public_resource_failures"
          : undefined,
      evidence: {
        failed_category_count: networkFailureCount,
        failed_categories: signals.failed_resource_categories,
        mixed_content_count: signals.mixed_content_count,
        blocked_mutation_count: runtime.blockedMutationCount,
        blocked_destination_count: runtime.blockedDestinationCount,
      },
    }),
    finding({
      id: "rendered_metadata_consistency",
      status:
        metadata.canonicalChanges > 0
          ? "fail"
          : metadata.hreflangChanges > 0 || metadata.jsonLdChanges > 0
            ? "partial"
            : "pass",
      summary_code:
        metadata.canonicalChanges > 0
          ? "rendered_canonical_changed"
          : metadata.hreflangChanges > 0 || metadata.jsonLdChanges > 0
            ? "rendered_metadata_changed"
            : "rendered_metadata_consistent",
      remediation_code:
        metadata.canonicalChanges > 0 || metadata.hreflangChanges > 0 || metadata.jsonLdChanges > 0
          ? "stabilize_server_rendered_metadata"
          : undefined,
      evidence: {
        canonical_change_count: metadata.canonicalChanges,
        hreflang_change_count: metadata.hreflangChanges,
        jsonld_change_count: metadata.jsonLdChanges,
      },
    }),
    finding({
      id: "public_fact_consistency",
      status:
        visibleFacts.comparableFactKinds === 0
          ? "unavailable"
          : visibleFacts.contradictionCount > 0
            ? "fail"
            : "pass",
      summary_code:
        visibleFacts.comparableFactKinds === 0
          ? "public_facts_not_comparable"
          : visibleFacts.contradictionCount > 0
            ? "public_facts_contradict"
            : "public_fact_sample_consistent",
      remediation_code:
        visibleFacts.contradictionCount > 0 ? "align_visible_and_structured_facts" : undefined,
      evidence: {
        comparable_fact_kind_count: visibleFacts.comparableFactKinds,
        contradiction_count: visibleFacts.contradictionCount,
      },
    }),
    finding({
      id: "session_or_challenge_wall",
      status: signals.challenge_kind ? "fail" : "pass",
      summary_code: signals.challenge_kind
        ? "public_page_challenge_observed"
        : "public_page_no_challenge_observed",
      remediation_code: signals.challenge_kind ? "provide_public_non_challenge_content" : undefined,
      evidence: {
        challenge_present: Boolean(signals.challenge_kind),
        challenge_kind: signals.challenge_kind ?? "none",
      },
    }),
    finding({
      id: "hidden_instruction_risk",
      status: hiddenInstructionCount > 0 ? "fail" : "pass",
      summary_code:
        hiddenInstructionCount > 0
          ? "hidden_agent_instructions_observed"
          : "hidden_agent_instructions_not_observed",
      remediation_code: hiddenInstructionCount > 0 ? "remove_hidden_agent_instructions" : undefined,
      evidence: { suspicious_hidden_element_count: hiddenInstructionCount },
    }),
    finding({
      id: "api_discovery_surface",
      status: apiDiscoveryCount > 0 ? "partial" : "not_applicable",
      summary_code:
        apiDiscoveryCount > 0 ? "api_discovery_declared_unverified" : "api_discovery_not_declared",
      evidence: { declared_api_surface_count: apiDiscoveryCount },
    }),
    finding({
      id: "content_license_surface",
      status: licenseLinkCount > 0 ? "partial" : "not_applicable",
      summary_code:
        licenseLinkCount > 0
          ? "content_license_declared_unverified"
          : "content_license_not_declared",
      evidence: { declared_license_link_count: licenseLinkCount },
    }),
    finding({
      id: "representative_page_consistency",
      status:
        runtime.pages.length < 2
          ? "not_applicable"
          : representativeIssues > runtime.pages.length - 1
            ? "fail"
            : representativeIssues > 0
              ? "partial"
              : "pass",
      summary_code:
        runtime.pages.length < 2
          ? "representative_pages_not_assessed"
          : representativeIssues > 0
            ? "representative_pages_inconsistent"
            : "representative_pages_consistent",
      remediation_code: representativeIssues > 0 ? "align_representative_page_facts" : undefined,
      evidence: {
        pages_assessed: runtime.pages.length,
        inconsistency_count: representativeIssues,
      },
    }),
    finding({
      id: "browser_runtime_cost",
      status:
        runtime.byteBudgetExceeded || runtime.requestBudgetExceeded
          ? "fail"
          : byteRatio >= 0.8 || requestRatio >= 0.8
            ? "partial"
            : "pass",
      summary_code: runtime.byteBudgetExceeded
        ? "browser_runtime_byte_budget_exceeded"
        : runtime.requestBudgetExceeded
          ? "browser_runtime_request_budget_exceeded"
          : byteRatio >= 0.8 || requestRatio >= 0.8
            ? "browser_runtime_near_budget"
            : "browser_runtime_within_budget",
      remediation_code:
        runtime.byteBudgetExceeded ||
        runtime.requestBudgetExceeded ||
        byteRatio >= 0.8 ||
        requestRatio >= 0.8
          ? "reduce_public_browser_runtime_cost"
          : undefined,
      evidence: {
        request_count: runtime.requestCount,
        transferred_bytes: runtime.transferredBytes,
        request_budget_percent: Math.min(100, Math.round(requestRatio * 100)),
        byte_budget_percent: Math.min(100, Math.round(byteRatio * 100)),
      },
    }),
  ];
};
