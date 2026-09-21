import { describe, expect, it } from "vitest";

import {
  ANALYTICS_EVENT_NAMES,
  BROWSER_OBSERVATION_IDS,
  CHECK_DEFINITIONS,
  BROWSER_OBSERVATION_VERSION,
  browserObservationInputV1Schema,
  browserObservationOutputV1Schema,
  browserObservationStatusResponseSchema,
  clientAnalyticsEventRequestSchema,
  createScanRequestSchema,
  registrationRequestSchema,
  reportResponseSchema,
  scanStatusResponseSchema,
  scanUrlWasSubmittedWithoutScheme,
  sharePreviewResponseSchema,
  scanJobV1Schema,
  uuidV7Schema,
} from "./index.js";

describe("canonical contracts", () => {
  it("keeps exactly 18 checks with nominal weight 100", () => {
    expect(CHECK_DEFINITIONS).toHaveLength(18);
    expect(new Set(CHECK_DEFINITIONS.map(({ id }) => id)).size).toBe(18);
    expect(
      CHECK_DEFINITIONS.reduce((sum, check) => sum + check.nominalWeight, 0),
    ).toBe(100);
  });

  it("keeps the eight-event taxonomy unique", () => {
    expect(ANALYTICS_EVENT_NAMES).toHaveLength(8);
    expect(new Set(ANALYTICS_EVENT_NAMES).size).toBe(8);
  });

  it("answers a report without a waitlist, and refuses one that still carries it", () => {
    const report = {
      scan_id: "018f3f56-2ec8-7b16-8f66-5b8f93f3251f",
      host: "bloomandco.com",
      segment: "owner",
      score: 46,
      coverage: 0.78,
      level: "readable",
      checks: CHECK_DEFINITIONS.map((definition) => ({
        id: definition.id,
        label_code: definition.labelCode,
        status: "unavailable",
        summary_code: null,
        user_impact_code: null,
        fix_code: null,
        evidence: {},
      })),
      benchmark: null,
    };

    expect(reportResponseSchema.safeParse(report).success).toBe(true);
    expect(
      reportResponseSchema.safeParse({
        ...report,
        waitlist: { entry_id: report.scan_id, position: "7", answer: null },
      }).success,
    ).toBe(false);
  });

  it("reports the existing published share alongside the exact preview", () => {
    const base = {
      host: "example.com",
      score: 46,
      level: "readable",
      rubric_version: "gtm-v1.0.0",
      generated_at: "2026-07-13T12:00:00.000Z",
    };
    const slug = "abcdefghijklmnopqrstuvwxyz_1234567890";
    expect(
      sharePreviewResponseSchema.safeParse({ ...base, existing_share: null })
        .success,
    ).toBe(true);
    expect(
      sharePreviewResponseSchema.safeParse({
        ...base,
        existing_share: {
          slug,
          public_url: `https://agentify.ad/s/${slug}`,
          status: "published",
        },
      }).success,
    ).toBe(true);
    expect(sharePreviewResponseSchema.safeParse(base).success).toBe(false);
    expect(
      sharePreviewResponseSchema.safeParse({
        ...base,
        existing_share: {
          slug,
          public_url: `https://agentify.ad/s/${slug}`,
          status: "revoked",
        },
      }).success,
    ).toBe(false);
  });

  it("carries the scanned host in the scan status response", () => {
    const base = {
      status: "running",
      progress: { completed: 1, total: 18 },
      checks: [],
      updated_at: "2026-07-13T12:00:00.000Z",
    };
    expect(
      scanStatusResponseSchema.safeParse({
        ...base,
        target_host: "example.com",
      }).success,
    ).toBe(true);
    expect(scanStatusResponseSchema.safeParse(base).success).toBe(true);
    expect(
      scanStatusResponseSchema.safeParse({ ...base, target_host: "" }).success,
    ).toBe(false);
  });

  it("rejects credentialed and non-http scan URLs", () => {
    expect(
      createScanRequestSchema.safeParse({
        url: "https://user:secret@example.com",
        segment: "store",
        landing_variant: "store-v1",
        turnstile_token: null,
      }).success,
    ).toBe(false);
    expect(
      createScanRequestSchema.safeParse({
        url: "file:///etc/passwd",
        segment: "store",
        landing_variant: "store-v1",
        turnstile_token: null,
      }).success,
    ).toBe(false);
  });

  it("normalizes scheme-less scan input and derives the downgrade signal", () => {
    const parsed = createScanRequestSchema.parse({
      url: "example.com/path#client-only",
      segment: "store",
      landing_variant: "store-v1",
      turnstile_token: null,
    });
    expect(parsed.url).toBe("https://example.com/path");
    expect(scanUrlWasSubmittedWithoutScheme("example.com/path")).toBe(true);
    expect(scanUrlWasSubmittedWithoutScheme("https://example.com/path")).toBe(
      false,
    );
  });

  it("requires UUIDv7 for record and job IDs", () => {
    expect(
      uuidV7Schema.safeParse("019b41a0-7c51-7d63-84bd-a5a20faef497").success,
    ).toBe(true);
    expect(
      uuidV7Schema.safeParse("550e8400-e29b-41d4-a716-446655440000").success,
    ).toBe(false);
    expect(
      scanJobV1Schema.safeParse({
        scan_id: "019b41a0-7c51-7d63-84bd-a5a20faef497",
        canonical_target_url: "https://example.com/",
        submitted_without_scheme: true,
        segment: "owner",
        rubric_version: "gtm-v1.0.0",
        deadline_at: "2026-07-12T12:00:00.000Z",
        attempt_no: 1,
      }).success,
    ).toBe(true);
  });

  it("normalizes an international registration phone and accepts none", () => {
    const base = {
      email: "owner@example.com",
      role: "business_owner",
      site_is_mine: false,
      marketing_email_opt_in: false,
      dataset_reuse_acknowledged: true,
    };
    expect(
      registrationRequestSchema.parse({
        ...base,
        phone: "+1 (415) 555-0123",
      }).phone,
    ).toBe("+14155550123");
    expect(
      registrationRequestSchema.safeParse({ ...base, phone: "4155550123" })
        .success,
    ).toBe(false);
    expect(registrationRequestSchema.parse(base).phone).toBeUndefined();
  });

  it("limits browser-owned events to the three client trigger contracts", () => {
    const base = {
      event_id: "019b41a0-7c51-7d63-84bd-a5a20faef497",
      segment: "owner",
      landing_variant: "owner-v1",
      properties: {},
    };
    expect(
      clientAnalyticsEventRequestSchema.safeParse({
        ...base,
        name: "landing_view",
      }).success,
    ).toBe(true);
    expect(
      clientAnalyticsEventRequestSchema.safeParse({
        ...base,
        name: "registration_completed",
      }).success,
    ).toBe(false);
  });

  it("keeps browser observation versioned, bounded, and non-scoring", () => {
    const operationId = "019b41a0-7c51-7d63-84bd-a5a20faef497";
    expect(
      browserObservationInputV1Schema.safeParse({
        schema_version: BROWSER_OBSERVATION_VERSION,
        operation_id: operationId,
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
      }).success,
    ).toBe(true);

    const output = {
      schema_version: BROWSER_OBSERVATION_VERSION,
      operation_id: operationId,
      actor_build: "1.0.42",
      status: "completed",
      pages_assessed: 1,
      signals: {
        rendered_text_chars: 10,
        raw_to_rendered_ratio: 1,
        landmark_counts: { main: 1 },
        heading_level_counts: { h1: 1 },
        interactive_control_count: 0,
        unnamed_control_count: 0,
        form_control_count: 0,
        unlabeled_form_control_count: 0,
        webmcp_present: false,
        webmcp_tool_count: 0,
        console_error_categories: [],
        failed_resource_categories: [],
        mixed_content_count: 0,
        dom_node_count: 5,
        script_count: 0,
        request_count: 1,
        transferred_bytes: 100,
        challenge_kind: null,
      },
      observations: BROWSER_OBSERVATION_IDS.map((id) => ({
        id,
        status: "pass",
        summary_code: `${id}_observed`,
        evidence: id === "accessibility_structure" ? { main_count: 1 } : {},
      })),
      timings: { total_ms: 100, pages: [100] },
    };
    for (const status of ["completed", "partial", "blocked", "failed"]) {
      expect(
        browserObservationOutputV1Schema.safeParse({ ...output, status })
          .success,
      ).toBe(true);
    }
    expect(
      browserObservationOutputV1Schema.safeParse({
        ...output,
        observations: output.observations.map((finding, index) =>
          index === 0
            ? {
                ...finding,
                evidence: {
                  endpoint_url: "https://127.0.0.1/?token=secret",
                },
              }
            : finding,
        ),
      }).success,
    ).toBe(false);
    expect(
      browserObservationOutputV1Schema.safeParse({
        ...output,
        observations: output.observations.slice(0, -1),
      }).success,
    ).toBe(false);
    expect(
      browserObservationOutputV1Schema.safeParse({
        ...output,
        observations: output.observations.map((finding, index) =>
          index === output.observations.length - 1
            ? { ...finding, id: output.observations[0]!.id }
            : finding,
        ),
      }).success,
    ).toBe(false);
  });

  it("rejects unsafe browser code and category strings at worker ingestion", () => {
    const operationId = "019b41a0-7c51-7d63-84bd-a5a20faef497";
    const output = {
      schema_version: BROWSER_OBSERVATION_VERSION,
      operation_id: operationId,
      actor_build: "1.0.42",
      status: "completed",
      pages_assessed: 1,
      signals: {
        rendered_text_chars: 10,
        raw_to_rendered_ratio: 1,
        landmark_counts: { main: 1 },
        heading_level_counts: { h1: 1 },
        interactive_control_count: 0,
        unnamed_control_count: 0,
        form_control_count: 0,
        unlabeled_form_control_count: 0,
        webmcp_present: false,
        webmcp_tool_count: 0,
        console_error_categories: [],
        failed_resource_categories: [],
        mixed_content_count: 0,
        dom_node_count: 5,
        script_count: 0,
        request_count: 1,
        transferred_bytes: 100,
        challenge_kind: null,
      },
      observations: BROWSER_OBSERVATION_IDS.map((id) => ({
        id,
        status: "pass",
        summary_code: `${id}_observed`,
        user_impact_code: "public_surface_clear",
        remediation_code: "keep_public_surface_stable",
        evidence: {},
      })),
      timings: { total_ms: 100, pages: [100] },
    };
    const unsafeValues = [
      "https://example.com/path?token=secret",
      "example.com",
      "127.0.0.1",
      "2001:db8::1",
      "/private/path",
      "state?token=secret",
      "access_token",
      "line\nbreak",
    ];

    for (const field of [
      "summary_code",
      "user_impact_code",
      "remediation_code",
    ] as const) {
      for (const unsafe of unsafeValues) {
        expect(
          browserObservationOutputV1Schema.safeParse({
            ...output,
            observations: output.observations.map((finding, index) =>
              index === 0 ? { ...finding, [field]: unsafe } : finding,
            ),
          }).success,
        ).toBe(false);
      }
    }

    for (const unsafe of unsafeValues) {
      const unsafeSignalVariants = [
        { ...output.signals, landmark_counts: { [unsafe]: 1 } },
        { ...output.signals, heading_level_counts: { [unsafe]: 1 } },
        { ...output.signals, console_error_categories: [unsafe] },
        { ...output.signals, failed_resource_categories: [unsafe] },
        { ...output.signals, challenge_kind: unsafe },
      ];
      for (const signals of unsafeSignalVariants) {
        expect(
          browserObservationOutputV1Schema.safeParse({ ...output, signals })
            .success,
        ).toBe(false);
      }
    }

    expect(browserObservationOutputV1Schema.safeParse(output).success).toBe(
      true,
    );
  });

  it("keeps Actor build metadata out of the public browser response", () => {
    const publicResponse = {
      version: BROWSER_OBSERVATION_VERSION,
      status: "completed",
      non_scoring: true,
      pages_assessed: 1,
      findings: [],
      updated_at: "2026-07-13T12:00:00.000Z",
    };
    expect(
      browserObservationStatusResponseSchema.safeParse(publicResponse).success,
    ).toBe(true);
    expect(
      browserObservationStatusResponseSchema.safeParse({
        ...publicResponse,
        actor_build: "1.0.42",
      }).success,
    ).toBe(false);
  });
});
