import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";

import {
  BROWSER_OBSERVATION_IDS,
  BROWSER_OBSERVATION_VERSION,
  accountDataRequestSchema,
  apiErrorEnvelopeSchema,
  apiErrorSchema,
  authFinalizeRequestSchema,
  authFinalizeResponseSchema,
  browserObservationFindingSchema,
  browserObservationInputV1Schema,
  browserObservationJobV1Schema,
  browserObservationOutputV1Schema,
  browserObservationSignalsSchema,
  browserObservationStatusResponseSchema,
  checkResultSchema,
  clientAnalyticsEventRequestSchema,
  contactAccessResponseSchema,
  createScanRequestSchema,
  createScanResponseSchema,
  createShareRequestSchema,
  createShareResponseSchema,
  merchantApplicationSchema,
  publicShareSnapshotSchema,
  registrationRequestSchema,
  registrationResponseSchema,
  remediationPromptResponseSchema,
  reportCheckSchema,
  reportResponseSchema,
  scanJobV1Schema,
  scanStatusResponseSchema,
  sharePreviewResponseSchema,
} from "./index.js";
import {
  acknowledgeReportLinkRequestSchema,
  consumeReportLinkRequestSchema,
  deleteUnattachedPersonRequestSchema,
  issueCabinetLinkRequestSchema,
  sendReportLinkRequestSchema,
} from "./report-identity.js";

const uuid = "019b41a0-7c51-7d63-84bd-a5a20faef497";
const receiptId = "550e8400-e29b-41d4-a716-446655440000";
const timestamp = "2026-09-21T12:00:00.000Z";
const tokenHash = "h".repeat(43);

const reportCheck = (id: number) => ({
  id,
  label_code: `check_${id}`,
  status: "pass",
  summary_code: "observed",
  user_impact_code: "clear",
  fix_code: null,
  evidence: {},
});

const browserSignals = {
  rendered_text_chars: 100,
  raw_to_rendered_ratio: 1,
  landmark_counts: { main: 1 },
  heading_level_counts: { h1: 1 },
  interactive_control_count: 1,
  unnamed_control_count: 0,
  form_control_count: 0,
  unlabeled_form_control_count: 0,
  webmcp_present: false,
  webmcp_tool_count: 0,
  console_error_categories: [],
  failed_resource_categories: [],
  mixed_content_count: 0,
  dom_node_count: 10,
  script_count: 1,
  request_count: 2,
  transferred_bytes: 500,
  challenge_kind: null,
};

const browserFinding = (id: (typeof BROWSER_OBSERVATION_IDS)[number]) => ({
  id,
  status: "pass",
  summary_code: `${id}_observed`,
  evidence: {},
});

const browserInput = {
  schema_version: BROWSER_OBSERVATION_VERSION,
  operation_id: uuid,
  target: {
    canonical_url: "https://example.com/",
    registrable_domain: "example.com",
    segment: "owner",
  },
  representative_urls: [],
  policy: {
    user_agent: "agentify-browser-observer/1.0",
    methods: ["GET", "HEAD"],
    use_proxy: false,
    respect_robots: true,
    crawl_purpose: "search",
  },
  limits: {
    max_pages: 3,
    max_requests_per_page: 80,
    max_total_bytes: 8 * 1024 * 1024,
    page_timeout_ms: 12_000,
    run_timeout_ms: 45_000,
  },
};

const publicShare = {
  host: "example.com",
  score: 72,
  level: "ahead_of_market",
  rubric_version: "gtm-v1.0.0",
  generated_at: timestamp,
};

type ObjectContract = Readonly<{
  name: string;
  schema: ZodType;
  valid: Record<string, unknown>;
  required: readonly (string | readonly [string, ...(string | number)[]])[];
}>;

const pathSegments = (
  path: string | readonly [string, ...(string | number)[]],
): readonly (string | number)[] => (typeof path === "string" ? [path] : path);

const withoutRequiredPath = (
  valid: Record<string, unknown>,
  path: string | readonly [string, ...(string | number)[]],
): Record<string, unknown> => {
  const incomplete = structuredClone(valid);
  const segments = pathSegments(path);
  let parent: unknown = incomplete;
  for (const segment of segments.slice(0, -1)) {
    parent = Array.isArray(parent)
      ? parent[Number(segment)]
      : (parent as Record<string, unknown>)[String(segment)];
  }
  const field = segments.at(-1)!;
  if (Array.isArray(parent)) delete parent[Number(field)];
  else delete (parent as Record<string, unknown>)[String(field)];
  return incomplete;
};

const contracts = [
  {
    name: "apiErrorSchema",
    schema: apiErrorSchema,
    valid: {
      code: "temporarily_busy",
      message: "Retry later",
      retryable: true,
      request_id: "request-1",
    },
    required: ["code", "message", "retryable", "request_id"],
  },
  {
    name: "apiErrorEnvelopeSchema",
    schema: apiErrorEnvelopeSchema,
    valid: {
      error: {
        code: "temporarily_busy",
        message: "Retry later",
        retryable: true,
        request_id: "request-1",
      },
    },
    required: [
      "error",
      ["error", "code"],
      ["error", "message"],
      ["error", "retryable"],
      ["error", "request_id"],
    ],
  },
  {
    name: "createScanRequestSchema",
    schema: createScanRequestSchema,
    valid: {
      url: "https://example.com/",
      segment: "owner",
      landing_variant: "owner-v1",
      turnstile_token: null,
    },
    required: ["url", "segment", "landing_variant", "turnstile_token"],
  },
  {
    name: "createScanResponseSchema",
    schema: createScanResponseSchema,
    valid: {
      scan_id: uuid,
      access_token: "a".repeat(32),
      status: "accepted",
      status_url: `/api/v1/scans/${uuid}`,
      estimated_seconds: 30,
    },
    required: [
      "scan_id",
      "access_token",
      "status",
      "status_url",
      "estimated_seconds",
    ],
  },
  {
    name: "scanStatusResponseSchema",
    schema: scanStatusResponseSchema,
    valid: {
      status: "running",
      progress: { completed: 1, total: 18 },
      checks: [{ id: 1, label_code: "robots", status: "pass" }],
      updated_at: timestamp,
      teaser: {
        score: 72,
        coverage: 1,
        level: "ahead_of_market",
        top_findings: ["machine_interface_visible"],
        positive: "public_evidence_available",
        hidden_count: 17,
      },
    },
    required: [
      "status",
      "progress",
      ["progress", "completed"],
      ["progress", "total"],
      "checks",
      ["checks", 0, "id"],
      ["checks", 0, "label_code"],
      ["checks", 0, "status"],
      "updated_at",
      ["teaser", "score"],
      ["teaser", "coverage"],
      ["teaser", "level"],
      ["teaser", "top_findings"],
      ["teaser", "positive"],
      ["teaser", "hidden_count"],
    ],
  },
  {
    name: "registrationRequestSchema",
    schema: registrationRequestSchema,
    valid: {
      email: "owner@example.com",
      role: "business_owner",
      site_is_mine: true,
      marketing_email_opt_in: false,
      dataset_reuse_acknowledged: true,
    },
    required: [
      "email",
      "role",
      "site_is_mine",
      "marketing_email_opt_in",
      "dataset_reuse_acknowledged",
    ],
  },
  {
    name: "registrationResponseSchema",
    schema: registrationResponseSchema,
    valid: { status: "verification_sent" },
    required: ["status"],
  },
  {
    name: "authFinalizeRequestSchema",
    schema: authFinalizeRequestSchema,
    valid: { state: "s".repeat(32) },
    required: ["state"],
  },
  {
    name: "authFinalizeResponseSchema",
    schema: authFinalizeResponseSchema,
    valid: { status: "verified", report_url: `/report/${uuid}` },
    required: ["status", "report_url"],
  },
  {
    name: "contactAccessResponseSchema",
    schema: contactAccessResponseSchema,
    valid: { status: "verified" },
    required: ["status"],
  },
  {
    name: "reportCheckSchema",
    schema: reportCheckSchema,
    valid: reportCheck(1),
    required: [
      "id",
      "label_code",
      "status",
      "summary_code",
      "user_impact_code",
      "fix_code",
      "evidence",
    ],
  },
  {
    name: "reportResponseSchema",
    schema: reportResponseSchema,
    valid: {
      scan_id: uuid,
      host: "example.com",
      segment: "owner",
      score: 72,
      coverage: 1,
      level: "ahead_of_market",
      checks: Array.from({ length: 18 }, (_, index) => reportCheck(index + 1)),
      benchmark: { sample_size: 30, average_score: 64 },
    },
    required: [
      "scan_id",
      "host",
      "segment",
      "score",
      "coverage",
      "level",
      "checks",
      ["checks", 0, "id"],
      ["checks", 0, "label_code"],
      ["checks", 0, "status"],
      ["checks", 0, "summary_code"],
      ["checks", 0, "user_impact_code"],
      ["checks", 0, "fix_code"],
      ["checks", 0, "evidence"],
      "benchmark",
      ["benchmark", "sample_size"],
      ["benchmark", "average_score"],
    ],
  },
  {
    name: "remediationPromptResponseSchema",
    schema: remediationPromptResponseSchema,
    valid: {
      version: "remediation-prompt-v1.0.0",
      scope: "full",
      content: "A bounded remediation plan",
      included_findings: ["missing_machine_interface"],
      generated_at: timestamp,
    },
    required: [
      "version",
      "scope",
      "content",
      "included_findings",
      "generated_at",
    ],
  },
  {
    name: "createShareRequestSchema",
    schema: createShareRequestSchema,
    valid: { allow_indexing: false },
    required: [],
  },
  {
    name: "createShareResponseSchema",
    schema: createShareResponseSchema,
    valid: {
      slug: "s".repeat(32),
      public_url: `https://agentify.ad/s/${"s".repeat(32)}`,
      status: "published",
    },
    required: ["slug", "public_url", "status"],
  },
  {
    name: "publicShareSnapshotSchema",
    schema: publicShareSnapshotSchema,
    valid: publicShare,
    required: ["host", "score", "level", "rubric_version", "generated_at"],
  },
  {
    name: "sharePreviewResponseSchema",
    schema: sharePreviewResponseSchema,
    valid: {
      ...publicShare,
      existing_share: {
        slug: "s".repeat(32),
        public_url: `https://agentify.ad/s/${"s".repeat(32)}`,
        status: "published",
      },
    },
    required: [
      "host",
      "score",
      "level",
      "rubric_version",
      "generated_at",
      "existing_share",
      ["existing_share", "slug"],
      ["existing_share", "public_url"],
      ["existing_share", "status"],
    ],
  },
  {
    name: "accountDataRequestSchema",
    schema: accountDataRequestSchema,
    valid: { type: "access" },
    required: ["type"],
  },
  {
    name: "clientAnalyticsEventRequestSchema",
    schema: clientAnalyticsEventRequestSchema,
    valid: { event_id: uuid, name: "landing_view", properties: {} },
    required: ["event_id", "name"],
  },
  {
    name: "checkResultSchema",
    schema: checkResultSchema,
    valid: {
      id: 1,
      status: "pass",
      nominalWeight: 5,
      applicableWeight: 5,
      earnedWeight: 5,
      summaryCode: "robots_clear",
      evidence: {},
      userImpactCode: "public_access",
      durationMs: 10,
    },
    required: [
      "id",
      "status",
      "nominalWeight",
      "applicableWeight",
      "earnedWeight",
      "summaryCode",
      "evidence",
      "userImpactCode",
      "durationMs",
    ],
  },
  {
    name: "scanJobV1Schema",
    schema: scanJobV1Schema,
    valid: {
      scan_id: uuid,
      canonical_target_url: "https://example.com/",
      segment: "owner",
      rubric_version: "gtm-v1.0.0",
      deadline_at: timestamp,
      attempt_no: 1,
    },
    required: [
      "scan_id",
      "canonical_target_url",
      "segment",
      "rubric_version",
      "deadline_at",
      "attempt_no",
    ],
  },
  {
    name: "merchantApplicationSchema",
    schema: merchantApplicationSchema,
    valid: {
      businessName: "Example shop",
      website: "https://example.com/",
      email: "owner@example.com",
      category: "retail",
      country: "Indonesia",
      consent: true,
    },
    required: [
      "businessName",
      "website",
      "email",
      "category",
      "country",
      "consent",
    ],
  },
  {
    name: "sendReportLinkRequestSchema",
    schema: sendReportLinkRequestSchema,
    valid: {
      operation: "send",
      email: "owner@example.com",
      intent_kind: "registration",
      state: tokenHash,
    },
    required: ["operation", "email", "intent_kind", "state"],
  },
  {
    name: "consumeReportLinkRequestSchema",
    schema: consumeReportLinkRequestSchema,
    valid: {
      operation: "verify",
      phase: "consume",
      token: "T".repeat(32),
      email: "owner@example.com",
      intent_kind: "recovery",
      state: tokenHash,
    },
    required: ["operation", "phase", "token", "email", "intent_kind", "state"],
  },
  {
    name: "acknowledgeReportLinkRequestSchema",
    schema: acknowledgeReportLinkRequestSchema,
    valid: {
      operation: "verify",
      phase: "acknowledge",
      receipt_id: receiptId,
      token_hash: tokenHash,
    },
    required: ["operation", "phase", "receipt_id", "token_hash"],
  },
  {
    name: "issueCabinetLinkRequestSchema",
    schema: issueCabinetLinkRequestSchema,
    valid: {
      operation: "issue",
      receipt_id: receiptId,
      token_hash: tokenHash,
    },
    required: ["operation", "receipt_id", "token_hash"],
  },
  {
    name: "deleteUnattachedPersonRequestSchema",
    schema: deleteUnattachedPersonRequestSchema,
    valid: {
      operation: "delete",
      operation_id: uuid,
      email: "owner@example.com",
    },
    required: ["operation", "operation_id", "email"],
  },
  {
    name: "browserObservationSignalsSchema",
    schema: browserObservationSignalsSchema,
    valid: browserSignals,
    required: [
      "rendered_text_chars",
      "raw_to_rendered_ratio",
      "landmark_counts",
      "heading_level_counts",
      "interactive_control_count",
      "unnamed_control_count",
      "form_control_count",
      "unlabeled_form_control_count",
      "webmcp_present",
      "webmcp_tool_count",
      "console_error_categories",
      "failed_resource_categories",
      "mixed_content_count",
      "dom_node_count",
      "script_count",
      "request_count",
      "transferred_bytes",
      "challenge_kind",
    ],
  },
  {
    name: "browserObservationFindingSchema",
    schema: browserObservationFindingSchema,
    valid: browserFinding(BROWSER_OBSERVATION_IDS[0]),
    required: ["id", "status", "summary_code", "evidence"],
  },
  {
    name: "browserObservationInputV1Schema",
    schema: browserObservationInputV1Schema,
    valid: browserInput,
    required: [
      "schema_version",
      "operation_id",
      "target",
      ["target", "canonical_url"],
      ["target", "registrable_domain"],
      ["target", "segment"],
      "representative_urls",
      "policy",
      ["policy", "user_agent"],
      ["policy", "methods"],
      ["policy", "use_proxy"],
      ["policy", "respect_robots"],
      ["policy", "crawl_purpose"],
      "limits",
      ["limits", "max_pages"],
      ["limits", "max_requests_per_page"],
      ["limits", "max_total_bytes"],
      ["limits", "page_timeout_ms"],
      ["limits", "run_timeout_ms"],
    ],
  },
  {
    name: "browserObservationOutputV1Schema",
    schema: browserObservationOutputV1Schema,
    valid: {
      schema_version: BROWSER_OBSERVATION_VERSION,
      operation_id: uuid,
      actor_build: "1.0.0",
      status: "completed",
      pages_assessed: 1,
      signals: browserSignals,
      observations: BROWSER_OBSERVATION_IDS.map(browserFinding),
      timings: { total_ms: 100, pages: [100] },
    },
    required: [
      "schema_version",
      "operation_id",
      "actor_build",
      "status",
      "pages_assessed",
      "signals",
      ["signals", "rendered_text_chars"],
      ["signals", "raw_to_rendered_ratio"],
      ["signals", "landmark_counts"],
      ["signals", "heading_level_counts"],
      ["signals", "interactive_control_count"],
      ["signals", "unnamed_control_count"],
      ["signals", "form_control_count"],
      ["signals", "unlabeled_form_control_count"],
      ["signals", "webmcp_present"],
      ["signals", "webmcp_tool_count"],
      ["signals", "console_error_categories"],
      ["signals", "failed_resource_categories"],
      ["signals", "mixed_content_count"],
      ["signals", "dom_node_count"],
      ["signals", "script_count"],
      ["signals", "request_count"],
      ["signals", "transferred_bytes"],
      ["signals", "challenge_kind"],
      "observations",
      ["observations", 0, "id"],
      ["observations", 0, "status"],
      ["observations", 0, "summary_code"],
      ["observations", 0, "evidence"],
      "timings",
      ["timings", "total_ms"],
      ["timings", "pages"],
    ],
  },
  {
    name: "browserObservationStatusResponseSchema",
    schema: browserObservationStatusResponseSchema,
    valid: {
      version: BROWSER_OBSERVATION_VERSION,
      status: "completed",
      non_scoring: true,
      pages_assessed: 1,
      findings: [browserFinding(BROWSER_OBSERVATION_IDS[0])],
      updated_at: timestamp,
    },
    required: [
      "version",
      "status",
      "non_scoring",
      "pages_assessed",
      "findings",
      ["findings", 0, "id"],
      ["findings", 0, "status"],
      ["findings", 0, "summary_code"],
      ["findings", 0, "evidence"],
      "updated_at",
    ],
  },
  {
    name: "browserObservationJobV1Schema",
    schema: browserObservationJobV1Schema,
    valid: { observation_id: uuid, operation_id: uuid, attempt_no: 1 },
    required: ["observation_id", "operation_id", "attempt_no"],
  },
] satisfies readonly ObjectContract[];

describe("exported scanner object schemas", () => {
  it.each(contracts)(
    "$name accepts its explicit example and identifies each missing required field",
    ({ schema, valid, required }) => {
      expect(schema.safeParse(valid).success).toBe(true);

      for (const field of required) {
        const expectedPath = pathSegments(field);
        const label = expectedPath.join(".");
        const incomplete = withoutRequiredPath(valid, field);
        const parsed = schema.safeParse(incomplete);
        expect(parsed.success, label).toBe(false);
        if (parsed.success) continue;
        const issue = parsed.error.issues.find(
          (candidate) =>
            candidate.path.length === expectedPath.length &&
            candidate.path.every(
              (segment, index) => segment === expectedPath[index],
            ),
        );
        expect(issue, label).toBeDefined();
        expect(issue?.message.trim().length, label).toBeGreaterThan(0);
      }
    },
  );
});
